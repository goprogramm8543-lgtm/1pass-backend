import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { Protection } from '../common/security.js';
export interface Mail {
  to?: string;
  token?: string;
  unsubscribe?: string;
  preferences?: string;
  id?: string;
  kind?: string;
  category?: string;
}
export interface EmailProvider {
  send(id: string, event: string, payload: Mail): Promise<string>;
}
export class SandboxProvider implements EmailProvider {
  constructor(
    private c: Config,
    private protection: Protection,
  ) {}
  async send(id: string, event: string, payload: Mail) {
    await mkdir(this.c.SANDBOX_MAIL_DIR, { recursive: true });
    const base = this.c.MARKETING_SITE_ORIGIN;
    const links = {
      ...(payload.token
        ? { confirm: `${base}/launch/confirm#token=${payload.token}` }
        : {}),
      ...(payload.unsubscribe
        ? {
            unsubscribe: `${base}/launch/unsubscribe#token=${payload.unsubscribe}`,
          }
        : {}),
      ...(payload.preferences
        ? {
            preferences: `${base}/launch/preferences#token=${payload.preferences}`,
          }
        : {}),
    };
    // Exclusive creation gives the local sink stable, durable idempotency.
    try {
      await writeFile(
        join(this.c.SANDBOX_MAIL_DIR, `${id}.mail`),
        this.protection.seal({
          id,
          event,
          templateVersion: 'v1',
          ...payload,
          links,
        }),
        { flag: 'wx', mode: 0o600 },
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    return id;
  }
}
