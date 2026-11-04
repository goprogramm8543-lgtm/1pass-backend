import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { Marketing } from '../marketing/service.js';
// Only UUID-named sink files inside the configured directory are eligible.
export async function cleanSandbox(
  m: Marketing,
  subject?: { email: string; ids: Set<string> },
) {
  const root = resolve(m.c.SANDBOX_MAIL_DIR);
  let files: string[];
  try {
    files = await readdir(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  for (const file of files) {
    if (!/^[a-f0-9-]{36}\.mail$/.test(file)) continue;
    const path = resolve(root, file);
    if (dirname(path) !== root) throw new Error('Invalid sandbox path');
    if (subject) {
      const mail = m.protection.open<{ to?: string; id: string }>(
        await readFile(path, 'utf8'),
      );
      if (mail.to === subject.email || subject.ids.has(mail.id))
        await unlink(path);
    } else if (
      (await stat(path)).mtimeMs <
      Date.now() - m.c.SANDBOX_RETENTION_DAYS * 86400000
    )
      await unlink(path);
  }
}
