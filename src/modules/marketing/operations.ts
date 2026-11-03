import { randomUUID } from 'node:crypto';
import type { Marketing, Subscriber } from './service.js';
import { audit } from './service.js';
export async function purge(m:Marketing) {
 return m.db.transaction(async tx=>{
  // Expired enquiry payloads and corresponding pending/dead notifications disappear together.
  await tx.query(`DELETE FROM marketing_email_outbox WHERE related_id IN
   (SELECT id FROM marketing_contact_requests WHERE delete_after<=now() UNION SELECT id FROM marketing_business_inquiries WHERE delete_after<=now())`);
  const contacts=await tx.query('DELETE FROM marketing_contact_requests WHERE delete_after<=now() RETURNING id');
  const business=await tx.query('DELETE FROM marketing_business_inquiries WHERE delete_after<=now() RETURNING id');
  const pending=await tx.query("DELETE FROM marketing_subscribers WHERE status='pending' AND updated_at<now()-$1*interval '1 day' RETURNING id",[m.c.PENDING_RETENTION_DAYS]);
  // Reduce opt-outs to a keyed suppression identifier after the grace period.
  const optedOut=await tx.query("DELETE FROM marketing_subscribers WHERE status IN ('unsubscribed','suppressed') AND updated_at<now()-interval '30 days' RETURNING id");
  await tx.query("DELETE FROM marketing_capability_tokens WHERE expires_at<now()-interval '7 days'");
  await tx.query("DELETE FROM marketing_email_outbox WHERE updated_at<now()-interval '30 days' AND state IN ('sent','cancelled','dead')");
  await tx.query("DELETE FROM marketing_email_events WHERE received_at<now()-interval '90 days'");
  await tx.query("DELETE FROM marketing_audit_events WHERE created_at<now()-interval '365 days'");
  await tx.query('DELETE FROM marketing_rate_limits WHERE reset_at<now()');
  const counts={contacts:contacts.rows.length,business:business.rows.length,pending:pending.rows.length,optedOut:optedOut.rows.length};
  await audit(tx,'retention_purge',randomUUID(),counts); return counts;
 });
}
export async function erase(m:Marketing,email:string) {
 return m.db.transaction(async tx=>{
  const s=(await tx.query<Subscriber>('SELECT * FROM marketing_subscribers WHERE email_normalized=$1 FOR UPDATE',[email])).rows[0];
  await tx.query("INSERT INTO marketing_suppressions(email_hash,reason) VALUES($1,'deleted') ON CONFLICT(email_hash) DO UPDATE SET reason='deleted'",[m.protection.identifier(email)]);
  if(s) {
   await tx.query('DELETE FROM marketing_email_events WHERE message_id IN (SELECT id::text FROM marketing_email_outbox WHERE subscriber_id=$1)',[s.id]);
   await tx.query('DELETE FROM marketing_audit_events WHERE target_id=$1',[s.id]);
   await tx.query('DELETE FROM marketing_subscribers WHERE id=$1',[s.id]);
  }
  for(const table of ['marketing_contact_requests','marketing_business_inquiries']) {
   const rows=(await tx.query<{id:string;protected_data:string}>(`SELECT id,protected_data FROM ${table} FOR UPDATE`)).rows;
   for(const row of rows) {
    const data=m.protection.open<{email?:string;workEmail?:string}>(row.protected_data);
    if((data.email??data.workEmail)===email) {
     await tx.query('DELETE FROM marketing_email_outbox WHERE related_id=$1',[row.id]);
     await tx.query('DELETE FROM marketing_audit_events WHERE target_id=$1',[row.id]);
     await tx.query(`DELETE FROM ${table} WHERE id=$1`,[row.id]);
    }
   }
  }
  await audit(tx,'privacy_deletion',randomUUID());
 });
}
export async function exportSubject(m:Marketing,email:string) {
 const subscriber=(await m.db.query('SELECT * FROM marketing_subscribers WHERE email_normalized=$1',[email])).rows[0]??null;
 const enquiries:unknown[]=[];
 for(const table of ['marketing_contact_requests','marketing_business_inquiries']) {
  for(const row of (await m.db.query<{id:string;protected_data:string;created_at:Date}>(`SELECT id,protected_data,created_at FROM ${table}`)).rows) {
   const data=m.protection.open<{email?:string;workEmail?:string}>(row.protected_data);
   if((data.email??data.workEmail)===email) enquiries.push({id:row.id,createdAt:row.created_at,...data});
  }
 }
 const interests=subscriber?(await m.db.query('SELECT interest,chosen_at FROM marketing_subscriber_interests WHERE subscriber_id=$1',[subscriber.id])).rows:[];
 const consentEvents=subscriber?(await m.db.query('SELECT operation,metadata,created_at FROM marketing_audit_events WHERE target_id=$1',[subscriber.id])).rows:[];
 return {subscriber,interests,consentEvents,enquiries};
}
