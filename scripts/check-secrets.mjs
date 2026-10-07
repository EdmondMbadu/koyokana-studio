import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const keyPatterns = [
  /AIza[0-9A-Za-z_-]{35}/,
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
];

export function credentialLines(content) {
  return content.split(/\r?\n/).flatMap((line, index) =>
    keyPatterns.some((pattern) => pattern.test(line)) ? [index + 1] : [],
  );
}

export function isPrivateConfig(path) {
  const name = path.split('/').at(-1);
  return (name === '.env' || name?.startsWith('.env.')) && name !== '.env.example'
    || path === 'src/environments/firebase-key.local.ts';
}

function main() {
  const staged = process.argv.includes('--staged');
  const paths = execFileSync('git', ['ls-files', '--cached', '-z'], { encoding: 'utf8' })
    .split('\0').filter(Boolean);
  let failed = false;
  for (const path of paths) {
    if (isPrivateConfig(path)) {
      console.error(`Private configuration must remain untracked: ${path}`);
      failed = true;
    }
    if (!staged && !existsSync(path)) continue;
    const content = staged
      ? execFileSync('git', ['show', `:${path}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      : readFileSync(path, 'utf8');
    for (const line of credentialLines(content)) {
      console.error(`Possible credential detected: ${path}:${line} (value omitted)`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
  else console.log('No API keys or private keys found in tracked files.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
