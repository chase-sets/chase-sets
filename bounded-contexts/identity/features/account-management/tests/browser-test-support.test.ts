import { describe, expect, it, vi } from "vitest";
import { createPgPool, createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";
import { createIdentityMutationPersistence } from "../api/fences";
import { ownedBrowserIdentityDatabase, seedBrowserConsent } from "./browser-test-support";

vi.mock("@chase-sets/event-core-postgres", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/event-core-postgres")>()),
  createPgPool: vi.fn(),
  createPostgresEventStore: vi.fn(),
}));
vi.mock("../api/fences", () => ({ createIdentityMutationPersistence: vi.fn() }));

describe("issue-7168-ac10-real-router Consent fixture", () => {
  it("returns a receipt matching the actual synthetic Consent commit and closes its pool", async () => {
    const { eventStore } = createInMemoryEventStore();
    const context = {
      tenantId: parseTypedId("tnt_synthetic", "tnt"),
      audit: {
        performedByUserId: parseTypedId("usr_synthetic", "usr"),
        forAccountId: parseTypedId("acc_synthetic", "acc"),
      },
    };
    for (const [streamId, eventType, payload] of [
      ["identity.user-usr_synthetic", "identity.user.created", { primaryEmail: `${"a".repeat(64)}@chasesets.test` }],
      ["identity.account-acc_synthetic", "identity.account.created", {}],
      [
        "identity.membership-mbr_synthetic",
        "identity.membership.granted",
        { userId: "usr_synthetic", accountId: "acc_synthetic" },
      ],
    ] as const)
      await eventStore.appendToStream({
        streamId,
        expectedVersion: "no_stream",
        context,
        events: [{ eventType, payload }],
      });
    const end = vi.fn();
    vi.mocked(createPgPool).mockReturnValue({ end } as never);
    vi.mocked(createPostgresEventStore).mockReturnValue(eventStore as never);
    vi.mocked(createIdentityMutationPersistence).mockReturnValue({ eventStore } as never);
    const result = await seedBrowserConsent(
      "postgres://identity_role@localhost:5432/cs_synthetic_identity",
      "postgres://catalog_role@localhost:5432/cs_synthetic_catalog",
      { userId: "usr_synthetic", accountId: "acc_synthetic", membershipId: "mbr_synthetic" },
    );
    const committed = await eventStore.readStream({ streamId: `identity.consent-${result.consentId}` });
    expect(committed).toHaveLength(1);
    expect(result.sources).toEqual([
      {
        sourceContextName: "identity",
        eventIds: [committed[0].eventId],
        maxGlobalPosition: String(committed[0].globalPosition),
      },
    ]);
    expect(end).toHaveBeenCalledOnce();
  });
  it("accepts only the matching owned loopback Identity database and refuses shared or malformed targets", () => {
    const catalog = "postgres://catalog_role@localhost:5432/cs_synthetic_catalog";
    expect(
      ownedBrowserIdentityDatabase("postgres://identity_role@localhost:5432/cs_synthetic_identity", catalog).pathname,
    ).toBe("/cs_synthetic_identity");
    for (const value of [
      undefined,
      "postgres://example.test/cs_synthetic_identity",
      "postgres://localhost/identity",
      "postgres://localhost/cs_other_identity",
      "postgres://localhost:5433/cs_synthetic_identity",
      "http://localhost:5432/cs_synthetic_identity",
      "invalid",
    ])
      expect(() => ownedBrowserIdentityDatabase(value, catalog)).toThrow();
  });
});
