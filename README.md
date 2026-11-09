# 1Pass marketing backend

Fastify + TypeScript + PostgreSQL for subscriptions, confirmation, preferences, unsubscribe and enquiries. Email is currently sandbox-only: encrypted messages are saved locally instead of sent. The frontend is not connected yet. No account or password-vault APIs are included.

## Local setup — no Docker required

1. Use Node 24.19.0, npm 11.17.0 and a running PostgreSQL server. Create a dedicated database such as `marketing` in pgAdmin. The API connects to PostgreSQL, not to pgAdmin.
2. Run `npm ci`. Copy `.env.example` to `.env` and set `DATABASE_URL` with your database details. URL-encode special characters in credentials.
3. Generate three separate random values with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Use them for the key in `DATA_KEYS`, `SUPPRESSION_HASH_KEY` and `EMAIL_WEBHOOK_SECRET`. Keep `.env` private.
4. Run:

```sh
npm run migrate
npm run dev
# In another terminal:
npm run worker
```

Commands load `.env` automatically. The API defaults to `http://localhost:4000`; check `/health/live` and `/health/ready`. The allowed frontend origin defaults to `http://localhost:3000`. Use `localhost`, not `127.0.0.1`, unless you change `PUBLIC_API_ORIGIN`. Advanced settings have defaults in `src/config.ts`.

## Folder guide

```text
src/
  app.ts, server.ts  API routes and startup
  config.ts         Environment settings
  worker.ts         Email queue worker
  ops.ts            Operator commands
  common/           Errors, encryption and rate limits
  db/               PostgreSQL connection and migration runner
  email/            Sandbox adapter, queue and cleanup
  marketing/        Validation and marketing workflows
migrations/         Database schema
tests/             Automated checks (not shipped in Docker runtime)
scripts/            Documentation generator and local database test runner
docs/               API contract, integration and operations guides
```

## Useful commands

| Command                               | Purpose                                |
| ------------------------------------- | -------------------------------------- |
| `npm run check`                       | Type-check, test and compile           |
| `npm run lint`                        | Type and formatting checks             |
| `npm run build` then `npm start`      | Run compiled API                       |
| `node --env-file=.env dist/worker.js` | Run compiled worker                    |
| `npm run test:postgres:local`         | Test against temporary real PostgreSQL |
| `npm run docs`                        | Regenerate OpenAPI                     |
| `npm run ops -- queue-status`         | Inspect email queue                    |
| `npm run ops -- purge`                | Apply configured retention             |

## Docker and deployment

### Development, production and database scripts

| Command                               | Purpose                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `npm run dev` / `npm run start:dev`   | Development API with automatic restart                                                         |
| `npm run worker:dev`                  | Development worker with automatic restart                                                      |
| `npm run build`                       | Compile TypeScript before running compiled commands                                            |
| `npm start`                           | Run compiled API using the configured environment (sandbox supported)                          |
| `npm run prod` / `npm run start:prod` | Run compiled API with `NODE_ENV=production`                                                    |
| `npm run worker:prod`                 | Run compiled worker with `NODE_ENV=production`                                                 |
| `npm run db:migrate`                  | Apply SQL migrations using the source runner                                                   |
| `npm run db:status`                   | Read applied/pending migrations without changing the database; exits nonzero for pending/drift |
| `npm run db:deploy`                   | Apply migrations using the compiled runner, without development dependencies                   |
| `npm run generate:api`                | Generate the OpenAPI contract                                                                  |

This project uses `pg` and SQL migrations, not Prisma: there is no Prisma schema or client to generate. Production API/worker commands deliberately retain the existing production guard and will fail until real email support is implemented. Use `npm start` for compiled local sandbox testing. Database commands still require valid PostgreSQL credentials.

`Dockerfile` compiles the source and packages runtime dependencies, compiled code and migrations. It starts the API as a non-root user on port 4000. Run the email worker separately using the same image with `node dist/worker.js` as its command. The migration job uses `node dist/db/migrate.js`.

`compose.yaml` currently starts only development PostgreSQL, with persistent storage and a health check: `docker compose up -d db`. Skip this when using your existing local database. A complete API/worker Compose deployment has not been added.

Direct Node.js and Docker deployment are both supported approaches. Production startup is blocked while email remains sandbox-only. Real email needs a provider adapter, credentials and verified domain; environment values alone cannot enable it yet.

- [API contract](docs/openapi.yaml): endpoints and payloads.
- [Frontend integration](docs/integration.md): form mappings, token handling and error states.
- [Operations](docs/operations.md): sandbox testing, deployment, privacy, recovery and release requirements.

## PL-01 local integration

The sibling Next.js frontend now supports explicitly enabled loopback marketing submissions and private token action pages. Independent `POST /api/v1/marketing/feedback` is included in OpenAPI and migration 003. `node --import tsx scripts/browser-qa.mjs` runs the actual browser/API/temp-PostgreSQL flow, captures only local encrypted mail and cleans up afterward. Ports 3100/4100 must be free; requires the sibling frontend dependencies and Edge on Windows. `npm run ops -- metrics` reports non-PII aggregate counts; private feedback review/export commands are documented in docs/operations.md. Production startup remains disabled pending a live provider and release approvals.
