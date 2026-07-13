import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../features/source-observations/ui/primary-workbench-route-context";
import {
  commandRedirectHref,
  type CatalogIntegrationsCommandResult,
} from "../support/route-support/admin-integrations/integrations-command-result";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

type CatalogMutationConsistencyEntry = Readonly<{
  id: string;
  owner: string;
  risk: string;
  strategy: string;
  surfaces?: readonly string[];
  visibleDestination?: Readonly<{
    routeId?: string;
    description?: string;
  }>;
  proof?: Readonly<{
    authoritativeResponse?: string;
    fallback?: string;
    tests?: readonly string[];
  }>;
  exception?: Readonly<{
    owner?: string;
    reason?: string;
    reviewBy?: string;
    issue?: string;
  }>;
}>;

type CatalogContext = Readonly<{
  mutationConsistencyInventory: readonly CatalogMutationConsistencyEntry[];
  projectionGroups?: readonly Readonly<{
    projectionName: string;
    sourceContextNames?: readonly string[];
    ownedTables?: readonly string[];
    resetStrategy?: string;
  }>[];
  readAfterWriteRouteInventory?: readonly unknown[];
}>;

type MutationConsistencyBaseline = Readonly<{
  surfaces: readonly string[];
}>;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(repoRoot, path), "utf8")) as T;
}

function catalogContext(): CatalogContext {
  return readJson<CatalogContext>("bounded-contexts/catalog/context.json");
}

describe("catalog admin post-write default-safe contract", () => {
  it("keeps Catalog out of the shared mutation-consistency baseline", () => {
    const baseline = readJson<MutationConsistencyBaseline>(
      "scripts/check-structure/mutation-consistency-baseline.json",
    );

    expect(baseline.surfaces.filter((surface) => surface.includes("bounded-contexts/catalog/"))).toEqual([]);
  });

  it("classifies Catalog admin writes as command snapshots, durable status, or realtime correction", () => {
    const context = catalogContext();
    const entries = context.mutationConsistencyInventory;
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const projectionGroups = new Map((context.projectionGroups ?? []).map((group) => [group.projectionName, group]));

    expect(context.readAfterWriteRouteInventory ?? []).toEqual([]);
    expect(projectionGroups.get("catalog-product-contents-projection")).toMatchObject({
      sourceContextNames: ["catalog"],
      ownedTables: ["catalog_resolved_product_contents"],
      resetStrategy: "truncate-owned-tables",
    });
    expect(entries.map((entry) => entry.strategy)).not.toContain("fresh-read");
    expect(entries.every((entry) => entry.owner === "catalog")).toBe(true);

    expect(byId.get("catalog.admin-model-api-command-snapshots")).toMatchObject({
      strategy: "snapshot-return",
      visibleDestination: {
        description: expect.stringContaining("committed aggregate snapshot"),
      },
      proof: {
        authoritativeResponse: expect.stringContaining("evolved aggregate state"),
      },
    });
    expect(byId.get("catalog.catalog-item-api-command-snapshots")).toMatchObject({
      strategy: "snapshot-return",
      visibleDestination: {
        description: expect.stringContaining("committed aggregate snapshot"),
      },
      proof: {
        authoritativeResponse: expect.stringContaining("evolved aggregate state"),
      },
    });
    expect(byId.get("catalog.source-observation-api-command-snapshots")).toMatchObject({
      strategy: "snapshot-return",
      visibleDestination: {
        routeId: "integrations",
        description: expect.stringContaining("durable job event streams"),
      },
      proof: {
        authoritativeResponse: expect.stringContaining("durable job"),
      },
    });
    expect(byId.get("catalog.shell-source-observation-workbench-correction")).toMatchObject({
      strategy: "realtime-correction",
      visibleDestination: {
        routeId: "integrations",
        description: expect.stringContaining("durable job event streams"),
      },
      proof: {
        fallback: expect.stringContaining("sync.required.snapshot"),
      },
    });
    expect(byId.get("catalog.integrations-route-action-command-snapshots")).toMatchObject({
      strategy: "snapshot-return",
      surfaces: [
        "route-action:bounded-contexts/catalog/support/route-support/admin-integrations/integrations-action.ts",
      ],
      proof: {
        authoritativeResponse: expect.stringContaining("CatalogIntegrationsCommandResult"),
      },
    });
  });

  it("keeps operator-surface command redirects free of browser fresh-read handoff params", () => {
    // Profile lifecycle (clone/section-edit/activate/rollback/deprecate/retire)
    // moved off this deprecated ?section= workspace router onto the v2 Provider
    // detail page (#3832; see provider-detail-action.ts, which builds its own
    // redirect and never calls commandRedirectHref). This still exercises the
    // legacy commandRedirectHref helper for a surface it still owns: governance
    // controls.
    const result: CatalogIntegrationsCommandResult = {
      feedback: {
        status: "success",
        intent: "activate-provider-profile",
        result: "profile-activated",
      },
      context: parseCatalogPrimaryWorkbenchRouteContext(
        "https://admin.example/catalog/integrations/governance?providerKey=tcgdex&profileVersion=2026.06.04&selectedObservationIds=obs_001",
      ),
      section: "controls",
      commandSection: "migration-evidence",
    };

    const href = commandRedirectHref(result);
    const redirected = new URL(href, "https://admin.example");

    expect(redirected.pathname).toBe("/catalog/integrations/governance");
    expect(redirected.searchParams.get("commandStatus")).toBe("success");
    expect(redirected.searchParams.get("commandResult")).toBe("profile-activated");
    expect(redirected.searchParams.get("commandSection")).toBe("migration-evidence");
    expect(redirected.searchParams.get("afterWrite")).toBeNull();
    expect(redirected.searchParams.get("postWriteHandoff")).toBeNull();
  });
});
