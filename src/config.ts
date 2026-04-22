import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Store } from "./state/db.ts";

const ToneMode = z.enum(["append", "replace"]);
export type ToneMode = z.infer<typeof ToneMode>;

const OrgWatch = z
  .object({
    name: z.string().min(1),
    mode: z.enum(["all", "include"]).default("all"),
    include: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default([]),
    tone_override: z.string().nullable().default(null),
    tone_mode: ToneMode.default("append"),
  })
  .refine((v) => v.mode !== "include" || v.include.length > 0, {
    message: "orgs[].include must be non-empty when mode is 'include'",
  });

/**
 * A repo entry is either a bare "owner/name" string (legacy YAML form) or an
 * object with a slug plus tone fields. Preprocess normalizes the string form
 * into an object so the rest of the app sees a single shape.
 */
const RepoEntry = z.preprocess(
  (v) => (typeof v === "string" ? { slug: v } : v),
  z.object({
    slug: z.string().regex(/^[^/]+\/[^/]+$/, "repos[] must be 'owner/name'"),
    tone_override: z.string().nullable().default(null),
    tone_mode: ToneMode.default("append"),
  }),
);

export const ConfigSchema = z.object({
  github: z.object({
    bot_username: z.string().default(""),
    skip_authors: z.array(z.string()).default([]),
  }),
  watch: z.object({
    orgs: z.array(OrgWatch).default([]),
    repos: z.array(RepoEntry).default([]),
  }),
  review: z.object({
    dry_run: z.boolean().default(true),
    max_approvals_per_hour: z.number().int().positive().default(10),
    tone: z.string().default(
      "Be constructive and specific. Explain WHY and HOW for every issue.",
    ),
    skip_drafts: z.boolean().default(true),
    skip_bots: z.boolean().default(true),
    require_ci_green: z.boolean().default(true),
  }),
  poll: z.object({
    interval_seconds: z.number().int().positive().default(60),
  }),
  claude: z.object({
    command: z.string().default("claude"),
    timeout_seconds: z.number().int().positive().default(600),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type OrgWatchEntry = z.infer<typeof OrgWatch>;

/** Whether the config is sufficient for the loop to run. */
export function isConfigured(cfg: Config): boolean {
  if (!cfg.github.bot_username) return false;
  if (cfg.watch.orgs.length + cfg.watch.repos.length === 0) return false;
  return true;
}

/** Full list of scalar keys persisted in config_scalars. Edit-one-place for UI rendering. */
export const SCALAR_DEFAULTS: Record<string, string> = {
  "github.bot_username": "",
  "review.dry_run": "true",
  "review.max_approvals_per_hour": "10",
  "review.tone":
    "Be constructive and specific. Explain WHY and HOW for every issue.",
  "review.skip_drafts": "true",
  "review.skip_bots": "true",
  "review.require_ci_green": "true",
  "poll.interval_seconds": "60",
  "claude.command": "claude",
  "claude.timeout_seconds": "600",
};

export function loadConfigFromStore(store: Store): Config {
  const scalars = { ...SCALAR_DEFAULTS, ...store.allScalars() };
  const orgs = store.listOrgs().map((r) => ({
    name: r.name,
    mode: r.mode,
    include: safeJsonArray(r.include_json),
    exclude: safeJsonArray(r.exclude_json),
    tone_override: r.tone_override,
    tone_mode: r.tone_mode,
  }));
  const repos = store.listWatchedRepoRows().map((r) => ({
    slug: r.slug,
    tone_override: r.tone_override,
    tone_mode: r.tone_mode,
  }));

  const raw = {
    github: {
      bot_username: scalars["github.bot_username"] ?? "",
      skip_authors: store.listSkipAuthors(),
    },
    watch: {
      orgs,
      repos,
    },
    review: {
      dry_run: asBool(scalars["review.dry_run"], true),
      max_approvals_per_hour: asInt(scalars["review.max_approvals_per_hour"], 10),
      tone: scalars["review.tone"] ?? "",
      skip_drafts: asBool(scalars["review.skip_drafts"], true),
      skip_bots: asBool(scalars["review.skip_bots"], true),
      require_ci_green: asBool(scalars["review.require_ci_green"], true),
    },
    poll: {
      interval_seconds: asInt(scalars["poll.interval_seconds"], 60),
    },
    claude: {
      command: scalars["claude.command"] ?? "claude",
      timeout_seconds: asInt(scalars["claude.timeout_seconds"], 600),
    },
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config in store:\n${issues}`);
  }
  return result.data;
}

/**
 * If the DB has no bot_username AND a config.yaml file exists, import it once.
 * Returns true if bootstrap happened (caller can surface in UI / events).
 */
export function bootstrapFromYaml(store: Store, yamlPath: string): boolean {
  if (store.getScalar("github.bot_username")) return false;
  if (!existsSync(yamlPath)) return false;

  const raw = parseYaml(readFileSync(yamlPath, "utf8"));
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `config.yaml bootstrap failed:\n${parsed.error.issues
        .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("\n")}`,
    );
  }
  const cfg = parsed.data;

  store.setScalar("github.bot_username", cfg.github.bot_username);
  store.setScalar("review.dry_run", String(cfg.review.dry_run));
  store.setScalar("review.max_approvals_per_hour", String(cfg.review.max_approvals_per_hour));
  store.setScalar("review.tone", cfg.review.tone);
  store.setScalar("review.skip_drafts", String(cfg.review.skip_drafts));
  store.setScalar("review.skip_bots", String(cfg.review.skip_bots));
  store.setScalar("review.require_ci_green", String(cfg.review.require_ci_green));
  store.setScalar("poll.interval_seconds", String(cfg.poll.interval_seconds));
  store.setScalar("claude.command", cfg.claude.command);
  store.setScalar("claude.timeout_seconds", String(cfg.claude.timeout_seconds));

  for (const a of cfg.github.skip_authors) store.addSkipAuthor(a);
  for (const r of cfg.watch.repos) {
    store.addWatchedRepo(r.slug);
    if (r.tone_override !== null || r.tone_mode !== "append") {
      store.setRepoTone(r.slug, r.tone_override, r.tone_mode);
    }
  }
  for (const o of cfg.watch.orgs) {
    store.upsertOrg({
      name: o.name,
      mode: o.mode,
      include_json: JSON.stringify(o.include),
      exclude_json: JSON.stringify(o.exclude),
      tone_override: o.tone_override,
      tone_mode: o.tone_mode,
    });
  }

  return true;
}

function safeJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function asBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
}

function asInt(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) ? n : fallback;
}
