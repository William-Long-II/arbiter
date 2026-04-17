import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOSTNAME: z.string().default("127.0.0.1"),
  GITHUB_PAT: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  JIRA_BASE_URL: z.string().url().optional(),
  JIRA_EMAIL: z.string().email().optional(),
  JIRA_API_TOKEN: z.string().optional(),
});

export type Config = {
  port: number;
  hostname: string;
  githubPat: string;
  githubWebhookSecret: string;
  anthropicApiKey: string;
  jira?: {
    baseUrl: string;
    email: string;
    apiToken: string;
  };
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
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    jira,
  };
}
