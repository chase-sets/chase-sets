import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  attachReadConsistencyMiddleware,
  type ReadConsistencyProjectionGroup,
  type ReadConsistencyRouteDependency,
} from "@chase-sets/bounded-context-runtime";
import { CHASE_SETS_READ_AFTER_WRITE_HEADER, encodeFreshWriteReceipt } from "@chase-sets/http/responses";

type MarketplaceManifest = Readonly<{
  apiMounts: readonly Readonly<{
    mountPath: string;
    kind: string;
    readFreshnessRoutes?: readonly ReadConsistencyRouteDependency[];
  }>[];
  projectionGroups: readonly Readonly<{ projectionName: string; ownedTables?: readonly string[] }>[];
}>;

const manifest = JSON.parse(
  readFileSync(
    resolve(fileURLToPath(new URL("../../../../..", import.meta.url)), "bounded-contexts/marketplace/context.json"),
    "utf8",
  ),
) as MarketplaceManifest;
const mount = manifest.apiMounts.find(
  (candidate) => candidate.mountPath === "/api/marketplace" && candidate.kind === "primary",
)!;
const policyProjection = "platform-policy-document-projection";

// A policy write's receipt names marketplace, the source its policy document projection subscribes under.
const receipt = encodeFreshWriteReceipt({
  observedAtMs: Date.now(),
  sources: [{ sourceContextName: "marketplace", maxGlobalPosition: "10", eventIds: ["evt_policy_draft"] }],
});

async function readOverview(lagging: string) {
  const groups = manifest.projectionGroups.map<ReadConsistencyProjectionGroup>((group) => ({
    targetContextName: "marketplace",
    projectionName: group.projectionName,
    ownedTables: group.ownedTables,
    subscriptionRunners: [
      {
        sourceContextName: "marketplace",
        checkpointKey: `${group.projectionName}:marketplace:v1`,
        refreshStatus: async () => ({
          lastGlobalPosition: group.projectionName === lagging ? "9" : "10",
          state: group.projectionName === lagging ? "behind" : "caught-up",
        }),
      },
    ],
  }));
  const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
  attachReadConsistencyMiddleware(
    { use: (_path, middleware) => void middlewares.push(middleware) },
    [{ contextName: "marketplace", mountPath: mount.mountPath, readFreshnessRoutes: mount.readFreshnessRoutes }],
    groups,
    { timeoutMs: 0, pollIntervalMs: 1 },
  );
  const handler = vi.fn(async () => undefined);
  const result = await middlewares[0]!(
    {
      req: {
        method: "GET",
        path: "/api/marketplace/listing-evidence-policy",
        header: (name: string) => (name === CHASE_SETS_READ_AFTER_WRITE_HEADER ? receipt : undefined),
      },
      json: (body: unknown, status: number) => ({ body, status }),
    },
    handler,
  );
  return { result, handlerCalls: handler.mock.calls.length };
}

describe("Listing Evidence Policy overview read after a write", () => {
  it("waits for the policy document projection the write's receipt names", async () => {
    const behind = await readOverview(policyProjection);

    expect(behind.handlerCalls).toBe(0);
    expect(behind.result).toMatchObject({
      status: 503,
      body: { error: { code: "projection_freshness_timeout", waitMode: "exact-dependency" } },
    });
  });

  it("reads once that projection has the write, whatever other projections lag", async () => {
    const fresh = await readOverview("marketplace-listing-projection");

    expect(fresh.result).toBeUndefined();
    expect(fresh.handlerCalls).toBe(1);
  });
});
