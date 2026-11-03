import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Database, Sql } from '../../infrastructure/db/index.js';
import type { Config } from '../../config/index.js';
import { digest,newToken,Protection } from '../../common/security.js';
import { ApiError } from '../../common/errors.js';
import { allowance } from '../../common/rate-limiting.js';
import * as schemas from './schemas.js';
export interface Subscriber { id:string; email_normalized:string; status:string }
interface Capability { id:string; subscriber_id:string; expires_at:Date|null; consumed_at:Date|null }
export const accepted = {success:true,code:'REQUEST_RECEIVED',message:'If eligible, we will send a confirmation email.'};
export const received = {success:true,code:'REQUEST_RECEIVED',message:'Your request has been received.'};
export async function audit(tx:Sql,operation:string,id:string,metadata:unknown={}) {
 await tx.query('INSERT INTO marketing_audit_events(id,operation,target_id,metadata) VALUES($1,$2,$3,$4)',[randomUUID(),operation,id,JSON.stringify(metadata)]);
}
export class Marketing {
 readonly protection:Protection;
 constructor(readonly db:Database,readonly c:Config) { this.protection=new Protection(c); }
 async queue(tx:Sql,event:string,id:string,subscriber:string|null,payload:unknown) {
  await tx.query('INSERT INTO marketing_email_outbox(id,event_type,related_id,subscriber_id,protected_payload) VALUES($1,$2,$3,$4,$5)',[randomUUID(),event,id,subscriber,this.protection.seal(payload)]);
 }
 async issue(tx:Sql,id:string,purpose:string,minutes:number|null) {
  const token=newToken();
  await tx.query("INSERT INTO marketing_capability_tokens(id,subscriber_id,purpose,token_hash,expires_at) VALUES($1,$2,$3,$4,CASE WHEN $5::double precision IS NULL THEN NULL ELSE now()+$5*interval '1 minute' END)",[randomUUID(),id,purpose,digest(token),minutes]);
  return token;
 }
 async topics(tx:Sql,id:string,values:string[]) {
  await tx.query('DELETE FROM marketing_subscriber_interests WHERE subscriber_id=$1',[id]);
  for(const value of values) await tx.query('INSERT INTO marketing_subscriber_interests(subscriber_id,interest) VALUES($1,$2)',[id,value]);
 }
 async subscribe(input:z.infer<typeof schemas.subscribe>) {
  if(input.consentVersion!==this.c.CONSENT_VERSION) throw new ApiError(400,'CONSENT_VERSION_INVALID');
  if(input.website) return accepted;
  if(!await allowance(this.db,`email:${this.protection.identifier(input.email)}`,1,this.c.RESEND_INTERVAL_SECONDS)) return accepted;
  await this.db.transaction(async tx=>{
   const suppression=(await tx.query<{reason:string}>('SELECT reason FROM marketing_suppressions WHERE email_hash=$1',[this.protection.identifier(input.email)])).rows[0];
   if(suppression && suppression.reason!=='unsubscribe') return;
   const id=randomUUID();
   await tx.query(`INSERT INTO marketing_subscribers(id,email_normalized,status,consent_version,consent_text_hash,consented_at,source)
    VALUES($1,$2,'pending',$3,$4,now(),$5) ON CONFLICT(email_normalized) DO NOTHING`,[id,input.email,this.c.CONSENT_VERSION,digest(this.c.CONSENT_TEXT),input.source]);
   const s=(await tx.query<Subscriber>('SELECT * FROM marketing_subscribers WHERE email_normalized=$1 FOR UPDATE',[input.email])).rows[0]!;
   if(s.status==='confirmed'||s.status==='suppressed') return;
   await tx.query("UPDATE marketing_subscribers SET status='pending',consent_version=$2,consent_text_hash=$3,consented_at=now(),source=$4,updated_at=now() WHERE id=$1",[s.id,this.c.CONSENT_VERSION,digest(this.c.CONSENT_TEXT),input.source]);
   await tx.query("UPDATE marketing_capability_tokens SET consumed_at=now() WHERE subscriber_id=$1 AND purpose IN ('confirm','preferences') AND consumed_at IS NULL",[s.id]);
   await tx.query("UPDATE marketing_email_outbox SET state='cancelled',protected_payload=NULL WHERE subscriber_id=$1 AND state='pending'",[s.id]);
   await this.topics(tx,s.id,input.interests);
   const token=await this.issue(tx,s.id,'confirm',this.c.CONFIRM_TOKEN_TTL_HOURS*60);
   await this.queue(tx,'confirmation',s.id,s.id,{to:input.email,token});
   await audit(tx,'consent_recorded',s.id,{version:this.c.CONSENT_VERSION,textHash:digest(this.c.CONSENT_TEXT),purpose:'marketing',source:input.source});
  });
  return accepted;
 }
 private async authorize(tx:Sql,token:string,purpose:string) {
  const t=(await tx.query<Capability>('SELECT * FROM marketing_capability_tokens WHERE token_hash=$1 AND purpose=$2',[digest(token),purpose])).rows[0];
  if(!t) throw new ApiError(400,'TOKEN_INVALID');
  const s=(await tx.query<Subscriber>('SELECT * FROM marketing_subscribers WHERE id=$1 FOR UPDATE',[t.subscriber_id])).rows[0];
  const current=(await tx.query<Capability>('SELECT * FROM marketing_capability_tokens WHERE id=$1 FOR UPDATE',[t.id])).rows[0];
  if(!s||!current||current.consumed_at) throw new ApiError(400,'TOKEN_INVALID');
  if(current.expires_at && new Date(current.expires_at).getTime()<=Date.now()) throw new ApiError(410,'TOKEN_EXPIRED');
  return {s,t:current};
 }
 async confirm(token:string) {
  await this.db.transaction(async tx=>{
   const {s,t}=await this.authorize(tx,token,'confirm');
   if(s.status!=='pending') throw new ApiError(400,'TOKEN_INVALID');
   const h=this.protection.identifier(s.email_normalized);
   const suppression=(await tx.query<{reason:string}>('SELECT reason FROM marketing_suppressions WHERE email_hash=$1',[h])).rows[0];
   if(suppression && suppression.reason!=='unsubscribe') throw new ApiError(400,'TOKEN_INVALID');
   await tx.query('UPDATE marketing_capability_tokens SET consumed_at=now() WHERE id=$1',[t.id]);
   await tx.query("DELETE FROM marketing_suppressions WHERE email_hash=$1 AND reason='unsubscribe'",[h]);
   await tx.query("UPDATE marketing_subscribers SET status='confirmed',confirmed_at=now(),unsubscribed_at=NULL,updated_at=now() WHERE id=$1",[s.id]);
   const unsubscribe=await this.issue(tx,s.id,'unsubscribe',null);
   const preferences=await this.issue(tx,s.id,'preferences',this.c.PREFERENCES_SESSION_TTL_MINUTES);
   await this.queue(tx,'management',s.id,s.id,{to:s.email_normalized,unsubscribe,preferences});
   await audit(tx,'confirmed',s.id);
  });
  return {success:true,code:'CONFIRMED'};
 }
 async suppress(tx:Sql,s:Subscriber,reason:string) {
  await tx.query(`INSERT INTO marketing_suppressions(email_hash,reason) VALUES($1,$2) ON CONFLICT(email_hash) DO UPDATE
   SET reason=CASE WHEN marketing_suppressions.reason='unsubscribe' THEN excluded.reason ELSE marketing_suppressions.reason END`,[this.protection.identifier(s.email_normalized),reason]);
  await tx.query("UPDATE marketing_subscribers SET status=$2,unsubscribed_at=now(),updated_at=now() WHERE id=$1",[s.id,reason==='unsubscribe' && s.status!=='suppressed'?'unsubscribed':'suppressed']);
  await tx.query("UPDATE marketing_capability_tokens SET consumed_at=now() WHERE subscriber_id=$1 AND purpose!='unsubscribe' AND consumed_at IS NULL",[s.id]);
  await tx.query("UPDATE marketing_email_outbox SET state='cancelled',protected_payload=NULL,claim_id=NULL WHERE subscriber_id=$1 AND state IN ('pending','processing')",[s.id]);
  await audit(tx,reason,s.id);
 }
 async unsubscribe(token:string) {
  await this.db.transaction(async tx=>{const {s}=await this.authorize(tx,token,'unsubscribe');await this.suppress(tx,s,'unsubscribe');});
  return {success:true,code:'UNSUBSCRIBED'};
 }
 async preferences(token:string,values?:string[]) {
  return this.db.transaction(async tx=>{
   const {s}=await this.authorize(tx,token,'preferences');
   if(s.status!=='confirmed') throw new ApiError(400,'TOKEN_INVALID');
   if(values) { await this.topics(tx,s.id,values); await audit(tx,'preferences_updated',s.id); }
   const topics=(await tx.query<{interest:string}>('SELECT interest FROM marketing_subscriber_interests WHERE subscriber_id=$1 ORDER BY interest',[s.id])).rows;
   return {status:s.status,interests:topics.map(v=>v.interest)};
  });
 }
 async requestPreferences(input:{email:string;website:string}) {
  if(input.website || !await allowance(this.db,`preferences:${this.protection.identifier(input.email)}`,1,this.c.RESEND_INTERVAL_SECONDS)) return accepted;
  await this.db.transaction(async tx=>{
   const s=(await tx.query<Subscriber>('SELECT * FROM marketing_subscribers WHERE email_normalized=$1 FOR UPDATE',[input.email])).rows[0];
   if(!s||s.status!=='confirmed') return;
   await tx.query("UPDATE marketing_capability_tokens SET consumed_at=now() WHERE subscriber_id=$1 AND purpose='preferences' AND consumed_at IS NULL",[s.id]);
   const preferences=await this.issue(tx,s.id,'preferences',this.c.PREFERENCES_SESSION_TTL_MINUTES);
   const unsubscribe=await this.issue(tx,s.id,'unsubscribe',null);
   await this.queue(tx,'management',s.id,s.id,{to:s.email_normalized,preferences,unsubscribe});
  });
  return accepted;
 }
 async enquiry(kind:'contact'|'business',input:z.infer<typeof schemas.contact>|z.infer<typeof schemas.business>) {
  if(input.website) return received;
  await this.db.transaction(async tx=>{
   const id=randomUUID(),{website:_,...data}=input;
   if(kind==='contact') await tx.query("INSERT INTO marketing_contact_requests(id,category,protected_data,delete_after) VALUES($1,$2,$3,now()+$4*interval '1 day')",[id,(input as z.infer<typeof schemas.contact>).category,this.protection.seal(data),this.c.ENQUIRY_RETENTION_DAYS]);
   else await tx.query("INSERT INTO marketing_business_inquiries(id,protected_data,consent_version,consent_text_hash,delete_after) VALUES($1,$2,$3,$4,now()+$5*interval '1 day')",[id,this.protection.seal(data),this.c.CONTACT_CONSENT_VERSION,digest(this.c.CONTACT_CONSENT_TEXT),this.c.ENQUIRY_RETENTION_DAYS]);
   // Internal notification contains a reference, never the private message or sender address.
   await this.queue(tx,'enquiry',id,null,{id,kind,category:kind==='contact'?(input as z.infer<typeof schemas.contact>).category:'business'});
   await audit(tx,`${kind}_received`,id);
  });
  return received;
 }
 async emailEvent(event:z.infer<typeof schemas.webhook>) {
  await this.db.transaction(async tx=>{
   const inserted=await tx.query('INSERT INTO marketing_email_events(id,provider,provider_event_id,message_id,event_type,occurred_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(provider,provider_event_id) DO NOTHING RETURNING id',[randomUUID(),'sandbox',event.id,event.messageId,event.type,event.occurredAt]);
   if(!inserted.rows.length||event.type==='delivered') return;
   const s=(await tx.query<Subscriber>('SELECT s.* FROM marketing_subscribers s JOIN marketing_email_outbox o ON o.subscriber_id=s.id WHERE o.id=$1 FOR UPDATE OF s',[event.messageId])).rows[0];
   if(s) await this.suppress(tx,s,event.type);
  });
  return {success:true,code:'EVENT_RECEIVED'};
 }
}
