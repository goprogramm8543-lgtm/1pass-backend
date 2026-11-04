import { randomUUID } from 'node:crypto';
import type { Marketing } from '../marketing/service.js';
import { digest } from '../common/security.js';
import { allowance } from '../common/rate-limiting.js';
import type { EmailProvider, Mail } from './provider.js';
interface Job {
  id: string;
  subscriber_id: string | null;
  event_type: string;
  protected_payload: string;
  attempts: number;
}
export async function runOne(
  m: Marketing,
  provider: EmailProvider,
): Promise<boolean> {
  const claim = randomUUID();
  const job = await m.db.transaction(async (tx) => {
    const j = (
      await tx.query<Job>(`SELECT * FROM marketing_email_outbox WHERE
   (state='pending' AND next_attempt<=now()) OR (state='processing' AND lease_until<=now())
   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`)
    ).rows[0];
    if (!j) return null;
    await tx.query(
      "UPDATE marketing_email_outbox SET state='processing',claim_id=$2,lease_until=now()+interval '2 minutes',attempts=attempts+1,updated_at=now() WHERE id=$1",
      [j.id, claim],
    );
    return { ...j, attempts: j.attempts + 1 };
  });
  if (!job) return false;
  try {
    const payload = m.protection.open<Mail>(job.protected_payload);
    let eligible = true;
    if (job.subscriber_id) {
      const s = (
        await m.db.query<{ status: string }>(
          'SELECT status FROM marketing_subscribers WHERE id=$1',
          [job.subscriber_id],
        )
      ).rows[0];
      eligible =
        !!s &&
        s.status ===
          (job.event_type === 'confirmation' ? 'pending' : 'confirmed');
      const token = payload.token ?? payload.preferences;
      if (token)
        eligible =
          eligible &&
          (
            await m.db.query(
              'SELECT id FROM marketing_capability_tokens WHERE token_hash=$1 AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at>now())',
              [digest(token)],
            )
          ).rows.length > 0;
    }
    if (!eligible) {
      await m.db.query(
        "UPDATE marketing_email_outbox SET state='cancelled',protected_payload=NULL,claim_id=NULL WHERE id=$1 AND claim_id=$2",
        [job.id, claim],
      );
      return true;
    }
    if (
      !(await allowance(m.db, 'outbound-global', m.c.EMAIL_HOURLY_LIMIT, 3600))
    ) {
      await m.db.query(
        "UPDATE marketing_email_outbox SET state='pending',attempts=attempts-1,next_attempt=now()+interval '1 hour',claim_id=NULL WHERE id=$1 AND claim_id=$2",
        [job.id, claim],
      );
      return false;
    }
    const stillOwned = await m.db.query(
      "SELECT id FROM marketing_email_outbox WHERE id=$1 AND claim_id=$2 AND state='processing'",
      [job.id, claim],
    );
    if (!stillOwned.rows.length) return true;
    const providerId = await provider.send(job.id, job.event_type, payload);
    await m.db.query(
      "UPDATE marketing_email_outbox SET state='sent',protected_payload=NULL,provider_message_id=$3,claim_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND claim_id=$2",
      [job.id, claim, providerId],
    );
  } catch {
    // Provider errors may contain PII or credentials; persist only our constant code.
    await m.db.query(
      `UPDATE marketing_email_outbox SET state=$3,last_error_code='DELIVERY_FAILED',claim_id=NULL,lease_until=NULL,
   next_attempt=now()+$4*interval '1 second',updated_at=now() WHERE id=$1 AND claim_id=$2`,
      [
        job.id,
        claim,
        job.attempts >= 5 ? 'dead' : 'pending',
        Math.min(3600, 30 * 2 ** job.attempts),
      ],
    );
  }
  return true;
}
