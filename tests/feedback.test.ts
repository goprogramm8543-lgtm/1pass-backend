import { it, expect } from 'vitest';
import { memoryDb, testConfig } from './helpers.js';
import { buildApp } from '../src/app.js';
import { Marketing } from '../src/marketing/service.js';
import {
  purge,
  erase,
  exportSubject,
  reviewFeedback,
} from '../src/marketing/operations.js';
it('feedback validates separate permission, protects content, persists without subscribing, reviews and deletes', async () => {
  const db = await memoryDb(),
    c = testConfig(),
    m = new Marketing(db, c),
    app = buildApp(c, db);
  const post = (payload: object) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/marketing/feedback',
      headers: { host: 'localhost:4000' },
      payload,
    });
  try {
    for (const payload of [
      { category: 'bad' },
      { category: 'notes', description: 'x'.repeat(1001) },
      { category: 'notes', email: 'test@example.com' },
      { category: 'notes', followUp: true },
      { category: 'notes', description: '<script>alert(1)</script>' },
      { category: 'notes', password: 'secret' },
      { category: 'notes', description: '-----BEGIN PRIVATE KEY-----' },
      { category: 'notes', country: 'USA' },
    ])
      expect((await post(payload)).statusCode).toBe(400);
    expect(
      (
        await post({
          category: 'passwords',
          description: 'Finding my accounts',
          website: 'bot',
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (await db.query('SELECT id FROM marketing_feedback')).rows,
    ).toHaveLength(0);
    expect(
      (
        await post({
          category: 'passwords',
          description: 'Finding my accounts',
          segment: 'consumer',
          country: 'IN',
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await post({
          category: 'sharing',
          email: 'TEST@example.com',
          followUp: true,
        })
      ).statusCode,
    ).toBe(202);
    const rows = (
      await db.query('SELECT * FROM marketing_feedback ORDER BY created_at')
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.protected_data).not.toContain('Finding');
    expect(rows[0]!.consented_at).toBeNull();
    expect(rows[1]!.consented_at).toBeTruthy();
    expect(
      (await db.query('SELECT * FROM marketing_subscribers')).rows,
    ).toHaveLength(0);
    expect(
      (await db.query('SELECT * FROM marketing_email_outbox')).rows,
    ).toHaveLength(0);
    expect((await exportSubject(m, 'test@example.com')).enquiries).toHaveLength(
      1,
    );
    await reviewFeedback(m, String(rows[0]!.id), 'reviewed');
    expect(
      (
        await db.query('SELECT status FROM marketing_feedback WHERE id=$1', [
          rows[0]!.id,
        ])
      ).rows[0]!.status,
    ).toBe('reviewed');
    await erase(m, 'test@example.com');
    expect(
      (await db.query('SELECT id FROM marketing_feedback')).rows,
    ).toHaveLength(1);
    await db.query(
      "UPDATE marketing_feedback SET delete_after=now()-interval '1 day'",
    );
    expect((await purge(m)).feedback).toBe(1);
    const throttled = buildApp({ ...c, RATE_LIMIT_MAX: 1 }, db);
    try {
      expect(
        (
          await throttled.inject({
            method: 'POST',
            url: '/api/v1/marketing/feedback',
            headers: { host: 'localhost:4000' },
            payload: { category: 'notes' },
          })
        ).statusCode,
      ).toBe(429);
    } finally {
      await throttled.close();
    }
  } finally {
    await app.close();
    await db.close();
  }
}, 30000);
