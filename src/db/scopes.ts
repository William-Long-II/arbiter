import { sql } from '../db.ts';

export type Scrutiny = 'light' | 'standard' | 'strict';
export type TargetKind = 'repo' | 'org';
export type ClaudeMode = 'default' | 'subscription' | 'api';
/**
 * Which open PRs the poller picks up for this scope.
 *  - 'open'             — every open non-draft PR (legacy default)
 *  - 'review_requested' — only PRs where the OAuth'd user (or one of their
 *    teams) is in the requested-reviewers list. Tighter signal — a human
 *    explicitly asked for review — and dramatically shrinks the result set
 *    on busy orgs.
 */
export type TriggerMode = 'open' | 'review_requested';

export type Scope = {
  id: number;
  userId: number;
  targetKind: TargetKind;
  target: string;
  baseBranchPattern: string;
  scrutiny: Scrutiny;
  excludeAuthors: string[];
  claudeMode: ClaudeMode;
  /** Opt-in: when true and the reviewer's verdict is `approve`, post the
   * review with event=APPROVE instead of COMMENT. Self-authored PRs always
   * fall back to COMMENT regardless (GitHub blocks self-approval). */
  autoApprove: boolean;
  /**
   * Tri-state footer config:
   * - null → use built-in default template
   * - ''   → no footer
   * - any other string → custom template (supports {{scrutiny}}, {{mode}},
   *   {{verdict}}, {{posted_as}} placeholders)
   */
  footerTemplate: string | null;
  /**
   * Free-text guidance appended to the scrutiny system prompt. Empty/null =
   * default behavior. Use to adjust focus ("be strict on auth code"), tone
   * ("snarky but constructive"), or context ("this is a Rust project").
   */
  personalityPrompt: string | null;
  triggerMode: TriggerMode;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const SCRUTINIES: readonly Scrutiny[] = ['light', 'standard', 'strict'];
const KINDS: readonly TargetKind[] = ['repo', 'org'];
const MODES: readonly ClaudeMode[] = ['default', 'subscription', 'api'];
const TRIGGER_MODES: readonly TriggerMode[] = ['open', 'review_requested'];

export function isScrutiny(v: unknown): v is Scrutiny {
  return typeof v === 'string' && (SCRUTINIES as readonly string[]).includes(v);
}
export function isTargetKind(v: unknown): v is TargetKind {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v);
}
export function isClaudeMode(v: unknown): v is ClaudeMode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v);
}
export function isTriggerMode(v: unknown): v is TriggerMode {
  return typeof v === 'string' && (TRIGGER_MODES as readonly string[]).includes(v);
}

const SELECT_COLUMNS = sql`
  id,
  user_id          AS "userId",
  target_kind      AS "targetKind",
  target,
  base_branch_pattern AS "baseBranchPattern",
  scrutiny,
  exclude_authors    AS "excludeAuthors",
  claude_mode        AS "claudeMode",
  auto_approve       AS "autoApprove",
  footer_template    AS "footerTemplate",
  personality_prompt AS "personalityPrompt",
  trigger_mode       AS "triggerMode",
  enabled,
  created_at       AS "createdAt",
  updated_at       AS "updatedAt"
`;

export async function listScopes(userId: number): Promise<Scope[]> {
  return sql<Scope[]>`
    SELECT ${SELECT_COLUMNS}
    FROM scopes
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
  `;
}

export async function getScope(userId: number, id: number): Promise<Scope | null> {
  const [row] = await sql<Scope[]>`
    SELECT ${SELECT_COLUMNS}
    FROM scopes
    WHERE id = ${id} AND user_id = ${userId}
    LIMIT 1
  `;
  return row ?? null;
}

export type ScopeInput = {
  targetKind: TargetKind;
  target: string;
  baseBranchPattern: string;
  scrutiny: Scrutiny;
  excludeAuthors: string[];
  claudeMode: ClaudeMode;
  autoApprove: boolean;
  footerTemplate: string | null;
  personalityPrompt: string | null;
  triggerMode: TriggerMode;
  enabled: boolean;
};

export async function createScope(userId: number, input: ScopeInput): Promise<Scope> {
  const [row] = await sql<Scope[]>`
    INSERT INTO scopes
      (user_id, target_kind, target, base_branch_pattern, scrutiny,
       exclude_authors, claude_mode, auto_approve, footer_template,
       personality_prompt, trigger_mode, enabled)
    VALUES
      (${userId}, ${input.targetKind}, ${input.target}, ${input.baseBranchPattern},
       ${input.scrutiny}, ${input.excludeAuthors}, ${input.claudeMode},
       ${input.autoApprove}, ${input.footerTemplate},
       ${input.personalityPrompt}, ${input.triggerMode}, ${input.enabled})
    RETURNING ${SELECT_COLUMNS}
  `;
  if (!row) throw new Error('createScope: no row returned');
  return row;
}

export async function updateScope(
  userId: number,
  id: number,
  input: ScopeInput,
): Promise<Scope | null> {
  const [row] = await sql<Scope[]>`
    UPDATE scopes
    SET target_kind = ${input.targetKind},
        target = ${input.target},
        base_branch_pattern = ${input.baseBranchPattern},
        scrutiny = ${input.scrutiny},
        exclude_authors = ${input.excludeAuthors},
        claude_mode = ${input.claudeMode},
        auto_approve = ${input.autoApprove},
        footer_template = ${input.footerTemplate},
        personality_prompt = ${input.personalityPrompt},
        trigger_mode = ${input.triggerMode},
        enabled = ${input.enabled},
        updated_at = now()
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING ${SELECT_COLUMNS}
  `;
  return row ?? null;
}

export async function setScopeEnabled(
  userId: number,
  id: number,
  enabled: boolean,
): Promise<void> {
  await sql`
    UPDATE scopes
    SET enabled = ${enabled}, updated_at = now()
    WHERE id = ${id} AND user_id = ${userId}
  `;
}

export async function deleteScope(userId: number, id: number): Promise<void> {
  await sql`DELETE FROM scopes WHERE id = ${id} AND user_id = ${userId}`;
}

/**
 * Parse and validate a form submission into a ScopeInput.
 * Returns either the validated input or an array of human-readable errors.
 */
export function parseScopeForm(
  form: Record<string, string | undefined>,
): { ok: true; input: ScopeInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  const targetKind = form.target_kind;
  if (!isTargetKind(targetKind)) errors.push('Target kind must be "repo" or "org".');

  const target = (form.target ?? '').trim();
  if (!target) errors.push('Target is required.');
  if (targetKind === 'repo' && target) {
    const parts = target.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      errors.push('Repo target must be "owner/name" — exactly one slash, both sides non-empty.');
    }
  }
  if (targetKind === 'org' && target && target.includes('/')) {
    errors.push('Org target must be just "owner" — no slashes.');
  }

  const baseBranchPattern = (form.base_branch_pattern ?? '').trim() || '*';

  const scrutiny = form.scrutiny;
  if (!isScrutiny(scrutiny)) errors.push('Scrutiny must be light, standard, or strict.');

  const claudeMode = form.claude_mode ?? 'default';
  if (!isClaudeMode(claudeMode)) errors.push('Claude mode must be default, subscription, or api.');

  const triggerMode = form.trigger_mode ?? 'open';
  if (!isTriggerMode(triggerMode)) {
    errors.push('Trigger mode must be "open" or "review_requested".');
  }

  const excludeAuthors = (form.exclude_authors ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const enabled = form.enabled === 'on' || form.enabled === 'true';
  const autoApprove = form.auto_approve === 'on' || form.auto_approve === 'true';
  // Personality is plain text. Trim trailing whitespace, treat empty as null.
  const personalityRaw = (form.personality_prompt ?? '').replace(/\s+$/, '');
  const personalityPrompt = personalityRaw.length > 0 ? personalityRaw : null;

  // Footer is a 3-way choice driven by a radio (footer_mode):
  //   'standard' → footerTemplate = null (worker uses built-in default)
  //   'none'     → footerTemplate = ''   (no footer at all)
  //   'custom'   → footerTemplate = whatever's in the footer_template textarea
  let footerTemplate: string | null;
  switch (form.footer_mode) {
    case 'none':
      footerTemplate = '';
      break;
    case 'custom':
      // Trim trailing whitespace. Empty custom is treated like 'none' —
      // the user chose custom but left the template blank.
      footerTemplate = (form.footer_template ?? '').replace(/\s+$/, '') || '';
      break;
    case 'standard':
    default:
      footerTemplate = null;
      break;
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    input: {
      targetKind: targetKind as TargetKind,
      target,
      baseBranchPattern,
      scrutiny: scrutiny as Scrutiny,
      excludeAuthors,
      claudeMode: claudeMode as ClaudeMode,
      autoApprove,
      footerTemplate,
      personalityPrompt,
      triggerMode: triggerMode as TriggerMode,
      enabled,
    },
  };
}
