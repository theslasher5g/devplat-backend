-- Email change with verification of the NEW address.
--
-- The address isn't switched until the new mailbox is proven, so a typo can't
-- lock someone out of their account. pending_email holds the requested address
-- until then; the token itself lives in verification_tokens under a new type.
ALTER TABLE users ADD COLUMN pending_email text;

ALTER TABLE verification_tokens DROP CONSTRAINT verification_tokens_type_check;
ALTER TABLE verification_tokens
  ADD CONSTRAINT verification_tokens_type_check
  CHECK (type IN ('verify_email', 'password_reset', 'email_change'));
