-- Durable record of "Book a call" / contact-form submissions, independent of
-- whether the notification email actually sends (Resend outage, bad API
-- key) — the submission itself is never lost.
CREATE TABLE contact_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  company text,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
