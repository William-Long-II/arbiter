import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const OrgWatch = z
  .object({
    name: z.string().min(1),
    mode: z.enum(["all", "include"]).default("all"),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
  })
  .refine((v) => v.mode !== "include" || (v.include && v.include.length > 0), {
    message: "orgs[].include must be non-empty when mode is 'include'",
  });

const RepoSlug = z.string().regex(/^[^/]+\/[^/]+$/, "repos[] must be 'owner/name'");

const ConfigSchema = z.object({
  github: z.object({
    bot_username: z.string().min(1),
    skip_authors: z.array(z.string()).default([]),
  }),
  watch: z
    .object({
      orgs: z.array(OrgWatch).default([]),
      repos: z.array(RepoSlug).default([]),
    })
    .refine((v) => v.orgs.length + v.repos.length > 0, {
      message: "watch must include at least one org or repo",
    }),
  review: z.object({
    dry_run: z.boolean().default(true),
    max_approvals_per_hour: z.number().int().positive().default(10),
    tone: z.string().default("Be constructive and specific. Explain WHY and HOW for every issue."),
    skip_drafts: z.boolean().default(true),
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

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw);
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config at ${path}:\n${issues}`);
  }
  return result.data;
}
