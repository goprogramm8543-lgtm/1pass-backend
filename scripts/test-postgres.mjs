import EmbeddedPostgres from 'embedded-postgres';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

const root = resolve('.test-postgres');
await mkdir(root, { recursive: true });
const dir = await mkdtemp(resolve(root, 'run-'));
const listener = createServer();
await new Promise((done, reject) => {
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', done);
});
const port = listener.address().port;
await new Promise((done, reject) =>
  listener.close((error) => (error ? reject(error) : done())),
);
const password = randomBytes(24).toString('hex');
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: 'test',
  password,
  port,
  persistent: true,
  createPostgresUser: false,
  autoRehydrateSymlinks: true,
  postgresFlags: ['-h', '127.0.0.1'],
  onLog: () => {},
  onError: () => {},
});
let started = false;
try {
  await pg.initialise();
  await pg.start();
  started = true;
  await pg.createDatabase('marketing_test');
  const url = `postgresql://test:${password}@127.0.0.1:${port}/marketing_test`;
  const child = spawn(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run'],
    {
      env: { ...process.env, TEST_DATABASE_URL: url },
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  process.exitCode = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => done(code ?? 1));
  });
} finally {
  if (started) await pg.stop();
  const within = relative(root, dir);
  if (!within || within.startsWith('..') || isAbsolute(within))
    throw new Error('Refusing cleanup outside test root');
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
