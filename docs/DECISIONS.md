# Implementation decisions — 2026-11-03

Scope: standalone marketing API only. No frontend edits, public deployment, vault identity or campaign sender.

Fastify with Zod, PostgreSQL and parameterized SQL through node-postgres. SQL migrations replace the proposed Prisma tooling: explicit transactions, row locks and queue claiming are central here, and this empty repository has no ORM to preserve. PostgreSQL also holds distributed fixed-window rate limits, avoiding a second mandatory datastore. Node and npm match the installed versions and are pinned.

Provider selection remains an owner decision. Only a sandbox adapter is enabled; it writes encrypted messages locally, never sends externally. Signed sandbox webhooks exercise raw-body authentication, replay prevention and suppression. They are NOT a claim of compatibility with any real provider. A production adapter, signature verifier and idempotency guarantee must be reviewed together.

Frontend inspection: `../1pass/src/components/forms/{sample-form,research-form}.tsx`, `src/lib/forms.ts`, `src/lib/analytics.ts`, and `docs/website/{COMPLETION,DECISIONS,QA}.md`.

Contract reconciliation (review before binding frontend):
- Map the frontend's single `interest=password-manager` to `interests=["password_manager"]`. Other interest values are unchanged.
- Contact has no name or subject: both are optional here. Preserve `feedback` as a fifth category because the existing product feedback UI uses it. No marketing consent is created by contact.
- Research maps `email` to `workEmail`, `size` to `teamSize`, `message` to optional `useCase`, and `followUp` to `contactConsent`. Preserve optional `role` and `approach`; company is optional, since the UI does not collect it. Team sizes match the UI exactly.
- The sample-mode acknowledgment checkbox is not approved live consent. Supply approved versions/text and replace disclosures in a separately authorized frontend integration.

Preferences use a bounded 30-minute bearer capability delivered only in a URL fragment, stored in memory by the frontend, and sent via Authorization. No query tokens, cookies, localStorage, analytics or Referer transmission. Confirmation delivers a separate management message with preference and durable unsubscribe capabilities. Preferences cannot reactivate an unsubscribed subscriber. Fresh signup and confirmation are required; bounce/complaint suppression cannot be cleared this way.

Token tables contain SHA-256 hashes of random 256-bit capabilities, without a pepper (entropy makes offline guessing infeasible). Outbox capability payloads must be recoverable for retries, so they are AES-256-GCM encrypted with a versioned key, never plaintext. Contact data is similarly encrypted. Suppression uses a separate keyed HMAC of normalized email, with a stable key and documented rotation procedure. Do not lose these keys.

Reference: [Fastify server options](https://fastify.dev/docs/latest/Reference/Server/) and [PostgreSQL row locking / SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html).
