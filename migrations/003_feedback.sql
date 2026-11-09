CREATE TABLE marketing_feedback (
 id uuid PRIMARY KEY,
 category text NOT NULL CHECK(category IN ('passwords','notes','sharing','documents','family','business','other')),
 protected_data text NOT NULL,
 follow_up boolean NOT NULL DEFAULT false,
 consent_version text NOT NULL,
 consent_text_hash text NOT NULL,
 consented_at timestamptz,
 status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewed','closed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 delete_after timestamptz NOT NULL,
 CHECK ((follow_up AND consented_at IS NOT NULL) OR (NOT follow_up AND consented_at IS NULL))
);
CREATE INDEX feedback_retention ON marketing_feedback(delete_after);
CREATE INDEX feedback_review ON marketing_feedback(status,created_at);
