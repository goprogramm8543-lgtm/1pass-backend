import { setTimeout } from 'node:timers/promises';
import { config } from './config.js';
import { postgres } from './db/client.js';
import { Marketing } from './marketing/service.js';
import { SandboxProvider } from './email/provider.js';
import { runOne } from './email/outbox.js';
const c = config(),
  db = postgres(c.DATABASE_URL),
  m = new Marketing(db, c),
  provider = new SandboxProvider(c, m.protection);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    stopping = true;
  });
try {
  while (!stopping) {
    try {
      if (!(await runOne(m, provider))) await setTimeout(1000);
    } catch {
      console.error(JSON.stringify({ code: 'WORKER_DATABASE_UNAVAILABLE' }));
      await setTimeout(5000);
    }
  }
} finally {
  await db.close();
}
