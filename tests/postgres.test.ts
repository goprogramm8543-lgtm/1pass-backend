import { it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { postgres } from '../src/infrastructure/db/index.js';
import { migrate } from '../src/infrastructure/db/migrate.js';
import { Marketing } from '../src/modules/marketing/service.js';
import { runOne } from '../src/infrastructure/queue/outbox.js';
import { testConfig,signup } from './helpers.js';
import { subscribe } from '../src/modules/marketing/schemas.js';
import type { Mail } from '../src/infrastructure/email/provider.js';
it.skipIf(!process.env.TEST_DATABASE_URL)('isolated PostgreSQL: concurrent signup, claiming and single-use confirmation',async()=>{
 const url=new URL(process.env.TEST_DATABASE_URL!),admin=postgres(url.toString());
 const schema='test_'+randomUUID().replaceAll('-','');
 await admin.query(`CREATE SCHEMA ${schema}`);
 url.searchParams.set('options',`-c search_path=${schema}`);const db=postgres(url.toString());
 try {
  await migrate(db);await migrate(db);
  const m=new Marketing(db,testConfig());
  await Promise.all(Array.from({length:8},()=>m.subscribe(subscribe.parse(signup))));
  expect((await db.query('SELECT * FROM marketing_subscribers')).rows).toHaveLength(1);
  const deliveries:Mail[]=[];
  const provider={async send(id:string,_event:string,payload:Mail){deliveries.push(payload);return id;}};
  await Promise.all([runOne(m,provider),runOne(m,provider)]);
  expect(deliveries).toHaveLength(1);
  const outcomes=await Promise.allSettled([m.confirm(deliveries[0]!.token!),m.confirm(deliveries[0]!.token!)]);
  expect(outcomes.filter(o=>o.status==='fulfilled')).toHaveLength(1);
 } finally {
  await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();
 }
},30000);
