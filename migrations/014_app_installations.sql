-- GitHub App installation registry (slice 2 of the OAuth → App migration).
--
-- Maps a GitHub account (the owner login that appears as the first segment
-- of `owner/repo`) to the App installation on that account. Populated
-- entirely from App webhook events (`installation` created/deleted/
-- suspend/unsuspend) — never from user action. A row here means the App is
-- installed on that account and arbiter MAY mint short-lived, finely-
-- scoped installation tokens for its repos instead of using a stored OAuth
-- user token. `suspended_at` set ⇒ the install exists but is suspended, so
-- the token resolver must fall back to OAuth rather than mint.
--
-- Account login is the natural key: GitHub guarantees one App installation
-- per account, and the resolver looks up by `owner`. Login can be renamed;
-- the `installation` event re-fires on rename so the upsert keeps it fresh,
-- and installation_id is the stable identifier we actually mint against.
CREATE TABLE IF NOT EXISTS app_installations (
  account_login    TEXT PRIMARY KEY,
  installation_id  BIGINT NOT NULL,
  -- 'User' | 'Organization' — informational; GitHub's account.type.
  account_type     TEXT,
  suspended_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A given installation_id maps to exactly one account; this catches a
-- delivery that would otherwise split one installation across two logins.
CREATE UNIQUE INDEX IF NOT EXISTS app_installations_installation_id_uniq
  ON app_installations (installation_id);
