import { it,expect } from 'vitest';
import { newToken,digest,Protection } from '../src/common/security.js';
import { config } from '../src/config/index.js';
import { testConfig } from './helpers.js';
it('generates 256-bit capabilities and detects encrypted payload tampering',()=>{
 const tokens=Array.from({length:1000},newToken);
 expect(new Set(tokens).size).toBe(1000);expect(tokens.every(t=>Buffer.from(t,'base64url').length===32)).toBe(true);
 const protection=new Protection(testConfig()),sealed=protection.seal({secret:'private'});
 expect(sealed).not.toContain('private');expect(protection.open(sealed)).toEqual({secret:'private'});
 const parts=sealed.split('.');parts[2]=Buffer.alloc(16).toString('base64url');
 expect(()=>protection.open(parts.join('.'))).toThrow();
 expect(digest(tokens[0]!)).not.toBe(tokens[0]);
});
it('supports reading old encryption keys after rotation and rejects premature production',()=>{
 const c=testConfig(),old=new Protection(c).seal({value:1});
 const rotated=new Protection({...c,DATA_KEYS:JSON.stringify({v1:'ab'.repeat(32),v2:'cd'.repeat(32)}),DATA_ACTIVE_KEY:'v2'});
 expect(rotated.open(old)).toEqual({value:1});expect(rotated.seal({value:2})).toMatch(/^v2\./);
 expect(()=>config({...c,NODE_ENV:'production'} as unknown as Record<string,string>)).toThrow('Production is disabled');
});
