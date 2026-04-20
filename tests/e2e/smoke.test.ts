/**
 * Headless e2e test — delegates entirely to the smoke harness.
 *
 * Running `bun test` will execute this file alongside the unit tests.
 * The same harness is also callable directly via `bun run smoke`.
 */
import { test } from "bun:test";
import { runSmoke } from "../../scripts/smoke";

test("e2e smoke: full pipeline from webhook to review post", async () => {
  await runSmoke();
}, 20_000); // generous timeout; harness self-enforces <15s
