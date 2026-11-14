import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import * as typedIds from "@chase-sets/primitives/typed-ids";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { createIdentitySecretAdapters } from "../../api-keys/api/secret-adapters";
import type { IdentityMutationPersistence, IdentityMutationTransaction } from "./fences";
import { createAccountManagementRuntime, validateReceiptHistory, type MutationInput } from "./runtime";
import * as apiKeyDomain from "../../api-keys/domain/domain";
import * as userDomain from "../../users/domain/domain";
import * as shippingDomain from "../../shipping-addresses/domain/domain";
import {
  assertOwnerHistoryFamily,
  validateApiKeyHistory,
  validateOwnerHistory,
  validateUserHistory,
  validateShippingAddressBookHistory,
  ownerState,
  userState,
  shippingAddressBookState,
  type OwnerKind,
} from "./owners";
import { actionEventTypes, closedObject, isInstant, parseAttemptKey, validateEventProofs } from "../domain/contract";
import { attemptStreamId } from "../domain/attempt";
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

function fixture(factory = createAccountManagementRuntime, auth = createIdentitySecretAdapters()) {
  const memory = createInMemoryEventStore();
  const health = vi.fn<IdentityMutationTransaction["projectionPredicate"]>(async () => [{ count: "1" }]);
  const provider = vi.fn<ShippingAddressServices["verifyShippingAddress"]>(async (address) => ({
    status: "accepted",
    address,
  }));
  const db = { query: vi.fn(async (sql: string) => ({ rows: sql.includes("count(*)") ? [{ count: "1" }] : [] })) };
  const faults = { afterAppend: false };
  const persistence: IdentityMutationPersistence = {
    eventStore: memory.eventStore,
    transaction: async (_scopes, work) =>
      work({
        db: db as never,
        read: async (streamId) => [...(memory.streams.get(streamId) ?? [])],
        append: async (requests) => {
          const appended = await memory.eventStore.appendToStreams!(requests);
          if (faults.afterAppend) {
            faults.afterAppend = false;
            throw Object.assign(new Error("synthetic acknowledgement loss"), { code: "concurrency_conflict" });
          }
          return appended;
        },
        projectionPredicate: health,
      }),
  };
  const runtime = factory(persistence, {
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
  return { memory, runtime, seed, provider, db, health, faults };
}

const frozenMain = "5671ba613e6e3323923cc1a5064435a5bb669e6a";
const featurePath = "bounded-contexts/identity/features/account-management";

function sourceAt(revision: string, file: string) {
  return execFileSync("git", ["show", `${revision}:${file}`], { encoding: "utf8", maxBuffer: 1024 * 1024 });
}

async function frozenModule(file: "owners" | "runtime") {
  async function load(file: "owners" | "runtime") {
    const source = sourceAt(frozenMain, `${featurePath}/api/${file}.ts`);
    const parsed = ts.createSourceFile(`${file}.ts`, source, ts.ScriptTarget.Latest, true);
    const imports = new Map<string, Record<string, unknown>>();
    for (const statement of parsed.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (statement.importClause?.isTypeOnly) continue;
      imports.set(specifier, specifier === "./owners" ? await load("owners") : await vi.importActual(specifier));
    }
    const exports: Record<string, unknown> = {};
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function("require", "exports", compiled)((specifier: string) => {
      if (!imports.has(specifier)) throw new Error(`unresolved frozen import: ${specifier}`);
      return imports.get(specifier);
    }, exports);
    return exports;
  }
  return load(file);
}

async function frozenRuntime() {
  return (await frozenModule("runtime")).createAccountManagementRuntime as typeof createAccountManagementRuntime;
}

async function completeTranscript(factory: typeof createAccountManagementRuntime) {
  let eventOrdinal = 0;
  let tokenOrdinal = 0;
  const ids = vi
    .spyOn(typedIds, "createId")
    .mockImplementation(
      <Prefix extends string>(prefix: Prefix) => `${prefix}_synthetic${++eventOrdinal}` as `${Prefix}_${string}`,
    );
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const auth = createIdentitySecretAdapters();
  const issueOpaqueToken = vi.fn(() => `key_synthetic_token_${++tokenOrdinal}_not_a_credential`);
  const hashSecret = vi.fn(auth.hashSecret);
  const f = fixture(factory, { ...auth, issueOpaqueToken, hashSecret });
  const results: unknown[] = [];
  let attempt = 0;
  const nextKey = () => `9230f01b-7871-420b-9c32-${String(++attempt).padStart(12, "0")}`;
  const submit = async (request: MutationInput) => {
    const result = await f.runtime.submit(request);
    results.push({ request, result });
    return result;
  };
  try {
    await f.seed(`identity.account-${actor.accountId}`, "identity.account.created", {
      accountId: actor.accountId,
      accountType: "personal",
      name: "Old",
      displayName: "Old",
    });
    await f.seed(`identity.user-${actor.userId}`, "identity.user.created", {
      userId: actor.userId,
      displayName: "Old",
      givenName: "Old",
      familyName: "User",
      primaryEmail: null,
    });
    const create = {
      ...input,
      key: nextKey(),
      action: "create-api-key",
      target: null,
      body: { userId: actor.userId, name: "Synthetic" },
    };
    const created = await submit(create);
    if (created.outcome !== "committed") throw new Error("synthetic create must commit");
    const id = created.receipt.result.id;
    await submit(create);
    results.push(await f.runtime.lookup(create));
    await submit({ ...create, body: { userId: actor.userId, name: "Different" } });
    await submit({ ...input, key: nextKey(), action: "rotate-api-key", target: id, body: {} });
    results.push(await f.runtime.lookup(create));
    await submit({ ...input, key: nextKey(), action: "revoke-api-key", target: id, body: {} });
    await submit({ ...input, key: nextKey(), action: "revoke-api-key", target: id, body: {} });
    await submit({ ...input, key: nextKey(), action: "rotate-api-key", target: id, body: {} });
    f.faults.afterAppend = true;
    const recovery = { ...create, key: nextKey() };
    await submit(recovery);
    results.push(await f.runtime.lookup(recovery));
    await submit({ ...input, key: nextKey() });
    await submit({ ...input, key: nextKey() });
    await submit({
      ...input,
      key: nextKey(),
      action: "update-user",
      target: actor.userId,
      body: { displayName: "New", givenName: "New", familyName: "User" },
    });
    await submit({
      ...input,
      key: nextKey(),
      action: "update-user",
      target: actor.userId,
      body: { displayName: "New", givenName: "New", familyName: "User" },
    });
    const address = {
      label: "Home",
      name: "Test",
      line1: "1 Test St",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    };
    const added = await submit({ ...input, key: nextKey(), action: "create", target: null, body: address });
    if (added.outcome !== "committed") throw new Error("synthetic address must commit");
    const adr = added.receipt.result.id;
    await submit({ ...input, key: nextKey(), action: "update", target: adr, body: address });
    await submit({ ...input, key: nextKey(), action: "default", target: adr, body: {} });
    await submit({ ...input, key: nextKey(), action: "archive", target: adr, body: {} });
    await submit({ ...input, key: nextKey(), action: "archive", target: adr, body: {} });
    await f.seed("identity.membership-mbr_synthetic", "identity.membership.granted", {
      membershipId: "mbr_synthetic",
      accountId: actor.accountId,
      userId: actor.userId,
      roleKey: "owner",
    });
    f.health.mockResolvedValue([{ count: "2" }]);
    for (const [action, body] of [
      ["change-role", { roleKey: "viewer" }],
      ["change-role", { roleKey: "viewer" }],
      ["revoke", {}],
      ["revoke", {}],
      ["reinstate", {}],
      ["reinstate", {}],
    ] as const)
      await submit({ ...input, key: nextKey(), action, target: "mbr_synthetic", body });
    await f.seed("identity.consent-cns_synthetic", "identity.consent.recorded", {
      consentId: "cns_synthetic",
      subjectType: "user",
      userId: actor.userId,
      accountId: null,
      policyKey: "synthetic",
      policyVersion: "1",
      recordedAt: "2026-01-01T00:00:00Z",
    });
    f.health.mockResolvedValue([{ consent_id: "cns_synthetic" }]);
    await submit({ ...input, key: nextKey(), action: "withdraw", target: "cns_synthetic", body: {} });
    await submit({ ...input, key: nextKey(), action: "withdraw", target: "cns_synthetic", body: {} });
    const invited = await submit({
      ...input,
      key: nextKey(),
      action: "create-invitation",
      target: null,
      body: {
        accountId: actor.accountId,
        invitationId: "ivt_synthetic",
        email: "synthetic@example.test",
        roleKey: "viewer",
        expiresAt: "2099-01-01T00:00:00Z",
      },
    });
    if (invited.outcome !== "committed") throw new Error("synthetic invitation must commit");
    await submit({
      ...input,
      key: nextKey(),
      action: "cancel-invitation",
      target: invited.receipt.result.id,
      body: {},
    });
    await submit({
      ...input,
      key: nextKey(),
      action: "cancel-invitation",
      target: invited.receipt.result.id,
      body: {},
    });
    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
    results.push(await f.runtime.lookup(create), await f.runtime.lookup(recovery));
    return JSON.stringify({
      results,
      events: f.memory.allEvents,
      streams: [...f.memory.streams],
      databaseEffects: f.db.query.mock.calls,
      tokens: issueOpaqueToken.mock.calls,
      hashes: hashSecret.mock.calls,
      providerCalls: f.provider.mock.calls,
    });
  } finally {
    ids.mockRestore();
    vi.useRealTimers();
  }
}

describe("issue-11108-ac2-frozen-transcript", () => {
  it("preserves the COMPLETE serialized main transcript, not a public DTO subset", async () => {
    const baseline = await completeTranscript(await frozenRuntime());
    const candidate = await completeTranscript(createAccountManagementRuntime);
    expect(Buffer.byteLength(baseline)).toBe(127161);
    expect(candidate).toBe(baseline);
    expect(
      JSON.parse(candidate).events.some(
        (event: StoredEvent) => event.eventType === "identity.api-key.verifier-recorded",
      ),
    ).toBe(true);
    expect(candidate.replace("active", "revoked")).not.toBe(baseline);
    process.stdout.write(
      `Frozen COMPLETE transcript: ${Buffer.byteLength(baseline)} UTF-8 bytes, main/candidate byte equality PASS\n`,
    );
  });
});

describe("issue-11108-ac4-contract-guards", () => {
  it("isolates every closed-object, attempt selector and instant predicate", () => {
    expect(closedObject({ known: 1 }, ["known"])).toEqual({ known: 1 });
    for (const value of [null, 1, "text", [], Object.create(null), new Date(), { unknown: true }])
      expect(() => closedObject(value, ["known"])).toThrow("INDETERMINATE");
    expect(parseAttemptKey(key.toUpperCase())).toBe(key);
    const binding = { tenantId: actor.tenantId, accountId: actor.accountId, userId: actor.userId };
    expect(attemptStreamId(binding, key.toUpperCase())).toBe(attemptStreamId(binding, key));
    expect(attemptStreamId(binding, "a230f01b-7871-420b-9c32-37139f80f749")).not.toBe(attemptStreamId(binding, key));
    for (const value of [
      null,
      1,
      [],
      key + " ",
      key.replace("-420b-", "-520b-"),
      key.replace("-9c32-", "-7c32-"),
      "not-a-key",
    ])
      expect(() => parseAttemptKey(value)).toThrow("interruption-safe-client-required");
    for (const value of [
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00.1Z",
      "2026-01-01T00:00:00.123+05:30",
      "2024-02-29T23:59:59-06:00",
    ])
      expect(isInstant(value), value).toBe(true);
    for (const value of [
      null,
      1,
      [],
      "2026-01-01",
      "2026-01-01T00:00:00",
      "2026-01-01T00:00:00.1234Z",
      "2026-01-01T00:00:00Z" + " ".repeat(21),
      "2026-13-01T00:00:00Z",
      "2026-02-30T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T00:60:00Z",
      "2026-01-01T00:00:60Z",
      "2026-01-01T00:00:00+99:00",
    ])
      expect(isInstant(value), String(value)).toBe(false);
  });

  it("isolates every receipt envelope and closed public result guard", async () => {
    const f = fixture();
    await f.seed(`identity.account-${actor.accountId}`, "identity.account.created", {
      accountId: actor.accountId,
      accountType: "personal",
      name: "Old",
      displayName: "Old",
    });
    await f.runtime.submit(input);
    const event = f.memory.allEvents.find(
      (entry) => entry.eventType === "identity.account-management-mutation-attempt.committed",
    )!;
    const binding = { tenantId: actor.tenantId, userId: actor.userId, accountId: actor.accountId };
    const request = { action: "update-profile" as const, target: actor.accountId };
    expect(validateReceiptHistory([event], binding, request)).toEqual(event.payload);
    for (const patch of [
      { streamVersion: 2 },
      { eventType: "identity.other" },
      { tenantId: "tnt_foreign" },
      { performedByUserId: "usr_foreign" },
      { forAccountId: "acc_foreign" },
      { occurredAt: "invalid" },
      { recordedAt: "invalid" },
      { metadata: { unknown: true } },
    ])
      expect(() => validateReceiptHistory([{ ...event, ...patch } as StoredEvent], binding, request)).toThrow();
    expect(() => validateReceiptHistory([], binding, request)).toThrow();
    expect(() => validateReceiptHistory([event, event], binding, request)).toThrow();
    const payload = event.payload;
    for (const patch of [
      { unknown: true },
      { schemaVersion: 2 },
      { binding: [] },
      { binding: { ...binding, unknown: true } },
      { binding: { ...binding, userId: "usr_foreign" } },
      { action: "update-user" },
      { target: "acc_foreign" },
      { owner: 1 },
      { owner: "a".repeat(251) },
      { hash: 1 },
      { hash: "A".repeat(64) },
      { hash: "a".repeat(63) },
      { category: "unknown" },
      { priorVersion: -1 },
      { priorVersion: 1.5 },
      { committedVersion: 0 },
      { committedVersion: 1.5 },
      { committedVersion: 10001 },
      { events: {} },
      { events: [payload.events, payload.events, payload.events] },
      { result: [] },
    ])
      expect(() =>
        validateReceiptHistory([{ ...event, payload: { ...payload, ...patch } } as StoredEvent], binding, request),
      ).toThrow();
    for (const patch of [
      { unknown: true },
      { id: 1 },
      { id: "a".repeat(101) },
      { version: 0 },
      { changed: "true" },
      { status: "unknown" },
    ])
      expect(() =>
        validateReceiptHistory(
          [{ ...event, payload: { ...payload, result: { ...(payload.result as object), ...patch } } } as StoredEvent],
          binding,
          request,
        ),
      ).toThrow();
    expect(validateReceiptHistory([event], binding, request)).toEqual(payload);
  });

  it("derives every action's proof grammar, preserving both real verifier proofs", () => {
    for (const [action, types] of Object.entries(actionEventTypes)) {
      const proofs = types.map((type, index) => ({ id: `evt_synthetic${index}`, type, digest: "a".repeat(64) }));
      const selected = action as keyof typeof actionEventTypes;
      expect(validateEventProofs(selected, proofs)).toBe(proofs);
      const mustChange = ["create", "create-api-key", "rotate-api-key", "create-invitation"].includes(action);
      if (mustChange) expect(() => validateEventProofs(selected, [])).toThrow();
      else expect(validateEventProofs(selected, [])).toEqual([]);
      for (const value of [null, {}, [...proofs, ...proofs, ...proofs], [...proofs, { ...proofs[0], id: "evt_extra" }]])
        expect(() => validateEventProofs(selected, value)).toThrow();
      for (const patch of [
        { id: 1 },
        { id: "" },
        { id: "evt_" },
        { id: "evt_" + "a".repeat(91) },
        { id: "evt_has space" },
        { type: "identity.other.created" },
        { digest: 1 },
        { digest: "a".repeat(63) },
        { digest: "A".repeat(64) },
        { digest: "g".repeat(64) },
        { unknown: true },
      ])
        expect(() => validateEventProofs(selected, [{ ...proofs[0], ...patch }, ...proofs.slice(1)])).toThrow();
      if (proofs.length === 2) {
        expect(() => validateEventProofs(selected, [...proofs].reverse())).toThrow();
        expect(() => validateEventProofs(selected, [proofs[0], { ...proofs[1], id: proofs[0].id }])).toThrow();
        expect(() => validateEventProofs(selected, proofs.slice(0, 1))).toThrow();
      }
    }
  });
});

function syntheticHistory(
  kind: OwnerKind,
  facts: readonly (readonly [string, Record<string, unknown>])[],
): StoredEvent[] {
  const id =
    kind === "user"
      ? actor.userId
      : kind === "account" || kind === "shipping-address-book"
        ? actor.accountId
        : `${kind === "api-key" ? "key" : kind === "membership" ? "mbr" : kind === "consent" ? "cns" : "ivt"}_synthetic`;
  return facts.map(
    ([eventType, payload], index) =>
      ({
        eventId: `evt_synthetic${index}`,
        streamId: `identity.${kind}-${id}`,
        streamVersion: index + 1,
        globalPosition: String(index + 1),
        tenantId: actor.tenantId,
        eventType,
        payload,
        metadata: {},
        occurredAt: "2026-01-01T00:00:00Z",
        recordedAt: "2026-01-01T00:00:00Z",
        performedByUserId: actor.userId,
        forAccountId: actor.accountId,
      }) as StoredEvent,
  );
}

describe("issue-11108-ac4-concrete-history", () => {
  const createdKey = [
    "identity.api-key.created",
    { apiKeyId: "key_synthetic", userId: actor.userId, name: "Synthetic", keyPrefix: "key_synthetic" },
  ] as const;
  const verifier = [
    "identity.api-key.verifier-recorded",
    { keyPrefix: "key_synthetic", secretHash: "a".repeat(64) },
  ] as const;
  const createdUser = [
    "identity.user.created",
    { userId: actor.userId, displayName: "Synthetic", givenName: "Test", familyName: "User", primaryEmail: null },
  ] as const;

  it("isolates the family guard with all unrelated validators and history fields frozen", () => {
    const valid = syntheticHistory("user", [createdUser]);
    const foreign = valid.map((event) => ({ ...event, eventType: "identity.api-key.created" }));
    const assertion = (guard: typeof assertOwnerHistoryFamily) => {
      expect(() => guard("user", valid)).not.toThrow();
      expect(() => guard("user", foreign)).toThrow("INDETERMINATE");
    };
    assertion(assertOwnerHistoryFamily);
    expect(() => assertion(() => {})).toThrow();
    expect(foreign).toEqual([{ ...valid[0], eventType: "identity.api-key.created" }]);
  });

  it("retains API-key actor-field authorization before token allocation or appends", async () => {
    const auth = createIdentitySecretAdapters();
    const allocate = vi.fn(auth.issueOpaqueToken);
    const f = fixture(createAccountManagementRuntime, { ...auth, issueOpaqueToken: allocate });
    await expect(
      f.runtime.submit({
        ...input,
        action: "create-api-key",
        target: null,
        body: { userId: "usr_foreign", name: "Synthetic" },
      }),
    ).rejects.toThrow("authorization_forbidden");
    expect(allocate).not.toHaveBeenCalled();
    expect(f.memory.allEvents).toEqual([]);
    expect(f.db.query).not.toHaveBeenCalled();
  });

  it("keeps authoritative verifier replay private and independent public lifecycle parity at every boundary", async () => {
    const baseline = await frozenRuntime();
    // The complete transcript separately exercises empty/create/rotate/revoke/no-op/retry/recovery/day-after projections.
    expect(await completeTranscript(createAccountManagementRuntime)).toBe(await completeTranscript(baseline));
    const apiKeyHistory = syntheticHistory("api-key", [createdKey, verifier]);
    expect(() => validateApiKeyHistory([], actor.tenantId, actor)).not.toThrow();
    expect(() => validateApiKeyHistory(apiKeyHistory, actor.tenantId, actor)).not.toThrow();
    const baselineOwners = await frozenModule("owners");
    const expected = (
      baselineOwners.ownerState as (kind: string, history: readonly StoredEvent[]) => { state: unknown }
    )("api-key", apiKeyHistory).state;
    const replay = vi.spyOn(apiKeyDomain, "evolveApiKey");
    const userReplay = vi.spyOn(userDomain, "evolveUser");
    const shippingReplay = vi.spyOn(shippingDomain, "evolveShippingAddressBook");
    try {
      validateApiKeyHistory(apiKeyHistory, actor.tenantId, actor);
      expect(replay.mock.results.at(-1)?.value).toEqual(expected);
      expect(replay.mock.results.at(-1)?.value).toMatchObject({ verifierHash: verifier[1].secretHash });
      expect(userReplay).not.toHaveBeenCalled();
      expect(shippingReplay).not.toHaveBeenCalled();
    } finally {
      replay.mockRestore();
      userReplay.mockRestore();
      shippingReplay.mockRestore();
    }
    const revoked = syntheticHistory("api-key", [createdKey, verifier, ["identity.api-key.revoked", {}]]);
    expect(() => validateApiKeyHistory(revoked, actor.tenantId, actor)).not.toThrow();
    expect(() => validateApiKeyHistory(revoked, actor.tenantId, { ...actor, userId: "usr_foreign" as never })).toThrow(
      "authorization_forbidden",
    );
    for (const facts of [
      [createdKey, verifier, verifier],
      [createdKey, ["identity.api-key.verifier-recorded", { ...verifier[1], keyPrefix: "wrong" }]],
      [createdKey, ["identity.api-key.verifier-recorded", { ...verifier[1], secretHash: "bad" }]],
      [
        createdKey,
        verifier,
        ["identity.api-key.revoked", {}],
        ["identity.api-key.used", { usedAt: "2026-01-02T00:00:00Z" }],
      ],
      [createdKey, verifier, ["identity.api-key.revoked", {}], ["identity.api-key.rotated", { keyPrefix: "next" }]],
    ] as (readonly [string, Record<string, unknown>])[][])
      expect(() => validateApiKeyHistory(syntheticHistory("api-key", facts), actor.tenantId, actor)).toThrow();
    const userHistory = syntheticHistory("user", [createdUser]);
    expect(validateUserHistory(userHistory, actor.tenantId)).toEqual(userState(userHistory));
    const foreignUserHistory = [
      ...userHistory,
      { ...apiKeyHistory[1], streamId: userHistory[0].streamId, streamVersion: 2 },
    ];
    expect(() => validateUserHistory(foreignUserHistory, actor.tenantId)).toThrow("INDETERMINATE");
    expect(() => validateShippingAddressBookHistory(apiKeyHistory, actor.tenantId)).toThrow("INDETERMINATE");
    expect(() => ownerState("api-key" as never, apiKeyHistory)).toThrow("INDETERMINATE");
  });

  it("isolates envelope, family, recursive schema, identity and bounds while valid neighbors remain accepted", () => {
    const valid = syntheticHistory("user", [
      createdUser,
      ["identity.user.profile-updated", { displayName: "Changed", givenName: "Test", familyName: "User" }],
    ]);
    expect(validateUserHistory(valid, actor.tenantId)).toEqual(userState(valid));
    const [first, second] = valid;
    const cases = [
      [{ ...first, tenantId: "tnt_foreign" }, second],
      [first, { ...second, streamVersion: 3 }],
      [first, { ...second, eventId: first.eventId }],
      [first, { ...second, streamId: "identity.user-usr_foreign" }],
      [{ ...first, eventType: "identity.api-key.created" }, second],
      [{ ...first, streamId: `identity.account-${actor.userId}` }],
      [{ ...first, payload: { ...first.payload, userId: "usr_foreign" } }],
      [{ ...first, payload: { ...first.payload, unknown: true } }],
      [{ ...first, payload: { ...first.payload, givenName: [] } }],
      [{ ...first, eventType: "identity.user.unknown" }],
      [{ ...second, streamVersion: 1 }],
      [first, { ...first, eventId: "evt_duplicate_creation", streamVersion: 2 }],
      [
        {
          ...first,
          payload: {
            ...first.payload,
            primaryContactMethod: {
              contactMethodId: "email",
              type: "email",
              value: "synthetic@example.test",
              unknown: true,
            },
          },
        },
      ],
      [
        {
          ...first,
          payload: {
            ...first.payload,
            primaryContactMethod: {
              contactMethodId: "email",
              type: "email",
              value: "synthetic@example.test",
              verifiedAt: "2026-02-30T00:00:00Z",
            },
          },
        },
      ],
    ];
    for (const history of cases) expect(() => validateUserHistory(history as StoredEvent[], actor.tenantId)).toThrow();
    const atBound: StoredEvent[] = [
      first,
      ...Array.from(
        { length: 9999 },
        (_, index): StoredEvent => ({ ...second, eventId: `evt_bound${index}`, streamVersion: index + 2 }),
      ),
    ];
    expect(() => validateUserHistory(atBound, actor.tenantId)).not.toThrow();
    expect(() =>
      validateUserHistory([...atBound, { ...second, eventId: "evt_over_bound", streamVersion: 10001 }], actor.tenantId),
    ).toThrow();
    expect(validateUserHistory(valid, actor.tenantId)).toEqual(userState(valid));
  });

  it("preserves fixed-family state guards, terminal steady states and concrete Shipping archive equality", () => {
    const account = [
      "identity.account.created",
      { accountId: actor.accountId, accountType: "personal", name: "Synthetic", displayName: "Synthetic" },
    ] as const;
    const membership = [
      "identity.membership.granted",
      { membershipId: "mbr_synthetic", userId: actor.userId, accountId: actor.accountId, roleKey: "owner" },
    ] as const;
    const consent = [
      "identity.consent.recorded",
      {
        consentId: "cns_synthetic",
        subjectType: "user",
        userId: actor.userId,
        accountId: null,
        policyKey: "synthetic",
        policyVersion: "1",
        recordedAt: "2026-01-01T00:00:00Z",
      },
    ] as const;
    const invitation = [
      "identity.invitation.created",
      {
        invitationId: "ivt_synthetic",
        accountId: actor.accountId,
        email: "synthetic@example.test",
        roleKey: "viewer",
        expiresAt: "2099-01-01T00:00:00Z",
      },
    ] as const;
    for (const [kind, creation, validFacts, invalidFacts] of [
      [
        "account",
        account,
        [
          ["identity.account.suspended", {}],
          ["identity.account.reactivated", {}],
          ["identity.account.closed", {}],
        ],
        [["identity.account.reactivated", {}]],
      ],
      [
        "membership",
        membership,
        [
          ["identity.membership.revoked", {}],
          ["identity.membership.reinstated", {}],
        ],
        [["identity.membership.reinstated", {}]],
      ],
      [
        "consent",
        consent,
        [["identity.consent.withdrawn", { ...consent[1], recordedAt: undefined, withdrawnAt: "2026-01-02T00:00:00Z" }]],
        [],
      ],
      [
        "invitation",
        invitation,
        [["identity.invitation.cancelled", {}]],
        [
          ["identity.invitation.cancelled", {}],
          ["identity.invitation.resent", { expiresAt: "2099-02-01T00:00:00Z" }],
        ],
      ],
    ] as const) {
      const normalize = (facts: readonly (readonly [string, object])[]) =>
        facts.map(
          ([type, payload]) =>
            [type, Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined))] as const,
        );
      const valid = syntheticHistory(kind, normalize([creation, ...validFacts]));
      expect(() => validateOwnerHistory(kind, valid, actor.tenantId)).not.toThrow();
      expect(() =>
        validateOwnerHistory(
          kind,
          syntheticHistory(kind, normalize([creation, ...validFacts, validFacts.at(-1)!])),
          actor.tenantId,
        ),
      ).toThrow();
      if (invalidFacts.length)
        expect(() =>
          validateOwnerHistory(kind, syntheticHistory(kind, normalize([creation, ...invalidFacts])), actor.tenantId),
        ).toThrow();
    }
    expect(() =>
      validateOwnerHistory(
        "membership",
        syntheticHistory("membership", [membership, ["identity.membership.role-changed", { roleKey: "owner" }]]),
        actor.tenantId,
      ),
    ).toThrow();
    for (const field of ["consentId", "subjectType", "userId", "accountId", "policyKey", "policyVersion"])
      expect(() =>
        validateOwnerHistory(
          "consent",
          syntheticHistory("consent", [
            consent,
            [
              "identity.consent.withdrawn",
              {
                consentId: "cns_synthetic",
                subjectType: "user",
                userId: actor.userId,
                accountId: null,
                policyKey: "synthetic",
                policyVersion: "1",
                withdrawnAt: "2026-01-02T00:00:00Z",
                [field]: field === "subjectType" ? "account" : "foreign",
              },
            ],
          ]),
          actor.tenantId,
        ),
      ).toThrow();
    const address = {
      name: "Synthetic",
      line1: "1 Test St",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    };
    const added = [
      "identity.shipping-address.added",
      {
        accountId: actor.accountId,
        shippingAddressId: "adr_synthetic",
        label: "Home",
        address,
        isDefault: true,
        addedAt: "2026-01-01T00:00:00Z",
      },
    ] as const;
    const archived = [
      "identity.shipping-address.archived",
      {
        accountId: actor.accountId,
        shippingAddressId: "adr_synthetic",
        promotedDefaultShippingAddressId: null,
        archivedAt: "2026-01-02T00:00:00Z",
      },
    ] as const;
    const history = syntheticHistory("shipping-address-book", [added, archived]);
    expect(validateShippingAddressBookHistory(history, actor.tenantId)).toEqual(shippingAddressBookState(history));
    for (const facts of [
      [added, added],
      [
        added,
        [
          "identity.shipping-address.default-set",
          { accountId: actor.accountId, shippingAddressId: "adr_synthetic", setAt: "2026-01-02T00:00:00Z" },
        ],
      ],
      [added, [archived[0], { ...archived[1], promotedDefaultShippingAddressId: "adr_foreign" }]],
      [added, archived, archived],
    ])
      expect(() =>
        validateShippingAddressBookHistory(
          syntheticHistory("shipping-address-book", facts as (readonly [string, Record<string, unknown>])[]),
          actor.tenantId,
        ),
      ).toThrow();
  });
});

function boundarySources(revision?: string) {
  const files = [
    `${featurePath}/api/owners.ts`,
    `${featurePath}/api/runtime.ts`,
    `${featurePath}/domain/attempt.ts`,
    "bounded-contexts/identity/features/users/api/social-login-ownership.ts",
    "bounded-contexts/identity/features/users/domain/domain.ts",
    "bounded-contexts/identity/features/api-keys/domain/domain.ts",
    "bounded-contexts/identity/features/shipping-addresses/domain/domain.ts",
  ];
  const root = path.resolve(import.meta.dirname, "../../../../..");
  return new Map(
    files.map((file) => [
      path.resolve(root, file).split(path.sep).join("/"),
      revision ? sourceAt(revision, file) : readFileSync(path.resolve(root, file), "utf8"),
    ]),
  );
}

function inspectBoundary(sources: Map<string, string>) {
  sources = new Map(sources);
  const library = path
    .resolve(path.dirname(ts.getDefaultLibFilePath({})), "lib.es5.d.ts")
    .split(path.sep)
    .join("/");
  sources.set(library, readFileSync(library, "utf8"));
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: false,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (file) =>
      sources.has(file) ? ts.createSourceFile(file, sources.get(file)!, ts.ScriptTarget.Latest, true) : undefined,
    getDefaultLibFileName: () => "",
    writeFile: () => {
      throw new Error("read-only source inspection");
    },
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (file) => sources.has(file),
    readFile: (file) => sources.get(file),
    getCanonicalFileName: (file) => file,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    resolveModuleNames: (names, containing) =>
      names.map((name) => {
        const file = path.resolve(path.dirname(containing), `${name}.ts`).split(path.sep).join("/");
        return sources.has(file) ? { resolvedFileName: file, extension: ts.Extension.Ts } : undefined;
      }),
  };
  const program = ts.createProgram([...sources.keys()], options, host);
  const checker = program.getTypeChecker();
  type Fn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
  const functions = new Map<ts.Symbol, Fn>();
  const names = new Map<string, ts.Symbol[]>();
  const calls = new Map<ts.Symbol, ts.CallExpression[]>();
  const edges = new Map<ts.Symbol, Set<ts.Symbol>>();
  const symbol = (node: ts.Node) => {
    let value = checker.getSymbolAtLocation(node);
    if (value && value.flags & ts.SymbolFlags.Alias) value = checker.getAliasedSymbol(value);
    return value;
  };
  const visit = (node: ts.Node, work: (node: ts.Node) => void) => {
    work(node);
    ts.forEachChild(node, (child) => visit(child, work));
  };
  for (const file of program.getSourceFiles())
    visit(file, (node) => {
      if (!ts.isFunctionDeclaration(node) && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return;
      if (!node.body) return;
      const name =
        (ts.isArrowFunction(node) ? undefined : node.name) ??
        (ts.isVariableDeclaration(node.parent) ? node.parent.name : undefined);
      if (!name) return;
      const resolved = symbol(name);
      if (!resolved) throw new Error("unresolved-function-symbol");
      functions.set(resolved, node);
      names.set(resolved.name, [...(names.get(resolved.name) ?? []), resolved]);
    });
  for (const [key, fn] of functions) {
    const dependencies = new Set<ts.Symbol>();
    const sites: ts.CallExpression[] = [];
    function walk(node: ts.Node) {
      if (node !== fn && ts.isFunctionDeclaration(node)) return;
      if (ts.isCallExpression(node)) sites.push(node);
      if (ts.isIdentifier(node)) {
        const resolved = symbol(node);
        if (resolved && functions.has(resolved) && resolved !== key) dependencies.add(resolved);
      }
      ts.forEachChild(node, walk);
    }
    if (fn.body) walk(fn.body);
    edges.set(key, dependencies);
    calls.set(key, sites);
  }
  const unique = (name: string) => {
    const matches = names.get(name) ?? [];
    if (matches.length !== 1) throw new Error(`unresolved-or-ambiguous-symbol:${name}`);
    return matches[0];
  };
  const reaches = (from: ts.Symbol, target: ts.Symbol, seen = new Set<ts.Symbol>()): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return [...(edges.get(from) ?? [])].some((next) => reaches(next, target, seen));
  };
  const credential = unique("evolveApiKey");
  const user = unique("evolveUser");
  const shipping = unique("evolveShippingAddressBook");
  const userRoots = ["foldUser", "validateUserHistory"].filter((name) => names.has(name)).map(unique);
  if (!userRoots.length || userRoots.some((root) => !reaches(root, user))) throw new Error("unknown-user-replay");
  if (userRoots.some((root) => reaches(root, credential))) throw new Error("user-return-credential-join");

  function originates(node: ts.Node, parameter: ts.Symbol, seen = new Set<ts.Node>()): boolean {
    if (seen.has(node)) return false;
    seen.add(node);
    if (ts.isPropertyAccessExpression(node)) {
      const value = checker.getTypeAtLocation(node);
      const types = value.isUnion() ? value.types : [value];
      if (
        types.every((type) =>
          Boolean(
            type.flags &
            (ts.TypeFlags.StringLike |
              ts.TypeFlags.NumberLike |
              ts.TypeFlags.BooleanLike |
              ts.TypeFlags.Null |
              ts.TypeFlags.Undefined),
          ),
        )
      )
        return false;
    }
    if (ts.isIdentifier(node)) {
      const resolved = symbol(node);
      if (resolved === parameter) return true;
      for (const declaration of resolved?.declarations ?? []) {
        if (
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer &&
          originates(declaration.initializer, parameter, seen)
        )
          return true;
        let container: ts.Node = declaration;
        while (
          ts.isBindingElement(container) ||
          ts.isArrayBindingPattern(container) ||
          ts.isObjectBindingPattern(container)
        )
          container = container.parent;
        if (
          ts.isVariableDeclaration(container) &&
          ts.isVariableDeclarationList(container.parent) &&
          ts.isForOfStatement(container.parent.parent) &&
          originates(container.parent.parent.expression, parameter, seen)
        )
          return true;
      }
      return false;
    }
    let result = false;
    ts.forEachChild(node, (child) => {
      if (originates(child, parameter, seen)) result = true;
    });
    return result;
  }
  const historyCallers: string[] = [];
  for (const [key, fn] of functions)
    for (const parameter of fn.parameters) {
      let rawHistory = false;
      if (parameter.type)
        visit(parameter.type, (node) => {
          if (ts.isIdentifier(node) && node.text === "StoredEvent") rawHistory = true;
        });
      if (!rawHistory) continue;
      const inputSymbol = symbol(parameter.name);
      if (!inputSymbol) throw new Error("unknown-history-parameter");
      const families = new Set<string>();
      for (const call of calls.get(key) ?? []) {
        if (!call.arguments.some((argument) => originates(argument, inputSymbol))) continue;
        const destinations = new Set<ts.Symbol>();
        visit(call, (node) => {
          if (ts.isIdentifier(node)) {
            const value = symbol(node);
            if (value && functions.has(value)) destinations.add(value);
          }
        });
        for (const destination of destinations) {
          if (reaches(destination, credential)) families.add("credential");
          if (reaches(destination, user)) families.add("user");
          if (reaches(destination, shipping)) families.add("shipping");
        }
      }
      historyCallers.push(`${key.name}:${[...families].sort().join(",")}`);
      if (families.has("credential") && (families.has("user") || families.has("shipping")))
        throw new Error(`shared-history-join:${key.name}`);
    }

  const projection = unique("apiKeyPublicOwner");
  if (reaches(projection, credential)) throw new Error("credential-public-field-flow");
  const projectionFunction = functions.get(projection)!;
  const returnedFields = new Set<string>();
  visit(projectionFunction, (node) => {
    if (ts.isReturnStatement(node) && node.expression) {
      if (!ts.isObjectLiteralExpression(node.expression)) throw new Error("unknown-public-return");
      for (const property of node.expression.properties) {
        if (!property.name || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)))
          throw new Error("unknown-public-field");
        returnedFields.add(property.name.text);
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text !== "eventType")
      throw new Error("unknown-public-input-field");
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      !ts.isStringLiteral(node.right)
    )
      throw new Error("unknown-public-status-assignment");
  });
  expect([...returnedFields].sort()).toEqual(["kind", "status"]);
  const safe = unique("safeOwner");
  if (reaches(safe, credential)) throw new Error("credential-public-field-flow");
  const runtime = [...program.getSourceFiles()].find((file) => file.fileName.endsWith("/api/runtime.ts"));
  if (!runtime) throw new Error("unknown-runtime-source");
  const privateReturns = new Set([credential, unique("replayApiKeyHistory"), unique("planApiKeyMutation")]);
  function privateField(
    node: ts.Expression,
    fields: readonly string[] = [],
    bindings = new Map<ts.Symbol, ts.Expression>(),
    seen = new Set<string>(),
  ): boolean {
    const key = `${node.getSourceFile().fileName}:${node.kind}:${node.pos}:${node.end}:${fields.join(".")}`;
    if (seen.has(key)) throw new Error("cyclic-public-field-flow");
    seen.add(key);
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAwaitExpression(node)
    )
      return privateField(node.expression, fields, bindings, seen);
    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === "length") return false; // Counts are public facts, never the contained verifier/delivery value.
      return privateField(node.expression, [node.name.text, ...fields], bindings, seen);
    }
    if (ts.isConditionalExpression(node))
      return (
        privateField(node.whenTrue, fields, bindings, new Set(seen)) ||
        privateField(node.whenFalse, fields, bindings, new Set(seen))
      );
    if (ts.isObjectLiteralExpression(node)) {
      if (!fields.length)
        return node.properties.some((property) => {
          if (ts.isPropertyAssignment(property)) return privateField(property.initializer, [], bindings, new Set(seen));
          if (ts.isShorthandPropertyAssignment(property))
            return privateField(property.name, [], bindings, new Set(seen));
          if (ts.isSpreadAssignment(property)) return privateField(property.expression, [], bindings, new Set(seen));
          throw new Error("unknown-object-field-flow");
        });
      const [field, ...rest] = fields;
      return node.properties.some((property) => {
        if (ts.isSpreadAssignment(property)) return privateField(property.expression, fields, bindings, new Set(seen));
        if (!property.name || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)))
          throw new Error("unknown-object-field-flow");
        if (property.name.text !== field) return false;
        if (ts.isPropertyAssignment(property)) return privateField(property.initializer, rest, bindings, new Set(seen));
        if (ts.isShorthandPropertyAssignment(property))
          return privateField(property.name, rest, bindings, new Set(seen));
        throw new Error("unknown-object-field-flow");
      });
    }
    if (ts.isCallExpression(node)) {
      const resolved = symbol(node.expression);
      if (!resolved) throw new Error("unknown-call-field-flow");
      if (privateReturns.has(resolved)) return true;
      const fn = functions.get(resolved);
      if (!fn) throw new Error(`unknown-call-field-flow:${resolved.name}`);
      if (!reaches(resolved, credential)) return false;
      const bound = new Map(bindings);
      fn.parameters.forEach((parameter, index) => {
        const name = symbol(parameter.name);
        if (name && node.arguments[index]) bound.set(name, node.arguments[index]);
      });
      const returns: ts.Expression[] = [];
      function collect(part: ts.Node) {
        if (
          part !== fn &&
          (ts.isFunctionDeclaration(part) || ts.isArrowFunction(part) || ts.isFunctionExpression(part))
        )
          return;
        if (ts.isReturnStatement(part) && part.expression) returns.push(part.expression);
        ts.forEachChild(part, collect);
      }
      if (fn.body) collect(fn.body);
      if (!returns.length) throw new Error("void-call-used-as-public-value");
      return returns.some((expression) => privateField(expression, fields, bound, new Set(seen)));
    }
    if (ts.isIdentifier(node)) {
      const resolved = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : symbol(node);
      if (!resolved) throw new Error(`unknown-identifier-field-flow:${node.text}`);
      const argument = bindings.get(resolved);
      if (argument) return privateField(argument, fields, bindings, seen);
      const values: ts.Expression[] = [];
      for (const declaration of resolved.declarations ?? []) {
        if (ts.isParameter(declaration)) return false; // Canonical identity/validated receipt parameters are the public inputs.
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) values.push(declaration.initializer);
      }
      visit(node.getSourceFile(), (part) => {
        if (
          ts.isBinaryExpression(part) &&
          part.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(part.left) &&
          symbol(part.left) === resolved
        )
          values.push(part.right);
      });
      if (!values.length) throw new Error(`unknown-identifier-field-flow:${resolved.name}`);
      return values.some((value) => privateField(value, fields, bindings, new Set(seen)));
    }
    if (ts.isBinaryExpression(node))
      return (
        privateField(node.left, [], bindings, new Set(seen)) || privateField(node.right, [], bindings, new Set(seen))
      );
    if (
      ts.isStringLiteral(node) ||
      ts.isNumericLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword
    )
      return false;
    throw new Error(`unknown-expression-field-flow:${ts.SyntaxKind[node.kind]}`);
  }
  const publicFields: string[] = [];
  visit(runtime, (node) => {
    if (ts.isCallExpression(node) && symbol(node.expression) === safe)
      for (const argument of node.arguments)
        if (privateField(argument)) throw new Error("credential-public-field-flow");
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      !["receipt", "result", "expected"].includes(node.name.text) ||
      !node.initializer
    )
      return;
    if (ts.isObjectLiteralExpression(node.initializer))
      for (const property of node.initializer.properties) {
        if (!property.name) {
          if (
            !ts.isSpreadAssignment(property) ||
            !ts.isCallExpression(property.expression) ||
            symbol(property.expression.expression) !== safe
          )
            throw new Error("unknown-public-spread");
          continue;
        }
        const field = property.name.getText(runtime);
        publicFields.push(`${node.name.text}.${field}`);
        if (field === "events") continue; // Full private payload fingerprints are deliberately retained.
        const expression = ts.isPropertyAssignment(property)
          ? property.initializer
          : ts.isShorthandPropertyAssignment(property)
            ? property.name
            : undefined;
        if (!expression) throw new Error("unknown-public-field-flow");
        if (privateField(expression)) throw new Error("credential-public-field-flow");
        visit(property, (part) => {
          if (
            ts.isIdentifier(part) &&
            ["plan", "secret", "apiKeyState", "verifierHash", "secretHash"].includes(part.text)
          )
            throw new Error("delivery-public-field-join");
        });
      }
  });
  if (!publicFields.includes("receipt.result") || !publicFields.includes("receipt.events"))
    throw new Error("unknown-receipt-shape");
  return { functions: functions.size, historyCallers: historyCallers.sort(), publicFields: publicFields.sort() };
}

describe("issue-11108-ac3-source-boundary", () => {
  it("rejects imported aliases, nested summaries, spreads and casts from private replay", () => {
    const candidate = boundarySources();
    const owners = [...candidate.keys()].find((file) => file.endsWith("/api/owners.ts"))!;
    const runtime = [...candidate.keys()].find((file) => file.endsWith("/api/runtime.ts"))!;
    for (const result of [
      "const alias = credentialAlias(history, 'tnt_test'); return { kind: 'api-key', status: alias.status };",
      "const nested = { summary: { status: credentialAlias(history, 'tnt_test').status } }; return { kind: 'api-key', status: nested.summary.status };",
      "const alias = credentialAlias(history, 'tnt_test'); return { kind: 'api-key', ...{ status: alias.status } };",
      "const alias = credentialAlias(history, 'tnt_test') as unknown as { status: 'active' }; return { kind: 'api-key', status: alias.status };",
    ]) {
      const source = ts.createSourceFile(
        runtime,
        `import { replayApiKeyHistory as credentialAlias } from './owners';\n${candidate.get(runtime)}`,
        ts.ScriptTarget.Latest,
        true,
      );
      const body = ts.createSourceFile("synthetic-field-flow.ts", result, ts.ScriptTarget.Latest, true).statements;
      const transform = ts.transform(source, [
        () => (file) =>
          ts.factory.updateSourceFile(
            file,
            file.statements.map((statement) =>
              ts.isFunctionDeclaration(statement) && statement.name?.text === "apiKeyPublicOwner"
                ? ts.factory.updateFunctionDeclaration(
                    statement,
                    statement.modifiers,
                    statement.asteriskToken,
                    statement.name,
                    statement.typeParameters,
                    statement.parameters,
                    statement.type,
                    ts.factory.createBlock(body, true),
                  )
                : statement,
            ),
          ),
      ]);
      try {
        const bypass = new Map(candidate);
        bypass.set(owners, `${candidate.get(owners)}\nexport { replayApiKeyHistory };\n`);
        bypass.set(runtime, ts.createPrinter().printFile(transform.transformed[0]));
        expect(() => inspectBoundary(bypass)).toThrow("credential-public-field-flow");
      } finally {
        transform.dispose();
      }
    }
    expect(() => inspectBoundary(candidate)).not.toThrow();
  });

  it("rejects retained and generic-join-only bypass on the same resolved-symbol assertion", () => {
    const candidate = boundarySources();
    const inventory = inspectBoundary(candidate);
    expect(inventory.functions).toBeGreaterThan(10);
    expect(inventory.historyCallers.some((caller) => caller.startsWith("replayApiKeyHistory:credential"))).toBe(true);
    const retained = boundarySources("b28bc8475b9258f9e414fa0c48fb25233d97d5fb");
    const red = (sources: Map<string, string>, label: string, expected: string) => {
      let message: string | undefined;
      try {
        inspectBoundary(sources);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe(expected);
      process.stdout.write(`${label}: RED ${message}\n`);
    };
    red(retained, "retained b28bc847", "user-return-credential-join");
    red(boundarySources(frozenMain), "frozen main", "shared-history-join:ownerState");
    const ownersFile = [...candidate.keys()].find((file) => file.endsWith("/api/owners.ts"))!;
    const source = ts.createSourceFile(ownersFile, candidate.get(ownersFile)!, ts.ScriptTarget.Latest, true);
    const transform = ts.transform(source, [
      (context) => {
        const visit: ts.Visitor = (node) => {
          if (ts.isFunctionDeclaration(node) && node.name?.text === "validateUserHistory" && node.body) {
            const statements = node.body.statements.map((statement) =>
              ts.isReturnStatement(statement)
                ? ts.factory.createReturnStatement(
                    ts.factory.createCallExpression(ts.factory.createIdentifier("validateOwnerHistory"), undefined, [
                      ts.factory.createStringLiteral("user"),
                      ts.factory.createIdentifier("history"),
                      ts.factory.createIdentifier("tenantId"),
                    ]),
                  )
                : statement,
            );
            return ts.factory.updateFunctionDeclaration(
              node,
              node.modifiers,
              node.asteriskToken,
              node.name,
              node.typeParameters,
              node.parameters,
              node.type,
              ts.factory.updateBlock(node.body, statements),
            );
          }
          if (ts.isFunctionDeclaration(node) && node.name?.text === "validateOwnerHistory" && node.body) {
            const joined = ts.factory.createIfStatement(
              ts.factory.createBinaryExpression(
                ts.factory.createIdentifier("kind"),
                ts.SyntaxKind.EqualsEqualsEqualsToken,
                ts.factory.createStringLiteral("api-key"),
              ),
              ts.factory.createReturnStatement(
                ts.factory.createCallExpression(ts.factory.createIdentifier("replayApiKeyHistory"), undefined, [
                  ts.factory.createIdentifier("history"),
                  ts.factory.createIdentifier("tenantId"),
                ]),
              ),
            );
            const user = ts.factory.createIfStatement(
              ts.factory.createBinaryExpression(
                ts.factory.createIdentifier("kind"),
                ts.SyntaxKind.EqualsEqualsEqualsToken,
                ts.factory.createStringLiteral("user"),
              ),
              ts.factory.createReturnStatement(
                ts.factory.createCallExpression(ts.factory.createIdentifier("userState"), undefined, [
                  ts.factory.createIdentifier("history"),
                ]),
              ),
            );
            return ts.factory.updateFunctionDeclaration(
              node,
              node.modifiers,
              node.asteriskToken,
              node.name,
              node.typeParameters,
              node.parameters,
              node.type,
              ts.factory.updateBlock(node.body, [
                node.body.statements[0],
                joined,
                user,
                ...node.body.statements.slice(1),
              ]),
            );
          }
          return ts.visitEachChild(node, visit, context);
        };
        return (node) => ts.visitNode(node, visit) as ts.SourceFile;
      },
    ]);
    try {
      const bypass = new Map(candidate);
      bypass.set(ownersFile, ts.createPrinter().printFile(transform.transformed[0]));
      red(bypass, "generic-join-only bypass", "user-return-credential-join");
      // Only the call/return join changed. Every pre-existing validation statement remains in both functions.
      const printed = ts.createPrinter().printFile(source);
      expect(bypass.get(ownersFile)).not.toBe(printed);
      expect(inspectBoundary(candidate)).toEqual(inventory);
      process.stdout.write(
        `candidate: GREEN resolved functions=${inventory.functions} history callers=${inventory.historyCallers.length} public fields=${inventory.publicFields.length}\n`,
      );
    } finally {
      transform.dispose();
    }
  });

  it("derives literal real-service DB requests and actual returned-ID reuse from the owning case", () => {
    const file = path.resolve(import.meta.dirname, "account-management.db.test.ts");
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const options = { noLib: true, noResolve: true };
    const host = ts.createCompilerHost(options);
    host.getSourceFile = (name) => (path.resolve(name) === file ? source : undefined);
    const checker = ts.createProgram([file], options, host).getTypeChecker();
    const calls: ts.CallExpression[] = [];
    let owner: ts.ArrowFunction | undefined;
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        node.arguments.some(
          (argument) =>
            ts.isStringLiteral(argument) &&
            argument.text === "issue-7168-ac5-history: all fifteen intents retain their no-op and terminal decisions",
        )
      )
        owner = node.arguments.find(ts.isArrowFunction);
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (!owner) throw new Error("owning DB case missing");
    function collect(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "submit"
      )
        calls.push(node);
      ts.forEachChild(node, collect);
    }
    collect(owner);
    const actions = new Set<string>();
    const returnedIdTargets = new Set<ts.Symbol>();
    let returnedIdUses = 0;
    for (const call of calls) {
      expect(call.arguments).toHaveLength(1);
      const request = call.arguments[0];
      if (!ts.isObjectLiteralExpression(request)) throw new Error("positional-or-indirect-submit-adapter");
      const property = (name: string) =>
        request.properties.find((field) => ts.isPropertyAssignment(field) && field.name.getText(source) === name) as
          | ts.PropertyAssignment
          | undefined;
      const action = property("action")?.initializer;
      if (!action || !ts.isStringLiteral(action)) throw new Error("nonliteral-service-action");
      actions.add(action.text);
      if (["rotate-api-key", "revoke-api-key"].includes(action.text)) {
        const target = property("target")!.initializer;
        const resolved = checker.getSymbolAtLocation(target);
        if (!resolved) throw new Error("unknown-returned-ID-symbol");
        returnedIdTargets.add(resolved);
        returnedIdUses++;
        const declaration = resolved.valueDeclaration;
        if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer)
          throw new Error("expected-ID-substitution");
        let origin = declaration.initializer;
        for (const field of ["id", "result", "receipt"]) {
          if (!ts.isPropertyAccessExpression(origin) || origin.name.text !== field)
            throw new Error("unknown-returned-ID-field-flow");
          origin = origin.expression;
        }
        const committed = checker.getSymbolAtLocation(origin)?.valueDeclaration;
        if (
          !committed ||
          !ts.isVariableDeclaration(committed) ||
          !committed.initializer ||
          !ts.isAwaitExpression(committed.initializer) ||
          !ts.isCallExpression(committed.initializer.expression)
        )
          throw new Error("unknown-returned-ID-service-call");
        const created = committed.initializer.expression;
        if (
          !ts.isPropertyAccessExpression(created.expression) ||
          !ts.isPropertyAccessExpression(call.expression) ||
          checker.getSymbolAtLocation(created.expression.expression) !==
            checker.getSymbolAtLocation(call.expression.expression)
        )
          throw new Error("different-service-returned-ID");
        const creation = created.arguments[0];
        if (
          !ts.isObjectLiteralExpression(creation) ||
          !creation.properties.some(
            (field) =>
              ts.isPropertyAssignment(field) &&
              field.name.getText(source) === "action" &&
              ts.isStringLiteral(field.initializer) &&
              field.initializer.text === "create-api-key",
          )
        )
          throw new Error("non-create-returned-ID");
      }
    }
    expect([...actions].sort()).toEqual(Object.keys(actionEventTypes).sort());
    expect(returnedIdTargets.size).toBe(1);
    expect(returnedIdUses).toBe(4);
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
