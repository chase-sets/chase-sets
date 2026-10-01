import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../../index";
import {
  createPostgresTcgplayerAutomationHttpConfigStore,
  TCGPLAYER_AUTOMATION_DOMAIN_KEYS,
} from "./tcgplayer-automation-client";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("TCGplayer shared domain budget", () => {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "tcgplayer_shared_budget");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(catalogModule, pools.catalog);
  });

  afterAll(async () => closeMultiContextTestPools(pools));

  it("admits through one authority across independent store instances", async () => {
    const first = createPostgresTcgplayerAutomationHttpConfigStore(pools.catalog);
    const second = createPostgresTcgplayerAutomationHttpConfigStore(pools.catalog);
    const firstAdmission = await first.admitDomainRequest!(
      TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API,
      "api",
      30_000,
    );
    const secondAdmission = await second.admitDomainRequest!(
      TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API,
      "worker",
      30_000,
    );

    expect(firstAdmission.granted).toBe(true);
    expect(secondAdmission.granted).toBe(false);
    expect(Date.parse(secondAdmission.notBefore)).toBeGreaterThanOrEqual(Date.parse(secondAdmission.admittedAt));

    await first.releaseDomainLease!(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API, firstAdmission.leaseId!, "api");
    await pools.catalog.query(
      "UPDATE catalog_tcgplayer_automation_domain_rate_limits SET last_request_started_at = clock_timestamp() - interval '1 minute' WHERE domain_key = $1",
      [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API],
    );
    const recovered = await second.admitDomainRequest!(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API, "worker", 30_000);
    expect(recovered.granted).toBe(true);
    await second.releaseDomainLease!(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API, recovered.leaseId!, "worker");
  });

  it("fences predecessor delay column names and reclaims expired leases", async () => {
    await expect(
      pools.catalog.query(
        "SELECT request_delay_ms, learned_min_delay_ms FROM catalog_tcgplayer_automation_domain_rate_limits",
      ),
    ).rejects.toBeDefined();

    const store = createPostgresTcgplayerAutomationHttpConfigStore(pools.catalog);
    const admission = await store.admitDomainRequest!(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY, "stale", 30_000);
    expect(admission.granted).toBe(true);
    await pools.catalog.query(
      "UPDATE catalog_tcgplayer_automation_domain_rate_limit_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE lease_id = $1",
      [admission.leaseId],
    );
    await pools.catalog.query(
      "UPDATE catalog_tcgplayer_automation_domain_rate_limits SET last_request_started_at = clock_timestamp() - interval '1 minute' WHERE domain_key = $1",
      [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY],
    );
    const reclaimed = await store.admitDomainRequest!(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY, "new", 30_000);
    expect(reclaimed.granted).toBe(true);
    await store.releaseDomainLease!(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY, reclaimed.leaseId!, "new");
  });
});
