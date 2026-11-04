# Marketing frontend handoff

No frontend files were changed. `NEXT_PUBLIC_MARKETING_API_BASE_URL` is the backend origin, e.g. `http://localhost:4000`; append `/api/v1/marketing`. No secret belongs in a public environment variable. Publish the contract in `openapi.yaml` before binding the sample forms.

## Existing form mapping

| Existing form field                             | API field / behavior                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| Launch `email`                                  | `email`, ASCII syntax, lowercased; no provider-specific rewriting                       |
| Launch `interest`                               | Single value becomes `interests: [value]`; map `password-manager` to `password_manager` |
| Launch `consent`                                | Must be true; replace the sample acknowledgment with approved live consent first        |
| Launch page                                     | Sanitized `source` ID or path; server records approved consent version/hash and time    |
| `website`                                       | Send honeypot; filled values receive generic success without persistence                |
| Contact `interest`                              | `category`; general, business, security, privacy, feedback                              |
| Contact `message`                               | 10–3,000 plain-text characters; `name` and `subject` optional                           |
| Contact sample consent                          | Not marketing consent; do not send this unknown field                                   |
| Research `email`, `size`, `message`, `followUp` | `workEmail`, `teamSize`, `useCase`, `contactConsent`                                    |
| Research `name`, `role`, `approach`             | Same names; role/approach optional on backend                                           |
| Research company                                | Optional `company`; existing form does not collect it                                   |

Research sizes: `1-10`, `11-50`, `51-250`, `251+`. Use-case is optional, at most 2,000 characters. Follow-up consent never creates a marketing subscription. Keep the visible warning not to paste credentials, recovery codes or customer data. Security reports also need a separate monitored reporting channel before launch.

## Requests and responses

All form POSTs require JSON, reject unknown properties, and return 202 on accepted submissions. Subscription and management-link requests return `{success:true,code:"REQUEST_RECEIVED",message:"If eligible, we will send a confirmation email."}` regardless of subscription existence. Enquiries return the same code with `Your request has been received.` Do not claim that an email has already been sent or promise a response SLA.

| Endpoint suffix                      | Method | Input / success                                                   |
| ------------------------------------ | ------ | ----------------------------------------------------------------- |
| `/subscriptions`                     | POST   | Subscribe schema; generic 202                                     |
| `/subscriptions/confirm`             | POST   | `{token}`; 200 `CONFIRMED`                                        |
| `/subscriptions/unsubscribe`         | POST   | `{token}`; 200 `UNSUBSCRIBED`, repeatable                         |
| `/subscriptions/preferences/request` | POST   | `{email,website?}`; generic 202                                   |
| `/subscriptions/preferences`         | GET    | Bearer capability; `{status:"confirmed",interests:[...]}`         |
| `/subscriptions/preferences`         | PATCH  | Bearer capability plus `{interests:[...]}`; updated status/topics |
| `/contact`                           | POST   | Contact schema; 202                                               |
| `/business-inquiries`                | POST   | Research schema; 202                                              |

`Authorization: Bearer <capability>` is only for preferences. No cookies or credentials mode is needed. CORS permits exact configured origins and Content-Type/Authorization headers. Queries are rejected, including email or token parameters.

## Token pages to implement during integration

Sandbox email links propose `/launch/confirm#token=…`, `/launch/unsubscribe#token=…`, and `/launch/preferences#token=…`. These are not existing operational pages. Capture the fragment into memory and immediately clear it with `history.replaceState`; set `Referrer-Policy: no-referrer`. Exclude these pages from analytics, session replay and third-party resources. Never put a token in query strings, localStorage, telemetry or error messages.

Require an explicit user action before POST confirmation or unsubscribe; GET/prefetch must not consume capabilities. Confirmation lasts 24 hours, is single-use and queues a management email. Preferences expire after 30 minutes; request a fresh link with `/preferences/request`. Updating topics cannot re-subscribe. Unsubscribe is reusable without a password; fresh consent and confirmation are required to opt back in. Bounce/complaint/deletion suppression cannot be cleared by public signup.

## Error mapping

Errors contain `success:false`, `code`, `requestId`, and optional `fields`. Map `VALIDATION_ERROR` fields to accessible inline errors and focus the first affected control. `CONSENT_VERSION_INVALID` means refresh approved copy/configuration. `TOKEN_INVALID` covers unknown, reused or wrong-purpose tokens; `TOKEN_EXPIRED` is 410. `CAPABILITY_REQUIRED` is 401. `RATE_LIMITED` is 429 with Retry-After seconds. `INTERNAL_ERROR` is a generic 500. Preserve safe form inputs after network failures; never send private inputs to monitoring.

Payload caps: 16 KiB for ordinary forms; 32 KiB for business. Unknown fields and active HTML are rejected. Email internationalization beyond ASCII is deliberately unsupported in this version and must not be silently transliterated.

## Integration release gate

Keep noindex, robots blocking, sample disclosures and CSP unchanged until a separately reviewed frontend integration. Replace sample wording only when submissions actually persist and consent copy is approved. Exercise real staging mail, expired/reused links, preferences, unsubscribe, 429/offline failures, focus handling, keyboard/axe and 320/768/1440 layouts before making forms live. Backend completion does not authorize indexing.
