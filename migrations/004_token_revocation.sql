-- Track when a user's GitHub OAuth token stopped working (revoked by the
-- user, an org admin, or GitHub itself). Cleared on the next successful
-- sign-in. Used to render a top-nav banner so the user knows why the worker
-- has gone silent and can re-authenticate.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS token_revoked_at TIMESTAMPTZ;
