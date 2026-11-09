# Operations guide

Consolidated deployment, security, recovery and verification reference. For local setup, start with [README](../README.md).

## Implementation decisions — 2026-11-03

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

November 4 completion: the owner explicitly selected sandbox email. Added a development-only native PostgreSQL test runner to verify real concurrency without Docker; it binds loopback, creates a random isolated database directory, stops the server and removes that directory. PGlite remains the fast default suite; CI uses a PostgreSQL service. Migration checksums normalize CRLF/LF for cross-platform restores. Frontend bindings and all production activation remain outside the sandbox release.

## Configuration and deployment

This release is development/sandbox only, as requested. Production startup is blocked until a reviewed real provider replaces the sandbox implementation. The Docker artifact is suitable for private sandbox evaluation; do not expose it for collection of real public data.

## Runtime components

Run one API process and one or more workers against the same PostgreSQL database and encryption key ring. SQL migrations live in `migrations/`; the migration runner serializes concurrent runs and rejects changed applied files. Use a separate migration role for DDL and a least-privilege runtime role for SELECT/INSERT/UPDATE/DELETE. No migration runs automatically at startup.

Build with `docker build -t 1pass-marketing-backend .`. Supply a protected environment file or secret-manager injection, then run `node dist/db/migrate.js`, `node dist/server.js` and `node dist/worker.js` as separate jobs. The image runs as the unprivileged node user. Mount a restricted shared sandbox-mail volume if multiple sandbox workers are used. Do not mount a production database into sandbox tests.

## Network and secrets

Terminate HTTPS at an approved ingress, preserve the canonical Host, limit request sizes/connections, disable query/body/header logging, and restrict `/health/ready` and operator access. Enable HSTS only after domain readiness. Use exact HTTPS origins for remote staging. The API does not trust forwarded IP headers: apply per-client limits at ingress; the database-backed application limiter sees the ingress IP when proxied. Never enable blanket `trustProxy` on an internet-reachable listener. Configure PostgreSQL with private networking, verified TLS and encrypted storage/backups.

`DATA_KEYS` maps version IDs (`v1`, `v2`, …) to 32-byte hex encryption keys. `DATA_ACTIVE_KEY` selects new writes. Keep old keys readable until all retained rows, sandbox files and restoreable backups are migrated or expired. `SUPPRESSION_HASH_KEY` is a separate stable HMAC key; losing or replacing it loses suppression matching. Do not rotate it by simply overwriting the value: plan a dual-identifier migration before any change. `EMAIL_WEBHOOK_SECRET` authenticates sandbox callback payloads only. Production provider signatures must follow the selected provider's contract.

`TOKEN_HASH_PEPPER` and Redis are intentionally not required. Random 256-bit tokens are SHA-256 hashed; PostgreSQL provides shared rate limits. Encrypted outbox payloads temporarily contain recoverable tokens for retry. Successful/cancelled jobs clear payloads. Retry failures store constant error codes without provider responses.

## Retention and observation

Run `ops purge` daily. Defaults: pending 30 days, enquiries 365, unsubscribed/suppressed subscriber details 30, completed/dead queue records 30, email events 90, audit events 365, sandbox files 7. Expired tokens are deleted after 7 days. Suppression HMACs remain until a reviewed privacy policy says otherwise. These values need company approval before live collection.

Collect structured request route/status/requestId logs without raw URLs, bodies or headers. Poll `ops queue-status`; alert when pending age exceeds 15 minutes, any dead jobs exist, or repeated `WORKER_DATABASE_UNAVAILABLE` appears. Alert on HTTP error/rate-limit spikes, readiness failures, and unusual complaint/bounce counts. Define owners and an external monitor in the chosen hosting platform; no alert integration is falsely claimed here.

Outbox claims use row locking and two-minute leases, with five attempts and bounded exponential backoff. Stable job IDs are provider idempotency keys. A real adapter must enforce a send timeout shorter than the lease and durable idempotency. At-least-once queue execution cannot guarantee exactly-once external delivery without provider support. Once an external send starts, unsubscribe cannot retract that in-flight transactional message. There is no campaign sender.

## CI and release

CI runs type checks, tests (including real PostgreSQL), formatting, contract drift checks, npm audit, CodeQL and Docker build. Branch protection and required checks must be configured in GitHub by the repository owner. Enable GitHub secret scanning/push protection where available; no account setting was changed by this implementation. Review and pin action/image digests during the deployment supply-chain review. Confirm remote CI results, restore drills, ingress behavior and provider delivery in the target environment before release.

## Marketing API threat model

Assets: addresses and consent evidence, private enquiries, scoped email capabilities, encryption/provider keys, suppression state, sender reputation and availability. Boundaries: public browser → API; API/worker → private PostgreSQL; worker → sandbox filesystem (future provider); signed callbacks → API; authorized operators → CLI/backups. Marketing subscriber IDs never identify vault users.

| Threat                       | Implemented control                                                                                               | Residual / release responsibility                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Email enumeration            | Generic signup/management responses; no email lookup GET                                                          | Response timing is not constant; monitor abuse and apply ingress limits                     |
| Token guessing/replay        | 256-bit random values, hash-only capability table, purpose/expiry checks, subscriber locks and atomic consumption | Bearer possession grants limited access; fragment hygiene belongs to the future frontend    |
| Consent forgery/reactivation | Current backend version/hash/time, fresh opt-in + confirmation, persistent suppression                            | Real wording and lawful retention require human approval                                    |
| Spam / mail bombing          | Honeypot, PostgreSQL IP counters, transactional per-email resend limit, hourly send budget, payload limits        | NAT tuning, upstream bot protection and distinct reporting address still required           |
| SQL/XSS/header injection     | Parameterized SQL, strict Zod objects/enums, plain-text fields, reference-only internal notifications             | Any future HTML template/admin UI must escape user text                                     |
| Database theft               | AES-GCM enquiry and queue payloads, hashed tokens, HMAC suppression                                               | Subscriber email is needed operationally; encrypted DB/storage and least privilege required |
| Webhook forgery/replay       | Exact raw bytes + HMAC + 5-minute time window + unique event ID                                                   | Sandbox scheme is not a provider implementation                                             |
| Provider/database outage     | Transactional outbox, leases, bounded retry/dead-letter, generic errors                                           | Monitoring and provider idempotency must be configured externally                           |
| Opt-out violation            | Suppression cancels queued jobs, revokes preferences/confirm tokens, blocks re-import signup                      | Already in-flight transactional messages cannot be recalled; campaigns absent               |
| Logs/analytics leak          | Explicit request metadata only, no raw error logging, no-referrer/no-store, no token query parameters             | Ingress, frontend and third-party telemetry need their own review                           |
| Operator compromise          | No public admin API; local CLI and encrypted payloads                                                             | MFA/SSO, audited host access, exports handling and backup controls belong to deployment     |
| Supply-chain compromise      | Exact versions, lockfile, audit/CodeQL CI, non-root image                                                         | Review dependencies/actions, enable secret scanning and protect release branches            |

Privacy exports decrypt only for an authorized operator; deletion retains a minimal suppression identifier. Disable API writes and workers during a deletion/restore maintenance window to avoid concurrent re-creation. Contact free text can still contain secrets despite validation and warnings; do not claim content inspection can reliably recognize every password. This review is not an independent security audit or an assessment of a future password manager.

## Security and release checklist

Implemented and exercised locally (see QA for exact runs):

- Strict schemas, unknown-field rejection, size caps, exact enums and control/HTML rejection.
- Scoped tokens, atomic confirmation, expiry, fresh consent and suppression handling.
- Encrypted private enquiries/outbox; keyed suppression; key-ring reads across rotation.
- Distributed IP/email limits, honeypot and hourly outbound budget.
- Raw-byte authenticated sandbox webhooks with replay window and event deduplication.
- Retry/dead-letter queue, generic errors, safe logs, exact host/origin policy.
- Migrations, retention/deletion/export commands, OpenAPI and CI configuration.

Required before accepting real public submissions:

- [ ] Real provider adapter, approved templates, routing inboxes and webhook verifier tested.
- [ ] Sending domain, SPF/DKIM/DMARC, monitored security/privacy/business contacts verified.
- [ ] Approved legal/privacy/consent/retention copy and processor/region review.
- [ ] Frontend bindings, fragment handling, truthful UX, CSP and staging E2E signed off.
- [ ] TLS/private PostgreSQL, least-privilege roles, secrets/key rotation and ingress limits.
- [ ] Encrypted backups and successful restore/deletion-replay drill.
- [ ] Operational owners, alerts, queue dashboard/polling and incident escalation configured.
- [ ] Remote CI green, CodeQL/secret/dependency findings reviewed, protected branches.
- [ ] Production configuration guard replaced only with explicit provider/release validation.
- [ ] Explicit deployment approval; public indexing reviewed separately.

## Email/provider outage

1. Check `/health/ready`, API status counts and `npm run ops -- queue-status`. Do not print decrypted outbox payloads or provider exception bodies.
2. Stop the worker if delivery is unsafe. API submissions remain transactional and queue locally while PostgreSQL is available. If PostgreSQL is down, the API must return an error; do not tell visitors their request was saved.
3. Inspect sanitized `last_error_code`, attempt counts and job age using an authorized database session. Jobs retry with exponential backoff; the fifth failure becomes `dead`. An interrupted worker's two-minute lease can be reclaimed with the same job ID.
4. Restore the sandbox directory/key access or, in a later provider integration, provider credentials/connectivity. Preserve idempotency keys and suppression. Never bulk-send directly from tables.
5. For a reviewed dead job, reset `state='pending'`, `attempts=0`, `next_attempt=now()`, `claim_id=NULL`, `lease_until=NULL` by its UUID using a parameterized operator query. Record an audit event/change ticket. Expired capabilities will be cancelled by the worker; request a fresh confirmation or preference link instead.
6. Restart one worker, verify a sandbox test delivery, then restore worker capacity. Confirm backlog drains and dead-letter alerts clear. Review complaint/bounce events before reopening a real provider in a future release.

The sink is local-only; no provider outage, domain authentication, deliverability or real-mail test is claimed by sandbox results.

## Privacy export and deletion

Verify the requestor and scope through an approved channel before running commands. The CLI has privileged access and no public authentication layer: use an MFA/SSO-protected operator host and least privilege. Do not pass addresses directly on command lines.

1. Pause API writes and workers during the maintenance window; otherwise in-flight work can recreate records or sandbox files.
2. Place the normalized subject email in a restricted `subject.txt`, outside tracked source (e.g. `.private-exports`). Export with `npm run ops -- export .private-exports/subject.txt .private-exports/export.json`. The output path must be new. Transfer only through an approved private channel.
3. Delete with `npm run ops -- delete .private-exports/subject.txt`. This removes matching sandbox copies, subscriber/tokens/outbox, matching enquiries and related audit/events, retaining an HMAC suppression with reason `deleted`. Public signup cannot reverse this suppression. No private address is written to the new deletion audit event.
4. Run export again and verify no subject records remain. Remove plaintext exports/subject files according to policy. Encrypted enquiry scanning is deliberate at current low volume; add a separately keyed lookup index if scale requires it.
5. Track the deletion in a restricted deletion ledger outside restored application backups. Apply it after any restore, before restarting workers or API writes. Existing backups cannot be selectively erased by this CLI: restrict backup access and let approved retention expire them, or perform an approved cryptographic deletion strategy.
6. Resume service and record the completion date, systems covered and any policy-approved retention exceptions without copying private message contents.

Schedule `npm run ops -- purge` daily for configured retention, including sandbox files. Future real email providers/CRMs need their own export/deletion procedures. `SUPPRESSION_HASH_KEY` must survive restores; do not drop suppression to make imports succeed.

## Incident response

Assign a security owner and backup before public operation. Use the organization's approved escalation channel; no contact address or response SLA is invented here.

1. Triage affected API/worker/database/provider components and time window using request IDs, status counts and sanitized audit events.
2. Contain: stop workers for suspected sender/key compromise; restrict ingress or stop public writes for database abuse. Preserve minimal evidence with controlled access and timestamps.
3. Revoke exposed credentials at their source. Rotate webhook secrets and invalidate exposed capabilities. Encryption key rotation requires versioned keys and re-encryption/retention planning; suppression-key rotation requires a migration, not replacement.
4. Assess actual access and data exposure. Marketing records can contain personal/sensitive text; do not infer that encryption protected data if application keys were also compromised. Engage the organization's privacy/legal owner for notification requirements.
5. Recover from a verified build/backup, replay suppression and deletion ledgers, run sandbox checks and review queue eligibility before restarting sends.
6. Record root cause, remediation, evidence access, outstanding risks and owner-approved reopening. Never place raw tokens, private messages or addresses in public issues or incident logs.

## Backup and restore drill

Infrastructure owners must configure encrypted PostgreSQL backups and key backups with separate access controls. This repository cannot verify an external backup service.

1. Create a database snapshot or custom-format `pg_dump` using a protected service configuration (avoid credentials in command history). Record schema migration checksums and capture the applicable encryption key versions and suppression key through the secret manager.
2. Restore into an isolated private database with API/worker disabled and no real provider access. Never overwrite production as a test.
3. Apply only unapplied migrations. Verify checksums, row relationships, token-purpose/expiry behavior and decrypt a synthetic enquiry.
4. Replay verified deletions and current suppressions from the external operational ledger before any send capability is enabled. Expired or stale queued confirmations should cancel rather than send.
5. Run health and lifecycle smoke tests against a fake provider. Measure recovery time and recovered data age against company-approved targets.
6. Record results and owner signoff, remove the isolated restore according to policy, and repeat on the approved schedule and after material schema/key changes.

## External dependencies and scope

Owner instruction on November 4, 2026: finish with sandbox email. The sandbox is intentional, not an unconfigured claim of live delivery.

| Dependency                  | Current state                                          | Needed to complete live integration                                                                    |
| --------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Email provider/account      | Encrypted local sink and fake-provider tests           | Select provider; supply credentials through secret manager; implement documented callbacks/idempotency |
| Company identity and domain | Local placeholders                                     | Approved domain, DNS/TLS access, verified From/Reply-To and routing inboxes                            |
| Consent/privacy/retention   | Development wording and configurable proposed defaults | Human approval of wording, versions, purposes, retention and processor arrangements                    |
| Frontend binding            | Existing sample Next.js repo untouched                 | Review documented field mappings and implement adapter/token pages in a separate frontend change       |
| Deployment                  | Docker/Compose/CI supplied                             | Choose host/region, private DB, secrets, ingress and access controls                                   |
| Operations                  | CLI and runbooks supplied                              | Name owners, schedule retention, configure alerts, execute backup/restore drill                        |
| Final verification          | Local checks recorded in QA                            | Run remote CI, staging mailbox tests, frontend accessibility/E2E, manual security/privacy signoff      |

No admin UI, campaign sender, one-click campaign headers, accounts, vault APIs, application downloads or billing are part of this milestone. Standard List-Unsubscribe support belongs to the future provider/campaign implementation; present unsubscribe is an explicit JSON POST capability. No deployment, real email, public form activation or indexing has occurred.

## Verification record

Reviewed November 4, 2026. Scope: standalone sandbox marketing backend. The frontend was not changed.

## Results

- TypeScript strict checking and compiled backend build passed.
- Standard suite: 16 tests passed; the native PostgreSQL-only concurrency test is intentionally skipped without `TEST_DATABASE_URL`.
- Real PostgreSQL 18.6 suite: **17 tests passed across 5 files**, including the HTTP lifecycle suite against the native database. The runner created an isolated schema/database, bound loopback, shut down the server and cleaned its temporary directory.
- Covered consent/duplicate signup, transaction rollback, confirmation replay/expiry, fresh resubscription, scoped preferences, durable opt-out, enquiry encryption/export/deletion, webhook forgery/replay/deduplication, suppression, worker retries/dead-letter/lease recovery, rate limits, safe logs, retention, encryption tamper/key rotation, sandbox idempotency/cleanup and OpenAPI coverage.
- Dependency audit reported **0 vulnerabilities** across installed dependencies, including development tools.
- Common credential-pattern scan found no matches in source/docs/config (excluding dependencies, build output, Git and temporary test data). This is not a substitute for an organization's secret-scanning service.
- `git diff --check` passed. OpenAPI is generated from the runtime Zod input schemas and checked into the repository.

An initial concurrent run of the standard and native suites hit a Windows test setup timeout. Test workers are now limited to two and hook timeout is 30 seconds; the native rerun passed. Production database statement timeouts were not relaxed. The restricted shell also encountered a Windows user-account lookup error in tsx; generation/checks succeeded under the authorized normal-user execution context.

## Not exercised here

Docker image build (Docker is not installed), remote GitHub Actions/CodeQL, hosted infrastructure/alerts, backups and restore drills, real email/provider webhooks, legal approval, or integrated frontend/browser staging E2E. Docker build and real PostgreSQL checks are configured in CI, but no remote run is claimed. Production remains blocked; the owner explicitly selected sandbox delivery.

## Feedback (PL-01 M4)

POST /api/v1/marketing/feedback is independent of subscriptions. Optional contact email requires separate follow-up permission. The encrypted payload stores category/problem/segment/country/email/permission; no raw IP is retained. Existing keyed rate records expire via purge. Status starts new; no public feed or admin endpoint. Feedback does not queue a notification containing private text.

Authorized local operators with DB/decryption access can run `npm run ops -- feedback-export protected-output.json` (first 100 records; exclusive file creation) then `npm run ops -- feedback-review review.json`, where the protected input contains an id and status reviewed/closed. Never commit exports; restrict OS access, verify contact permission before follow-up, and remove exports after review. An email in a feedback record is not marketing consent. Existing export/delete subject-file operations include feedback; anonymous records can be removed by a verified operator using their record ID. `ops purge` removes expired feedback and its audit references. Default FEEDBACK_RETENTION_DAYS=90 requires owner/legal approval before public collection. Stop workers for deletion as in existing runbook.
