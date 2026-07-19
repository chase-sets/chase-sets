import { afterEach, describe, expect, it } from "vitest";
import {
  stagingRefreshOverlapWorkflowFiles,
  stagingRefreshRequiredSecrets,
  stagingRefreshSetMatrix,
} from "./staging-refresh-preflight-config.mjs";
import {
  activeStagingRefreshOverlaps,
  deployedSecretPostureFromKeys,
  evaluateProviderPosture,
  evaluateStagingRefreshSecrets,
  findExpectedOptionAcrossPages,
  githubActiveRuns,
  inspectSetMatrix,
  matchingExpectedOption,
  parseStagingRefreshPreflightArgs,
  resolveAuthenticatedGitHubActionsIdentity,
  runStagingRefreshPreflight,
  runStagingRefreshOverlapGate,
  stagingRefreshOverlapWorkflowNames,
  workflowNameFromFile,
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

  it("reports only deployed Kubernetes Secret key posture", () => {
    const posture = deployedSecretPostureFromKeys(stagingRefreshRequiredSecrets.map((secret) => secret.name));

    expect(posture.every((secret) => secret.state === "configured")).toBe(true);
    expect(posture[0]).toEqual({ name: stagingRefreshRequiredSecrets[0].name, state: "configured" });
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
          [
            "--skip-github-metadata",
            "--skip-deployed-secret-check",
            "--skip-overlap-check",
            "--allow-credited-provider-reads",
          ],
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

  it("pins every set and provider row required by the authoritative epic matrix", () => {
    expect(stagingRefreshSetMatrix.map((check) => check.id)).toEqual([
      "pokemon-en-base-set-tcgdex",
      "pokemon-en-base-set-tcgplayer",
      "pokemon-en-surging-sparks-tcgplayer",
      "pokemon-en-surging-sparks-tcgdex",
      "pokemon-ja-super-electric-breaker-tcgdex",
      "pokemon-ja-triplet-beat-tcgdex",
      "pokemon-zh-tw-surging-sparks-tcgdex",
      "pokemon-ko-surging-sparks-tcgdex",
      "mtg-fifth-dawn-mtgjson",
      "mtg-time-spiral-mtgjson",
      "mtg-fifth-dawn-scryfall",
      "mtg-time-spiral-scryfall",
      "mtg-fifth-dawn-tcgplayer",
      "mtg-time-spiral-tcgplayer",
      "yugioh-legend-blue-eyes-ygoprodeck",
      "yugioh-rarity-collection-ygoprodeck",
      "yugioh-legend-blue-eyes-ygojson",
      "yugioh-rarity-collection-ygojson",
      "yugioh-legend-blue-eyes-tcgplayer",
      "yugioh-rarity-collection-tcgplayer",
      "one-piece-romance-dawn-scrydex-cards",
      "one-piece-op09-scrydex-sealed",
      "one-piece-romance-dawn-tcgplayer",
      "lorcana-first-chapter-lorcanajson",
      "lorcana-first-chapter-lorcast",
      "lorcana-first-chapter-scrydex",
      "lorcana-first-chapter-tcgplayer",
      "lorcana-rise-floodborn-lorcanajson",
      "lorcana-rise-floodborn-lorcast",
      "lorcana-rise-floodborn-scrydex",
      "lorcana-rise-floodborn-tcgplayer",
    ]);
    expect(stagingRefreshSetMatrix.flatMap((check) => check.unitKeys)).not.toContain(
      "scrydex:lorcana:sealed-product:source-observation-import",
    );
  });

  it("accepts the current TCGplayer display labels for pinned representative sets", () => {
    const pokemon = stagingRefreshSetMatrix.find((check) => check.id === "pokemon-en-surging-sparks-tcgplayer");
    const yugioh = stagingRefreshSetMatrix.find((check) => check.id === "yugioh-legend-blue-eyes-tcgplayer");

    expect(pokemon?.selections.at(-1)?.labels).toContain("SV08: Surging Sparks");
    expect(yugioh?.selections.at(-1)?.labels).toContain("The Legend of Blue Eyes White Dragon");
  });
});

describe("staging refresh overlap and CLI posture", () => {
  it("derives the overlap allowlist from the real workflow names", () => {
    expect(stagingRefreshOverlapWorkflowNames).toEqual([
      "Platform Deploy",
      "Platform Staging Reset",
      "Platform Staging Wake Drills",
      "Platform Staging Mixed-Version Wake Evidence",
      "Platform Database Restore Drill",
      "Catalog Staging Provider UAT",
      "Catalog Integration Staging Reset",
      "Platform Staging Representative Commerce State",
    ]);
    expect(stagingRefreshOverlapWorkflowFiles.map(workflowNameFromFile)).toEqual(stagingRefreshOverlapWorkflowNames);
  });

  it("reports real active overlap workflow names and ignores the current run", () => {
    expect(
      activeStagingRefreshOverlaps(
        [
          { databaseId: 1, name: "Platform Staging Reset", status: "in_progress", url: "https://example/1" },
          { databaseId: 2, name: "Platform Deploy", status: "queued", url: "https://example/2" },
          { databaseId: 3, name: "Platform PR", status: "in_progress", url: "https://example/3" },
          {
            databaseId: 4,
            name: "Platform Staging Mixed-Version Wake Evidence",
            status: "in_progress",
            url: "https://example/4",
          },
        ],
        "1",
      ),
    ).toEqual([
      { databaseId: 2, name: "Platform Deploy", status: "queued", url: "https://example/2" },
      {
        databaseId: 4,
        name: "Platform Staging Mixed-Version Wake Evidence",
        status: "in_progress",
        url: "https://example/4",
      },
    ]);
  });

  it("paginates every active GitHub run status beyond the first 100 results", async () => {
    const calls = [];
    const runs = await githubActiveRuns({ repository: "chase-sets/chase-sets" }, async (command, args) => {
      calls.push({ command, args });
      const endpoint = args.find((arg) => arg.startsWith("repos/"));
      const status = new URL(`https://example.test/${endpoint}`).searchParams.get("status");
      return {
        stdout:
          status === "in_progress"
            ? Array.from({ length: 101 }, (_, index) => ({
                databaseId: index + 1,
                name: "Platform Deploy",
                status,
                url: `https://example/${index + 1}`,
              }))
                .map((run) => JSON.stringify(run))
                .join("\n")
            : "",
      };
    });

    expect(runs).toHaveLength(101);
    expect(calls).toHaveLength(5);
    expect(calls.every(({ command, args }) => command === "gh" && args.includes("--paginate"))).toBe(true);
    expect(calls.every(({ args }) => args.some((arg) => arg.includes("per_page=100")))).toBe(true);
  });

  it("derives repository and verifies the current reset run through authenticated gh responses", async () => {
    const calls = [];
    const identity = await resolveAuthenticatedGitHubActionsIdentity(
      {
        workflowFile: ".github/workflows/catalog-integration-staging-reset.yml",
        runIdHint: "5718",
      },
      async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "repo") return { stdout: "chase-sets/chase-sets\n" };
        return {
          stdout: JSON.stringify({
            databaseId: 5718,
            repository: "chase-sets/chase-sets",
            path: ".github/workflows/catalog-integration-staging-reset.yml",
            event: "workflow_dispatch",
            status: "in_progress",
          }),
        };
      },
    );

    expect(identity).toEqual({ repository: "chase-sets/chase-sets", currentRunId: "5718" });
    expect(calls[0]).toEqual(
      expect.objectContaining({ command: "gh", args: expect.arrayContaining(["repo", "view", "nameWithOwner"]) }),
    );
    expect(calls[1].args).toContain("repos/chase-sets/chase-sets/actions/runs/5718");
  });

  it("rejects a supplied run id when authenticated gh says it is not this reset workflow", async () => {
    await expect(
      resolveAuthenticatedGitHubActionsIdentity(
        {
          workflowFile: ".github/workflows/catalog-integration-staging-reset.yml",
          runIdHint: "99",
        },
        async (_command, args) =>
          args[0] === "repo"
            ? { stdout: "chase-sets/chase-sets\n" }
            : {
                stdout: JSON.stringify({
                  databaseId: 99,
                  repository: "chase-sets/chase-sets",
                  path: ".github/workflows/platform-production.yml",
                  event: "workflow_dispatch",
                  status: "in_progress",
                }),
              },
      ),
    ).rejects.toThrow("authenticated-github-run-identity-mismatch");
  });

  it("fails the final overlap-only gate closed when an overlapping workflow starts", async () => {
    const report = await runStagingRefreshOverlapGate(
      { repository: "chase-sets/chase-sets", environment: "staging", currentRunId: "1" },
      {
        execFile: async (_command, args) => ({
          stdout: args.some((arg) => arg.includes("status=in_progress"))
            ? JSON.stringify({
                databaseId: 2,
                name: "Platform Staging Mixed-Version Wake Evidence",
                status: "in_progress",
                url: "https://example/2",
              })
            : "",
        }),
      },
    );

    expect(report.result).toBe("blocked");
    expect(report.blockers).toContain("overlap:Platform Staging Mixed-Version Wake Evidence:in_progress");
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
