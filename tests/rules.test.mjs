// Security-rules tests — run with: npm run test:rules (starts the emulators).
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, increment, serverTimestamp } from 'firebase/firestore';
import { ref, uploadBytes, getBytes } from 'firebase/storage';

const OWNER = { uid: 'owner', email: 'mbadungoma@gmail.com', email_verified: true };
const ALICE = { uid: 'alice', email: 'alice@example.com', email_verified: true };
const BOB = { uid: 'bob', email: 'bob@example.com', email_verified: true };
const STRANGER = { uid: 'stranger', email: 'x@example.com', email_verified: true };

let env;
const ctx = (u) => env.authenticatedContext(u.uid, { email: u.email, email_verified: u.email_verified });
const db = (u) => ctx(u).firestore();

async function seed(data) {
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    for (const [path, value] of Object.entries(data)) await setDoc(doc(f, path), value);
  });
}

const user = (u, role) => ({ uid: u.uid, email: u.email, displayName: u.uid, photoURL: null, role });
const clip = (uid, id, extra = {}) => ({
  sentenceId: 's1', text: 'Mbote', originalText: 'Mbote', textEdited: false, category: 'general',
  speakerId: uid, speakerName: uid, storagePath: `recordings/${uid}/${id}.wav`, durationSec: 3.2,
  sampleRate: 48000, bitDepth: 24, channels: 1, sizeBytes: 1000, qc: { flags: [] }, hasFlags: false,
  status: 'pending', source: 'studio', ...extra,
});

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-koyokana',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
    storage: { rules: readFileSync('storage.rules', 'utf8'), host: '127.0.0.1', port: 9199 },
  });
});
after(async () => env?.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
});

describe('users', () => {
  it('owner can create themselves as admin', async () => {
    await assertSucceeds(setDoc(doc(db(OWNER), 'users/owner'), user(OWNER, 'admin')));
  });
  it('owner with unverified email cannot self-admin', async () => {
    const u = env.authenticatedContext('owner', { email: OWNER.email, email_verified: false }).firestore();
    await assertFails(setDoc(doc(u, 'users/owner'), user(OWNER, 'admin')));
    await assertSucceeds(setDoc(doc(u, 'users/owner'), user(OWNER, 'pending')));
  });
  it('others can only create themselves as pending', async () => {
    await assertFails(setDoc(doc(db(ALICE), 'users/alice'), user(ALICE, 'admin')));
    await assertFails(setDoc(doc(db(ALICE), 'users/alice'), user(ALICE, 'recorder')));
    await assertSucceeds(setDoc(doc(db(ALICE), 'users/alice'), user(ALICE, 'pending')));
  });
  it('cannot create a profile for someone else', async () => {
    await assertFails(setDoc(doc(db(ALICE), 'users/bob'), user(BOB, 'pending')));
  });
  it('users cannot change their own role, but can edit their profile', async () => {
    await seed({ 'users/alice': user(ALICE, 'pending') });
    await assertFails(updateDoc(doc(db(ALICE), 'users/alice'), { role: 'admin' }));
    await assertSucceeds(updateDoc(doc(db(ALICE), 'users/alice'), { displayName: 'Alice', speaker: { name: 'A' } }));
  });
  it('verified owner can promote themselves', async () => {
    await seed({ 'users/owner': user(OWNER, 'pending') });
    await assertSucceeds(updateDoc(doc(db(OWNER), 'users/owner'), { role: 'admin' }));
  });
  it('admin can change other roles but not their own', async () => {
    await seed({ 'users/owner': user(OWNER, 'admin'), 'users/alice': user(ALICE, 'pending') });
    await assertSucceeds(updateDoc(doc(db(OWNER), 'users/alice'), { role: 'recorder' }));
    await assertFails(updateDoc(doc(db(OWNER), 'users/alice'), { email: 'evil@x.com' }));
    await assertFails(updateDoc(doc(db(OWNER), 'users/owner'), { role: 'recorder' }));
  });
  it('recorder cannot change roles', async () => {
    await seed({ 'users/alice': user(ALICE, 'recorder'), 'users/bob': user(BOB, 'pending') });
    await assertFails(updateDoc(doc(db(ALICE), 'users/bob'), { role: 'recorder' }));
  });
  it('pending users can read only themselves', async () => {
    await seed({ 'users/alice': user(ALICE, 'pending'), 'users/bob': user(BOB, 'recorder') });
    await assertSucceeds(getDoc(doc(db(ALICE), 'users/alice')));
    await assertFails(getDoc(doc(db(ALICE), 'users/bob')));
    await assertSucceeds(getDoc(doc(db(BOB), 'users/alice')));
  });
});

describe('sentences & clips', () => {
  beforeEach(async () => {
    await seed({
      'users/owner': user(OWNER, 'admin'),
      'users/alice': user(ALICE, 'recorder'),
      'users/bob': user(BOB, 'reviewer'),
      'users/stranger': user(STRANGER, 'pending'),
      'sentences/s1': { text: 'Mbote', category: 'general', seq: 1, status: 'open', recordCount: 0, hasDigits: false },
    });
  });

  it('only admins create sentences', async () => {
    const s = { text: 'x', category: 'g', seq: 2, status: 'open', recordCount: 0, hasDigits: false };
    await assertFails(setDoc(doc(db(ALICE), 'sentences/s2'), s));
    await assertSucceeds(setDoc(doc(db(OWNER), 'sentences/s2'), s));
  });
  it('pending users cannot read the script', async () => {
    await assertFails(getDoc(doc(db(STRANGER), 'sentences/s1')));
    await assertSucceeds(getDoc(doc(db(ALICE), 'sentences/s1')));
  });
  it('recorder can mark a sentence recorded but not edit its text', async () => {
    await assertSucceeds(updateDoc(doc(db(ALICE), 'sentences/s1'), { status: 'recorded', recordCount: increment(1), lastRecordedAt: serverTimestamp(), lastRecordedBy: 'alice' }));
    await assertFails(updateDoc(doc(db(ALICE), 'sentences/s1'), { text: 'changed' }));
  });
  it('recorder creates own clip with the canonical path', async () => {
    await assertSucceeds(setDoc(doc(db(ALICE), 'clips/c1'), clip('alice', 'c1')));
    await assertFails(setDoc(doc(db(ALICE), 'clips/c2'), clip('bob', 'c2')));
    await assertFails(setDoc(doc(db(ALICE), 'clips/c3'), { ...clip('alice', 'c3'), storagePath: 'recordings/alice/other.wav' }));
    await assertFails(setDoc(doc(db(ALICE), 'clips/c4'), clip('alice', 'c4', { status: 'approved' })));
    await assertFails(setDoc(doc(db(STRANGER), 'clips/c5'), clip('stranger', 'c5')));
  });
  it('reviewers approve, recorders cannot', async () => {
    await seed({ 'clips/c1': clip('alice', 'c1') });
    await assertFails(updateDoc(doc(db(ALICE), 'clips/c1'), { status: 'approved' }));
    await assertSucceeds(updateDoc(doc(db(BOB), 'clips/c1'), { status: 'approved', reviewedBy: 'bob', reviewNote: '' }));
    await assertFails(updateDoc(doc(db(BOB), 'clips/c1'), { status: 'approved', reviewedBy: 'alice' }));
    await assertFails(updateDoc(doc(db(BOB), 'clips/c1'), { durationSec: 99 }));
    await assertFails(deleteDoc(doc(db(BOB), 'clips/c1')));
    await assertSucceeds(deleteDoc(doc(db(OWNER), 'clips/c1')));
  });
  it('daily counters accept only known fields', async () => {
    await assertSucceeds(setDoc(doc(db(ALICE), 'daily/2026-10-07'), { date: '2026-10-07', clips: increment(1), seconds: increment(3) }, { merge: true }));
    await assertFails(setDoc(doc(db(ALICE), 'daily/2026-10-07'), { date: '2026-10-07', hack: true }, { merge: true }));
    await assertFails(setDoc(doc(db(STRANGER), 'daily/2026-10-08'), { date: '2026-10-08', clips: 1 }));
  });
});

describe('datasets & runs', () => {
  beforeEach(async () => {
    await seed({ 'users/owner': user(OWNER, 'admin'), 'users/alice': user(ALICE, 'recorder') });
  });
  it('datasets are admin-created and immutable except notes', async () => {
    const d = { name: 'tts-v1', task: 'tts', clipCount: 1, notes: '' };
    await assertFails(setDoc(doc(db(ALICE), 'datasets/tts-v1'), d));
    await assertFails(setDoc(doc(db(OWNER), 'datasets/other'), d));
    await assertSucceeds(setDoc(doc(db(OWNER), 'datasets/tts-v1'), d));
    await assertSucceeds(updateDoc(doc(db(OWNER), 'datasets/tts-v1'), { notes: 'hello' }));
    await assertFails(updateDoc(doc(db(OWNER), 'datasets/tts-v1'), { clipCount: 99 }));
    await assertFails(setDoc(doc(db(OWNER), 'datasets/tts-v1'), { ...d, clipCount: 5 }));
  });
  it('runs are admin-only writes', async () => {
    await assertFails(setDoc(doc(db(ALICE), 'runs/r1'), { name: 'x' }));
    await assertSucceeds(setDoc(doc(db(OWNER), 'runs/r1'), { name: 'x' }));
    await assertSucceeds(getDoc(doc(db(ALICE), 'runs/r1')));
  });
});

describe('storage', () => {
  beforeEach(async () => {
    await seed({
      'users/owner': user(OWNER, 'admin'),
      'users/alice': user(ALICE, 'recorder'),
      'users/stranger': user(STRANGER, 'pending'),
    });
  });
  const wav = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]);
  it('recorders upload WAVs only into their own folder', async () => {
    const s = ctx(ALICE).storage();
    await assertSucceeds(uploadBytes(ref(s, 'recordings/alice/abc123.wav'), wav, { contentType: 'audio/wav' }));
    await assertFails(uploadBytes(ref(s, 'recordings/bob/abc124.wav'), wav, { contentType: 'audio/wav' }));
    await assertFails(uploadBytes(ref(s, 'recordings/alice/abc125.wav'), wav, { contentType: 'text/plain' }));
    await assertFails(uploadBytes(ref(s, 'recordings/alice/abc123.wav'), wav, { contentType: 'audio/wav' }));
  });
  it('pending users cannot upload or read', async () => {
    const s = ctx(STRANGER).storage();
    await assertFails(uploadBytes(ref(s, 'recordings/stranger/x1.wav'), wav, { contentType: 'audio/wav' }));
    await assertFails(getBytes(ref(s, 'recordings/alice/abc123.wav')));
  });
  it('only admins write dataset manifests', async () => {
    await assertFails(uploadBytes(ref(ctx(ALICE).storage(), 'datasets/tts-v1/manifest.jsonl'), wav));
    await assertSucceeds(uploadBytes(ref(ctx(OWNER).storage(), 'datasets/tts-v1/manifest.jsonl'), wav));
  });
});
