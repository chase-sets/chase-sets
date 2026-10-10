import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createScrydexOnePieceProviderAdapter } from "./adapter";
import { scrydexUsageTestModeFixture, type ScrydexUsageTestModeFixture } from "./usage-test-mode-fixture";

// One read-only Scrydex `/account/v1/usage` request through the production adapter's
// redaction boundary. Credentials come only from SCRYDEX_API_KEY and SCRYDEX_TEAM_ID;
// the output is the closed-schema fixture and nothing else. Scrydex tariffs the usage
// read as one general credit; no other provider request is made.
export async function captureScrydexUsageTestModeFixture(input: {
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof globalThis.fetch;
  now?: () => Date;
}): Promise<ScrydexUsageTestModeFixture> {
  const apiKey = input.env.SCRYDEX_API_KEY?.trim();
  const teamId = input.env.SCRYDEX_TEAM_ID?.trim();
  if (!apiKey || !teamId) {
    throw new Error("Set SCRYDEX_API_KEY and SCRYDEX_TEAM_ID to capture the Scrydex usage fixture.");
  }

  const adapter = createScrydexOnePieceProviderAdapter({
    credentials: { apiKey, teamId },
    fetch: input.fetch,
    now: input.now,
  });
  return scrydexUsageTestModeFixture(await adapter.getUsageSnapshot());
}

// Replays a usage read a host took in-cluster with the runtime's own credentials
// (kept outside the repository as status, observed-at, and response body) through
// the same adapter boundary at the captured instant, so the fixture is derived by
// production code rather than written by hand. No request leaves the process.
export async function replayScrydexUsageTestModeFixture(capture: {
  observedAt: string;
  httpStatus: number;
  body: unknown;
}): Promise<ScrydexUsageTestModeFixture> {
  const observedAt = new Date(capture.observedAt);
  if (!Number.isFinite(observedAt.getTime())) {
    throw new Error("Scrydex usage replay needs the capture's ISO observed-at.");
  }
  return captureScrydexUsageTestModeFixture({
    env: { SCRYDEX_API_KEY: "replay-placeholder", SCRYDEX_TEAM_ID: "replay-placeholder" },
    fetch: async () => Response.json(capture.body, { status: capture.httpStatus }),
    now: () => observedAt,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const replayPath = process.argv[2] === "--replay" ? process.argv[3] : undefined;
    const fixture = replayPath
      ? await replayScrydexUsageTestModeFixture(JSON.parse(readFileSync(replayPath, "utf8")))
      : await captureScrydexUsageTestModeFixture({ env: process.env, fetch: globalThis.fetch });
    process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
  } catch (error) {
    // Only the probe's own fixed messages are printed; provider and runtime detail stays redacted.
    process.stderr.write(
      `${error instanceof Error && error.message.startsWith("Set SCRYDEX_") ? error.message : "Scrydex usage capture failed; details are redacted."}\n`,
    );
    process.exitCode = 1;
  }
}
