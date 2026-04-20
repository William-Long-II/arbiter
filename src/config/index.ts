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
  ANTHROPIC_API_KEY: z.string().min(1),
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
  anthropicApiKey: string;
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
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
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
