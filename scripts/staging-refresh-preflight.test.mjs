import { afterEach, describe, expect, it } from "vitest";
import { stagingRefreshRequiredSecrets, stagingRefreshSetMatrix } from "./staging-refresh-preflight-config.mjs";
import {
  activeStagingRefreshOverlaps,
  deployedSecretPostureFromApp,
  evaluateProviderPosture,
  evaluateStagingRefreshSecrets,
  findExpectedOptionAcrossPages,
  inspectSetMatrix,
  matchingExpectedOption,
  parseStagingRefreshPreflightArgs,
  runStagingRefreshPreflight,
} from "./staging-refresh-preflight.mjs";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const name of stagingRefreshRequiredSecrets.map((secret) => secret.name)) {
    if (originalEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = originalEnv[name];
    }
  }
});

function metadata() {
  return stagingRefreshRequiredSecrets.map((secret) => ({ name: secret.name, updatedAt: "2026-07-17T00:00:00Z" }));
}

function validSecretEnv() {
  return {
    TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE: "fixture-cookie",
    SCRYDEX_API_KEY: "fixture-scrydex-key",
    SCRYDEX_TEAM_ID: "fixture-team",
    STRIPE_SECRET_KEY: "sk_test_fixture",
    STRIPE_PUBLISHABLE_KEY: "pk_test_fixture",
    STRIPE_WEBHOOK_SECRET: "whsec_fixture",
    EASYPOST_API_KEY: "EZTKfixture",
  };
}

describe("staging refresh credential posture", () => {
  it("distinguishes secret-name presence from value-kind verification without emitting values", () => {
    const values = validSecretEnv();
    const posture = evaluateStagingRefreshSecrets(metadata(), values);

    expect(posture.every((secret) => secret.metadataState === "present" && secret.valueState === "verified")).toBe(
      true,
    );
    expect(JSON.stringify(posture)).not.toContain(values.TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE);
    expect(JSON.stringify(posture)).not.toContain(values.SCRYDEX_API_KEY);
  });

  it("fails key-mode classification without echoing a live-looking value", () => {
    const values = { ...validSecretEnv(), STRIPE_SECRET_KEY: "sk_live_must-not-leak", EASYPOST_API_KEY: "EZAK_live" };
    const posture = evaluateStagingRefreshSecrets(metadata(), values);

    expect(posture.find((secret) => secret.name === "STRIPE_SECRET_KEY")?.valueState).toBe("invalid");
    expect(posture.find((secret) => secret.name === "EASYPOST_API_KEY")?.valueState).toBe("invalid");
    expect(JSON.stringify(posture)).not.toContain("sk_live_must-not-leak");
  });

  it("records metadata-only checks as not inspectable", () => {
    const posture = evaluateStagingRefreshSecrets(metadata(), {});
    expect(posture.every((secret) => secret.valueState === "not-inspectable")).toBe(true);
  });

  it("reports only deployed secret names and component posture from DigitalOcean metadata", () => {
    const encryptedValue = "EV[1:encrypted-must-not-appear]";
    const posture = deployedSecretPostureFromApp({
      spec: {
        services: [
          {
            name: "platform-api",
            envs: stagingRefreshRequiredSecrets.map((secret) => ({
              key: secret.name,
              value: encryptedValue,
              type: "SECRET",
            })),
          },
        ],
      },
    });

    expect(posture.every((secret) => secret.state === "configured")).toBe(true);
    expect(posture[0]?.components).toEqual(["platform-api"]);
    expect(JSON.stringify(posture)).not.toContain(encryptedValue);
  });
});

describe("staging refresh provider posture", () => {
  it("reports configured provider readiness and support-safe Scrydex credit category", () => {
    const posture = evaluateProviderPosture({
      providerReadiness: {
        providers: [
          {
            providerKey: "tcgplayer",
            readiness: "ready",
            credentialReadiness: "ready",
            credentialReadinessState: "configured",
            diagnostics: [],
          },
          {
            providerKey: "scrydex",
            readiness: "ready",
            credentialReadiness: "ready",
            credentialReadinessState: "configured",
            diagnostics: [{ code: "scrydex-account-usage-checked" }],
            usageBudget: null,
          },
        ],
      },
    });

    expect(posture.credentialPosture).toEqual([
      expect.objectContaining({ providerKey: "tcgplayer", readiness: "ready" }),
      expect.objectContaining({ providerKey: "scrydex", credentialReadinessState: "configured" }),
    ]);
    expect(posture.scrydexCreditCategory).toBe("available");
  });

  it("surfaces low credit posture as a category rather than raw usage", () => {
    const posture = evaluateProviderPosture({
      providerReadiness: {
        providers: [{ providerKey: "scrydex", diagnostics: [{ code: "scrydex-account-credit-low" }] }],
      },
    });
    expect(posture.scrydexCreditCategory).toBe("low");
    expect(posture).not.toHaveProperty("remainingCredits");
  });

  it("checks Scrydex credit posture before live options and stops further credited reads when low", async () => {
    Object.assign(process.env, validSecretEnv());
    const requested = [];
    const optionsByKind = new Map();
    for (const check of stagingRefreshSetMatrix) {
      for (const selection of check.selections) {
        const items = optionsByKind.get(selection.queryKind) ?? [];
        items.push({ label: selection.labels[0], value: selection.values[0] ?? selection.labels[0] });
        optionsByKind.set(selection.queryKind, items);
      }
    }
    const report = await runStagingRefreshPreflight(
      {
        ...parseStagingRefreshPreflightArgs(
          ["--skip-github-metadata", "--skip-doctl", "--skip-overlap-check", "--allow-credited-provider-reads"],
          { ...validSecretEnv(), PLATFORM_ADMIN_EMAIL: "admin@example.test", PLATFORM_ADMIN_PASSWORD: "password" },
        ),
      },
      {
        fetch: async (url) => {
          const parsed = new URL(url);
          requested.push(parsed);
          if (parsed.pathname === "/api/auth/password-sign-in") {
            return Response.json({ sessionToken: "fixture-session" });
          }
          if (parsed.pathname.endsWith("/integration-control-plane/overview")) {
            return Response.json({
              providerReadiness: {
                providers: [
                  {
                    providerKey: "tcgplayer",
                    readiness: "ready",
                    credentialReadiness: "ready",
                    credentialReadinessState: "configured",
                    diagnostics: [],
                  },
                  {
                    providerKey: "scrydex",
                    readiness: "degraded",
                    credentialReadiness: "ready",
                    credentialReadinessState: "configured",
                    diagnostics: [{ code: "scrydex-account-credit-low" }],
                  },
                ],
              },
            });
          }
          return Response.json({
            items: optionsByKind.get(parsed.searchParams.get("queryKind")) ?? [],
            page: { hasMore: false, nextCursor: null },
          });
        },
      },
    );

    const overviewIndex = requested.findIndex((url) => url.pathname.endsWith("/integration-control-plane/overview"));
    const firstOptionIndex = requested.findIndex((url) => url.pathname.endsWith("/integration-options"));
    expect(overviewIndex).toBeGreaterThan(-1);
    expect(firstOptionIndex).toBeGreaterThan(overviewIndex);
    expect(
      requested.some(
        (url) => url.pathname.endsWith("/integration-options") && url.searchParams.get("providerKey") === "scrydex",
      ),
    ).toBe(false);
    expect(report.scrydexCreditCategory).toBe("low");
    expect(report.blockers).toContain("scrydex-credit:low");
  });
});

describe("staging refresh set matrix", () => {
  it("matches labels and provider values case-insensitively", () => {
    expect(
      matchingExpectedOption([{ label: "Other", value: "op01" }], {
        labels: ["Romance Dawn"],
        values: ["OP01"],
      }),
    ).toEqual({ label: "Other", value: "op01" });
  });

  it("paginates beyond the first 25-option page before declaring a set missing", async () => {
    const cursors = [];
    const found = await findExpectedOptionAcrossPages({ labels: ["Surging Sparks"], values: [] }, async (cursor) => {
      cursors.push(cursor);
      return cursor === null
        ? {
            items: Array.from({ length: 25 }, (_, index) => ({ label: `Set ${index}`, value: String(index) })),
            page: { hasMore: true, nextCursor: "offset:25" },
          }
        : {
            items: [{ label: "Surging Sparks", value: "SV08" }],
            page: { hasMore: false, nextCursor: null },
          };
    });

    expect(cursors).toEqual([null, "offset:25"]);
    expect(found).toMatchObject({ match: { label: "Surging Sparks" }, pageCount: 2, optionCount: 26 });
  });

  it("does not contact Scrydex until credited-provider reads are explicitly approved", async () => {
    const requested = [];
    const allOptionsByKind = new Map();
    for (const check of stagingRefreshSetMatrix) {
      for (const selection of check.selections) {
        const items = allOptionsByKind.get(selection.queryKind) ?? [];
        for (const label of selection.labels) {
          items.push({ label, value: selection.values[0] ?? label });
        }
        for (const value of selection.values) {
          items.push({ label: selection.labels[0] ?? value, value });
        }
        allOptionsByKind.set(selection.queryKind, items);
      }
    }
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      requested.push(parsed);
      const queryKind = parsed.searchParams.get("queryKind");
      return new Response(
        JSON.stringify({
          items: allOptionsByKind.get(queryKind) ?? [],
          page: { hasMore: false, nextCursor: null },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const results = await inspectSetMatrix(
      { adminBaseUrl: "https://admin.example", allowCreditedProviderReads: false },
      "chase_sets_session=fixture",
      fetchImpl,
    );

    expect(
      results.filter((result) => result.providerKey === "scrydex").every((result) => result.state === "human-gated"),
    ).toBe(true);
    expect(requested.some((url) => url.searchParams.get("providerKey") === "scrydex")).toBe(false);
    expect(
      results.filter((result) => result.providerKey !== "scrydex").every((result) => result.state === "confirmed"),
    ).toBe(true);
  });

  it("covers every epic product line and provider while excluding the gated Scrydex Lorcana sealed profile", () => {
    const coverage = new Set(stagingRefreshSetMatrix.map((check) => `${check.productLine}:${check.providerKey}`));
    for (const expected of [
      "pokemon:tcgdex",
      "pokemon:tcgplayer",
      "mtg:mtgjson",
      "mtg:scryfall",
      "mtg:tcgplayer",
      "yugioh:ygoprodeck",
      "yugioh:ygojson",
      "yugioh:tcgplayer",
      "one-piece:scrydex",
      "one-piece:tcgplayer",
      "lorcana:lorcanajson",
      "lorcana:lorcast",
      "lorcana:scrydex",
      "lorcana:tcgplayer",
    ]) {
      expect(coverage, expected).toContain(expected);
    }
    expect(stagingRefreshSetMatrix.flatMap((check) => check.unitKeys)).not.toContain(
      "scrydex:lorcana:sealed-product:source-observation-import",
    );
  });
});

describe("staging refresh overlap and CLI posture", () => {
  it("reports only active workflows that can overlap the refresh and ignores the current run", () => {
    expect(
      activeStagingRefreshOverlaps(
        [
          { databaseId: 1, name: "Platform Staging Reset", status: "in_progress", url: "https://example/1" },
          { databaseId: 2, name: "Platform Deploy", status: "queued", url: "https://example/2" },
          { databaseId: 3, name: "Platform PR", status: "in_progress", url: "https://example/3" },
          { databaseId: 4, name: "Platform Staging Wake Drills", status: "completed", url: "https://example/4" },
        ],
        "1",
      ),
    ).toEqual([{ databaseId: 2, name: "Platform Deploy", status: "queued", url: "https://example/2" }]);
  });

  it("requires an explicit flag before credited-provider reads", () => {
    expect(parseStagingRefreshPreflightArgs([], {}).allowCreditedProviderReads).toBe(false);
    expect(parseStagingRefreshPreflightArgs(["--allow-credited-provider-reads"], {}).allowCreditedProviderReads).toBe(
      true,
    );
  });

  it("requires an explicit operator confirmation for future evidence-window overlap", () => {
    expect(parseStagingRefreshPreflightArgs([], {}).scheduledOverlapConfirmed).toBe(false);
    expect(parseStagingRefreshPreflightArgs(["--confirm-no-scheduled-overlap"], {}).scheduledOverlapConfirmed).toBe(
      true,
    );
  });
});
