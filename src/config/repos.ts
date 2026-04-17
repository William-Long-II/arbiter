import { readFileSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";

const RepoEntrySchema = z.object({
  enabled: z.boolean().default(true),
  rereview: z.enum(["auto-on-sync", "label-or-mention"]).default("auto-on-sync"),
  rereview_label: z.string().default("re-review"),
});

export type RepoEntry = z.infer<typeof RepoEntrySchema>;

const ReposFileSchema = z.object({
  repos: z.record(z.string(), RepoEntrySchema),
});

export type RepoAllowlist = {
  isAllowed: (fullName: string) => boolean;
  get: (fullName: string) => RepoEntry | undefined;
  all: () => Record<string, RepoEntry>;
};

export function loadReposFile(path: string): RepoAllowlist {
  const raw = readFileSync(path, "utf8");
  const parsed = YAML.parse(raw);
  const data = ReposFileSchema.parse(parsed ?? { repos: {} });
  return buildAllowlist(data.repos);
}

export function buildAllowlist(
  repos: Record<string, RepoEntry>,
): RepoAllowlist {
  const normalized: Record<string, RepoEntry> = {};
  for (const [key, value] of Object.entries(repos)) {
    normalized[key.toLowerCase()] = value;
  }
  return {
    isAllowed: (fullName) => {
      const entry = normalized[fullName.toLowerCase()];
      return Boolean(entry?.enabled);
    },
    get: (fullName) => normalized[fullName.toLowerCase()],
    all: () => ({ ...normalized }),
  };
}
