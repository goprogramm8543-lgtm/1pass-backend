import { readFile, writeFile } from 'node:fs/promises';
import { config } from './config.js';
import { postgres } from './db/client.js';
import { Marketing } from './marketing/service.js';
import { purge, erase, exportSubject } from './marketing/operations.js';
import { email } from './marketing/schemas.js';
import { cleanSandbox } from './email/cleanup.js';
const c = config(),
  db = postgres(c.DATABASE_URL),
  m = new Marketing(db, c);
const [command, path, output] = process.argv.slice(2);
try {
  if (command === 'purge') {
    console.log(await purge(m));
    await cleanSandbox(m);
  } else if (command === 'queue-status')
    console.log(
      (
        await db.query(
          'SELECT state,count(*)::int AS count,min(created_at) AS oldest FROM marketing_email_outbox GROUP BY state',
        )
      ).rows,
    );
  else if (command === 'sandbox-read' && path && output) {
    await writeFile(
      output,
      JSON.stringify(m.protection.open(await readFile(path, 'utf8')), null, 2),
      { flag: 'wx', mode: 0o600 },
    );
    console.log(
      'Sandbox message exported to the requested file; delete it after testing.',
    );
  } else if ((command === 'delete' || command === 'export') && path) {
    // Read subject from a protected file, avoiding email addresses in shell history.
    const subject = email.parse((await readFile(path, 'utf8')).trim());
    if (command === 'delete') {
      const data = await exportSubject(m, subject);
      const ids = new Set(data.enquiries.map((e) => (e as { id: string }).id));
      // Stop workers for privacy deletion; remove sink copies before the DB references.
      await cleanSandbox(m, { email: subject, ids });
      await erase(m, subject);
    } else if (output)
      await writeFile(
        output,
        JSON.stringify(await exportSubject(m, subject), null, 2),
        { flag: 'wx', mode: 0o600 },
      );
    else throw new Error('Export requires an output path');
    console.log('Operation complete');
  } else
    throw new Error(
      'Usage: ops purge | queue-status | delete subject-file | export subject-file output-file | sandbox-read encrypted-file output-file',
    );
} finally {
  await db.close();
}
