import { z } from 'zod';

const settings = z.object({
 NODE_ENV: z.enum(['development','test','production']).default('development'),
 PORT: z.coerce.number().int().min(1).max(65535).default(4000),
 HOST: z.string().default('127.0.0.1'),
 DATABASE_URL: z.string().min(1),
 PUBLIC_API_ORIGIN: z.url().default('http://localhost:4000'),
 MARKETING_SITE_ORIGIN: z.url().default('http://localhost:3000'),
 CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
 EMAIL_PROVIDER: z.literal('sandbox').default('sandbox'),
 EMAIL_WEBHOOK_SECRET: z.string().min(32),
 DATA_KEYS: z.string(), DATA_ACTIVE_KEY: z.string().default('v1'),
 SUPPRESSION_HASH_KEY: z.string().min(32),
 CONSENT_VERSION: z.string().min(1).default('development-marketing-v1'),
 CONSENT_TEXT: z.string().min(1).default('DEVELOPMENT ONLY: receive launch updates.'),
 CONTACT_CONSENT_VERSION: z.string().default('development-research-v1'),
 CONTACT_CONSENT_TEXT: z.string().default('DEVELOPMENT ONLY: contact me about this research.'),
 CONFIRM_TOKEN_TTL_HOURS: z.coerce.number().positive().max(48).default(24),
 PREFERENCES_SESSION_TTL_MINUTES: z.coerce.number().positive().max(60).default(30),
 RESEND_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(900),
 RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
 EMAIL_HOURLY_LIMIT: z.coerce.number().int().positive().default(100),
 PENDING_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
 ENQUIRY_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
 LOG_LEVEL: z.enum(['silent','fatal','error','warn','info','debug']).default('info'),
 SANDBOX_MAIL_DIR: z.string().default('.sandbox-mail'),
});
export type Config = z.infer<typeof settings>;
export function config(env: Record<string,string|undefined> = process.env): Config {
 const c = settings.parse(env);
 let keys: Record<string,string>;
 try { keys = JSON.parse(c.DATA_KEYS); } catch { throw new Error('DATA_KEYS must be a JSON key ring'); }
 if (!keys[c.DATA_ACTIVE_KEY] || Object.values(keys).some(k => !/^[a-f0-9]{64}$/i.test(k))) throw new Error('DATA_KEYS must contain 32-byte hex keys');
 for (const origin of [c.PUBLIC_API_ORIGIN,c.MARKETING_SITE_ORIGIN,...c.CORS_ALLOWED_ORIGINS.split(',')]) {
  if (new URL(origin).origin !== origin) throw new Error('Origins must be exact origins without paths');
 }
 // Live delivery requires an explicitly implemented and reviewed provider adapter.
 if (c.NODE_ENV === 'production') throw new Error('Production is disabled until a real email provider and release gates are implemented');
 return c;
}
