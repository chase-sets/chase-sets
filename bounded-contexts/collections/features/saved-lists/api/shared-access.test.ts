import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, CatalogItemId } from "@chase-sets/primitives/typed-ids";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type { SavedListId, SavedListLineId, SavedListOwnerSnapshot } from "../domain/contracts";
import type { SavedListUnlistedSecret } from "../domain/sharing-contracts";
import { createSavedListCapabilityService } from "../domain/unlisted-capability";
import type { SavedListSharedPageRecord } from "../read-model/shared-page-queries";
import { authorizeSavedListAccess, buildSavedListUnlistedLink, createSavedListSharedAccess } from "./shared-access";

const listId = "svl_shared" as SavedListId;
const ownerAccountId = "acc_owner" as AccountId;
const viewerAccountId = "acc_viewer" as AccountId;
const lineId = "sll_one" as SavedListLineId;
const capabilities = createSavedListCapabilityService({
  activeKeyId: "primary",
  keys: [{ id: "primary", secret: "shared-access-capability-key-0001" }],
});
const material = capabilities.mint({ listId, commandId: "slc_rotate" as never });

function page(overrides: Partial<SavedListSharedPageRecord> = {}): SavedListSharedPageRecord {
  return {
    listId,
    ownerAccountId,
    title: "Trade targets",
    description: "Cards worth watching",
    visibility: "public",
    lifecycle: "active",
    coverLineId: lineId,
    lineCount: 1,
    showTrackedQuantities: false,
    showCurrentEstimatedValue: false,
    sourceChangedAt: "2026-07-13T12:00:00.000Z",
    sourceVersion: 4,
    policyVersion: 2,
    unlistedVerifier: material.verifier,
    unlistedGeneration: 1,
    lines: [
      {
        lineId,
        product: {
          catalogItemId: "cat_one" as CatalogItemId,
          productId: "cat_one::condition:near-mint" as ProductKey,
          selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
        },
        trackedQuantity: 7,
        position: 0,
      },
    ],
    ...overrides,
  };
}

describe("Saved List shared access", () => {
  it.each([
    [
      "owner private",
      page({ visibility: "private" }),
      { kind: "account", accountId: ownerAccountId, copyCapability: "allowed" },
      null,
      true,
      "owner",
      true,
    ],
    [
      "signed-in private",
      page({ visibility: "private" }),
      { kind: "account", accountId: viewerAccountId, copyCapability: "allowed" },
      null,
      false,
      null,
      false,
    ],
    ["anonymous public", page(), { kind: "anonymous" }, null, true, "public", false],
    [
      "copy-capable public",
      page(),
      { kind: "account", accountId: viewerAccountId, copyCapability: "allowed" },
      null,
      true,
      "public",
      true,
    ],
    [
      "anonymous unlisted without secret",
      page({ visibility: "unlisted" }),
      { kind: "anonymous" },
      null,
      false,
      null,
      false,
    ],
    [
      "anonymous unlisted with secret",
      page({ visibility: "unlisted" }),
      { kind: "anonymous" },
      material.verifier,
      true,
      "unlisted",
      false,
    ],
    [
      "copy-capable unlisted with secret",
      page({ visibility: "unlisted" }),
      { kind: "account", accountId: viewerAccountId, copyCapability: "allowed" },
      material.verifier,
      true,
      "unlisted",
      true,
    ],
    [
      "archived owner",
      page({ lifecycle: "archived" }),
      { kind: "account", accountId: ownerAccountId, copyCapability: "allowed" },
      null,
      false,
      null,
      false,
    ],
  ] as const)("applies the matrix for %s", (_name, record, subject, verifier, allowed, mode, canCopy) => {
    expect(authorizeSavedListAccess(record, subject, verifier)).toEqual({ allowed, mode, canCopy });
  });

  it("redacts hidden quantity and every forbidden owner, Inventory, cost, and history field", async () => {
    const audits: unknown[] = [];
    const access = createSavedListSharedAccess({
      sharedPages: { load: async () => page() },
      ownerSnapshots: { getOwnerSnapshot: async () => null },
      capabilities,
      rateLimits: { check: async () => ({ limited: false, retryAfterSeconds: 0 }) },
      audit: {
        record: async (fact) => {
          audits.push(fact);
        },
      },
      abuseReports: { submit: async () => ({ reportReference: "report_1" }) },
      clock: () => "2026-07-13T13:00:00.000Z",
    });
    const result = await access.read({ listId, subject: { kind: "anonymous" }, requestKey: "ip:one" });
    expect(result).toMatchObject({
      status: "found",
      view: {
        source: "shared-projection",
        savedList: { lines: [{ trackedQuantity: null }] },
        responsePolicy: { cacheControl: "private, no-store", robots: "index,follow" },
      },
    });
    const serialized = JSON.stringify(result).toLowerCase();
    for (const forbidden of [
      "privatenotes",
      "privatetags",
      "owneraccountid",
      "ownedcard",
      "inventory",
      "cost",
      "location",
      "sku",
      "profit",
      "loss",
      "history",
      "edithistory",
    ])
      expect(serialized).not.toContain(forbidden);
    expect(audits).toEqual([expect.objectContaining({ outcome: "allowed", accessMode: "public" })]);
  });

  it("normalizes missing, private, revoked, and invalid-link responses and prevents cache bleed", async () => {
    const records = [
      null,
      page({ visibility: "private" }),
      page({ visibility: "unlisted", unlistedVerifier: null, unlistedGeneration: 2 }),
      page({ visibility: "unlisted" }),
    ];
    const access = createSavedListSharedAccess({
      sharedPages: { load: async () => records.shift() ?? null },
      ownerSnapshots: { getOwnerSnapshot: async () => null },
      capabilities,
      rateLimits: { check: async () => ({ limited: false, retryAfterSeconds: 0 }) },
      audit: { record: async () => undefined },
      abuseReports: { submit: async () => ({ reportReference: "report_1" }) },
    });
    const invalid = "sl1.primary.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as SavedListUnlistedSecret;
    const inputs = [undefined, undefined, material.secret, invalid];
    for (const unlistedSecret of inputs) {
      await expect(
        access.read({
          listId,
          subject: { kind: "anonymous" },
          requestKey: "ip:one",
          unlistedSecret,
        }),
      ).resolves.toEqual({ status: "not-found" });
    }
  });

  it("invalidates the prior secret immediately after rotation", () => {
    const rotated = capabilities.mint({ listId, commandId: "slc_rotate_again" as never });
    const current = page({ visibility: "unlisted", unlistedVerifier: rotated.verifier, unlistedGeneration: 2 });
    expect(authorizeSavedListAccess(current, { kind: "anonymous" }, material.verifier).allowed).toBe(false);
    expect(authorizeSavedListAccess(current, { kind: "anonymous" }, rotated.verifier)).toMatchObject({
      allowed: true,
      mode: "unlisted",
    });
  });

  it("rate limits shared reads and delegates accepted reports to the existing moderation adapter", async () => {
    const report = vi.fn(async () => ({ reportReference: "report_1" }));
    let limited = true;
    const access = createSavedListSharedAccess({
      sharedPages: { load: async () => page() },
      ownerSnapshots: { getOwnerSnapshot: async () => null },
      capabilities,
      rateLimits: {
        check: async ({ surface }) => ({
          limited: surface === "shared-view" ? limited : false,
          retryAfterSeconds: 30,
        }),
      },
      audit: { record: async () => undefined },
      abuseReports: { submit: report },
    });
    await expect(access.read({ listId, subject: { kind: "anonymous" }, requestKey: "ip:one" })).resolves.toEqual({
      status: "rate-limited",
      retryAfterSeconds: 30,
    });
    limited = false;
    await expect(
      access.report({
        listId,
        subject: { kind: "account", accountId: viewerAccountId, copyCapability: "denied" },
        requestKey: "account:viewer",
        reason: "spam",
      }),
    ).resolves.toEqual({ status: "accepted", reportReference: "report_1" });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: "saved-list", targetId: listId, reason: "spam" }),
    );
  });

  it("keeps the secret in the fragment and applies unlisted noindex/no-referrer posture", async () => {
    const link = buildSavedListUnlistedLink("https://example.test", listId, material.secret);
    const url = new URL(link);
    expect(`${url.origin}${url.pathname}${url.search}`).not.toContain(material.secret);
    expect(url.hash).toContain(encodeURIComponent(material.secret));
    const access = createSavedListSharedAccess({
      sharedPages: { load: async () => page({ visibility: "unlisted" }) },
      ownerSnapshots: { getOwnerSnapshot: async () => null },
      capabilities,
      rateLimits: { check: async () => ({ limited: false, retryAfterSeconds: 0 }) },
      audit: { record: async () => undefined },
      abuseReports: { submit: vi.fn(async () => ({ reportReference: "report_1" })) },
    });
    const result = await access.read({
      listId,
      subject: { kind: "anonymous" },
      requestKey: "ip:one",
      unlistedSecret: material.secret,
    });
    expect(result).toMatchObject({
      status: "found",
      view: { responsePolicy: { robots: "noindex,nofollow,noarchive", referrerPolicy: "no-referrer" } },
    });
  });
});
