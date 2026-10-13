import { describe, expect, it, vi } from "vitest";
import { resumeAgentGrantRevocation } from "./revocation";
import type { AgentGrantRevocations, RevocationState } from "@chase-sets/identity/server";
import type { PaymentServices } from "@chase-sets/payments/server";
import type { EventStoreContext } from "@chase-sets/event-core/storage";

const context: EventStoreContext = {
  tenantId: "tnt_identity",
  audit: { performedByUserId: "usr_a", forAccountId: "acc_a" },
};

describe("agent-grant-revocation-stage-recovery", () => {
  it("recovers under the original effect context when token and UI callers differ", async () => {
    const original: EventStoreContext = {
      tenantId: "tnt_identity",
      audit: { performedByUserId: "usr_identity_system", forAccountId: "acc_a" },
    };
    const recovery: EventStoreContext = {
      tenantId: "tnt_customer",
      audit: { performedByUserId: "usr_a", forAccountId: "acc_a" },
    };
    const phases = ["admitted", "identity-terminal", "payments-terminal", "webhook-excluded", "completed"] as const;
    const state = {
      operationId: "eea0342d-079b-460e-9dfe-06c42a0a8a70",
      accountId: "acc_a",
      grantId: "grant_a",
      revokedAt: "2026-10-12T00:00:00.000Z",
      phase: "identity-terminal" as const,
      version: 2,
      effectContext: original,
    };
    const advance: AgentGrantRevocations["advance"] = vi.fn(async (current) => ({
      ...current, phase: phases[current.version], version: current.version + 1,
    }));
    const cleanup = vi.fn(async () => ({ detached: 0, alreadyRemoved: 0, instrumentIds: [] }));
    await resumeAgentGrantRevocation({ advance, cleanup, exclude: vi.fn(async () => true) }, state, recovery);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(
      { accountId: "acc_a", agentGrantId: "grant_a", revokedAt: state.revokedAt }, original,
    );
    expect(advance).toHaveBeenNthCalledWith(1, state, original);
  });
  it.each([1, 2, 3, 4])(
    "recovers a lost reply after durable phase %s without rerunning completed effects",
    async (lostVersion) => {
      const phases = ["admitted", "identity-terminal", "payments-terminal", "webhook-excluded", "completed"] as const;
      let retained: RevocationState = {
        operationId: "eea0342d-079b-460e-9dfe-06c42a0a8a70",
        accountId: "acc_a",
        grantId: "grant_a",
        revokedAt: "2026-10-12T00:00:00.000Z",
        phase: "admitted",
        version: 1,
        effectContext: context,
      };
      let lost = false;
      const advance: AgentGrantRevocations["advance"] = async (state) => {
        retained = { ...state, phase: phases[state.version], version: state.version + 1 };
        if (!lost && state.version === lostVersion) {
          lost = true;
          throw new Error("synthetic-lost-reply");
        }
        return retained;
      };
      const cleanup = vi.fn(async () => ({ detached: 0, alreadyRemoved: 0, instrumentIds: [] }));
      const exclude = vi.fn(async () => true);
      await expect(resumeAgentGrantRevocation({ advance, cleanup, exclude }, retained, context)).rejects.toThrow(
        "synthetic-lost-reply",
      );
      expect(await resumeAgentGrantRevocation({ advance, cleanup, exclude }, retained, context)).toMatchObject({
        phase: "completed",
      });
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(exclude).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["admitted", "identity-terminal", "payments-terminal", "webhook-excluded", "completed"] as const)(
    "resumes missing work from %s",
    async (phase) => {
      const phases = ["admitted", "identity-terminal", "payments-terminal", "webhook-excluded", "completed"] as const;
      let state: RevocationState = {
        operationId: "eea0342d-079b-460e-9dfe-06c42a0a8a70",
        accountId: "acc_a",
        grantId: "grant_a",
        revokedAt: "2026-10-12T00:00:00.000Z",
        phase,
        version: phases.indexOf(phase) + 1,
        effectContext: context,
      };
      const advance: AgentGrantRevocations["advance"] = vi.fn(
        async () => (state = { ...state, phase: phases[state.version], version: state.version + 1 }),
      );
      const cleanup: PaymentServices["revokeSavedCheckoutInstrumentsForAgentGrant"] = vi.fn(async () => ({
        detached: 0,
        alreadyRemoved: 0,
        instrumentIds: [],
      }));
      const exclude = vi.fn(async () => true);
      expect(await resumeAgentGrantRevocation({ advance, cleanup, exclude }, state, context)).toMatchObject({
        phase: "completed",
      });
      expect(cleanup).toHaveBeenCalledTimes(phases.indexOf(phase) < 2 ? 1 : 0);
      expect(exclude).toHaveBeenCalledTimes(phases.indexOf(phase) < 3 ? 1 : 0);
      if (phases.indexOf(phase) < 2)
        expect(cleanup).toHaveBeenCalledWith(
          { accountId: "acc_a", agentGrantId: "grant_a", revokedAt: state.revokedAt },
          context,
        );
    },
  );
  it("missing Payments wiring cannot certify completion", async () => {
    const state: RevocationState = {
      operationId: "eea0342d-079b-460e-9dfe-06c42a0a8a70",
      accountId: "acc_a",
      grantId: "grant_a",
      revokedAt: "2026-10-12T00:00:00.000Z",
      phase: "identity-terminal",
      version: 2,
      effectContext: context,
    };
    const advance = vi.fn();
    await expect(
      resumeAgentGrantRevocation({ advance, exclude: vi.fn() }, state, context),
    ).rejects.toThrow("revocation_effect_unavailable");
    expect(advance).not.toHaveBeenCalled();
  });
});
