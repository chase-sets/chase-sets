import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { JsonValue } from "@chase-sets/primitives/json";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";
import * as typedIds from "@chase-sets/primitives/typed-ids";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { createIdentitySecretAdapters } from "../../api-keys/api/secret-adapters";
import type { IdentityMutationPersistence } from "./fences";
import { createAccountManagementRuntime, validateReceiptHistory, type MutationInput } from "./runtime";
import { actionEventTypes } from "../domain/contract";
import { assertOwnerHistoryFamily, ownerState, validateOwnerHistory, type OwnerKind } from "./owners";
import { digest } from "../domain/attempt";
import * as socialLoginLink from "../../users/domain/social-login-link";
import { acceptInvitationOperation } from "../../invitations/api/acceptance-operation";
import { acceptanceContext, acceptanceOperation, seedAcceptance } from "../../invitations/api/acceptance-test-support";
import {
  SHIPPING_ADDRESS_REQUIRED_MESSAGES,
  ShippingAddressFieldError,
  ShippingAddressUndeliverableError,
  type ShippingAddressField,
} from "../../shipping-addresses/domain/errors";
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

function fixture(auth = createIdentitySecretAdapters()) {
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
    auth,
    shippingAddresses: { verifyShippingAddress: provider } as never,
  });
  const seed = async (streamId: string, eventType: string, payload: Record<string, unknown>) =>
    memory.eventStore.appendToStream({
      streamId,
      expectedVersion: "no_stream",
      context,
      events: [{ eventType, payload: payload as never }],
    });
  return { memory, runtime, seed, provider, db, health, persistence };
}

describe("owner summary and API-key boundary equivalence", () => {
  it("projects every owner status as a closed credential-free summary without changing domain state", async () => {
    const f = fixture();
    await f.seed(`identity.user-${actor.userId}`, "identity.user.created", {
      userId: actor.userId,
      displayName: "Synthetic",
      givenName: "",
      familyName: "",
      primaryEmail: "marker@example.test",
    });
    const base = f.memory.allEvents[0];
    const cases: readonly Readonly<{ kind: OwnerKind; initial: string; transitions: readonly string[] }>[] = [
      { kind: "account", initial: "active", transitions: ["suspended", "reactivated", "closed"] },
      { kind: "shipping-address-book", initial: "active", transitions: [] },
      { kind: "consent", initial: "unrecorded", transitions: ["recorded", "withdrawn"] },
      { kind: "user", initial: "active", transitions: ["suspended", "reactivated"] },
      { kind: "api-key", initial: "active", transitions: ["revoked"] },
      { kind: "membership", initial: "active", transitions: ["revoked", "reinstated"] },
      { kind: "invitation", initial: "pending", transitions: ["accepted", "declined", "cancelled", "expired"] },
    ];
    for (const { kind, initial, transitions } of cases) {
      expect(ownerState(kind, []).summary).toEqual({ status: initial });
      for (const transition of transitions) {
        const history = [{ ...base, eventType: `identity.${kind}.${transition}`, payload: {} }];
        const owner = ownerState(kind, history);
        const state = owner.kind === "api-key" ? owner.apiKeyState : owner.state;
        expect(owner.summary).toEqual({ status: "status" in state ? state.status : "active" });
        expect(Object.keys(owner.summary)).toEqual(["status"]);
        expect(owner.summary).not.toHaveProperty("verifierHash");
      }
    }
  });

  it("preserves deterministic API-key create rotate revoke first repeat lookup recovery result and event proof bytes", async () => {
    let sequence = 0;
    const ids = vi
      .spyOn(typedIds, "createId")
      .mockImplementation((prefix) => parseTypedId(`${prefix}_${String(++sequence).padStart(26, "0")}`, prefix));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T12:00:00.000Z"));
    try {
      let issued = 0;
      const auth = {
        ...createIdentitySecretAdapters(),
        issueOpaqueToken: vi.fn(() => `key_synthetic_equivalence_${++issued}`),
        hashSecret: vi.fn(createIdentitySecretAdapters().hashSecret),
      };
      const f = fixture(auth);
      const transcript: JsonValue[] = [];
      const create = {
        ...input,
        action: "create-api-key",
        target: null,
        body: { userId: actor.userId, name: "Synthetic" },
      };
      const first = await f.runtime.submit(create);
      expect(first.outcome).toBe("committed");
      if (first.outcome !== "committed") throw new Error("Expected API-key commit");
      transcript.push(first, await f.runtime.submit(create), await f.runtime.lookup(create));
      const target = first.current.id;
      const rotate = {
        ...input,
        key: "f230f01b-7871-420b-9c32-37139f80f749",
        action: "rotate-api-key",
        target,
        body: {},
      };
      const rotated = await f.runtime.submit(rotate);
      expect(rotated.outcome).toBe("committed");
      transcript.push(
        rotated,
        await f.runtime.submit(rotate),
        await f.runtime.lookup(rotate),
        await f.runtime.lookup(create),
      );
      const revoke = { ...rotate, key: "a230f01b-7871-420b-9c32-37139f80f749", action: "revoke-api-key" };
      const revoked = await f.runtime.submit(revoke);
      expect(revoked.outcome).toBe("committed");
      transcript.push(
        revoked,
        await f.runtime.submit(revoke),
        await f.runtime.lookup(revoke),
        await f.runtime.lookup(create),
      );
      const noOp = await f.runtime.submit({ ...revoke, key: "b230f01b-7871-420b-9c32-37139f80f749" });
      expect(noOp).toMatchObject({ outcome: "committed", receipt: { events: [], result: { changed: false } } });
      transcript.push(noOp);
      const transact = f.persistence.transaction;
      const conflict = vi.spyOn(f.persistence, "transaction").mockImplementationOnce(async (scopes, work) => {
        await transact(scopes, work);
        throw Object.assign(new Error("synthetic commit delivery conflict"), { code: "concurrency_conflict" });
      });
      const recovered = await f.runtime.submit({ ...create, key: "c230f01b-7871-420b-9c32-37139f80f749" });
      expect(recovered).toMatchObject({
        outcome: "committed",
        newlyCommitted: false,
        secretState: "committed-secret-unrecoverable",
      });
      expect(recovered).not.toHaveProperty("secret");
      conflict.mockRestore();
      transcript.push(recovered);
      for (const result of [first, rotated, revoked]) {
        if (result.outcome !== "committed") throw new Error("Expected API-key commit");
        const persisted = f.memory.streams
          .get(result.receipt.owner)!
          .slice(result.receipt.priorVersion, result.receipt.committedVersion);
        expect(result.receipt.events).toEqual(
          persisted.map((event) => ({ id: event.eventId, type: event.eventType, digest: digest(event.payload) })),
        );
      }
      expect(auth.issueOpaqueToken).toHaveBeenCalledTimes(3);
      expect(auth.hashSecret).toHaveBeenCalledTimes(6);
      transcript.push(
        f.memory.allEvents.map(({ eventId, streamId, streamVersion, eventType, payload }) => ({
          eventId,
          streamId,
          streamVersion,
          eventType,
          payload,
        })),
      );
      transcript.push(f.db.query.mock.calls, auth.issueOpaqueToken.mock.calls, auth.hashSecret.mock.calls);
      // Frozen public results, complete events/proofs and persistence effects at the retained pre-repair head.
      expect(digest(transcript)).toBe("3b7525930cc86873fda287580546fc935b382ddd450b685fc7b43f1134520296");
      expect(createHash("sha256").update(JSON.stringify(transcript)).digest("hex")).toBe(
        "e16cd753ec467de09334636d81d18f7e52659cb130cc7a6d2d975358b3e42fb7",
      );
    } finally {
      ids.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("authenticated unlink receipt lifecycle", () => {
  const linkKey = socialLoginLink.socialLoginLinkKey("google", "synthetic-unlink-subject");
  async function setup(methods = ["password", "social-login"], secondLink = false) {
    const f = fixture();
    await f.seed(`identity.user-${actor.userId}`, "identity.user.created", {
      userId: actor.userId,
      displayName: "Synthetic",
      givenName: "",
      familyName: "",
      primaryEmail: "marker@example.test",
    });
    await f.memory.eventStore.appendToStream({
      streamId: `identity.user-${actor.userId}`,
      expectedVersion: "any",
      context,
      events: [
        ...methods.map((authMethod) => ({ eventType: "identity.user.auth-method-enabled", payload: { authMethod } })),
        {
          eventType: "identity.user.social-login-linked",
          payload: {
            providerName: "google",
            providerSubject: "synthetic-unlink-subject",
            email: "marker@example.test",
            linkedAt: "2026-01-01T00:00:00Z",
          },
        },
        ...(secondLink
          ? [
              {
                eventType: "identity.user.social-login-linked",
                payload: {
                  providerName: "facebook",
                  providerSubject: "synthetic-other-subject",
                  email: "marker@example.test",
                  linkedAt: "2026-01-01T00:00:00Z",
                },
              },
            ]
          : []),
      ],
    });
    const request: MutationInput = {
      ...input,
      action: "unlink-social-login",
      target: linkKey,
      body: {},
      actor: { ...actor, authenticationMethod: "password", authenticatedAt: new Date().toISOString() },
    };
    return { ...f, request };
  }
  it("isolates family rejection from every envelope and aggregate validator, with a discriminating no-op control", async () => {
    const f = await setup();
    const valid = f.memory.streams.get(`identity.user-${actor.userId}`)!;
    const foreign = valid.map((event, index) =>
      index === 0 ? { ...event, eventType: "identity.api-key.created" } : event,
    );
    const discriminate = (guard: typeof assertOwnerHistoryFamily) => {
      expect(() => guard("user", valid)).not.toThrow();
      expect(() => guard("user", foreign)).toThrow("INDETERMINATE");
    };
    discriminate(assertOwnerHistoryFamily);
    expect(() => discriminate(() => {})).toThrow();
    expect(foreign[0]).toEqual({ ...valid[0], eventType: "identity.api-key.created" });
    expect(foreign.slice(1)).toEqual(valid.slice(1));
  });
  it("isolates API-key verifier replay from User link-key construction and rejects cross-aggregate history", async () => {
    const f = await setup();
    const apiKeyId = "key_synthetic";
    const secretHash = "a".repeat(64);
    await f.memory.eventStore.appendToStream({
      streamId: `identity.api-key-${apiKeyId}`,
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "identity.api-key.created",
          payload: { apiKeyId, userId: actor.userId, name: "Synthetic", keyPrefix: "synthetic-prefix" },
        },
        {
          eventType: "identity.api-key.verifier-recorded",
          payload: { keyPrefix: "synthetic-prefix", secretHash },
        },
      ],
    });
    const selector = vi.spyOn(socialLoginLink, "socialLoginLinkKey");
    try {
      const apiKeyHistory = f.memory.streams.get(`identity.api-key-${apiKeyId}`)!;
      const apiKey = ownerState("api-key", apiKeyHistory);
      expect(apiKey).toEqual(validateOwnerHistory("api-key", apiKeyHistory, actor.tenantId));
      if (apiKey.kind !== "api-key") throw new Error("Expected API-key owner");
      expect(apiKey.apiKeyState).toMatchObject({ verifierHash: secretHash });
      expect(selector).not.toHaveBeenCalled();

      const userHistory = f.memory.streams.get(`identity.user-${actor.userId}`)!;
      const user = ownerState("user", userHistory);
      expect(user).toEqual(validateOwnerHistory("user", userHistory, actor.tenantId));
      if (user.kind !== "user") throw new Error("Expected User owner");
      expect(user.state).not.toHaveProperty("verifierHash");
      expect(() =>
        validateOwnerHistory(
          "user",
          [
            ...userHistory,
            { ...apiKeyHistory[1], streamId: userHistory[0].streamId, streamVersion: userHistory.length + 1 },
          ],
          actor.tenantId,
        ),
      ).toThrow("INDETERMINATE");
      expect(await f.runtime.submit(f.request)).toMatchObject({ outcome: "committed" });
      expect(selector).toHaveBeenCalledWith("google", "synthetic-unlink-subject");
      expect(
        selector.mock.calls.every(
          ([provider, subject]) => provider === "google" && subject === "synthetic-unlink-subject",
        ),
      ).toBe(true);
    } finally {
      selector.mockRestore();
    }
  });
  it.each([false, true])(
    "records exactly one receipt, validates %s other-link proof shape, and returns first result on repeat/lookup",
    async (secondLink) => {
      const f = await setup(undefined, secondLink);
      const first = await f.runtime.submit(f.request);
      expect(first.outcome).toBe("committed");
      if (first.outcome !== "committed") throw new Error("Unlink did not commit");
      expect(first.receipt.events.map((event) => event.type)).toEqual([
        "identity.user.social-login-revocation-requested",
        "identity.user.social-login-revoked",
        ...(secondLink ? [] : ["identity.user.auth-method-disabled"]),
      ]);
      expect(Object.keys(first).sort()).toEqual(["current", "destination", "newlyCommitted", "outcome", "receipt"]);
      expect(Object.keys(first.receipt).sort()).toEqual([
        "action",
        "binding",
        "category",
        "committedVersion",
        "events",
        "hash",
        "owner",
        "priorVersion",
        "result",
        "schemaVersion",
        "target",
      ]);
      expect(JSON.stringify(first)).not.toContain("synthetic-unlink-subject");
      expect(JSON.stringify(first)).not.toContain("marker@example.test");
      const count = f.memory.allEvents.length;
      expect(
        await f.runtime.submit({
          ...f.request,
          actor: { ...f.request.actor, authenticatedAt: null, authenticationMethod: undefined },
        }),
      ).toMatchObject({ outcome: "committed", newlyCommitted: false, receipt: first.receipt });
      expect(await f.runtime.lookup(f.request)).toMatchObject({
        outcome: "committed",
        newlyCommitted: false,
        receipt: first.receipt,
      });
      expect(await f.runtime.submit({ ...f.request, key: "a230f01b-7871-420b-9c32-37139f80f749" })).toEqual({
        outcome: "conflict",
        code: "social-login-link-not-active",
      });
      expect(f.memory.allEvents).toHaveLength(count);
      expect(
        f.memory.allEvents.filter(
          (event) => event.eventType === "identity.account-management-mutation-attempt.committed",
        ),
      ).toHaveLength(1);
      const stored = f.memory.allEvents.find(
        (event) => event.eventType === "identity.account-management-mutation-attempt.committed",
      )!;
      for (const action of Object.keys(actionEventTypes) as (keyof typeof actionEventTypes)[]) {
        if (action === "unlink-social-login") continue;
        const events = [
          ...first.receipt.events.slice(0, 2),
          { id: "evt_disabled", type: "identity.user.auth-method-disabled", digest: "b".repeat(64) },
        ];
        expect(() =>
          validateReceiptHistory(
            [{ ...stored, payload: { ...stored.payload, action, events } }],
            { tenantId: actor.tenantId, userId: actor.userId, accountId: actor.accountId },
            { action, target: linkKey },
          ),
        ).toThrow("INDETERMINATE");
      }
      expect(f.provider).not.toHaveBeenCalled();
      expect(
        await f.runtime.submit({
          ...f.request,
          key: "b230f01b-7871-420b-9c32-37139f80f749",
          action: "update-user",
          target: actor.userId,
          body: { displayName: "Updated", givenName: "", familyName: "" },
        }),
      ).toMatchObject({ outcome: "committed" });
    },
  );
  it.each(["valid", "missing-third", "wrong-third", "extra-third", "interrupted-pair"])(
    "invitation sibling preserves unlink history sequence: %s",
    async (variant) => {
      const memory = createInMemoryEventStore();
      await seedAcceptance(memory.eventStore);
      const at = new Date().toISOString();
      const requested = {
        eventType: "identity.user.social-login-revocation-requested",
        payload: { providerName: "google", linkKey, requestedAt: at },
      };
      await memory.eventStore.appendToStream({
        streamId: `identity.user-${acceptanceOperation.userId}`,
        expectedVersion: "any",
        context: acceptanceContext,
        events: [
          { eventType: "identity.user.auth-method-enabled", payload: { authMethod: "password" } },
          { eventType: "identity.user.auth-method-enabled", payload: { authMethod: "social-login" } },
          {
            eventType: "identity.user.social-login-linked",
            payload: {
              providerName: "google",
              providerSubject: "synthetic-unlink-subject",
              email: "recipient@example.com",
              linkedAt: at,
            },
          },
          ...(variant === "extra-third"
            ? [
                {
                  eventType: "identity.user.social-login-linked",
                  payload: {
                    providerName: "facebook",
                    providerSubject: "synthetic-other-subject",
                    email: "recipient@example.com",
                    linkedAt: at,
                  },
                },
              ]
            : []),
          requested,
          ...(variant === "interrupted-pair"
            ? [
                {
                  eventType: "identity.user.profile-updated",
                  payload: { displayName: "Recipient", givenName: "", familyName: "" },
                },
              ]
            : []),
          {
            eventType: "identity.user.social-login-revoked",
            payload: { providerName: "google", linkKey, revokedAt: at },
          },
          ...(variant === "missing-third"
            ? []
            : [
                {
                  eventType: "identity.user.auth-method-disabled",
                  payload: { authMethod: variant === "wrong-third" ? "password" : "social-login" },
                },
              ]),
        ],
      });
      const before = memory.allEvents.length;
      const result = acceptInvitationOperation(memory.eventStore, {
        operation: acceptanceOperation,
        acceptanceTokenHash: "existing-store-token-hash",
        context: acceptanceContext,
      });
      if (variant === "valid") {
        await expect(result).resolves.toMatchObject({ membershipId: acceptanceOperation.membershipId });
      } else {
        await expect(result).rejects.toThrow();
        expect(memory.allEvents).toHaveLength(before);
      }
    },
  );
  it.each(["missing-third", "wrong-third", "extra-third"])(
    "rejects retained conditional-disabled poison: %s",
    async (poison) => {
      const f = await setup(undefined, poison === "extra-third");
      const at = new Date().toISOString();
      await f.memory.eventStore.appendToStream({
        streamId: `identity.user-${actor.userId}`,
        expectedVersion: "any",
        context,
        events: [
          {
            eventType: "identity.user.social-login-revocation-requested",
            payload: { providerName: "google", linkKey, requestedAt: at },
          },
          {
            eventType: "identity.user.social-login-revoked",
            payload: { providerName: "google", linkKey, revokedAt: at },
          },
          ...(poison === "missing-third"
            ? []
            : [
                {
                  eventType: "identity.user.auth-method-disabled",
                  payload: { authMethod: poison === "wrong-third" ? "password" : "social-login" },
                },
              ]),
        ],
      });
      const count = f.memory.allEvents.length;
      expect(await f.runtime.submit(f.request)).toEqual({ outcome: "indeterminate", code: "INDETERMINATE" });
      expect(f.memory.allEvents).toHaveLength(count);
    },
  );
  it("refuses each authority guard with zero events and zero receipts, including the isolated inactive Session control", async () => {
    for (const [methods, secondLink, patch, code] of [
      [["password", "social-login"], false, { authenticatedAt: null }, "recent-authentication-required"],
      [["password", "social-login"], false, { authenticatedAt: "malformed" }, "recent-authentication-required"],
      [
        ["password", "social-login"],
        false,
        { authenticatedAt: new Date(Date.now() + 60000).toISOString() },
        "recent-authentication-required",
      ],
      [
        ["password", "social-login"],
        false,
        { authenticatedAt: new Date(Date.now() - 16 * 60000).toISOString() },
        "recent-authentication-required",
      ],
      [["password", "social-login"], false, { authenticationMethod: undefined }, "authentication-method-not-different"],
      [["password", "social-login"], false, { authenticationMethod: "google" }, "authentication-method-not-different"],
      [["social-login"], true, { authenticationMethod: "password" }, "authentication-method-not-different"],
      [["social-login"], false, { authenticationMethod: "password" }, "last-authentication-method"],
    ] as const) {
      const f = await setup([...methods], secondLink);
      const count = f.memory.allEvents.length;
      expect(await f.runtime.submit({ ...f.request, actor: { ...f.request.actor, ...patch } })).toEqual({
        outcome: "conflict",
        code,
      });
      expect(f.memory.allEvents).toHaveLength(count);
    }
    const f = await setup();
    const count = f.memory.allEvents.length;
    expect(await f.runtime.submit({ ...f.request, target: "f".repeat(64) })).toEqual({
      outcome: "conflict",
      code: "social-login-link-not-active",
    });
    expect(f.memory.allEvents).toHaveLength(count);
  });
});

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
  it.each(
    (Object.keys(SHIPPING_ADDRESS_REQUIRED_MESSAGES) as ShippingAddressField[]).flatMap((field) =>
      ["create", "update"].map((action) => ({ field, action })),
    ),
  )("keyed field rejection retains $action $field without a receipt or event", async ({ field, action }) => {
    const f = fixture();
    // Country defaults before normalization; the port can still reject that required field.
    f.provider.mockRejectedValue(new ShippingAddressFieldError(field));
    const body = {
      label: "Home",
      name: "Test",
      line1: "1 Test St",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    };
    const result = await f.runtime.submit({
      ...input,
      action,
      target: action === "update" ? "adr_01ARZ3NDEKTSV4RRFFQ69G5FAV" : null,
      body: { ...body, [field]: " " },
    });
    expect(result).toEqual({ outcome: "not-recorded", code: "validation-failed", shippingAddressField: field });
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
