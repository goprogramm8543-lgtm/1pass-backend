import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { stringify } from 'yaml';
import * as s from '../src/marketing/schemas.js';
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const response = (description: string, name: string, example?: unknown) => ({
  description,
  content: {
    'application/json': { schema: ref(name), ...(example ? { example } : {}) },
  },
});
const schemas: Record<string, unknown> = {};
const examples: Record<string, unknown> = {
  Feedback: {
    category: 'passwords',
    description: 'Finding the right account is difficult.',
    followUp: false,
    website: '',
  },
  Subscribe: {
    email: 'person@example.com',
    interests: ['password_manager'],
    consent: true,
    consentVersion: 'development-marketing-v1',
    source: 'homepage',
    website: '',
  },
  Token: { token: 'A'.repeat(43) },
  Preferences: { interests: ['business'] },
  PreferenceRequest: { email: 'person@example.com', website: '' },
  Contact: {
    email: 'person@example.com',
    category: 'general',
    message: 'A question about the planned product.',
    website: '',
  },
  Business: {
    name: 'Example Person',
    workEmail: 'person@example.com',
    teamSize: '11-50',
    contactConsent: true,
    role: 'Operations',
    useCase: 'Research about team workflows.',
    website: '',
  },
  Webhook: {
    id: 'sandbox-event-1',
    messageId: '1f54c859-67ce-4ed7-8d62-320481d3ea1b',
    type: 'delivered',
    occurredAt: '2026-11-04T00:00:00Z',
  },
};
for (const [name, schema] of Object.entries({
  Feedback: s.feedback,
  Subscribe: s.subscribe,
  Token: s.tokenBody,
  Preferences: s.preferences,
  PreferenceRequest: s.preferenceRequest,
  Contact: s.contact,
  Business: s.business,
  Webhook: s.webhook,
})) {
  const json = z.toJSONSchema(schema, { io: 'input' });
  delete json.$schema;
  schemas[name] = json;
}
schemas.Result = {
  type: 'object',
  required: ['success', 'code'],
  properties: {
    success: { const: true },
    code: { type: 'string' },
    message: { type: 'string' },
  },
};
schemas.Error = {
  type: 'object',
  required: ['success', 'code', 'requestId'],
  properties: {
    success: { const: false },
    code: {
      type: 'string',
      enum: [
        'VALIDATION_ERROR',
        'CONSENT_VERSION_INVALID',
        'TOKEN_INVALID',
        'TOKEN_EXPIRED',
        'CAPABILITY_REQUIRED',
        'WEBHOOK_INVALID',
        'RATE_LIMITED',
        'HOST_NOT_ALLOWED',
        'ORIGIN_NOT_ALLOWED',
        'QUERY_NOT_ALLOWED',
        'JSON_REQUIRED',
        'INVALID_JSON',
        'PAYLOAD_TOO_LARGE',
        'INTERNAL_ERROR',
        'NOT_FOUND',
      ],
    },
    requestId: { type: 'string' },
    fields: { type: 'object', additionalProperties: { type: 'string' } },
  },
};
schemas.PreferenceResult = {
  type: 'object',
  required: ['status', 'interests'],
  properties: {
    status: { const: 'confirmed' },
    interests: {
      type: 'array',
      items: { enum: ['password_manager', 'documents', 'family', 'business'] },
    },
  },
};
schemas.Health = {
  type: 'object',
  required: ['status'],
  properties: { status: { enum: ['ok', 'ready', 'unavailable'] } },
};
const paths: Record<string, Record<string, unknown>> = {};
function operation(
  path: string,
  method: string,
  summary: string,
  body: string | undefined,
  status: number,
  result = 'Result',
  secured = false,
) {
  const errors: Record<string, unknown> = {};
  for (const code of [400, 401, 403, 410, 413, 415, 429, 500])
    errors[code] = response(
      code === 429
        ? 'Retry after the Retry-After seconds'
        : 'Stable error code; no private details',
      'Error',
    );
  paths[`/api/v1/marketing${path}`] ??= {};
  const op: Record<string, unknown> = {
    operationId: method + path.replace(/\W+/g, '_'),
    summary,
    security: secured ? [{ PreferencesBearer: [] }] : [],
    ...(body
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: ref(body),
                example: examples[body],
              },
            },
          },
        }
      : {}),
    responses: {
      [status]: response(
        'Successful operation',
        result,
        result === 'PreferenceResult'
          ? { status: 'confirmed', interests: ['business'] }
          : {
              success: true,
              code:
                status === 202
                  ? 'REQUEST_RECEIVED'
                  : path.endsWith('/confirm')
                    ? 'CONFIRMED'
                    : path.endsWith('/unsubscribe')
                      ? 'UNSUBSCRIBED'
                      : 'EVENT_RECEIVED',
              ...(status === 202
                ? {
                    message: path.startsWith('/subscriptions')
                      ? 'If eligible, we will send a confirmation email.'
                      : 'Your request has been received.',
                  }
                : {}),
            },
      ),
      ...errors,
    },
  };
  paths[`/api/v1/marketing${path}`]![method] = op;
  return op;
}
operation(
  '/feedback',
  'post',
  'Independent problem feedback; separate optional contact permission, no subscription.',
  'Feedback',
  202,
);
operation(
  '/subscriptions',
  'post',
  'Request a confirmation. Unknown, confirmed and suppressed addresses get the same response.',
  'Subscribe',
  202,
);
operation(
  '/subscriptions/confirm',
  'post',
  'Consume a single-use confirmation capability.',
  'Token',
  200,
);
operation(
  '/subscriptions/unsubscribe',
  'post',
  'Durable, repeatable opt-out. GET never changes state.',
  'Token',
  200,
);
operation(
  '/subscriptions/preferences',
  'get',
  'Read status and topics using a 30-minute scoped bearer capability.',
  undefined,
  200,
  'PreferenceResult',
  true,
);
operation(
  '/subscriptions/preferences',
  'patch',
  'Replace topics without reactivating consent.',
  'Preferences',
  200,
  'PreferenceResult',
  true,
);
operation(
  '/subscriptions/preferences/request',
  'post',
  'Request a fresh management email without revealing subscription state.',
  'PreferenceRequest',
  202,
);
operation(
  '/contact',
  'post',
  'Store a plain-text enquiry; no promotional opt-in.',
  'Contact',
  202,
);
operation(
  '/business-inquiries',
  'post',
  'Store research follow-up consent separately from marketing.',
  'Business',
  202,
);
const hook = operation(
  '/webhooks/email',
  'post',
  'Sandbox only: verify HMAC-SHA256 over timestamp + dot + exact raw JSON bytes.',
  'Webhook',
  200,
);
hook.parameters = [
  {
    in: 'header',
    name: 'X-Webhook-Timestamp',
    required: true,
    schema: { type: 'string', pattern: '^\\d{10}$' },
    description: 'Unix seconds; maximum clock difference 300 seconds.',
  },
  {
    in: 'header',
    name: 'X-Webhook-Signature',
    required: true,
    schema: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    description:
      'Lowercase hex HMAC using EMAIL_WEBHOOK_SECRET. Event IDs deduplicate retries.',
  },
];
for (const route of ['live', 'ready'])
  paths[`/health/${route}`] = {
    get: {
      operationId: `health_${route}`,
      summary:
        route === 'live'
          ? 'Process liveness'
          : 'Database and migration table readiness; restrict at edge',
      security: [],
      responses: {
        200: response('Healthy', 'Health'),
        ...(route === 'ready'
          ? { 503: response('Unavailable', 'Health') }
          : {}),
      },
    },
  };
await writeFile(
  'docs/openapi.yaml',
  stringify(
    {
      openapi: '3.1.0',
      info: {
        title: '1Pass Marketing API',
        version: '1.0.0',
        description:
          'Development/sandbox contract. Strict JSON objects; unknown properties and query parameters rejected. ASCII email is lowercased without dot/plus rewriting. Plain text only: names reject URLs, HTML and controls; messages reject HTML and non-whitespace controls. Interests must be unique. Current server consent version is required. Form body limit 16 KiB; business 32 KiB. No vault identity or campaign APIs.',
      },
      servers: [
        {
          url: 'http://localhost:4000',
          description: 'Development placeholder',
        },
      ],
      paths,
      components: {
        securitySchemes: {
          PreferencesBearer: {
            type: 'http',
            scheme: 'bearer',
            description:
              'Bounded marketing preferences capability; never a vault/account credential.',
          },
        },
        schemas,
      },
    },
    { lineWidth: 100 },
  ),
);
