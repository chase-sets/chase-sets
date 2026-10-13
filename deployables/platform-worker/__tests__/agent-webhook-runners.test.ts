import type { WorkerHostRuntime } from "@chase-sets/platform-runtime/worker";
import { describe, expect, it, vi } from "vitest";
import type { AgentGrantRevocations, RevocationState } from "@chase-sets/identity/server";
import type { PaymentServices } from "@chase-sets/payments/server";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createAgentWebhookDispatchRunners } from "../src/agent-webhook-runners";

describe("agent webhook worker runners", () => {
  it("agent-grant-revocation-floor restarts the composed missing-effect runner without reopening authority", async () => {
    let state: RevocationState = {
      operationId: "eea0342d-079b-460e-9dfe-06c42a0a8a70",
      accountId: "acc_a",
      grantId: "grant_a",
      revokedAt: "2026-10-12T00:00:00.000Z",
      phase: "identity-terminal",
      version: 2,
    };
    const context: EventStoreContext = {
      tenantId: "tnt_identity",
      audit: { performedByUserId: "usr_a", forAccountId: "acc_a" },
    };
    const phases = ["admitted", "identity-terminal", "payments-terminal", "webhook-excluded", "completed"] as const;
    const owner: Pick<AgentGrantRevocations, "pending" | "advance"> = {
      pending: async () => (state.phase === "completed" ? [] : [{ state, context }]),
      advance: async () => (state = { ...state, phase: phases[state.version], version: state.version + 1 }),
    };
    const cleanup = vi
      .fn<PaymentServices["revokeSavedCheckoutInstrumentsForAgentGrant"]>()
      .mockRejectedValueOnce(new Error("synthetic_cleanup_loss"))
      .mockResolvedValue({ detached: 0, alreadyRemoved: 0, instrumentIds: [] });
    const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const runtime = {
      mountedContexts: [
        { contextName: "auth", pool },
        { contextName: "identity", pool },
      ],
      services: {
        identity: { agentGrantRevocations: owner },
        payments: { payments: { revokeSavedCheckoutInstrumentsForAgentGrant: cleanup } },
      },
    } as unknown as WorkerHostRuntime;
    const recovery = () =>
      createAgentWebhookDispatchRunners(runtime, { workerId: "worker_1" }).find(
        (runner) => runner.name === "auth.agent-grant-revocation-recovery",
      )!;
    await expect(recovery().runOnce()).rejects.toThrow("synthetic_cleanup_loss");
    expect(state.phase).toBe("identity-terminal");
    expect(await recovery().runOnce()).toMatchObject({ processed: 1 });
    expect(state.phase).toBe("completed");
    expect(await recovery().runOnce()).toMatchObject({ processed: 0 });
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenLastCalledWith(
      { accountId: "acc_a", agentGrantId: "grant_a", revokedAt: state.revokedAt },
      context,
    );
  });
  it("registers the Auth agent webhook dispatcher as a platform-worker job", () => {
    const runners = createAgentWebhookDispatchRunners(createRuntimeWithAuth(), { workerId: "worker_1" });

    expect(runners).toHaveLength(1);
    expect(runners[0]).toMatchObject({
      name: "auth.agent-webhook-dispatcher",
      kind: "job",
    });
  });

  it("does not register the dispatcher when Auth is not mounted", () => {
    const runtime = {
      mountedContexts: [],
      services: {},
      projectionGroups: [],
      subscriptionRunners: [],
    } as unknown as WorkerHostRuntime;

    expect(createAgentWebhookDispatchRunners(runtime, { workerId: "worker_1" })).toEqual([]);
  });
});

function createRuntimeWithAuth(): WorkerHostRuntime {
  const fail = () => {
    throw new Error("agent webhook runner registration test must not query the database");
  };

  return {
    mountedContexts: [
      {
        contextName: "auth",
        services: {},
        module: {} as never,
        pool: {
          query: fail,
          connect: fail,
        } as never,
        projectionHandlerSets: [],
      },
    ],
    services: {},
    projectionGroups: [],
    subscriptionRunners: [],
  } as unknown as WorkerHostRuntime;
}
