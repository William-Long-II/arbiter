import { sql } from '../db.ts';

export type User = {
  id: number;
  githubId: number;
  githubLogin: string;
  githubToken: string;
  avatarUrl: string | null;
  /** Set when the worker/poller observes a 401 from Octokit (token
   * revoked by the user, an org admin, or GitHub). Cleared on successful
   * sign-in. Used by the top-nav banner. */
  tokenRevokedAt: Date | null;
};

export async function upsertUser(input: {
  githubId: number;
  githubLogin: string;
  githubToken: string;
  avatarUrl: string | null;
}): Promise<User> {
  const [row] = await sql<User[]>`
    INSERT INTO users (github_id, github_login, github_token, avatar_url, updated_at)
    VALUES (${input.githubId}, ${input.githubLogin}, ${input.githubToken}, ${input.avatarUrl}, now())
    ON CONFLICT (github_id) DO UPDATE
    SET github_login     = EXCLUDED.github_login,
        github_token     = EXCLUDED.github_token,
        avatar_url       = EXCLUDED.avatar_url,
        token_revoked_at = NULL,
        updated_at       = now()
    RETURNING id, github_id AS "githubId", github_login AS "githubLogin",
              github_token AS "githubToken", avatar_url AS "avatarUrl",
              token_revoked_at AS "tokenRevokedAt"
  `;
  if (!row) throw new Error('upsertUser: no row returned');
  return row;
}

/**
 * Mark a user's GitHub token as revoked. Idempotent — calling repeatedly
 * keeps the earliest revoked-at timestamp.
 */
export async function markTokenRevoked(userId: number): Promise<void> {
  await sql`
    UPDATE users
    SET token_revoked_at = COALESCE(token_revoked_at, now())
    WHERE id = ${userId}
  `;
}

export type Session = {
  id: string;
  userId: number;
  expiresAt: Date;
};

export async function createSession(userId: number, ttlSeconds: number): Promise<Session> {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await sql`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (${id}, ${userId}, ${expiresAt})
  `;
  return { id, userId, expiresAt };
}

export async function getSessionUser(sessionId: string): Promise<User | null> {
  const [row] = await sql<User[]>`
    SELECT u.id, u.github_id AS "githubId", u.github_login AS "githubLogin",
           u.github_token AS "githubToken", u.avatar_url AS "avatarUrl",
           u.token_revoked_at AS "tokenRevokedAt"
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ${sessionId} AND s.expires_at > now()
    LIMIT 1
  `;
  return row ?? null;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE id = ${sessionId}`;
}

export async function pruneExpiredSessions(): Promise<number> {
  const result = await sql`DELETE FROM sessions WHERE expires_at <= now()`;
  return result.count;
}
