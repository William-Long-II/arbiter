-- Instance-level settings written by the first-run setup wizard.
-- Key/value rather than columns: the set is small, grows rarely, and a
-- fresh instance needs to distinguish "never configured" (no rows) from
-- "configured with defaults". Env vars always win over rows here — the
-- wizard only fills what the operator left blank (see src/settings.ts).
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
