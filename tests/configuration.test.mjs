import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { credentialLines, isPrivateConfig } from '../scripts/check-secrets.mjs';

test('detects the original configuration shape without depending on Git history', () => {
  const fakeKey = ['AI', 'za', 'z'.repeat(35)].join('');
  const reportedShape = `firebase: {\n  apiKey: '${fakeKey}',\n}`;
  assert.deepEqual(credentialLines(reportedShape), [2]);
  assert.deepEqual(credentialLines(readFileSync('src/environments/environment.base.ts', 'utf8')), []);
});

test('detects quoted keys and private keys, while allowing examples and demo config', () => {
  const fakeKey = ['AI', 'za', 'x'.repeat(35)].join('');
  assert.deepEqual(credentialLines(`FIREBASE_API_KEY="${fakeKey}"`), [1]);
  assert.deepEqual(credentialLines('-----BEGIN RSA ' + 'PRIVATE KEY-----'), [1]);
  assert.deepEqual(credentialLines('FIREBASE_API_KEY=\napiKey: "demo-koyokana-key"'), []);
  assert.equal(isPrivateConfig('.env.local'), true);
  assert.equal(isPrivateConfig('src/environments/firebase-key.local.ts'), true);
  assert.equal(isPrivateConfig('.env.example'), false);
});

test('configuration generation fails without a key and uses environment values over local values', () => {
  const root = mkdtempSync(join(tmpdir(), 'koyokana-config-test-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'src/environments'), { recursive: true });
    cpSync('scripts/configure-firebase.mjs', join(root, 'scripts/configure-firebase.mjs'));
    const env = { ...process.env };
    delete env.FIREBASE_API_KEY;
    const run = (extra = {}) => spawnSync(process.execPath, [join(root, 'scripts/configure-firebase.mjs')], { env: { ...env, ...extra }, encoding: 'utf8' });
    const missing = run();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Set FIREBASE_API_KEY/);
    assert.equal(existsSync(join(root, 'src/environments/firebase-key.local.ts')), false);
    const localKey = ['AI', 'za', 'x'.repeat(35)].join('');
    const envKey = ['AI', 'za', 'y'.repeat(35)].join('');
    writeFileSync(join(root, '.env.local'), `FIREBASE_API_KEY=${localKey}\n`);
    assert.equal(run().status, 0);
    const override = run({ FIREBASE_API_KEY: envKey });
    assert.equal(override.status, 0);
    assert.equal(override.stdout.includes(envKey), false);
    assert.ok(readFileSync(join(root, 'src/environments/firebase-key.local.ts'), 'utf8').includes(envKey));
    assert.equal(run({ FIREBASE_API_KEY: 'invalid' }).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
