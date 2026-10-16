// @vitest-environment node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventRecordToStore, EventStoreContext } from "@chase-sets/event-core/storage";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import {
  createPostgresEventStore,
  readGapSafeEventStoreHead,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as platformOperationsModule } from "../../../index";
import { createPlatformOperationsServices } from "../../../support/runtime-support/services";
import { createSupportEvidenceAttachmentReference } from "../domain/attachment-reference";
import { LEGACY_DELETION_CLAIMED, LEGACY_RECONSTRUCTION_STREAM } from "../domain/legacy-evidence";
import { attachmentStorageKey } from "./attachments";
import { createLegacyReferenceReconstruction } from "./legacy-reference-reconstruction";
import { dryRun } from "../../../../../scripts/support-evidence-provider-inventory.mjs";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl) throw new Error("TEST_DATABASE_URL is required for legacy reference reconstruction DB tests.");
const context: EventStoreContext = {
  tenantId: "tnt_legacy_test" as EventStoreContext["tenantId"],
  audit: {
    performedByUserId: "usr_legacy_test" as EventStoreContext["audit"]["performedByUserId"],
    forAccountId: "acc_legacy_test" as EventStoreContext["audit"]["forAccountId"],
  },
};
const bytes = Buffer.from("legacy bytes are never re-encoded");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const attachmentId = `sea_${"0".repeat(26)}`;
const reference = createSupportEvidenceAttachmentReference({ attachmentId, sha256, contentType: "image/png" });
const caseId = "sup_legacy";
const streamId = `support.support-request-${caseId}`;
const key = attachmentStorageKey(caseId, attachmentId, sha256, "image/png");
const evidence = (attachments: string[]): EventRecordToStore => ({
  eventType: "support.support-request.evidence-submitted",
  payload: { evidence: { attachments } },
});

describe("complete legacy reference authority and guarded claims (Postgres)", () => {
  let pools: Readonly<Record<"platform-operations", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  let store: EventStore;
  const service = (eventStore = store) =>
    createLegacyReferenceReconstruction({ eventStore, readHorizon: () => readGapSafeEventStoreHead(pool) });
  const append = async (events: readonly EventRecordToStore[], id = streamId) => {
    const history = await readCompleteStream(store, { streamId: id });
    return store.appendToStream({ streamId: id, expectedVersion: history.at(-1)?.streamVersion ?? 0, context, events });
  };
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl,
      ["platform-operations"],
      "support_legacy_reconstruction",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools["platform-operations"];
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(platformOperationsModule.schemaSql);
    store = createPostgresEventStore({ pool });
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it.each([500, 501])(
    "reads every event across the %i boundary, keeps operation-less legacy references, ignores seed placeholders and is horizon-idempotent",
    async (count) => {
      await append(Array.from({ length: count - 1 }, () => ({ eventType: "support.test-history", payload: {} })));
      await append([evidence([reference, "seed://support/placeholder"])]);
      const horizon = await readGapSafeEventStoreHead(pool);
      const original = await readCompleteStream(store, { streamId });
      const authority = await createPlatformOperationsServices(pool).supportEvidenceLegacy.reconstruct({ horizon });
      expect(authority).toMatchObject({ status: "complete", horizon, count: 1, references: [key], operationKeys: [] });
      const firstReceipt = await readCompleteStream(store, { streamId: LEGACY_RECONSTRUCTION_STREAM });
      expect(firstReceipt).toHaveLength(1);
      expect(firstReceipt[0]!.payload).toEqual({ horizon, count: 1, digest: authority.digest });
      expect(await service().reconstruct({ horizon })).toEqual(authority);
      expect(await readCompleteStream(store, { streamId: LEGACY_RECONSTRUCTION_STREAM })).toEqual(firstReceipt);
      expect(await readCompleteStream(store, { streamId })).toEqual(original);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
    },
  );

  it.each(["stream-gap", "global-gap", "non-contiguous-page", "truncated-stream"])(
    "returns unknown for %s; kills unknown-authority-inventory-bypass",
    async (defect) => {
      await append(
        Array.from({ length: 501 }, (_, index) =>
          index === 500 ? evidence([reference]) : { eventType: "support.test-history", payload: {} },
        ),
      );
      const broken: EventStore = {
        ...store,
        readAll: async (input) => {
          const page = await store.readAll(input);
          return defect === "global-gap" ? page.filter((event) => event.streamVersion !== 2) : page;
        },
        readStream: async (input) => {
          const page = await store.readStream(input);
          if (input.streamId !== streamId) return page;
          if (defect === "stream-gap") return page.filter((event) => event.streamVersion !== 2);
          if (defect === "non-contiguous-page" && input.fromVersion === 501)
            return page.map((event) => ({ ...event, streamVersion: 502 }));
          if (defect === "truncated-stream" && input.fromVersion === 501) return [];
          return page;
        },
      };
      expect((await service(broken).reconstruct()).status).toBe("unknown");
      expect(await readCompleteStream(store, { streamId: LEGACY_RECONSTRUCTION_STREAM })).toHaveLength(0);
      const deps = {
        legacy: service(broken),
        storage: { listPrivate: async () => ({ status: "page", entries: [], nextContinuationToken: null }) },
        options: {
          environment: "test",
          implementationSha: "a".repeat(40),
          imageDigest: `sha256:${"a".repeat(64)}`,
          horizon: await readGapSafeEventStoreHead(pool),
          boundaryReceiptId: "b".repeat(64),
          snapshotReceiptId: "c".repeat(64),
          requestCap: 10,
          requestCostUpperBoundUsd: 0.001,
        },
      };
      expect((await dryRun(deps)).receipt.result).toBe("retention");
      const source = await readFile(
        new URL("../../../../../scripts/support-evidence-provider-inventory.mjs", import.meta.url),
        "utf8",
      );
      const anchor = 'authority.status === "complete"';
      expect(source).toContain(anchor);
      const mutated = source.replace(anchor, "true").replace('current.status === "complete"', "true");
      const bypass = await import(`data:text/javascript;base64,${Buffer.from(mutated).toString("base64")}`);
      // Only the inventory's unknown-authority guard changes. The same broken DB reader remains governing input.
      expect((await bypass.dryRun(deps)).receipt.result).toBe("approval-required");
    },
  );

  it("refuses an unsafe future horizon and malformed storage references, rather than treating absence as completeness", async () => {
    expect((await service().reconstruct({ horizon: "99999999" })).status).toBe("unknown");
    await append([evidence(["support-attachment:v1:malformed"])]);
    expect((await service().reconstruct()).status).toBe("unknown");
  });

  it("reconstructs operation ownership from authoritative staged history, not a locator", async () => {
    await append(
      [
        {
          eventType: "support.attachment-operation.staged",
          payload: {
            owner: { supportRequestId: caseId },
            items: [{ attachmentId, canonicalSha256: sha256, contentType: "image/png" }],
          },
        },
      ],
      "support.attachment-operation-synthetic-test",
    );
    const authority = await service().reconstruct();
    expect(authority.operationKeys).toEqual([key]);
    expect(
      await service().claim({
        manifestDigest: "a".repeat(64),
        horizon: authority.horizon,
        keys: [key],
        referenceDigest: authority.digest,
      }),
    ).toBe(false);
  });

  it("claims candidates with a case guard and persists per-key outcomes without changing case history or bytes", async () => {
    await append([evidence(["seed://support/placeholder"])]);
    const original = await readCompleteStream(store, { streamId });
    const legacy = service();
    const authority = await legacy.reconstruct();
    const manifestDigest = "a".repeat(64);
    expect(
      await legacy.claim({
        manifestDigest,
        horizon: authority.horizon,
        keys: [key],
        referenceDigest: authority.digest,
      }),
    ).toBe(true);
    await legacy.recordOutcomes({ manifestDigest, outcomes: [{ key, status: "deleted" }] });
    const claims = await readCompleteStream(store, { streamId: `support.evidence-legacy-deletion-${manifestDigest}` });
    expect(claims.map((event) => event.eventType)).toEqual([
      LEGACY_DELETION_CLAIMED,
      "SupportEvidenceLegacyDeletionRecorded",
    ]);
    expect(claims[1]!.payload.outcomes).toEqual([{ key, status: "deleted" }]);
    expect(await readCompleteStream(store, { streamId })).toEqual(original);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
  });

  it("refuses references added before a claim or between batches", async () => {
    await append([evidence(["seed://support/placeholder"])]);
    const legacy = service();
    const authority = await legacy.reconstruct();
    const manifestDigest = "a".repeat(64);
    const otherKey = attachmentStorageKey(caseId, `sea_${"1".repeat(26)}`, sha256, "image/png");
    expect(
      await legacy.claim({
        manifestDigest,
        horizon: authority.horizon,
        keys: [otherKey],
        referenceDigest: authority.digest,
      }),
    ).toBe(true);
    await append([evidence([reference])]);
    expect(
      await legacy.claim({
        manifestDigest,
        horizon: authority.horizon,
        keys: [key],
        referenceDigest: authority.digest,
      }),
    ).toBe(false);
    expect(
      await readCompleteStream(store, { streamId: `support.evidence-legacy-deletion-${manifestDigest}` }),
    ).toHaveLength(1);
  });

  it("atomic empty-event guard rejects an interleaving reference; empty-case-guard-bypass mutant admits it", async () => {
    await append([evidence(["seed://support/placeholder"])]);
    const authority = await service().reconstruct();
    const race = (bypass: boolean): EventStore => ({
      ...store,
      appendToStreams: async (inputs) => {
        await append([evidence([reference])]);
        return store.appendToStreams!(bypass ? inputs.filter((input) => input.events.length > 0) : inputs);
      },
    });
    const input = {
      manifestDigest: "a".repeat(64),
      horizon: authority.horizon,
      keys: [key],
      referenceDigest: authority.digest,
    };
    expect(await service(race(false)).claim(input)).toBe(false);
    expect(
      await readCompleteStream(store, { streamId: `support.evidence-legacy-deletion-${input.manifestDigest}` }),
    ).toHaveLength(0);
    // Restore only the governing pre-race fixture through a distinct case; do not rewrite any event.
    const otherId = "sup_other";
    const otherStream = `support.support-request-${otherId}`;
    await append([evidence(["seed://support/placeholder"])], otherStream);
    const otherAuthority = await service().reconstruct();
    const mutant: EventStore = {
      ...store,
      appendToStreams: async (inputs) => {
        await append([evidence([reference])], otherStream);
        return store.appendToStreams!(inputs.filter((entry) => entry.events.length > 0));
      },
    };
    expect(
      await service(mutant).claim({
        ...input,
        manifestDigest: "b".repeat(64),
        horizon: otherAuthority.horizon,
        keys: [attachmentStorageKey(otherId, attachmentId, sha256, "image/png")],
        referenceDigest: otherAuthority.digest,
      }),
    ).toBe(true);
  });
});
