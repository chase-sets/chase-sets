import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { createAccountCapabilityRuntime } from "./runtime";
import { parseCapabilityAdministrationAuthority } from "./authority";
import { AUTHORITY_RECEIPT_STREAM } from "./administration";

const instant = new Date("2026-10-12T12:00:00.000Z");
const actor: ResolvedActor = {
  sessionId: "ses_synthetic",
  membershipId: "mbr_synthetic",
  tenantId: "tnt_synthetic",
  userId: "usr_synthetic",
  accountId: "acc_actor",
  roleKey: "member",
  permissions: [],
  authenticatedAt: instant.toISOString(),
};
const context: EventStoreContext = {
  tenantId: actor.tenantId as never,
  audit: { performedByUserId: actor.userId as never, forAccountId: actor.accountId as never },
};
const scope = {
  environment: "preview",
  deploymentInstance: '["support-deployment-instance/v1","preview-9385","release-a"]',
  implementationSha: "a".repeat(40),
};
const declaration = {
  version: 1,
  environment: scope.environment,
  deploymentInstance: scope.deploymentInstance,
  authorityId: "support-admin",
  revision: 1,
  adminUserIds: [actor.userId],
};
const input = { accountId: "acc_target", capabilityKey: "support.evidence.any-case", expectedVersion: 0 };
const assignmentStream = "identity.account-capability-tnt_synthetic-acc_target-support.evidence.any-case";
const registry = [
  {
    key: input.capabilityKey,
    kind: "boolean",
    defaultValue: false,
    description: "synthetic",
    owningContext: "platform-operations",
  },
] as const;

export function defineAssignmentContract(getStore: () => Promise<EventStore>) {
  function runtime(store: EventStore, overrides: Partial<typeof declaration> = {}, target = true) {
    return createAccountCapabilityRuntime(
      { eventStore: store, checkpointStore: {} as never, db: {} as never },
      {
        authority: parseCapabilityAdministrationAuthority(JSON.stringify({ ...declaration, ...overrides }), scope),
        registry,
        targetAccountInTenant: async () => target,
        now: () => instant,
      },
    );
  }
  const receipts = (store: EventStore) => store.readStream({ streamId: AUTHORITY_RECEIPT_STREAM });
  const assignments = (store: EventStore) => store.readStream({ streamId: assignmentStream });
  const audits = async (store: EventStore) =>
    (await store.readAll()).filter((event) => event.eventType === "identity.account-capability.assignment-attempted");

  describe("assignment audit and monotonic authority receipt contract", () => {
    it("accepted, retry, revoke and denied attempts persist bounded provenance without credentials", async () => {
      const store = await getStore();
      const services = runtime(store);
      await services.initializeAdministrationAuthority();
      await services.attemptAccountCapabilityAssignment("grant", actor, input, context);
      await services.attemptAccountCapabilityAssignment("grant", actor, input, context);
      await services.attemptAccountCapabilityAssignment("revoke", actor, { ...input, expectedVersion: 1 }, context);
      const offList = { ...actor, userId: "usr_other" };
      await expect(
        services.attemptAccountCapabilityAssignment("grant", offList, input, {
          ...context,
          audit: { ...context.audit, performedByUserId: offList.userId as never },
        }),
      ).rejects.toMatchObject({ code: "administration_authority_required" });
      expect(await assignments(store)).toHaveLength(2);
      const attempts = await audits(store);
      expect(attempts).toHaveLength(4);
      expect(new Set(attempts.map((event) => event.payload.attemptId)).size).toBe(4);
      expect(attempts.map((event) => event.payload.assignmentVersion)).toEqual([1, 1, 2, null]);
      for (const event of attempts) {
        expect(event.payload).toMatchObject({
          authorityId: "support-admin",
          authorityRevision: 1,
          configDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          targetAccountId: input.accountId,
          attemptedAt: instant.toISOString(),
          reason: expect.stringMatching(/^(accepted|administration_authority_required)$/),
        });
        for (const forbidden of ["credentials", "sessionId", "authenticatedAt"])
          expect(event.payload).not.toHaveProperty(forbidden);
      }
      expect((await receipts(store))[0].payload).toMatchObject({ implementationSha: scope.implementationSha });
    });
    it("equal revision records nothing, but another digest refuses composition", async () => {
      const store = await getStore();
      await runtime(store).initializeAdministrationAuthority();
      await runtime(store).initializeAdministrationAuthority();
      await expect(
        runtime(store, { adminUserIds: ["usr_other"] }).initializeAdministrationAuthority(),
      ).rejects.toMatchObject({ code: "authority_digest_conflict" });
      expect(await receipts(store)).toHaveLength(1);
      expect(await assignments(store)).toHaveLength(0);
    });
    it("poisoned receipt history refuses initialization and assignment without echoing planted fields", async () => {
      const store = await getStore();
      await store.appendToStream({
        streamId: AUTHORITY_RECEIPT_STREAM,
        expectedVersion: "no_stream",
        context,
        events: [
          {
            eventType: "identity.capability-administration-authority.recorded",
            payload: {
              authorityId: "support-admin",
              revision: 1,
              configDigest: `sha256:${"a".repeat(64)}`,
              implementationSha: scope.implementationSha,
              unexpected: "PLANTED_SECRET",
            },
          },
        ],
      });
      const services = runtime(store);
      await expect(services.initializeAdministrationAuthority()).rejects.toMatchObject({
        code: "authority_history_invalid",
      });
      await expect(services.attemptAccountCapabilityAssignment("grant", actor, input, context)).rejects.toMatchObject({
        code: "authority_unavailable",
      });
      expect(await assignments(store)).toHaveLength(0);
      expect(JSON.stringify(await audits(store))).not.toContain("PLANTED_SECRET");
    });
    it("higher empty-list retirement fences old and lower-revision processes but keeps existing grants", async () => {
      const store = await getStore();
      const old = runtime(store);
      await old.initializeAdministrationAuthority();
      await old.attemptAccountCapabilityAssignment("grant", actor, input, context);
      const retirement = runtime(store, { revision: 2, adminUserIds: [] });
      await retirement.initializeAdministrationAuthority();
      await expect(
        old.attemptAccountCapabilityAssignment("revoke", actor, { ...input, expectedVersion: 1 }, context),
      ).rejects.toMatchObject({ code: "authority_receipt_stale" });
      const lower = runtime(store);
      await lower.initializeAdministrationAuthority();
      await expect(
        lower.attemptAccountCapabilityAssignment("revoke", actor, { ...input, expectedVersion: 1 }, context),
      ).rejects.toMatchObject({ code: "authority_receipt_stale" });
      await expect(
        retirement.attemptAccountCapabilityAssignment("revoke", actor, { ...input, expectedVersion: 1 }, context),
      ).rejects.toMatchObject({ code: "administration_authority_required" });
      expect(await receipts(store)).toHaveLength(2);
      expect(await assignments(store)).toHaveLength(1);
    });
    it.each([false, true])(
      "executes receipt-guard-deleted mutant=%s at the identical retirement interleaving",
      async (mutant) => {
        const store = await getStore();
        const old = runtime(store);
        await old.initializeAdministrationAuthority();
        let release!: () => void;
        let reached!: () => void;
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        const entered = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const append = store.appendToStreams!.bind(store);
        const spy = vi.spyOn(store, "appendToStreams").mockImplementationOnce(async (inputs) => {
          reached();
          await blocked;
          return append(mutant ? inputs.filter((input) => input.streamId !== AUTHORITY_RECEIPT_STREAM) : inputs);
        });
        const outcome = old.attemptAccountCapabilityAssignment("grant", actor, input, context);
        const observed = outcome.then(
          () => "accepted",
          () => "denied",
        );
        await entered;
        await runtime(store, { revision: 2, adminUserIds: [] }).initializeAdministrationAuthority();
        release();
        expect(await observed).toBe(mutant ? "accepted" : "denied");
        spy.mockRestore();
        const written = await assignments(store);
        if (mutant) expect(() => expect(written).toHaveLength(0)).toThrow();
        else expect(written).toHaveLength(0);
        expect((await audits(store)).map((event) => event.payload.reason)).toEqual([
          mutant ? "accepted" : "assignment_concurrency_conflict",
        ]);
      },
    );
    it("audit append failure rolls back the grant; errors never become event payloads", async () => {
      const store = await getStore();
      const services = runtime(store);
      await services.initializeAdministrationAuthority();
      const append = store.appendToStreams!.bind(store);
      const spy = vi
        .spyOn(store, "appendToStreams")
        .mockImplementationOnce((inputs) =>
          append(inputs.map((input, index) => (index === 1 ? { ...input, expectedVersion: 7 } : input))),
        );
      await expect(services.attemptAccountCapabilityAssignment("grant", actor, input, context)).rejects.toMatchObject({
        code: "assignment_concurrency_conflict",
      });
      spy.mockRestore();
      expect(await assignments(store)).toHaveLength(0);
      expect((await audits(store)).some((event) => event.payload.reason === "accepted")).toBe(false);
    });
    it("audit store unavailable fails closed, with no mutation", async () => {
      const store = await getStore();
      const services = runtime(store);
      await services.initializeAdministrationAuthority();
      const multi = vi.spyOn(store, "appendToStreams").mockRejectedValueOnce(new Error("PLANTED_SECRET"));
      const single = vi.spyOn(store, "appendToStream").mockRejectedValueOnce(new Error("PLANTED_SECRET"));
      await expect(services.attemptAccountCapabilityAssignment("grant", actor, input, context)).rejects.toThrow();
      multi.mockRestore();
      single.mockRestore();
      expect(await assignments(store)).toHaveLength(0);
      expect(JSON.stringify(await audits(store))).not.toContain("PLANTED_SECRET");
    });
    it("wrong target tenant and stale assignment version cannot mutate", async () => {
      const store = await getStore();
      await expect(
        runtime(store, {}, false).attemptAccountCapabilityAssignment("grant", actor, input, context),
      ).rejects.toMatchObject({ code: "target_account_outside_tenant" });
      const services = runtime(store);
      await services.initializeAdministrationAuthority();
      await services.attemptAccountCapabilityAssignment("grant", actor, input, context);
      await expect(services.attemptAccountCapabilityAssignment("revoke", actor, input, context)).rejects.toMatchObject({
        code: "assignment_unavailable",
      });
      expect(await assignments(store)).toHaveLength(1);
      expect((await audits(store)).map((event) => event.payload.reason)).toEqual([
        "target_account_outside_tenant",
        "accepted",
        "assignment_refused",
      ]);
    });
  });
}
