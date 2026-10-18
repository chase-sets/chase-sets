import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { createIdentitySecretAdapters } from "../../api-keys/api/secret-adapters";
import type { IdentityMutationPersistence } from "./fences";
import { createAccountManagementRuntime, type MutationInput } from "./runtime";
import { validateOwnerHistory } from "./owners";
import { ShippingAddressUndeliverableError } from "../../shipping-addresses/domain/errors";
import type { ShippingAddressServices } from "../../shipping-addresses/api/runtime";

const actor: ResolvedActor = {
  tenantId: "tnt_test" as never,
  userId: "usr_01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
  accountId: "acc_01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
  membershipId: "mbr_01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
  sessionId: "ses_test" as never,
  roleKey: "owner",
  permissions: ["accounts.manage", "security.manage", "memberships.manage"],
};
const context: EventStoreContext = {
  tenantId: parseTypedId(actor.tenantId, "tnt"),
  audit: { performedByUserId: parseTypedId(actor.userId, "usr"), forAccountId: parseTypedId(actor.accountId, "acc") },
};
const key = "9230f01b-7871-420b-9c32-37139f80f749";
const input: MutationInput = {
  actor,
  context,
  key,
  action: "update-profile",
  target: actor.accountId,
  body: { name: "New", displayName: "New" },
};

function fixture() {
  const memory = createInMemoryEventStore();
  const health = vi.fn(async () => [{ count: "1" }]);
  const provider = vi.fn<ShippingAddressServices["verifyShippingAddress"]>(async (address) => ({
    status: "accepted",
    address,
  }));
  const db = { query: vi.fn(async (sql: string) => ({ rows: sql.includes("count(*)") ? [{ count: "1" }] : [] })) };
  const persistence: IdentityMutationPersistence = {
    eventStore: memory.eventStore,
    transaction: async (_scopes, work) =>
      work({
        db: db as never,
        read: async (streamId) => [...(memory.streams.get(streamId) ?? [])],
        append: memory.eventStore.appendToStreams,
        projectionPredicate: health,
      }),
  };
  const runtime = createAccountManagementRuntime(persistence, {
    auth: createIdentitySecretAdapters(),
    shippingAddresses: { verifyShippingAddress: provider } as never,
  });
  const seed = async (streamId: string, eventType: string, payload: Record<string, unknown>) =>
    memory.eventStore.appendToStream({
      streamId,
      expectedVersion: "no_stream",
      context,
      events: [{ eventType, payload: payload as never }],
    });
  return { memory, runtime, seed, provider, db, health };
}

describe("issue-7168-ac3-atomic-replay", () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(async () => {
    f = fixture();
    await f.seed(`identity.account-${actor.accountId}`, "identity.account.created", {
      accountId: actor.accountId,
      accountType: "personal",
      name: "Old",
      displayName: "Old",
    });
  });
  it("returns immutable original proof and a distinct current authority without another append", async () => {
    const first = await f.runtime.submit(input);
    expect(first.outcome).toBe("committed");
    if (first.outcome === "committed") expect(Object.keys(first.current).sort()).toEqual(["id", "status", "version"]);
    const count = f.memory.allEvents.length;
    expect(await f.runtime.submit(input)).toMatchObject({ outcome: "committed", newlyCommitted: false });
    expect(f.memory.allEvents).toHaveLength(count);
    expect(await f.runtime.submit({ ...input, body: { name: "Changed", displayName: "Changed" } })).toMatchObject({
      outcome: "conflict",
      code: "attempt-hash-conflict",
      current: { id: actor.accountId, version: 2, status: "active" },
    });
    await f.runtime.submit({
      ...input,
      key: "f230f01b-7871-420b-9c32-37139f80f749",
      body: { name: "Later", displayName: "Later" },
    });
    expect(await f.runtime.lookup(input)).toMatchObject({
      outcome: "committed",
      receipt: { committedVersion: 2 },
      current: { version: 3 },
    });
    const recovered = await f.runtime.lookup(input);
    expect(recovered.outcome).toBe("committed");
    if (recovered.outcome === "committed") {
      expect(recovered).toHaveProperty("destination", expect.stringMatching(/^\/account\?afterWrite=/));
    }
  });
  it("rejects the receipt-only bypass mutant", async () => {
    await f.runtime.submit(input);
    f.memory.streams.set(
      `identity.account-${actor.accountId}`,
      f.memory.streams.get(`identity.account-${actor.accountId}`)!.slice(0, 1),
    );
    expect(await f.runtime.lookup(input)).toEqual({ outcome: "indeterminate", code: "INDETERMINATE" });
  });
  it("issue-7168-ac5-history rejects closed-receipt and event-proof bypass mutants", async () => {
    await f.runtime.submit(input);
    const [stream, original] = [...f.memory.streams].find(([name]) =>
      name.startsWith("identity.account-management-mutation-attempt-"),
    )!;
    const event = original[0];
    const receipt = event.payload;
    for (const payload of [
      { ...receipt, result: { ...(receipt.result as object), secret: "forbidden" } },
      { ...receipt, result: { ...(receipt.result as object), changed: "true" } },
      { ...receipt, events: [{ ...(receipt.events as object[])[0], type: "identity.account.closed" }] },
      { ...receipt, events: [{ ...(receipt.events as object[])[0], id: "" }] },
      { ...receipt, events: [] },
      { ...receipt, priorVersion: -1 },
      { ...receipt, committedVersion: 10001 },
      { ...receipt, category: [] },
      { ...receipt, result: [] },
      { ...receipt, binding: { ...(receipt.binding as object), userId: [] } },
    ]) {
      f.memory.streams.set(stream, [{ ...event, payload: payload as never }]);
      expect((await f.runtime.lookup(input)).outcome).not.toBe("committed");
    }
    for (const patch of [
      { occurredAt: "2026-01-01" },
      { recordedAt: "2026-02-30T00:00:00Z" },
      { metadata: { secret: "forbidden" } },
    ]) {
      f.memory.streams.set(stream, [{ ...event, ...patch } as StoredEvent]);
      expect(await f.runtime.lookup(input)).toEqual({ outcome: "indeterminate", code: "INDETERMINATE" });
    }
    f.memory.streams.set(stream, original);
    expect((await f.runtime.lookup(input)).outcome).toBe("committed");
  });
});

describe("issue-7168-ac5-history", () => {
  it("rejects duplicate terminal facts, unknown payload fields and malformed nested primitives", async () => {
    const f = fixture();
    const stream = `identity.membership-${actor.membershipId}`;
    await f.seed(stream, "identity.membership.granted", {
      membershipId: actor.membershipId,
      accountId: actor.accountId,
      userId: actor.userId,
      roleKey: "owner",
    });
    await f.memory.eventStore.appendToStream({
      streamId: stream,
      expectedVersion: 1,
      context,
      events: [
        { eventType: "identity.membership.revoked", payload: {} },
        { eventType: "identity.membership.revoked", payload: {} },
      ],
    });
    expect(() => validateOwnerHistory("membership", f.memory.streams.get(stream)!, actor.tenantId)).toThrow();
    const event = f.memory.streams.get(stream)![0];
    expect(() =>
      validateOwnerHistory(
        "membership",
        [{ ...event, payload: { ...event.payload, secret: "forbidden" } }],
        actor.tenantId,
      ),
    ).toThrow();
    expect(() =>
      validateOwnerHistory(
        "membership",
        [{ ...event, payload: { ...event.payload, accountId: [] } } as StoredEvent],
        actor.tenantId,
      ),
    ).toThrow();
  });
});

describe("issue-7168-ac6-api-key-secret", () => {
  it("keeps the first secret out of receipts and lookup even when the verifier projection lags", async () => {
    const f = fixture();
    const keyInput = { ...input, action: "create-api-key", target: null, body: { userId: actor.userId, name: "Test" } };
    const first = await f.runtime.submit(keyInput);
    expect(first).toMatchObject({ outcome: "committed", newlyCommitted: true });
    if (first.outcome !== "committed") throw new Error("Expected commit");
    expect(first.secret).toBeTruthy();
    expect(JSON.stringify(first.receipt)).not.toContain(first.secret!);
    expect(JSON.stringify(f.memory.allEvents)).not.toContain(first.secret!);
    expect(await f.runtime.submit(keyInput)).toMatchObject({
      outcome: "committed",
      secretState: "committed-secret-unrecoverable",
    });
    expect(JSON.stringify(await f.runtime.lookup(keyInput))).not.toContain(first.secret!);
  });
});

describe("issue-7168-ac7-address-provider-order", () => {
  it("keyed field rejection retains the field without a receipt or event", async () => {
    const f = fixture();
    const result = await f.runtime.submit({
      ...input,
      action: "create",
      target: null,
      body: { label: "Home", line1: "1 Test St", city: "Chicago", state: "IL", postalCode: "60601", country: "US" },
    });
    expect(result).toEqual({ outcome: "not-recorded", code: "validation-failed", shippingAddressField: "name" });
    expect(f.memory.allEvents).toHaveLength(0);
  });

  it.each(["verified", "corrected", "unverified"] as const)(
    "retains the accepted %s port snapshot and never calls the port on replay",
    async (status) => {
      const f = fixture();
      f.provider.mockImplementation(async (address) => ({
        status: "accepted" as const,
        address: {
          ...address,
          verification: {
            status,
            source: "synthetic-port",
            checkedAt: "2026-01-01T00:00:00Z",
            buyerDecision: status === "unverified" ? "provider-unavailable" : null,
          },
        },
      }));
      const request = {
        ...input,
        action: "create",
        target: null,
        body: {
          label: "Home",
          name: "Test",
          line1: "1 Test St",
          city: "Chicago",
          state: "IL",
          postalCode: "60601",
          country: "US",
        },
      };
      const result = await f.runtime.submit(request);
      expect(result.outcome).toBe("committed");
      if (result.outcome !== "committed") throw new Error("Expected commit");
      expect(f.memory.streams.get(result.receipt.owner)?.[0].payload).toMatchObject({
        address: { verification: { status } },
      });
      expect((await f.runtime.submit(request)).outcome).toBe("committed");
      expect(f.provider).toHaveBeenCalledTimes(1);
    },
  );
  it("choice-required and undeliverable append nothing; an explicit choice gets a new attempt", async () => {
    const f = fixture();
    const request = {
      ...input,
      action: "create",
      target: null,
      body: {
        label: "Home",
        name: "Test",
        line1: "1 Test St",
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
      },
    };
    f.provider.mockImplementationOnce(
      async (address) => ({ status: "choice-required", suggestedAddress: address }) as never,
    );
    expect(await f.runtime.submit(request)).toMatchObject({
      outcome: "not-recorded",
      code: "address-standardization-suggested",
    });
    expect(f.memory.allEvents).toHaveLength(0);
    f.provider.mockRejectedValueOnce(new ShippingAddressUndeliverableError());
    expect(await f.runtime.submit({ ...request, key: "f230f01b-7871-420b-9c32-37139f80f749" })).toMatchObject({
      outcome: "not-recorded",
      code: "shipping-address-undeliverable",
    });
    expect(f.memory.allEvents).toHaveLength(0);
    expect(
      await f.runtime.submit({
        ...request,
        key: "a230f01b-7871-420b-9c32-37139f80f749",
        body: { ...request.body, addressVerificationDecision: "keep-original" },
      }),
    ).toMatchObject({ outcome: "committed" });
    expect(f.provider).toHaveBeenCalledTimes(3);
    expect(f.provider.mock.calls[2][1]).toBe("keep-original");
  });
  it("does not discard a changed accepted snapshot as an equal-input no-op", async () => {
    const f = fixture();
    const body = {
      label: "Home",
      name: "Test",
      line1: "1 Test St",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    };
    const first = await f.runtime.submit({ ...input, action: "create", target: null, body });
    if (first.outcome !== "committed") throw new Error("Expected commit");
    f.provider.mockImplementation(async (address) => ({
      status: "accepted" as const,
      address: { ...address, line1: "2 Test St" },
    }));
    const changed = await f.runtime.submit({
      ...input,
      key: "f230f01b-7871-420b-9c32-37139f80f749",
      action: "update",
      target: first.receipt.result.id,
      body,
    });
    expect(changed).toMatchObject({ outcome: "committed", receipt: { result: { changed: true } } });
    expect(f.memory.streams.get(first.receipt.owner)?.at(-1)?.payload).toMatchObject({
      address: { line1: "2 Test St" },
    });
    expect(f.provider).toHaveBeenCalledTimes(2);
  });
  it("calls the unchanged port once after receipt lookup and zero times on replay", async () => {
    const f = fixture();
    const addressInput = {
      ...input,
      action: "create",
      target: null,
      body: {
        label: "Home",
        name: "Test",
        line1: "1 Test St",
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
      },
    };
    expect(await f.runtime.submit(addressInput)).toMatchObject({ outcome: "committed" });
    expect(await f.runtime.submit(addressInput)).toMatchObject({ outcome: "committed", newlyCommitted: false });
    expect(f.provider).toHaveBeenCalledTimes(1);
  });
});
