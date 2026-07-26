import type { BcApiModule, BcSeedAggregateStateReport, BcSeedOptions } from "@chase-sets/bounded-context-module";
import { seedApiHostIfEmpty } from "@chase-sets/platform-runtime/api";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { describe, expect, it } from "vitest";
import { createPlatformApiHost } from "../src/app";
import type { PlatformApiContextName } from "../src/config";
import { apiContextRegistry } from "../src/generated/api-context-registry";
import {
  createPlatformApiBootstrapTestHarness,
  listingPhotoStorage,
  type PlatformApiTestPools,
} from "./bootstrap-db-test-support";

/**
 * DB-tier coverage for #4906 across every mounted context: a seed must decide
 * what remains to author from its authoritative `event_store_events` streams,
 * never from an UNLOGGED read-model projection that PostgreSQL truncates on
 * crash recovery.
 *
 * The caller inventory below is the one recorded on the issue. Each entry names
 * the projection tables whose truncation used to make that context's seed
 * re-issue a create command into an already-existing aggregate. The confirmed
 * inventory failure and the resume/fail-closed controls live in the cheaper
 * `inventory-seed-resume.db.test.ts` partition.
 */
const callerInventory = [
  {
    contextName: "inventory",
    projections: ["inventory_holds", "inventory_items", "inventory_storage_locations"],
  },
  { contextName: "identity", projections: ["identity_accounts"] },
  {
    contextName: "marketplace",
    projections: ["marketplace_review_pages", "marketplace_offer_pages", "marketplace_listing_pages"],
  },
  { contextName: "payments", projections: ["payments_payment_pages"] },
  { contextName: "settlement", projections: ["settlement_payout_pages"] },
  { contextName: "fulfillment", projections: ["fulfillment_shipment_pages"] },
  { contextName: "checkout", projections: ["checkout_cart_line_pages", "checkout_session_pages"] },
  { contextName: "ordering", projections: ["ordering_order_pages", "ordering_postage_policy_pages"] },
  {
    contextName: "platform-operations",
    projections: ["experience_platform_feedback_pages", "support_request_pages"],
  },
] as const satisfies readonly Readonly<{ contextName: PlatformApiContextName; projections: readonly string[] }>[];

/**
 * Mounted contexts that seed but deliberately declare no stream-sourced seed
 * state, with the reason. A newly mounted seeding context is a coverage
 * omission unless it is added here on purpose, which is what makes the
 * enumeration below fail loudly rather than silently shrink.
 */
const seedStateExemptions = new Map<string, string>([
  ["pricing", "seed is a no-op; it authors no aggregate"],
  ["commercial-terms", "authors logged platform-policy documents, not UNLOGGED projections"],
  ["public-presence", "authors logged platform-policy documents and promo-bar rows, not UNLOGGED projections"],
]);

let pools: PlatformApiTestPools;
createPlatformApiBootstrapTestHarness("platform_api_authoritative_seed_resume", (state) => {
  pools = state.pools;
});

type SeedingModule = Pick<BcApiModule<unknown, unknown, unknown>, "contextName" | "seed" | "inspectSeedState">;

function createHost() {
  return createPlatformApiHost({
    runtimeProfile: "public",
    pools,
    hostPorts: {
      processorGateway: createFakePaymentProcessorGateway(),
      listingPhotoStorage,
    },
  });
}

const seedOptions: BcSeedOptions = {
  enabledDataProfiles: ["critical-bootstrap", "catalog-integration-bootstrap", "scenario-seed"],
  environmentName: "test",
};

async function ordinaryBoot(runtime: ReturnType<typeof createHost>): Promise<void> {
  await seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime, seedOptions);
}

/**
 * Re-invokes every mounted context's `seed` in host seed order, which is the
 * caller shape `platform-runtime/api.ts` uses at `:468` (seed), `:475`
 * (`projection-drain:<context>`), and `:494` (`seed-reconcile:<context>`)
 * within a single boot.
 */
async function invokeConvertedSeeds(runtime: ReturnType<typeof createHost>): Promise<void> {
  for (const entry of callerInventory) {
    const context = runtime.mountedContexts.find((mounted) => mounted.contextName === entry.contextName);
    if (!context?.module.seed) {
      throw new Error(`Context '${entry.contextName}' is not mounted with a seed.`);
    }
    await context.module.seed(context.pool, context.services, seedOptions);
  }
}

function seedingModules(runtime: ReturnType<typeof createHost>): readonly SeedingModule[] {
  return runtime.mountedModules.map((entry) => entry.module as SeedingModule).filter((module) => Boolean(module.seed));
}

function poolFor(contextName: string) {
  return pools[contextName as PlatformApiContextName];
}

async function contextEventCount(contextName: string): Promise<number> {
  const result = await poolFor(contextName).query<Readonly<{ count: string }>>(
    "SELECT COUNT(*) AS count FROM event_store_events",
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function allContextEventCounts(): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const entry of callerInventory) {
    counts[entry.contextName] = await contextEventCount(entry.contextName);
  }
  return counts;
}

function summarizeStates(reports: readonly BcSeedAggregateStateReport[]): string {
  const byKind = new Map<string, number>();
  for (const report of reports) {
    byKind.set(report.kind, (byKind.get(report.kind) ?? 0) + 1);
  }
  return [...byKind.entries()].map(([kind, count]) => `${kind}=${count}`).join(" ");
}

describe("authoritative seed resume", () => {
  it("enumerates stream-sourced seed-state coverage from the runtime mount list", async () => {
    const runtime = createHost();
    const modules = seedingModules(runtime);
    expect(modules.length).toBeGreaterThan(0);

    const missing = modules
      .filter((module) => !module.inspectSeedState && !seedStateExemptions.has(module.contextName))
      .map((module) => module.contextName);
    expect(missing, `seeding contexts without stream-sourced seed state: ${missing.join(", ")}`).toEqual([]);

    // No stale exemptions: every exempt name must still be a mounted seeding context.
    const mountedNames = new Set(modules.map((module) => module.contextName));
    const staleExemptions = [...seedStateExemptions.keys()].filter((name) => !mountedNames.has(name));
    expect(staleExemptions).toEqual([]);

    // Every context in the issue's caller inventory is covered, and none is exempt.
    for (const entry of callerInventory) {
      const module = modules.find((candidate) => candidate.contextName === entry.contextName);
      expect(module, `caller-inventory context '${entry.contextName}' is not mounted`).toBeDefined();
      expect(seedStateExemptions.has(entry.contextName)).toBe(false);
      expect(module?.inspectSeedState, `'${entry.contextName}' declares no inspectSeedState`).toBeDefined();
    }

    // Omission negative control: a mounted seeding context that does not declare
    // stream-sourced seed state must be reported by the very same enumeration.
    const withOmission = modules.map((module) =>
      module.contextName === "inventory" ? { contextName: module.contextName, seed: module.seed } : module,
    );
    const omitted = withOmission
      .filter((module) => !module.inspectSeedState && !seedStateExemptions.has(module.contextName))
      .map((module) => module.contextName);
    expect(omitted).toEqual(["inventory"]);
  });

  it("resumes every converted context after its UNLOGGED guard projections are truncated", async () => {
    const runtime = createHost();
    await ordinaryBoot(runtime);

    const afterBootOne = await allContextEventCounts();
    for (const [contextName, count] of Object.entries(afterBootOne)) {
      expect(count, `${contextName} must have seeded events after boot one`).toBeGreaterThan(0);
    }

    for (const entry of callerInventory) {
      await poolFor(entry.contextName).query(`TRUNCATE TABLE ${entry.projections.join(", ")} CASCADE`);
      for (const projection of entry.projections) {
        const rows = await poolFor(entry.contextName).query<Readonly<{ count: string }>>(
          `SELECT COUNT(*) AS count FROM ${projection}`,
        );
        expect(Number(rows.rows[0]?.count ?? 0), `${entry.contextName}.${projection}`).toBe(0);
      }
    }
    expect(await allContextEventCounts(), "truncating projections must not touch streams").toEqual(afterBootOne);

    // Re-invoke every seed three times against the emptied projections, exactly
    // as one boot does at api.ts:468, :475 and :494. Before this change the
    // inventory pass threw `InventoryDomainError: Storage location has already
    // been created.` and no later context seeded at all.
    for (let invocation = 1; invocation <= 3; invocation += 1) {
      await invokeConvertedSeeds(runtime);
      expect(await allContextEventCounts(), `invocation ${invocation}`).toEqual(afterBootOne);
    }

    const afterBootTwo = await allContextEventCounts();
    expect(afterBootTwo).toEqual(afterBootOne);

    for (const entry of callerInventory) {
      const module = seedingModules(runtime).find((candidate) => candidate.contextName === entry.contextName);
      const reports = await module!.inspectSeedState!(poolFor(entry.contextName));
      console.log(
        `[#4906] ${entry.contextName}: truncated ${entry.projections.join(", ")} -> ` +
          `${reports.length} seed aggregates ${summarizeStates(reports)}, ` +
          `events ${afterBootTwo[entry.contextName]}`,
      );
      for (const report of reports) {
        console.log(
          `[#4906]   ${entry.contextName} ${report.aggregateName} '${report.key}' ` +
            `kind=${report.kind} status=${report.status ?? "-"} events=${report.eventCount} ` +
            `stream=${report.streamId}`,
        );
      }

      expect(reports.length, `${entry.contextName} reports no seed aggregates`).toBeGreaterThan(0);
      // No aggregate may be left half-authored: `draft` after a completed
      // resume is the committed-but-incomplete shape this issue exists to fix.
      const draft = reports.filter((report) => report.kind === "draft");
      expect(draft, `${entry.contextName} left draft aggregates: ${JSON.stringify(draft)}`).toEqual([]);
      expect(
        reports.some((report) => report.kind === "active"),
        `${entry.contextName} resumed no aggregate to active`,
      ).toBe(true);
    }
    // Full-host boot case: same explicit budget the suite already uses for
    // `bootstrap-scenario.db.test.ts`'s single full-host boot.
  }, 300_000);
});
