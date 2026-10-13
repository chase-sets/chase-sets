import { describe, expect, it, vi } from "vitest";
import { resumeAgentGrantRevocation } from "./revocation";
import type { AgentGrantRevocations, RevocationState } from "@chase-sets/identity/server";
import type { PaymentServices } from "@chase-sets/payments/server";
import type { EventStoreContext } from "@chase-sets/event-core/storage";

describe("agent-grant-revocation-stage-recovery", () => {
  it.each([1, 2, 3, 4])(
    "recovers a lost reply after durable phase %s without rerunning completed effects",
    async (lostVersion) => {
      const phases = ["admitted", "identity-terminal", "payments-terminal", "webhook-excluded", "completed"] as const;
      let retained: RevocationState = {
        operationId: "eea0342d-079b-460e-9dfe-06c42a0a8a70",
        accountId: "account_a",
        grantId: "grant_a",
        revokedAt: "2026-10-12T00:00:00.000Z",
        phase: "admitted",
        version: 1,
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
      const context = {} as EventStoreContext;
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
      const context: EventStoreContext = {
        tenantId: "tnt_identity",
        audit: { performedByUserId: "usr_a", forAccountId: "acc_a" },
      };
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
      accountId: "account_a",
      grantId: "grant_a",
      revokedAt: "2026-10-12T00:00:00.000Z",
      phase: "identity-terminal",
      version: 2,
    };
    const advance = vi.fn();
    await expect(
      resumeAgentGrantRevocation({ advance, exclude: vi.fn() }, state, {} as EventStoreContext),
    ).rejects.toThrow("revocation_effect_unavailable");
    expect(advance).not.toHaveBeenCalled();
  });
});
