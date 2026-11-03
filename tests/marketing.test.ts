import { beforeAll,afterAll,beforeEach,describe,it,expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { Writable } from 'node:stream';
import { buildApp } from '../src/app.js';
import { Marketing } from '../src/modules/marketing/service.js';
import { runOne } from '../src/infrastructure/queue/outbox.js';
import type { Mail, EmailProvider } from '../src/infrastructure/email/provider.js';
import { memoryDb,testConfig,signup } from './helpers.js';
import type { Database } from '../src/infrastructure/db/index.js';
import { erase,purge,exportSubject } from '../src/modules/marketing/operations.js';
const p='/api/v1/marketing';
let db:Database;
const c=testConfig();
let app:ReturnType<typeof buildApp>,m:Marketing;
let sent:{id:string;event:string;payload:Mail}[]=[];
const provider:EmailProvider={async send(id,event,payload){sent.push({id,event,payload});return id;}};
const post=(route:string,payload:unknown)=>app.inject({method:'POST',url:p+route,headers:{host:'localhost:4000'},payload:payload as object});
async function confirmed() {
 await post('/subscriptions',signup);await runOne(m,provider);
 const token=sent[0]!.payload.token!;
 const result=await post('/subscriptions/confirm',{token});expect(result.statusCode).toBe(200);
 await runOne(m,provider);return {token,...sent.at(-1)!.payload};
}
beforeAll(async()=>{db=await memoryDb();},30000);
beforeEach(async()=>{
 await db.query('TRUNCATE marketing_subscribers,marketing_contact_requests,marketing_business_inquiries,marketing_email_outbox,marketing_email_events,marketing_audit_events,marketing_suppressions,marketing_rate_limits CASCADE');
 sent=[];m=new Marketing(db,c);app=buildApp(c,db);
});
afterAll(async()=>{await db.close();});
describe('marketing HTTP lifecycle',()=>{
 it('normalizes email, queues once, confirms once, authenticates preferences and durably opts out',async()=>{
  expect((await post('/subscriptions',{...signup,email:'Person@Example.com'})).statusCode).toBe(202);
  expect((await post('/subscriptions',signup)).json()).toEqual((await post('/subscriptions',signup)).json());
  expect((await db.query('SELECT * FROM marketing_email_outbox')).rows).toHaveLength(1);
  await runOne(m,provider);const token=sent[0]!.payload.token!;
  expect((await post('/subscriptions/confirm',{token})).statusCode).toBe(200);
  expect((await post('/subscriptions/confirm',{token})).statusCode).toBe(400);
  await runOne(m,provider);const {unsubscribe,preferences}=sent[1]!.payload;
  expect((await post('/subscriptions/confirm',{token:unsubscribe})).statusCode).toBe(400);
  expect((await app.inject({url:p+'/subscriptions/preferences',headers:{host:'localhost:4000'}})).statusCode).toBe(401);
  const prefs=await app.inject({method:'PATCH',url:p+'/subscriptions/preferences',headers:{host:'localhost:4000',authorization:`Bearer ${preferences}`},payload:{interests:['business']}});
  expect(prefs.json()).toEqual({status:'confirmed',interests:['business']});
  expect((await post('/subscriptions/unsubscribe',{token:unsubscribe})).statusCode).toBe(200);
  expect((await post('/subscriptions/unsubscribe',{token:unsubscribe})).statusCode).toBe(200);
  expect((await db.query('SELECT reason FROM marketing_suppressions')).rows[0]).toEqual({reason:'unsubscribe'});
  expect((await app.inject({url:p+'/subscriptions/preferences',headers:{host:'localhost:4000',authorization:`Bearer ${preferences}`}})).statusCode).toBe(400);
 });
 it('requires fresh consent and confirmation after unsubscribe',async()=>{
  const {unsubscribe}=await confirmed();await post('/subscriptions/unsubscribe',{token:unsubscribe});
  await db.query('DELETE FROM marketing_rate_limits');
  await post('/subscriptions',signup);
  expect((await db.query('SELECT status FROM marketing_subscribers')).rows[0]!.status).toBe('pending');
  expect((await db.query('SELECT * FROM marketing_suppressions')).rows).toHaveLength(1);
  await runOne(m,provider);await post('/subscriptions/confirm',{token:sent.at(-1)!.payload.token});
  expect((await db.query('SELECT * FROM marketing_suppressions')).rows).toHaveLength(0);
 });
 it('rejects expired and concurrent replayed confirmation',async()=>{
  await post('/subscriptions',signup);await runOne(m,provider);
  const token=sent[0]!.payload.token!;
  await db.query("UPDATE marketing_capability_tokens SET expires_at=now()-interval '1 second'");
  expect((await post('/subscriptions/confirm',{token})).statusCode).toBe(410);
  await db.query("UPDATE marketing_capability_tokens SET expires_at=now()+interval '1 day'");
  const responses=await Promise.all([post('/subscriptions/confirm',{token}),post('/subscriptions/confirm',{token})]);
  expect(responses.map(r=>r.statusCode).sort()).toEqual([200,400]);
 });
 it('validates exact enums, consent, unknown fields, plain text and body limits',async()=>{
  for(const change of [{consent:false},{consentVersion:'forged'},{interests:['password-manager']},{interests:['family','family']},{extra:'x'},{email:'bad'}]) expect((await post('/subscriptions',{...signup,...change})).statusCode).toBe(400);
  expect((await post('/subscriptions',{...signup,website:'bot'})).statusCode).toBe(202);
  expect((await db.query('SELECT * FROM marketing_subscribers')).rows).toHaveLength(0);
  expect((await post('/contact',{email:signup.email,category:'general',message:'<script>alert(1)</script>'})).statusCode).toBe(400);
  expect((await post('/contact',{email:signup.email,category:'general',message:'x'.repeat(20000)})).statusCode).toBe(413);
 });
 it('encrypts enquiries and routes references without creating subscriptions',async()=>{
  expect((await post('/contact',{email:signup.email,category:'feedback',message:'Private message contents'})).statusCode).toBe(202);
  expect((await post('/business-inquiries',{name:'Person',workEmail:signup.email,teamSize:'11-50',role:'Operations',contactConsent:true})).statusCode).toBe(202);
  const stored=JSON.stringify((await db.query('SELECT * FROM marketing_contact_requests')).rows);
  expect(stored).not.toContain('Private message');expect(stored).not.toContain(signup.email);
  expect((await db.query('SELECT * FROM marketing_subscribers')).rows).toHaveLength(0);
  await runOne(m,provider);expect(JSON.stringify(sent)).not.toContain(signup.email);
  expect((await exportSubject(m,signup.email)).enquiries).toHaveLength(2);
  await erase(m,signup.email);expect((await exportSubject(m,signup.email)).enquiries).toHaveLength(0);
 });
 it('verifies original webhook bytes, rejects stale signatures, deduplicates and suppresses',async()=>{
  await confirmed();
  const body=JSON.stringify({id:'event-1',messageId:sent[0]!.id,type:'complained',occurredAt:new Date().toISOString()});
  const send=(timestamp:string,sig?:string)=>app.inject({method:'POST',url:p+'/webhooks/email',headers:{host:'localhost:4000','content-type':'application/json','x-webhook-timestamp':timestamp,'x-webhook-signature':sig??createHmac('sha256',c.EMAIL_WEBHOOK_SECRET).update(timestamp+'.'+body).digest('hex')},payload:body});
  const now=String(Math.floor(Date.now()/1000));
  expect((await send(now,'0'.repeat(64))).statusCode).toBe(401);
  expect((await send('1000000000')).statusCode).toBe(401);
  expect((await send(now)).statusCode).toBe(200);expect((await send(now)).statusCode).toBe(200);
  expect((await db.query('SELECT * FROM marketing_email_events')).rows).toHaveLength(1);
  await db.query('DELETE FROM marketing_rate_limits');await post('/subscriptions',signup);
  expect((await db.query('SELECT status FROM marketing_subscribers')).rows[0]!.status).toBe('suppressed');
 });
 it('retries provider failures with the same idempotency key, then dead-letters',async()=>{
  await post('/subscriptions',signup);
  const ids:string[]=[];const failing:EmailProvider={async send(id){ids.push(id);throw new Error('secret@example.com');}};
  for(let i=0;i<5;i++) {await runOne(m,failing);await db.query('UPDATE marketing_email_outbox SET next_attempt=now()');}
  expect(new Set(ids).size).toBe(1);
  const job=(await db.query('SELECT state,last_error_code FROM marketing_email_outbox')).rows[0];
  expect(job).toEqual({state:'dead',last_error_code:'DELIVERY_FAILED'});
 });
 it('enforces host, origin, query secrecy, shared rate limits and safe logs',async()=>{
  expect((await app.inject({url:'/health/live',headers:{host:'evil.test'}})).statusCode).toBe(403);
  expect((await app.inject({url:'/health/live',headers:{host:'localhost:4000',origin:'https://evil.test'}})).statusCode).toBe(403);
  expect((await app.inject({url:p+'/subscriptions/preferences?email=person@example.com',headers:{host:'localhost:4000'}})).statusCode).toBe(400);
  const limited=buildApp({...c,RATE_LIMIT_MAX:1},db);
  await limited.inject({method:'POST',url:p+'/subscriptions',headers:{host:'localhost:4000'},payload:signup});
  expect((await limited.inject({method:'POST',url:p+'/subscriptions',headers:{host:'localhost:4000'},payload:signup})).statusCode).toBe(429);
  await limited.close();
  let logs='';const stream=new Writable({write(chunk,_encoding,cb){logs+=chunk.toString();cb();}});
  const logged=buildApp(c,db,{level:'info',stream});
  await logged.inject({method:'POST',url:p+'/contact',headers:{host:'localhost:4000',authorization:'Bearer private-token'},payload:{email:signup.email,category:'general',message:'very private message'}});
  await logged.close();expect(logs).not.toContain(signup.email);expect(logs).not.toContain('private-token');expect(logs).not.toContain('very private');
 });
 it('purges expired data and keeps minimal suppression',async()=>{
  const {unsubscribe}=await confirmed();await post('/subscriptions/unsubscribe',{token:unsubscribe});
  await db.query("UPDATE marketing_subscribers SET updated_at=now()-interval '31 days'");
  await purge(m);
  expect((await db.query('SELECT * FROM marketing_subscribers')).rows).toHaveLength(0);
  expect((await db.query('SELECT * FROM marketing_suppressions')).rows).toHaveLength(1);
 });
});
