import { z } from 'zod';
const label = (max: number) => z.string().trim().min(1).max(max).refine(v => !/[\x00-\x1f\x7f<>]|https?:\/\/|www\./i.test(v),'Use plain text without URLs or control characters');
const message = (max: number) => z.string().trim().max(max).refine(v => !/[<>\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v),'Use plain text');
// No provider-specific dot/plus rewriting. ASCII email is an explicit v1 limitation.
export const email = z.email().max(254).regex(/^[\x21-\x7e]+$/).transform(v => v.toLowerCase());
export const interests = z.array(z.enum(['password_manager','documents','family','business'])).min(1).max(4).refine(v => new Set(v).size === v.length,'Interests must be unique');
const website = z.string().max(256).default('');
export const subscribe = z.strictObject({email,interests,consent:z.literal(true),consentVersion:label(100),source:z.string().max(100).regex(/^[a-zA-Z0-9/_-]+$/).default('homepage'),website});
export const capability = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const tokenBody = z.strictObject({token:capability});
export const preferences = z.strictObject({interests});
export const contact = z.strictObject({name:label(120).optional(),email,category:z.enum(['general','business','security','privacy','feedback']),subject:label(200).optional(),message:message(3000).refine(v=>v.length>=10,'Use at least 10 characters'),website});
export const business = z.strictObject({name:label(120),workEmail:email,company:label(160).optional(),teamSize:z.enum(['1-10','11-50','51-250','251+']),useCase:message(2000).default(''),role:label(120).optional(),approach:z.enum(['Shared spreadsheet or document','Passwords saved in browsers','A team password manager','Single sign-on or an identity provider','Not sure, or something else']).optional(),contactConsent:z.literal(true),website});
export const webhook = z.strictObject({id:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),messageId:z.uuid(),type:z.enum(['delivered','bounced','complained','suppressed']),occurredAt:z.iso.datetime()});
