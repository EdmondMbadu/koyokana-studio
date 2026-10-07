// Run against the Authentication emulator only: npm run test:auth.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { deleteApp, initializeApp } from 'firebase/app';
import {
  applyActionCode, checkActionCode, confirmPasswordReset, connectAuthEmulator,
  createUserWithEmailAndPassword, getAuth, GoogleAuthProvider,
  reauthenticateWithCredential, sendEmailVerification,
  sendPasswordResetEmail, signInWithCredential, signInWithEmailAndPassword,
  signOut, updatePassword, verifyPasswordResetCode,
} from 'firebase/auth';

const projectId = 'demo-koyokana';
const endpoint = 'http://127.0.0.1:9099';
function setup() {
  const app = initializeApp({ apiKey: 'demo-koyokana-key', projectId }, randomUUID());
  const auth = getAuth(app);
  connectAuthEmulator(auth, endpoint, { disableWarnings: true });
  return { app, auth };
}
function googleCredential(email, sub) {
  const encode = (x) => Buffer.from(JSON.stringify(x)).toString('base64url');
  const token = `${encode({ alg: 'none' })}.${encode({
    iss: 'https://accounts.google.com', aud: 'demo-koyokana', sub, email,
    email_verified: true, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
  })}.`;
  return GoogleAuthProvider.credential(token);
}
async function emailCode(email, type) {
  const response = await fetch(`${endpoint}/emulator/v1/projects/${projectId}/oobCodes`);
  assert.equal(response.status, 200);
  const data = await response.json();
  const code = data.oobCodes.findLast((x) => x.email === email && x.requestType === type);
  assert.ok(code, 'The emulator generated the requested account-action code');
  return code.oobCode;
}

test('Google account can add a password, reset it, and keep the same UID for both providers', async () => {
  const { app, auth } = setup();
  const id = randomUUID();
  const email = `link-${id}@example.test`;
  const password = `emulator-only-${randomUUID()}`;
  const resetPassword = `emulator-reset-${randomUUID()}`;
  const google = googleCredential(email, id);
  try {
    const original = await signInWithCredential(auth, google);
    const uid = original.user.uid;
    await reauthenticateWithCredential(original.user, google);
    await updatePassword(original.user, password);
    await original.user.reload();
    assert.equal(original.user.uid, uid);
    assert.deepEqual(original.user.providerData.map((p) => p.providerId).sort(), ['google.com', 'password']);
    await signOut(auth);
    assert.equal((await signInWithEmailAndPassword(auth, email, password)).user.uid, uid);
    await sendPasswordResetEmail(auth, email);
    const code = await emailCode(email, 'PASSWORD_RESET');
    assert.equal(await verifyPasswordResetCode(auth, code), email);
    await confirmPasswordReset(auth, code, resetPassword);
    await assert.rejects(verifyPasswordResetCode(auth, code), (error) => error.code === 'auth/invalid-action-code');
    await signOut(auth);
    assert.equal((await signInWithEmailAndPassword(auth, email, resetPassword)).user.uid, uid);
    await signOut(auth);
    assert.equal((await signInWithCredential(auth, google)).user.uid, uid);
    await signOut(auth);
    assert.equal((await signInWithEmailAndPassword(auth, email, resetPassword)).user.uid, uid);
  } finally {
    await deleteApp(app);
  }
});

test('a Google-only account can set its first password through a verified reset code', async () => {
  const { app, auth } = setup();
  const id = randomUUID();
  const email = `reset-${id}@example.test`;
  const password = `emulator-only-${randomUUID()}`;
  try {
    const original = await signInWithCredential(auth, googleCredential(email, id));
    const uid = original.user.uid;
    await sendPasswordResetEmail(auth, email);
    const code = await emailCode(email, 'PASSWORD_RESET');
    assert.equal(await verifyPasswordResetCode(auth, code), email);
    await confirmPasswordReset(auth, code, password);
    await signOut(auth);
    assert.equal((await signInWithEmailAndPassword(auth, email, password)).user.uid, uid);
  } finally {
    await deleteApp(app);
  }
});

test('email verification codes still work with the shared action handler', async () => {
  const { app, auth } = setup();
  const email = `verify-${randomUUID()}@example.test`;
  try {
    const original = await createUserWithEmailAndPassword(auth, email, `emulator-only-${randomUUID()}`);
    await sendEmailVerification(original.user);
    const code = await emailCode(email, 'VERIFY_EMAIL');
    assert.equal((await checkActionCode(auth, code)).operation, 'VERIFY_EMAIL');
    await applyActionCode(auth, code);
    await original.user.reload();
    assert.equal(original.user.emailVerified, true);
  } finally {
    await deleteApp(app);
  }
});
