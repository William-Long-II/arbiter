import type { Intent } from "./index";

export type TicketRef = { providerId: string; key: string; raw: unknown };

export interface IntentProvider {
  id: string;
  match(pr: {
    title: string;
    body: string;
    branch?: string;
    repoOwner?: string;
    repoName?: string;
  }): TicketRef | null;
  fetch(ref: TicketRef): Promise<Intent>;
}
