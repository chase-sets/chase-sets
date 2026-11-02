import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createMarketplaceAttempt, hashMarketplaceRequest } from "./attempt";
import { createMarketplaceMutationLookup } from "./lookup";
import { marketplaceMutationRecoveryResultSchema } from "../domain/contracts";
import { offerAttemptResultSchema } from "../../offers/api/attempt-result";
import { context } from "../../offer-policy/tests/fixtures";
import { getMutationResultCommandReceipt } from "@chase-sets/http/responses";
import { readFileSync, readdirSync } from "node:fs";
import { offerEvidenceSnapshotSchema } from "../../offers/domain/evidence-snapshot-schema";
import { buildListingEvidenceSnapshot } from "../../listings/domain/evidence-snapshot";

const input = {
  attemptId: "lookup_attempt_identity_01",
  accountId: "acc_buyer",
  mutationKind: "offer.submit" as const,
  target: { kind: "product" as const, id: "cat_one::" },
  request: { priceAmount: "10.00" },
};
describe("Marketplace owner lookup", () => {
  it("rejects poisoned evidence hashes and shallow nested evidence facts", () => {
    const snapshot = buildListingEvidenceSnapshot({ evidence: [], createdAt: "2026-01-01T00:00:00.000Z" });
    expect(offerEvidenceSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      offerEvidenceSnapshotSchema.safeParse({ ...snapshot, snapshotHash: `sha256:${"f".repeat(64)}` }).success,
    ).toBe(false);
    expect(
      offerEvidenceSnapshotSchema.safeParse({ ...snapshot, evidence: [{ assets: [{ cookie: "private" }] }] }).success,
    ).toBe(false);
  });
  it("returns a closed first receipt without a write; wrong owner and unmatched are identical not-observed", async () => {
    const store = createInMemoryEventStore().eventStore;
    const attempt = createMarketplaceAttempt(store, input, offerAttemptResultSchema);
    await attempt.commit([], { offerId: "off_one" as never, version: 1 }, { id: "off_one", version: 1 }, context);
    const append = vi.spyOn(store, "appendToStreams");
    const lookup = createMarketplaceMutationLookup(store);
    const query = { ...input, requestHash: attempt.binding.canonicalRequestHash };
    const found = await lookup(query);
    expect(getMutationResultCommandReceipt(found)?.commitPositions).toHaveLength(1);
    expect(JSON.stringify(found)).not.toContain("commandReceipt");
    expect(found).toEqual({
      ...attempt.binding,
      ownerStatus: "committed",
      ownerReceipt: { id: "off_one", version: 1 },
    });
    const wrong = await lookup({ ...query, accountId: "acc_other" });
    const missing = await createMarketplaceMutationLookup(createInMemoryEventStore().eventStore)({
      ...query,
      accountId: "acc_other",
    });
    expect(wrong).toEqual(missing);
    expect(wrong.ownerStatus).toBe("not-observed");
    expect(append).not.toHaveBeenCalled();
  });
  it("keeps the core independent of Platform Runtime and descriptor/lifecycle contracts", () => {
    const directories = [new URL("./", import.meta.url), new URL("../domain/", import.meta.url)];
    for (const directory of directories)
      for (const name of readdirSync(directory).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))) {
        const source = readFileSync(new URL(name, directory), "utf8");
        expect(source).not.toMatch(
          /(?:from\s*["']@chase-sets\/platform-runtime|export[^;]*RecoverableMutationDescriptor|export[^;]*Lifecycle)/,
        );
      }
  });
  it.each([
    { actorBinding: { accountId: "acc_buyer", cookie: "private" } },
    { target: { kind: "offer", id: "off_one", path: "/private" } },
    { ownerReceipt: { id: "off_one", version: 1, url: "https://private" } },
    { lifecycle: "submitting" },
    { bytes: [1, 2] },
    { sourceActionKey: "raw" },
  ])("recursively rejects an extra payload field %j", (extra) => {
    expect(
      marketplaceMutationRecoveryResultSchema.safeParse({
        schemaVersion: 1,
        mutationKind: "offer.submit",
        attemptKeyFingerprint: "a".repeat(64),
        actorBinding: { accountId: "acc_buyer" },
        target: { kind: "product", id: "cat_one::" },
        canonicalRequestHash: "b".repeat(64),
        ownerStatus: "committed",
        ...extra,
      }).success,
    ).toBe(false);
  });
});
