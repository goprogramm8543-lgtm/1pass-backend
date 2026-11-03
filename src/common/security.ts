import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import type { Config } from '../config/index.js';
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export class Protection {
 private keys: Record<string,string>;
 constructor(private c: Config) { this.keys = JSON.parse(c.DATA_KEYS); }
 identifier(value: string) { return createHmac('sha256',this.c.SUPPRESSION_HASH_KEY).update(value).digest('hex'); }
 seal(value: unknown): string {
  const iv = randomBytes(12), id = this.c.DATA_ACTIVE_KEY;
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(this.keys[id]!, 'hex'), iv);
  cipher.setAAD(Buffer.from(id));
  const data = Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return [id,iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),data.toString('base64url')].join('.');
 }
 open<T>(sealed: string): T {
  const [id,iv,tag,data] = sealed.split('.');
  if (!id || !iv || !tag || !data || !this.keys[id]) throw new Error('PROTECTED_DATA_INVALID');
  const cipher = createDecipheriv('aes-256-gcm',Buffer.from(this.keys[id]!, 'hex'),Buffer.from(iv,'base64url'));
  cipher.setAAD(Buffer.from(id)); cipher.setAuthTag(Buffer.from(tag,'base64url'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(data,'base64url')),cipher.final()]).toString('utf8')) as T;
 }
}
