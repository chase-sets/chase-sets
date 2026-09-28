import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION, type EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createProductMeasureRuntime, type ProductMeasureProfileInput } from "./runtime";
import {
  readAuthoritativeProductMeasureProfiles,
  recordProductMeasureProfile,
  productMeasureProfilesStream,
  productMeasureProfileRecorded,
} from "./profiles";

const context: EventStoreContext = {
  tenantId: "tnt_synthetic",
  audit: { forAccountId: "acc_synthetic", performedByUserId: "usr_synthetic" },
};
const profile: ProductMeasureProfileInput = {
  profileId: "pmp_synthetic",
  key: "synthetic",
  name: "Synthetic profile",
  unitLengthInches: 1,
  unitWidthInches: 2,
  unitHeightInches: 3,
  unitWeightOunces: 4,
  physicalFlags: ["rigid"],
  stackBehavior: "non-stackable",
  confidence: "measured",
};

describe("Product Measure Profile authority", () => {
  it("retains source revision and inactive state through replay without accepting a stale initialization", async () => {
    const { eventStore } = createInMemoryEventStore();
    expect(await recordProductMeasureProfile(eventStore, profile, context)).toBe(1);
    const inactive = { ...profile, status: "inactive" as const, unitWeightOunces: 5 };
    expect(await recordProductMeasureProfile(eventStore, inactive, context)).toBe(2);
    expect(await recordProductMeasureProfile(eventStore, profile, context, "initialize")).toBe(2);
    const replay = await readAuthoritativeProductMeasureProfiles(eventStore);
    expect(replay.profiles[0]).toMatchObject({
      status: "inactive",
      measure_snapshot: { unitWeightOunces: 5, measureVersion: "synthetic:r2" },
    });
    expect(await eventStore.readStream({ streamId: productMeasureProfilesStream })).toHaveLength(2);
  });

  it("rejects malformed physical authority both on write and historical replay", async () => {
    const { eventStore } = createInMemoryEventStore();
    await expect(
      recordProductMeasureProfile(eventStore, { ...profile, unitWeightOunces: Number.POSITIVE_INFINITY }, context),
    ).rejects.toThrow();
    await eventStore.appendToStream({
      streamId: productMeasureProfilesStream,
      expectedVersion: 0,
      context,
      events: [
        {
          eventType: productMeasureProfileRecorded,
          payload: { profile: { ...profile, stackBehavior: "synthetic-corrupt" } },
        },
      ],
    });
    await expect(readAuthoritativeProductMeasureProfiles(eventStore)).rejects.toThrow();
  });

  it("reconciles a legacy SQL-only profile with a restart-safe event first and a revision-guarded projection", async () => {
    const { eventStore } = createInMemoryEventStore();
    let sourceRevision = 0;
    let crash = true;
    const inserts: unknown[][] = [];
    const db: PgQueryable = {
      async query<Row>(sql: string, values?: readonly unknown[]) {
        if (sql.includes("WHERE source_revision = 0"))
          return {
            rows: (sourceRevision
              ? []
              : [
                  {
                    profile_id: profile.profileId,
                    key: profile.key,
                    name: profile.name,
                    status: "active",
                    match_blueprint_id: null,
                    match_category_ids: [],
                    match_selected_options: [],
                    precedence: 100,
                    measure_snapshot: profile,
                  },
                ]) as Row[],
          };
        if (sql.includes("INSERT INTO catalog_product_measure_profiles")) {
          expect(sql).toContain("WHERE catalog_product_measure_profiles.source_revision <= EXCLUDED.source_revision");
          if (crash) {
            crash = false;
            throw new Error("synthetic projection interruption");
          }
          sourceRevision = Number(values![8]);
          inserts.push([...values!]);
          return { rows: [] as Row[] };
        }
        throw new Error("Unexpected synthetic migration query.");
      },
    };
    const restart = () =>
      createProductMeasureRuntime({
        eventStore,
        db,
        checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
      });
    await expect(restart().reconcileProfileAuthority(context)).rejects.toThrow("synthetic projection interruption");
    expect(await eventStore.readStream({ streamId: productMeasureProfilesStream })).toHaveLength(1);
    expect(await restart().reconcileProfileAuthority(context)).toBe(1);
    expect(await restart().reconcileProfileAuthority(context)).toBe(0);
    expect(await eventStore.readStream({ streamId: productMeasureProfilesStream })).toHaveLength(1);
    expect(JSON.parse(String(inserts[0]![6]))).toMatchObject({ measureVersion: "synthetic:r1" });
  });
});
