import Fastify, { type FastifyServerOptions } from 'fastify';
import { randomUUID,createHmac,timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config/index.js';
import type { Database } from './infrastructure/db/index.js';
import { Marketing } from './modules/marketing/service.js';
import * as schema from './modules/marketing/schemas.js';
import { ApiError } from './common/errors.js';
import { allowance } from './common/rate-limiting.js';
const prefix='/api/v1/marketing';
export function buildApp(c:Config,db:Database,logger?:FastifyServerOptions['logger']) {
 const m=new Marketing(db,c);
 const app=Fastify({logger:logger??{level:c.LOG_LEVEL},disableRequestLogging:true,requestIdHeader:false,genReqId:()=>randomUUID(),trustProxy:false,bodyLimit:16384,requestTimeout:10000});
 // Retain exact webhook bytes. No body, URL, headers or raw errors enter logs.
 app.removeContentTypeParser('application/json');
 app.addContentTypeParser('application/json',{parseAs:'buffer'},(_req,body,done)=>done(null,body));
 app.addHook('onRequest',async(req,reply)=>{
  reply.header('x-request-id',req.id).header('cache-control','no-store').header('referrer-policy','no-referrer').header('x-content-type-options','nosniff').header('content-security-policy',"default-src 'none'; frame-ancestors 'none'");
  const host=new URL(c.PUBLIC_API_ORIGIN).host;
  if(req.headers.host!==host) throw new ApiError(403,'HOST_NOT_ALLOWED');
  const origin=req.headers.origin;
  if(origin) {
   if(!c.CORS_ALLOWED_ORIGINS.split(',').includes(origin)) throw new ApiError(403,'ORIGIN_NOT_ALLOWED');
   reply.header('access-control-allow-origin',origin).header('vary','Origin');
  }
  if(req.method==='OPTIONS') {
   reply.header('access-control-allow-methods','GET,POST,PATCH,OPTIONS').header('access-control-allow-headers','Content-Type,Authorization').code(204).send();return;
  }
  if(req.url.split('?')[0]?.startsWith(prefix)) {
   if(!await allowance(db,`ip:${m.protection.identifier(req.ip)}`,c.RATE_LIMIT_MAX,60)) {
    reply.header('retry-after','60');throw new ApiError(429,'RATE_LIMITED');
   }
  }
 });
 app.addHook('preValidation',async req=>{
  if(req.url.split('?')[0]===`${prefix}/webhooks/email`) return;
  if(Object.keys(req.query as object).length) throw new ApiError(400,'QUERY_NOT_ALLOWED');
  if(req.method==='POST'||req.method==='PATCH') {
   if(!req.headers['content-type']?.match(/^application\/json(?:\s*;.*)?$/i)) throw new ApiError(415,'JSON_REQUIRED');
   try { req.body=JSON.parse((req.body as Buffer).toString('utf8')); } catch { throw new ApiError(400,'INVALID_JSON'); }
  }
 });
 app.addHook('onResponse',async(req,reply)=>{
  app.log.info({requestId:req.id,method:req.method,route:req.routeOptions.url??'unmatched',status:reply.statusCode},'request');
 });
 app.setErrorHandler((error,req,reply)=>{
  if(error instanceof z.ZodError) return reply.code(400).send({success:false,code:'VALIDATION_ERROR',requestId:req.id,fields:Object.fromEntries(error.issues.map(i=>[String(i.path[0]??'body'),'Invalid value']))});
  const e=error as {statusCode?:number;code?:string};
  const status=error instanceof ApiError?error.status:e.statusCode===413?413:e.statusCode===415?415:500;
  const code=error instanceof ApiError?error.code:status===413?'PAYLOAD_TOO_LARGE':status===415?'JSON_REQUIRED':'INTERNAL_ERROR';
  if(status===500) app.log.error({requestId:req.id,code},'request_failed');
  return reply.code(status).send({success:false,code,requestId:req.id});
 });
 app.setNotFoundHandler((_req,reply)=>reply.code(404).send({success:false,code:'NOT_FOUND'}));
 app.get('/health/live',async()=>({status:'ok'}));
 app.get('/health/ready',async(_req,reply)=>{
  try { await db.query('SELECT 1 FROM schema_migrations LIMIT 1');return {status:'ready'}; }
  catch {return reply.code(503).send({status:'unavailable'});}
 });
 app.post(`${prefix}/subscriptions`,async(req,reply)=>reply.code(202).send(await m.subscribe(schema.subscribe.parse(req.body))));
 app.post(`${prefix}/subscriptions/confirm`,async req=>m.confirm(schema.tokenBody.parse(req.body).token));
 app.post(`${prefix}/subscriptions/unsubscribe`,async req=>m.unsubscribe(schema.tokenBody.parse(req.body).token));
 const bearer=(authorization:string|undefined)=>{
  const parsed=schema.capability.safeParse(authorization?.startsWith('Bearer ')?authorization.slice(7):'');
  if(!parsed.success) throw new ApiError(401,'CAPABILITY_REQUIRED'); return parsed.data;
 };
 app.get(`${prefix}/subscriptions/preferences`,async req=>m.preferences(bearer(req.headers.authorization)));
 app.patch(`${prefix}/subscriptions/preferences`,async req=>m.preferences(bearer(req.headers.authorization),schema.preferences.parse(req.body).interests));
 app.post(`${prefix}/subscriptions/preferences/request`,async(req,reply)=>reply.code(202).send(await m.requestPreferences(z.strictObject({email:schema.email,website:z.string().max(256).default('')}).parse(req.body))));
 app.post(`${prefix}/contact`,async(req,reply)=>reply.code(202).send(await m.enquiry('contact',schema.contact.parse(req.body))));
 app.post(`${prefix}/business-inquiries`,{bodyLimit:32768},async(req,reply)=>reply.code(202).send(await m.enquiry('business',schema.business.parse(req.body))));
 app.post(`${prefix}/webhooks/email`,async req=>{
  const timestamp=req.headers['x-webhook-timestamp'],signature=req.headers['x-webhook-signature'];
  if(typeof timestamp!=='string'||!/^\d{10}$/.test(timestamp)||Math.abs(Date.now()/1000-Number(timestamp))>300||typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)||!Buffer.isBuffer(req.body)) throw new ApiError(401,'WEBHOOK_INVALID');
  const expected=createHmac('sha256',c.EMAIL_WEBHOOK_SECRET).update(timestamp+'.').update(req.body).digest();
  if(!timingSafeEqual(expected,Buffer.from(signature,'hex'))) throw new ApiError(401,'WEBHOOK_INVALID');
  let body:unknown;try {body=JSON.parse(req.body.toString('utf8'));} catch {throw new ApiError(400,'INVALID_JSON');}
  return m.emailEvent(schema.webhook.parse(body));
 });
 return app;
}
