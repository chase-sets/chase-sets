import { describe, expect, it, vi } from "vitest";
import type { OrderingOrderServices } from "@chase-sets/ordering/server";
import { createEvidenceWindowSourceRecoveryRoutes } from "./evidence-window-source-recovery";

const windowId = "abcdef0123456789abcdef0123456789";
const openedAt = "2026-09-26T12:00:00.000Z";
const source = {
  windowId,
  subInvocation: "2a" as const,
  windowOpenedAt: openedAt,
  sourceIdentity: { sourceType: "cart-checkout" as const, sourceReferenceId: "chk_1", buyerAccountId: "acc_buyer" },
  creatorState: "closed" as const,
  dischargedAt: null,
  terminalReport: null,
  version: 2,
};

function app(mode: "test" | "live" = "test") {
  const read = vi.fn(async () => [source]);
  const close = vi.fn(async () => ({ outcome: "existing" as const, source }));
  const release = vi.fn(async () => ({
    outcome: "owed" as const,
    creatorState: "closed" as const,
    surfaces: {
      purchaseLimits: "owed" as const,
      usage: "owed" as const,
      sourceClaim: "owed" as const,
      capacityAndSellerSignals: "owed" as const,
      orderStreams: "owed" as const,
    },
    purchaseLimitResidue: [],
  }));
  const routes = createEvidenceWindowSourceRecoveryRoutes({
    admissionSecret: "local-test-secret",
    authority: { effectiveMode: mode, gatewayKinds: { paymentProcessor: "fake", moneyMovement: "fake" } },
    registrationById: vi.fn(async () => ({
      windowId,
      openedAt,
      expiresAt: "2026-09-27T12:00:00.000Z",
      state: "closed" as const,
      observedMode: "test" as const,
    })),
    sources: { read, close, release, observe: vi.fn() } as unknown as OrderingOrderServices["evidenceWindowSources"],
  });
  return { routes, read, close, release };
}

const headers = { "x-evidence-window-admission": "local-test-secret", "content-type": "application/json" };

describe("Ordering source recovery admission routes", () => {
  it("AC-10 refuses production and missing/incorrect parent admission before Ordering I/O", async () => {
    const production = app("live");
    const response = await production.routes.request(`/${windowId}/sources`, { headers });
    expect(response.status).toBe(409);
    expect(production.read).not.toHaveBeenCalled();
    const unadmitted = app();
    expect((await unadmitted.routes.request(`/${windowId}/sources`)).status).toBe(403);
    expect(unadmitted.read).not.toHaveBeenCalled();
  });

  it("AC-09 reads closed historical registration and rejects mismatched time before release", async () => {
    const privateRoutes = app();
    const listed = await privateRoutes.routes.request(`/${windowId}/sources`, { headers });
    expect(listed.status).toBe(200);
    expect(privateRoutes.read).toHaveBeenCalledWith(windowId);
    const wrong = await privateRoutes.routes.request(`/${windowId}/sources/2a/release`, {
      method: "POST",
      headers,
      body: JSON.stringify({ windowOpenedAt: "2026-09-26T11:00:00.000Z" }),
    });
    expect(wrong.status).toBe(400);
    expect(privateRoutes.release).not.toHaveBeenCalled();
    const accepted = await privateRoutes.routes.request(`/${windowId}/sources/2a/release`, {
      method: "POST",
      headers,
      body: JSON.stringify({ windowOpenedAt: openedAt }),
    });
    expect(accepted.status).toBe(409);
    expect(privateRoutes.release).toHaveBeenCalledWith({
      sourceIdentity: source.sourceIdentity,
      windowOpenedAt: openedAt,
    });
  });

  it("AC-07 close admits exact version and never accepts caller source or buyer identity", async () => {
    const privateRoutes = app();
    const rejected = await privateRoutes.routes.request(`/${windowId}/sources/2a/close`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedVersion: 2, sourceIdentity: source.sourceIdentity }),
    });
    expect(rejected.status).toBe(400);
    const accepted = await privateRoutes.routes.request(`/${windowId}/sources/2a/close`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedVersion: 2 }),
    });
    expect(accepted.status).toBe(200);
    expect(privateRoutes.close).toHaveBeenCalledWith({ windowId, subInvocation: "2a", expectedVersion: 2 });
  });
});
