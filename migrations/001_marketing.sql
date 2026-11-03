CREATE TABLE marketing_subscribers (
 id uuid PRIMARY KEY, email_normalized text NOT NULL UNIQUE,
 status text NOT NULL CHECK (status IN ('pending','confirmed','unsubscribed','suppressed')),
 consent_version text NOT NULL, consent_text_hash text NOT NULL, consented_at timestamptz NOT NULL,
 confirmed_at timestamptz, unsubscribed_at timestamptz, source text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE marketing_subscriber_interests (
 subscriber_id uuid REFERENCES marketing_subscribers ON DELETE CASCADE,
 interest text NOT NULL CHECK (interest IN ('password_manager','documents','family','business')),
 chosen_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(subscriber_id,interest)
);
CREATE TABLE marketing_capability_tokens (
 id uuid PRIMARY KEY, subscriber_id uuid NOT NULL REFERENCES marketing_subscribers ON DELETE CASCADE,
 purpose text NOT NULL CHECK (purpose IN ('confirm','unsubscribe','preferences')),
 token_hash text NOT NULL UNIQUE, expires_at timestamptz, consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tokens_subscriber ON marketing_capability_tokens(subscriber_id);
CREATE INDEX tokens_expiry ON marketing_capability_tokens(expires_at);
CREATE TABLE marketing_contact_requests (
 id uuid PRIMARY KEY, category text NOT NULL CHECK(category IN ('general','business','security','privacy','feedback')),
 protected_data text NOT NULL, status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','triaged','contacted','closed')),
 created_at timestamptz NOT NULL DEFAULT now(), delete_after timestamptz NOT NULL
);
CREATE TABLE marketing_business_inquiries (
 id uuid PRIMARY KEY, protected_data text NOT NULL, consent_version text NOT NULL,
 consent_text_hash text NOT NULL, consented_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','triaged','contacted','closed')),
 created_at timestamptz NOT NULL DEFAULT now(), delete_after timestamptz NOT NULL
);
CREATE TABLE marketing_email_outbox (
 id uuid PRIMARY KEY, subscriber_id uuid REFERENCES marketing_subscribers ON DELETE CASCADE,
 related_id uuid NOT NULL, event_type text NOT NULL, template_version text NOT NULL DEFAULT 'v1',
 protected_payload text, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','sent','dead','cancelled')),
 attempts integer NOT NULL DEFAULT 0, next_attempt timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
 claim_id uuid, last_error_code text, provider_message_id text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_due ON marketing_email_outbox(state,next_attempt);
CREATE INDEX outbox_subscriber ON marketing_email_outbox(subscriber_id);
CREATE TABLE marketing_email_events (
 id uuid PRIMARY KEY, provider text NOT NULL, provider_event_id text NOT NULL,
 message_id text NOT NULL, event_type text NOT NULL, occurred_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider,provider_event_id)
);
CREATE TABLE marketing_audit_events (
 id uuid PRIMARY KEY, actor text NOT NULL DEFAULT 'system', operation text NOT NULL,
 target_id uuid NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE marketing_suppressions (
 email_hash text PRIMARY KEY, reason text NOT NULL CHECK(reason IN ('unsubscribe','bounced','complained','suppressed','deleted')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE marketing_rate_limits (
 key text PRIMARY KEY, hits integer NOT NULL, reset_at timestamptz NOT NULL
);
CREATE INDEX rate_expiry ON marketing_rate_limits(reset_at);
CREATE INDEX contact_retention ON marketing_contact_requests(delete_after);
CREATE INDEX business_retention ON marketing_business_inquiries(delete_after);
