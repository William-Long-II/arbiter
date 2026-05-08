-- Initial schema for reviewme v2
-- Run on every boot via src/db.ts; statements must be idempotent.

CREATE TABLE IF NOT EXISTS users (
  id              BIGSERIAL PRIMARY KEY,
  github_id       BIGINT UNIQUE NOT NULL,
  github_login    TEXT NOT NULL,
  github_token    TEXT NOT NULL,
  avatar_url      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

-- A scope rule: which PRs to capture and how strictly to review them.
-- target_kind = 'repo' (target = "owner/name") or 'org' (target = "owner")
CREATE TABLE IF NOT EXISTS scopes (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_kind           TEXT NOT NULL CHECK (target_kind IN ('repo','org')),
  target                TEXT NOT NULL,
  base_branch_pattern   TEXT NOT NULL DEFAULT '*',
  scrutiny              TEXT NOT NULL CHECK (scrutiny IN ('light','standard','strict')),
  exclude_authors       TEXT[] NOT NULL DEFAULT ARRAY['dependabot[bot]','renovate[bot]'],
  claude_mode           TEXT NOT NULL DEFAULT 'default' CHECK (claude_mode IN ('default','subscription','api')),
  enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scopes_user_id_idx ON scopes(user_id);
CREATE INDEX IF NOT EXISTS scopes_enabled_idx ON scopes(enabled) WHERE enabled = TRUE;

-- A review job. One row per (repo, pr_number, head_sha) — idempotent on PR push.
CREATE TABLE IF NOT EXISTS pending_reviews (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_id        BIGINT REFERENCES scopes(id) ON DELETE SET NULL,
  repo_full       TEXT NOT NULL,
  pr_number       INT NOT NULL,
  pr_title        TEXT NOT NULL,
  pr_author       TEXT NOT NULL,
  base_branch     TEXT NOT NULL,
  head_branch     TEXT NOT NULL,
  head_sha        TEXT NOT NULL,
  scrutiny        TEXT NOT NULL CHECK (scrutiny IN ('light','standard','strict')),
  claude_mode     TEXT NOT NULL CHECK (claude_mode IN ('subscription','api')),
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','skipped')),
  attempt         INT NOT NULL DEFAULT 0,
  error           TEXT,
  output          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS pending_reviews_unique_head
  ON pending_reviews(repo_full, pr_number, head_sha);
CREATE INDEX IF NOT EXISTS pending_reviews_status_idx
  ON pending_reviews(status, created_at)
  WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS pending_reviews_user_idx
  ON pending_reviews(user_id, created_at DESC);
