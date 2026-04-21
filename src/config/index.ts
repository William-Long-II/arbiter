import { z } from "zod";
import { loadReposFile, type RepoAllowlist } from "./repos";
export { getAllowlist, reload } from "./repos";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOSTNAME: z.string().default("127.0.0.1"),
  GITHUB_PAT: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  /** Optional secondary webhook secret for zero-downtime rotation. */
  GITHUB_WEBHOOK_SECRET_SECONDARY: z.string().min(1).optional(),
  /**
   * The Anthropic API key is required when LLM_BACKEND=api (the default).
   * When LLM_BACKEND=claude-cli the key is ignored and may be empty/unset,
   * since the `claude` CLI uses its own auth (claude /login). An empty string
   * is treated as unset so operators can leave `ANTHROPIC_API_KEY=` in .env
   * when running CLI-backed. loadConfig() enforces the combined rule.
   */
  ANTHROPIC_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v === "" ? undefined : v)),
  /**
   * LLM backend selection.  `api` is the SDK-backed default; `claude-cli`
   * shells out to the `claude` binary using its own auth (Max subscription).
   */
  LLM_BACKEND: z.enum(["api", "claude-cli"]).default("api"),
  JIRA_BASE_URL: z.string().url().optional(),
  JIRA_EMAIL: z.string().email().optional(),
  JIRA_API_TOKEN: z.string().optional(),
  REPOS_PATH: z.string().default("./repos.yaml"),
  GITHUB_MACHINE_USER_LOGIN: z.string().optional(),
  /** Auto-replay dead letters on boot: "enabled" (default) or "disabled". */
  DEAD_LETTER_AUTO_REPLAY: z.enum(["enabled", "disabled"]).default("enabled"),
  /** Maximum age of dead-letter files to auto-replay (minutes). Default 60. */
  DEAD_LETTER_REPLAY_MAX_AGE_MINUTES: z.coerce.number().int().positive().default(60),
  /** Maximum number of dead-letter files to auto-replay per boot. Default 50. */
  DEAD_LETTER_REPLAY_MAX_COUNT: z.coerce.number().int().positive().default(50),
});

export type Config = {
  port: number;
  hostname: string;
  githubPat: string;
  githubWebhookSecret: string;
  /** Optional secondary secret for zero-downtime rotation. When set, both secrets are accepted. */
  githubWebhookSecretSecondary?: string;
  /**
   * Anthropic API key. Required when llmBackend === "api"; a harmless placeholder
   * when llmBackend === "claude-cli" (the SDK client is constructed but never
   * used for LLM calls in CLI mode).
   */
  anthropicApiKey: string;
  llmBackend: "api" | "claude-cli";
  reposPath: string;
  machineUserLogin?: string;
  jira?: {
    baseUrl: string;
    email: string;
    apiToken: string;
  };
  deadLetterAutoReplay: "enabled" | "disabled";
  deadLetterReplayMaxAgeMinutes: number;
  deadLetterReplayMaxCount: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);

  // Cross-field validation: ANTHROPIC_API_KEY is required in api mode.
  // In claude-cli mode we fall back to a clearly-labelled placeholder —
  // the SDK client is constructed for type reasons but never sends a request.
  if (parsed.LLM_BACKEND === "api" && !parsed.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is required when LLM_BACKEND=api. " +
        "Set the key in .env, or set LLM_BACKEND=claude-cli to use the Claude CLI (requires `claude /login`).",
    );
  }

  const jira =
    parsed.JIRA_BASE_URL && parsed.JIRA_EMAIL && parsed.JIRA_API_TOKEN
      ? {
          baseUrl: parsed.JIRA_BASE_URL,
          email: parsed.JIRA_EMAIL,
          apiToken: parsed.JIRA_API_TOKEN,
        }
      : undefined;

  return {
    port: parsed.PORT,
    hostname: parsed.HOSTNAME,
    githubPat: parsed.GITHUB_PAT,
    githubWebhookSecret: parsed.GITHUB_WEBHOOK_SECRET,
    githubWebhookSecretSecondary: parsed.GITHUB_WEBHOOK_SECRET_SECONDARY,
    anthropicApiKey:
      parsed.ANTHROPIC_API_KEY ?? "sk-ant-unused-claude-cli-backend",
    llmBackend: parsed.LLM_BACKEND,
    reposPath: parsed.REPOS_PATH,
    machineUserLogin: parsed.GITHUB_MACHINE_USER_LOGIN,
    jira,
    deadLetterAutoReplay: parsed.DEAD_LETTER_AUTO_REPLAY,
    deadLetterReplayMaxAgeMinutes: parsed.DEAD_LETTER_REPLAY_MAX_AGE_MINUTES,
    deadLetterReplayMaxCount: parsed.DEAD_LETTER_REPLAY_MAX_COUNT,
  };
}

export function loadAllowlist(path: string): RepoAllowlist {
  return loadReposFile(path);
}

export type {
  RepoAllowlist,
  RepoEntry,
  OrgDefaults,
  ResolvedRepoConfig,
  RepoReviewConfig,
} from "./repos";
