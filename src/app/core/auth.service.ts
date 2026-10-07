import { Injectable, computed, inject, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import {
  GoogleAuthProvider,
  User,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  reauthenticateWithPopup,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  updatePassword,
} from 'firebase/auth';
import { Unsubscribe, doc, onSnapshot, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { filter, firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { auth, db } from './firebase';
import { MEMBER_ROLES, SpeakerProfile, UserProfile } from './models';
import { ToastService } from './toast.service';

const LAST_SEEN_INTERVAL_MS = 10 * 60 * 1000;
const PROFILE_LOAD_TIMEOUT_MS = 20_000;

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);

  /** Firebase user, or null when signed out. */
  readonly user = signal<User | null>(null);
  readonly providerIds = signal<string[]>([]);
  readonly hasPassword = computed(() => this.providerIds().includes('password'));
  /** Firestore profile (users/{uid}). */
  readonly profile = signal<UserProfile | null>(null);
  readonly emailVerified = signal(false);
  /** Set once the first auth state has been received. */
  readonly initialized = signal(false);
  readonly profileLoading = signal(false);
  readonly profileError = signal<string | null>(null);

  readonly role = computed(() => this.profile()?.role ?? null);
  readonly isAdmin = computed(() => this.role() === 'admin');
  readonly isReviewer = computed(() => this.role() === 'admin' || this.role() === 'reviewer');
  readonly isMember = computed(() => {
    const r = this.role();
    return !!r && MEMBER_ROLES.includes(r);
  });
  readonly isOwnerEmail = computed(() => {
    const email = this.user()?.email?.toLowerCase();
    return !!email && environment.ownerEmails.map((e) => e.toLowerCase()).includes(email);
  });
  readonly displayName = computed(() => {
    const p = this.profile();
    const u = this.user();
    return p?.displayName || u?.displayName || u?.email?.split('@')[0] || 'You';
  });
  readonly firstName = computed(() => this.displayName().split(' ')[0]);
  readonly initials = computed(() =>
    this.displayName()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]!.toUpperCase())
      .join(''),
  );

  private readonly state$ = toObservable(
    computed(() => ({
      init: this.initialized(),
      uid: this.user()?.uid ?? null,
      loading: this.profileLoading(),
    })),
  );

  private unsubProfile: Unsubscribe | null = null;
  private profileLoadTimer: ReturnType<typeof setTimeout> | null = null;
  private creatingProfile = false;
  private promotingOwner = false;
  private touchedLastSeen = false;
  private pendingDisplayName: string | null = null;

  constructor() {
    onAuthStateChanged(auth, (u) => this.handleUser(u));
  }

  /**
   * Resolves once auth and the profile have settled.
   * Pass a uid to wait until that specific user is active (after sign-in).
   */
  settle(expectedUid?: string): Promise<unknown> {
    return firstValueFrom(
      this.state$.pipe(
        filter((s) => s.init && !s.loading && (expectedUid === undefined || s.uid === expectedUid)),
      ),
    );
  }

  // ───────────────────────────── sign-in methods

  async signInWithGoogle(): Promise<void> {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const cred = await signInWithPopup(auth, provider);
    await this.settle(cred.user.uid);
  }

  async signInWithEmail(email: string, password: string): Promise<void> {
    const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
    await this.settle(cred.user.uid);
  }

  async signUpWithEmail(name: string, email: string, password: string): Promise<void> {
    this.pendingDisplayName = name.trim() || null;
    const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
    if (name.trim()) await updateProfile(cred.user, { displayName: name.trim() });
    sendEmailVerification(cred.user).catch(() => undefined);
    await this.settle(cred.user.uid);
  }

  sendPasswordReset(email: string): Promise<void> {
    return sendPasswordResetEmail(auth, email.trim());
  }

  /** Adds a password to the signed-in Google account, preserving its UID/profile. */
  async addPassword(password: string): Promise<void> {
    const u = auth.currentUser;
    if (!u?.email) throw new Error('Sign in with Google before adding a password.');
    if (u.providerData.some((p) => p.providerId === 'password')) {
      throw new Error('This account already has a password. Use the reset link to change it.');
    }
    if (!u.providerData.some((p) => p.providerId === 'google.com')) {
      throw new Error('Sign in with Google before adding a password.');
    }
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await reauthenticateWithPopup(u, provider);
    // The account already owns this email. Updating its password adds password
    // sign-in without attempting another sign-up for the same address.
    await updatePassword(u, password);
    await u.reload();
    await u.getIdToken(true);
    this.providerIds.set(u.providerData.map((p) => p.providerId));
  }

  async resendVerification(): Promise<void> {
    const u = auth.currentUser;
    if (u) await sendEmailVerification(u);
  }

  /** Re-reads the user after they clicked the verification link. */
  async refreshVerification(): Promise<boolean> {
    const u = auth.currentUser;
    if (!u) return false;
    await u.reload();
    await u.getIdToken(true);
    this.emailVerified.set(u.emailVerified);
    const p = this.profile();
    if (p) await this.maybePromoteOwner(u, p);
    return u.emailVerified;
  }

  async signOut(): Promise<void> {
    await signOut(auth);
    this.toasts.toasts.set([]);
    await this.router.navigateByUrl('/login');
  }

  async updateMyProfile(patch: { displayName?: string; speaker?: SpeakerProfile }): Promise<void> {
    const u = auth.currentUser;
    if (!u) throw new Error('Not signed in');
    await updateDoc(doc(db, 'users', u.uid), { ...patch, updatedAt: serverTimestamp() });
    if (patch.displayName && patch.displayName !== u.displayName) {
      await updateProfile(u, { displayName: patch.displayName }).catch(() => undefined);
    }
  }

  // ───────────────────────────── internals

  private handleUser(u: User | null): void {
    this.providerIds.set(u?.providerData.map((p) => p.providerId) ?? []);
    this.clearProfileLoadTimer();
    this.unsubProfile?.();
    this.unsubProfile = null;
    this.creatingProfile = false;
    this.promotingOwner = false;
    this.touchedLastSeen = false;
    this.profile.set(null);
    this.profileError.set(null);

    if (!u) {
      this.profileLoading.set(false);
      this.user.set(null);
      this.emailVerified.set(false);
      this.initialized.set(true);
      return;
    }

    this.profileLoading.set(true);
    this.user.set(u);
    this.emailVerified.set(u.emailVerified);
    this.initialized.set(true);

    // Firestore retries a missing database or an offline connection without
    // invoking the snapshot error callback. Let login and route guards settle.
    this.profileLoadTimer = setTimeout(() => {
      this.failProfile(
        new Error(
          'The studio database did not respond. Check your connection, and make sure the default Firestore database is created and its security rules are deployed.',
        ),
      );
    }, PROFILE_LOAD_TIMEOUT_MS);

    const ref = doc(db, 'users', u.uid);
    this.unsubProfile = onSnapshot(
      ref,
      { includeMetadataChanges: true },
      (snap) => {
        if (!snap.exists()) {
          if (!this.creatingProfile) {
            this.creatingProfile = true;
            this.createProfile(u).catch((err) => this.failProfile(err));
          }
          return;
        }
        // Roles are read from this document by the security rules. Wait until
        // Firestore commits it before opening pages that require membership.
        if (snap.metadata.hasPendingWrites) return;
        const p = { ...(snap.data() as Omit<UserProfile, 'uid'>), uid: u.uid } as UserProfile;
        this.clearProfileLoadTimer();
        this.profileError.set(null);
        this.profile.set(p);
        this.profileLoading.set(false);
        this.maybePromoteOwner(u, p).catch(() => undefined);
        this.touchLastSeen(p).catch(() => undefined);
      },
      (err) => this.failProfile(err),
    );
  }

  private failProfile(err: unknown): void {
    this.clearProfileLoadTimer();
    console.error('[auth] profile error', err);
    this.profileError.set(err instanceof Error ? err.message : String(err));
    this.profileLoading.set(false);
  }

  private clearProfileLoadTimer(): void {
    if (this.profileLoadTimer !== null) {
      clearTimeout(this.profileLoadTimer);
      this.profileLoadTimer = null;
    }
  }

  private isOwner(u: User): boolean {
    const email = u.email?.toLowerCase();
    return (
      !!email &&
      u.emailVerified &&
      environment.ownerEmails.map((e) => e.toLowerCase()).includes(email)
    );
  }

  private async createProfile(u: User): Promise<void> {
    const name =
      this.pendingDisplayName || u.displayName || (u.email ? u.email.split('@')[0]! : 'Speaker');
    this.pendingDisplayName = null;
    const profile: Omit<UserProfile, 'uid' | 'createdAt' | 'lastSeenAt'> & Record<string, unknown> = {
      uid: u.uid,
      email: u.email ?? '',
      displayName: name,
      photoURL: u.photoURL ?? null,
      role: this.isOwner(u) ? 'admin' : 'pending',
      speaker: { name, gender: '', ageRange: '', region: 'Kinshasa', languages: 'Lingala, French' },
      createdAt: serverTimestamp(),
      lastSeenAt: serverTimestamp(),
    };
    this.touchedLastSeen = true;
    await setDoc(doc(db, 'users', u.uid), profile);
  }

  /** The owner may have signed up before verifying their email — promote once verified. */
  private async maybePromoteOwner(u: User, p: UserProfile): Promise<void> {
    if (p.role === 'admin' || this.promotingOwner || !this.isOwner(u)) return;
    this.promotingOwner = true;
    try {
      await updateDoc(doc(db, 'users', u.uid), { role: 'admin', updatedAt: serverTimestamp() });
    } finally {
      this.promotingOwner = false;
    }
  }

  private async touchLastSeen(p: UserProfile): Promise<void> {
    if (this.touchedLastSeen) return;
    this.touchedLastSeen = true;
    const last = p.lastSeenAt?.toMillis?.() ?? 0;
    if (Date.now() - last < LAST_SEEN_INTERVAL_MS) return;
    await updateDoc(doc(db, 'users', p.uid), { lastSeenAt: serverTimestamp() });
  }
}

/** Human-friendly messages for Firebase Auth error codes. */
export function authErrorMessage(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-login-credentials':
      return 'That email and password don’t match an account.';
    case 'auth/invalid-email':
      return 'Enter a valid email address.';
    case 'auth/email-already-in-use':
      return 'An account already exists with this email. Sign in with Google, then add a password in Settings, or use Forgot password.';
    case 'auth/weak-password':
      return 'Use at least 8 characters for your password.';
    case 'auth/requires-recent-login':
      return 'Sign in again, then try changing your password.';
    case 'auth/user-mismatch':
      return 'Choose the same Google account you used to sign in to the studio.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a moment and try again.';
    case 'auth/network-request-failed':
      return 'Network error. Check your connection.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return '';
    case 'auth/popup-blocked':
      return 'Your browser blocked the sign-in popup. Allow popups for this site.';
    case 'auth/operation-not-allowed':
      return 'This sign-in method is not enabled in the Firebase console.';
    case 'auth/configuration-not-found':
      return `Firebase Authentication is not set up for ${environment.firebase.projectId}. Enable Google and Email/Password in the Firebase console, or run npm run deploy:auth.`;
    case 'auth/unauthorized-domain':
      return 'This domain is not authorized in Firebase Auth settings. Add the hostname (for example, localhost) under Authentication → Settings → Authorized domains.';
    case 'auth/account-exists-with-different-credential':
      return 'This email is already linked to another sign-in method.';
    default:
      return err instanceof Error ? err.message : 'Something went wrong.';
  }
}
