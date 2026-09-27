import { afterEach, describe, expect, it, vi } from "vitest";
import { createStripePaymentProcessorGateway } from "@chase-sets/stripe-payments";
import { STRIPE_API_VERSION } from "@chase-sets/stripe-config";
import { providerWriteDigest, providerWriterShape } from "@chase-sets/evidence-window-provider-write/material";
import {
  providerWriteIdempotencyKey,
  type EvidenceWindowProviderWrite,
  type ProviderWriteRow,
  type ProviderObjectClass,
} from "@chase-sets/evidence-window-provider-write";
import type { ProcessorSetupSessionCancellationResult } from "@chase-sets/payment-processing";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPaymentsServices } from "../../../support/runtime-support/services";
import {
  createEvidenceWindowDisposition,
  setupDisposition,
  type EvidenceWindowDispositionOptions,
} from "./evidence-window-disposition";
import {
  OPTION_B_CLASS_TABLE,
  SCENARIO_FIXTURES,
  validateProviderObjectDisposition,
} from "../../../../../scripts/provider-object-disposition/validate-provider-object-disposition.mjs";
import { computeResultDigest } from "../../../../../scripts/provider-object-disposition/canonicalize-provider-object-disposition.mjs";

const windowId = "a".repeat(32);
const now = "2026-01-01T00:00:00.000Z";
const expiry = "2099-01-01T00:00:00.000Z";
const marker = "SYNTHETIC_PRIVATE_MARKER";
afterEach(() => vi.unstubAllGlobals());

function row(objectClass: ProviderObjectClass, ordinal = 1, patch: Partial<ProviderWriteRow> = {}): ProviderWriteRow {
  return {
    key: { windowId, objectClass, creationOrdinal: ordinal, operation: "create" },
    binding: {
      writerKind: objectClass === 3 ? "setup-embedded" : "payment-saved",
      logicalOperationId: `operation${ordinal}`,
      ownerAccountId: "acc_SYNTHETIC",
    },
    envelope: null,
    digest: null,
    state: "succeeded",
    version: 1,
    observedClass: null,
    reusedExisting: false,
    replayAttempts: 0,
    logicalSlot: objectClass === 6 ? (ordinal as 1 | 2 | 3) : null,
    providerReference: `${objectClass === 3 ? "seti" : objectClass === 5 ? "cus" : "pi"}_${marker}${ordinal}`,
    responseExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    replayDeadline: expiry,
    ...patch,
  };
}

// Synthetic CAS store for focused gateway controls; the SQL implementation is exercised in provider-journal.db.test.ts.
function journal(initial: ProviderWriteRow[]) {
  let rows = initial;
  const find = (key: ProviderWriteRow["key"]) =>
    rows.find((candidate) => providerWriteIdempotencyKey(candidate.key) === providerWriteIdempotencyKey(key));
  const update = (original: ProviderWriteRow, patch: Partial<ProviderWriteRow>) => {
    const changed = { ...original, ...patch, version: original.version + 1 };
    rows = rows.map((candidate) => (candidate === original ? changed : candidate));
    return { kind: "existing" as const, row: changed };
  };
  const port: EvidenceWindowProviderWrite = {
    readWindow: async (id) => rows.filter((candidate) => candidate.key.windowId === id),
    reserveOrResolve: async (input) => {
      const shape = providerWriterShape(input.binding);
      const key = { ...input.originalKey!, operation: shape.operation };
      const existing = find(key);
      if (existing) return { kind: "existing", row: existing };
      const next = row(shape.objectClass, key.creationOrdinal, {
        key,
        binding: input.binding,
        envelope: input.envelope,
        digest: await providerWriteDigest(input.envelope),
        state: "pending",
        providerReference: null,
      });
      rows.push(next);
      return { kind: "reserved", row: next };
    },
    complete: async (key, version, result) => {
      const current = find(key)!;
      if (current.version !== version || current.state !== "pending") return { kind: "stale-write-rejected" };
      return update(current, {
        state: result.state,
        providerReference: result.state === "succeeded" ? result.providerReference : null,
      });
    },
    claimReplay: async (key, version) => {
      const current = find(key)!;
      if (current.version !== version) return { kind: "stale-write-rejected" };
      if (current.replayAttempts || current.state !== "pending") {
        update(current, { state: "ambiguous" });
        return { kind: "refused", code: "write-unresolved" };
      }
      return update(current, { replayAttempts: 1 });
    },
    observeCapture: async (key, version) => {
      const current = find(key)!;
      return current.version === version ? update(current, { observedClass: 1 }) : { kind: "stale-write-rejected" };
    },
    observeCustomerReuse: vi.fn(),
    admitSavedResponse: vi.fn(),
  };
  return port;
}

function compose(initial: ProviderWriteRow[] = [], patch: Partial<EvidenceWindowDispositionOptions> = {}) {
  const store = journal(initial);
  const gateway = createStripePaymentProcessorGateway({
    secretKey: "sk_test_SYNTHETIC",
    publishableKey: "pk_test_SYNTHETIC",
    webhookSecret: "whsec_SYNTHETIC",
    evidenceWindowProviderWrite: store,
    evidenceWindowCorrelation: { currentOpenWindow: async () => ({ windowId, expiresAt: expiry }) },
  });
  const options: EvidenceWindowDispositionOptions = {
    journal: store,
    processorGateway: gateway,
    providerModeObservation: {
      mode: "test",
      deploymentEnvironment: "test",
      paymentProcessorKind: "stripe",
      moneyMovementKind: "stripe",
    },
    authority: async () => ({ windowId, expiresAt: expiry, providerMode: "test" }),
    requestCapturedRemedy: async () => true,
    ...patch,
  };
  return { store, gateway, options, dispose: createEvidenceWindowDisposition(options) };
}

function fakeProvider(store: EvidenceWindowProviderWrite, lostPosts = 0) {
  const canceled = new Set<string>();
  const attempts: { method: string; key: string | null; body: BodyInit | null | undefined }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const isPost = init.method === "POST";
      const reference = url.split("/").at(isPost ? -2 : -1)!;
      const key = new Headers(init.headers).get("Idempotency-Key");
      attempts.push({ method: init.method!, key, body: init.body });
      if (isPost) {
        const committed = (await store.readWindow(windowId)).find(
          (candidate) => providerWriteIdempotencyKey(candidate.key) === key,
        );
        expect(committed).toMatchObject({ state: "pending", envelope: { apiVersion: STRIPE_API_VERSION } });
        expect(committed!.envelope!.bodyText).toBe(init.body ?? null);
        if (lostPosts-- > 0) throw new Error(marker);
        canceled.add(reference);
      }
      return Response.json({ id: reference, status: canceled.has(reference) ? "canceled" : "requires_confirmation" });
    }),
  );
  return attempts;
}

describe("evidence window disposition synthetic controls", () => {
  it("AC-01: fixture-derived six-class handling and omitted-class mutant", async () => {
    const subject = compose([row(1), row(2), row(3), row(5), row(6)]);
    fakeProvider(subject.store);
    const result = await subject.dispose(windowId);
    expect(result.variant).toBe("success");
    expect(result.classes.map((entry) => entry.class)).toEqual(OPTION_B_CLASS_TABLE.map((entry) => entry.class));
    expect(result.classes.map((entry) => entry.observedCount)).toEqual([1, 0, 0, 0, 1, 1]);
    const mutant = { ...result, classes: result.classes.slice(1) };
    mutant.resultDigest = computeResultDigest(mutant);
    expect(validateProviderObjectDisposition(mutant).ok).toBe(false);
  });

  it("AC-02: gateway-to-fetch cancels uncaptured PI and terminal repeat sends no POST", async () => {
    const subject = compose([row(2)]);
    const attempts = fakeProvider(subject.store);
    expect((await subject.dispose(windowId)).classes[1]!.state).toBe("cancelled");
    expect((await subject.dispose(windowId)).classes[1]!.state).toBe("already-terminal");
    expect(attempts.filter((attempt) => attempt.method === "POST")).toHaveLength(1);
    expect((await subject.store.readWindow(windowId)).filter((entry) => entry.key.operation === "create")).toHaveLength(
      1,
    );
  });

  it.each<[ProcessorSetupSessionCancellationResult, string]>([
    [{ outcome: "cancelled", processorStatus: "canceled" }, "cancelled"],
    [{ outcome: "already-terminal", processorStatus: "canceled" }, "already-terminal"],
    [{ outcome: "already-terminal", processorStatus: "succeeded" }, "already-terminal"],
    [{ outcome: "not-found" }, "unknown"],
    [{ outcome: "refused", reason: "invalid-reference", httpStatus: null }, "disposition-failed"],
    [{ outcome: "refused", reason: "provider-rejected", httpStatus: 400 }, "disposition-failed"],
    [{ outcome: "refused", reason: "transport-failure", httpStatus: null }, "unknown"],
    [{ outcome: "refused", reason: "unexpected-status", httpStatus: 200 }, "unknown"],
  ])("AC-03: shipped SetupIntent result union mapping %j", (input, state) =>
    expect(setupDisposition(input)).toBe(state),
  );

  it("AC-03: SetupIntent composed primitive and invalid-reference control never call PI cancellation", async () => {
    const subject = compose([row(3), row(2, 2, { providerReference: "seti_SYNTHETIC_INVALID" })]);
    const attempts = fakeProvider(subject.store);
    const result = await subject.dispose(windowId);
    expect(result.classes[2]!.state).toBe("cancelled");
    expect(result.classes[1]!.state).toBe("disposition-failed");
    expect(attempts.filter((attempt) => attempt.method === "POST")).toHaveLength(1);
    await expect(subject.gateway.cancelPayment("seti_SYNTHETIC_INVALID", { kind: "ungoverned" })).rejects.toThrow();
    expect(attempts.filter((attempt) => attempt.method === "POST")).toHaveLength(1);
  });

  it.each([
    { capHit: true },
    { total: 1 },
    { references: ["pi_SYNTHETIC_OTHER"], total: 1 },
    { nextLink: "https://unsafe.invalid" },
    { complete: false },
    { membershipQualified: false },
  ])("AC-04: cap/independent-total/membership disagreement yields unknown %j", async (patch) => {
    const subject = compose([], {
      crossCheck: async () => ({
        references: [],
        total: 0,
        complete: true,
        capHit: false,
        nextLink: null,
        membershipQualified: true,
        ...patch,
      }),
    });
    const result = await subject.dispose(windowId);
    expect(result.variant).toBe("cleanup-failure");
    expect(result.classes.slice(0, 4).every((entry) => entry.state === "unknown" && entry.observedCount === null)).toBe(
      true,
    );
  });

  it.each(["pending", "ambiguous"] as const)(
    "AC-04b/AC-04c: %s creation never becomes not-created or zero",
    async (state) => {
      const result = await compose([row(3, 1, { state }), row(6, 1, { state })]).dispose(windowId);
      expect(result.classes[2]).toMatchObject({ state: "unknown", observedCount: null, enumerationComplete: false });
      expect(result.classes[5]).toMatchObject({ state: "unknown", observedCount: null, enumerationComplete: false });
      const mutant = structuredClone(result);
      mutant.classes[2]!.observedCount = 0;
      mutant.resultDigest = computeResultDigest(mutant);
      expect(validateProviderObjectDisposition(mutant).ok).toBe(false);
    },
  );

  it.each([1, 2, 3])("AC-05: %i Account Session slots stay owed against budget 2", async (count) => {
    const result = await compose(Array.from({ length: count }, (_, index) => row(6, index + 1))).dispose(windowId);
    expect(result.classes[5]!.observedCount).toBe(count);
    expect(result.variant).toBe(count > 2 ? "cleanup-failure" : "success");
    if (count > 2) expect(result.failure).toBe("budget-exceeded");
  });

  it.each([1, 2])("AC-05: retained Customer and captured residue bound/plus-one %i", async (count) => {
    const result = await compose(
      Array.from({ length: count }, (_, index) => [
        row(1, index + 1),
        row(5, index + 1, { reusedExisting: true }),
      ]).flat(),
    ).dispose(windowId);
    expect(result.variant).toBe(count === 1 ? "success" : "cleanup-failure");
  });

  it("AC-06: planted markers absent success, refusal and failure output", async () => {
    const subject = compose([row(3)]);
    fakeProvider(subject.store, 3);
    const failure = await subject.dispose(windowId);
    const success = await compose([row(5)]).dispose(windowId);
    const refusal = await subject.dispose(marker);
    for (const result of [failure, success, refusal]) {
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(validateProviderObjectDisposition(result).ok).toBe(true);
    }
  });

  it("AC-07: production service composition is zero-fetch before authority or journal", async () => {
    const subject = compose([row(2)]);
    const fetch = vi.fn();
    const authority = vi.fn();
    const read = vi.spyOn(subject.store, "readWindow");
    vi.stubGlobal("fetch", fetch);
    const services = createPaymentsServices({ query: vi.fn(), connect: vi.fn() } as unknown as PgTransactionalPool, {
      processorGateway: subject.gateway,
      evidenceWindowProviderWrite: subject.store,
      evidenceWindowDisposition: { authority },
      providerModeObservation: {
        mode: "test",
        deploymentEnvironment: "production",
        paymentProcessorKind: "stripe",
        moneyMovementKind: "stripe",
      },
    });
    expect((await services.disposeEvidenceWindow(windowId)).refusal).toBe("production-environment");
    expect(fetch).not.toHaveBeenCalled();
    expect(authority).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("AC-09: shared fixture scenarios validate; invented runner residueUnknown is rejected", () => {
    for (const scenario of Object.values(SCENARIO_FIXTURES))
      expect(validateProviderObjectDisposition(scenario).ok).toBe(true);
    const mutant = { ...SCENARIO_FIXTURES.success, residueUnknown: false };
    mutant.resultDigest = computeResultDigest(mutant);
    expect(validateProviderObjectDisposition(mutant).ok).toBe(false);
  });

  it("AC-04: missing known membership and beyond-cap observations are not zero residue", async () => {
    for (const check of [
      { references: [], total: 0, capHit: false },
      { references: Array.from({ length: 64 }, (_, index) => `pi_SYNTHETIC${index}`), total: 65, capHit: true },
    ]) {
      const subject = compose([row(2)], {
        crossCheck: async () => ({ ...check, complete: true, nextLink: null, membershipQualified: true }),
      });
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      expect((await subject.dispose(windowId)).classes[1]).toMatchObject({ state: "unknown", observedCount: null });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("AC-04b: foreign-window and concurrent new creation cannot make the inventory complete", async () => {
    const subject = compose([row(5)]);
    const original = subject.store.readWindow;
    let reads = 0;
    const read = vi
      .spyOn(subject.store, "readWindow")
      .mockImplementation(async (id) => [...(await original(id)), ...(reads++ ? [row(6)] : [])]);
    const result = await subject.dispose(windowId);
    expect(result.classes.every((entry) => entry.state === "unknown" && entry.observedCount === null)).toBe(true);
    read.mockImplementation(async () => [
      row(5, 1, { key: { windowId: "b".repeat(32), objectClass: 5, creationOrdinal: 1, operation: "create" } }),
    ]);
    expect((await subject.dispose(windowId)).refusal).toBe("journal-unavailable");
  });

  it("AC-05: capture changes the original row class, never the number of objects", async () => {
    const subject = compose([row(2)]);
    const fetch = vi.fn(async () => Response.json({ id: row(2).providerReference, status: "succeeded" }));
    vi.stubGlobal("fetch", fetch);
    const result = await subject.dispose(windowId);
    expect(result.classes[0]).toMatchObject({ state: "remedy-requested", observedCount: 1 });
    expect(result.classes[1]!.observedCount).toBe(0);
    expect(await subject.store.readWindow(windowId)).toHaveLength(1);
    expect((await subject.store.readWindow(windowId))[0]!.observedClass).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("AC-10: accepted cancellation with lost response reconciles terminal without another POST", async () => {
    const subject = compose([row(3)]);
    let accepted = false;
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        if (init.method === "POST") {
          posts++;
          accepted = true;
          throw new Error(marker);
        }
        return Response.json({ id: row(3).providerReference, status: accepted ? "canceled" : "requires_confirmation" });
      }),
    );
    expect((await subject.dispose(windowId)).classes[2]!.state).toBe("already-terminal");
    const retained = await subject.store.readWindow(windowId);
    expect((await createEvidenceWindowDisposition(subject.options)(windowId)).variant).toBe("success");
    expect(posts).toBe(1);
    expect(await subject.store.readWindow(windowId)).toEqual(retained);
  });

  it("AC-10: inside-fetch precommit and restarted exact replay preserve body/key/deadline", async () => {
    const subject = compose([row(2)]);
    const attempts = fakeProvider(subject.store, 1);
    expect((await subject.dispose(windowId)).variant).toBe("cleanup-failure");
    const before = (await subject.store.readWindow(windowId)).find((entry) => entry.key.operation === "dispose")!;
    expect((await createEvidenceWindowDisposition(subject.options)(windowId)).variant).toBe("success");
    const after = (await subject.store.readWindow(windowId)).find((entry) => entry.key.operation === "dispose")!;
    const posts = attempts.filter((attempt) => attempt.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual(posts[1]);
    expect(after.replayAttempts).toBe(1);
    expect(after.replayDeadline).toBe(before.replayDeadline);
  });

  it("AC-10: exhausted ambiguity refuses rather than using a fresh key", async () => {
    const subject = compose([row(2)]);
    const attempts = fakeProvider(subject.store, 10);
    for (let index = 0; index < 4; index++) expect((await subject.dispose(windowId)).variant).toBe("cleanup-failure");
    expect(attempts.filter((attempt) => attempt.method === "POST")).toHaveLength(2);
  });
});
