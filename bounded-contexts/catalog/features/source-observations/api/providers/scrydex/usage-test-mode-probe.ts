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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const fixture = await captureScrydexUsageTestModeFixture({ env: process.env, fetch: globalThis.fetch });
    process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
  } catch (error) {
    // Only the probe's own fixed messages are printed; provider and runtime detail stays redacted.
    process.stderr.write(
      `${error instanceof Error && error.message.startsWith("Set SCRYDEX_") ? error.message : "Scrydex usage capture failed; details are redacted."}\n`,
    );
    process.exitCode = 1;
  }
}
