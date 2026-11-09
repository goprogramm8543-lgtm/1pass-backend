import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { testConfig } from './helpers.js';
import { Protection } from '../src/common/security.js';
import { SandboxProvider } from '../src/email/provider.js';
import { cleanSandbox } from '../src/email/cleanup.js';
import { Marketing } from '../src/marketing/service.js';
import type { Database } from '../src/db/client.js';
it('sandbox delivery is encrypted, idempotent, privately removable and retained only briefly', async () => {
  const root = tmpdir(),
    dir = await mkdtemp(join(root, '1pass-sandbox-test-'));
  try {
    const c = { ...testConfig(), SANDBOX_MAIL_DIR: dir },
      protection = new Protection(c);
    const provider = new SandboxProvider(c, protection),
      id = randomUUID();
    await provider.send(id, 'confirmation', {
      to: 'test@example.com',
      token: 'a'.repeat(43),
    });
    const original = await readFile(join(dir, `${id}.mail`), 'utf8');
    await provider.send(id, 'confirmation', {
      to: 'test@example.com',
      token: 'b'.repeat(43),
    });
    expect(await readFile(join(dir, `${id}.mail`), 'utf8')).toBe(original);
    expect(original).not.toContain('test@example.com');
    expect(protection.open<{ token: string }>(original).token).toBe(
      'a'.repeat(43),
    );
    const content = protection.open<{ subject: string; text: string }>(
      original,
    );
    expect(content.subject).toContain('Confirm');
    expect(content.text).toContain('Until you confirm, you are not subscribed');
    expect(content.text).toContain('unsubscribe');
    expect(content.text).not.toContain('premium months');
    const m = new Marketing({} as Database, c);
    await cleanSandbox(m, { email: 'test@example.com', ids: new Set() });
    expect(await readdir(dir)).toEqual([]);
    await provider.send(id, 'enquiry', { id, kind: 'contact' });
    const old = new Date(Date.now() - 8 * 86400000);
    await utimes(join(dir, `${id}.mail`), old, old);
    await cleanSandbox(m);
    expect(await readdir(dir)).toEqual([]);
  } finally {
    if (dirname(dir) !== root) throw new Error('Unexpected cleanup path');
    await rm(dir, { recursive: true, force: true });
  }
});
