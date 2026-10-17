import { describe, expect, it, vi } from "vitest";
import type { OrderingOrderServices } from "@chase-sets/ordering/server";
import { Hono } from "hono";
import type { EvidenceWindowById } from "./evidence-window-registration";
import {
  createEvidenceWindowSourceAdmissionMiddleware,
  createEvidenceWindowSourceRecoveryRoutes,
} from "./evidence-window-source-recovery";

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

describe("checkout evidence-window source admission middleware (#6755 F3)", () => {
  const openRegistration: EvidenceWindowById = {
    windowId,
    openedAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    state: "open" as const,
    observedMode: "test" as const,
  };
  const pair = { "x-evidence-window-id": windowId, "x-evidence-window-sub-invocation": "2b" };

  type StampOptions = Readonly<{
    mode?: "test" | "live";
    method?: string;
    actor?: boolean;
    headers?: Readonly<Record<string, string>>;
    registrationById?: () => Promise<EvidenceWindowById | null>;
  }>;

  async function stamped(options: StampOptions = {}) {
    const registrationById = vi.fn(options.registrationById ?? (async () => openRegistration));
    const host = new Hono<{ Variables: { actor: { accountId: string }; evidenceWindowSourceAdmission: unknown } }>();
    host.use("*", async (c, next) => {
      if (options.actor !== false) c.set("actor", { accountId: "acc_buyer" });
      await next();
    });
    host.use(
      "/checkout",
      createEvidenceWindowSourceAdmissionMiddleware({
        authority: {
          effectiveMode: options.mode ?? "test",
          gatewayKinds: { paymentProcessor: "fake", moneyMovement: "fake" },
        },
        registrationById,
      }),
    );
    host.all("/checkout", (c) => c.json({ admission: c.get("evidenceWindowSourceAdmission") ?? "absent" }));
    const response = await host.request("/checkout", {
      method: options.method ?? "POST",
      headers: options.headers ?? pair,
    });
    return { body: (await response.json()) as { admission: unknown }, registrationById };
  }

  it("stamps the registration's opening time for an open, unexpired test-mode window", async () => {
    const { body, registrationById } = await stamped();
    expect(body.admission).toEqual({ source: { windowId, subInvocation: "2b", windowOpenedAt: openedAt } });
    expect(registrationById).toHaveBeenCalledExactlyOnceWith(windowId);
  });

  it("stamps nothing outside test mode or on a non-POST request", async () => {
    for (const options of [{ mode: "live" as const }, { method: "GET" }]) {
      const { body, registrationById } = await stamped(options);
      expect(body.admission).toBe("absent");
      expect(registrationById).not.toHaveBeenCalled();
    }
  });

  it.each<readonly [string, StampOptions]>([
    ["no actor", { actor: false }],
    ["a partial header pair", { headers: { "x-evidence-window-id": windowId } }],
    ["an unknown sub-invocation", { headers: { ...pair, "x-evidence-window-sub-invocation": "3a" } }],
    ["a malformed window id", { headers: { ...pair, "x-evidence-window-id": "not-a-window" } }],
    ["an unknown registration", { registrationById: async () => null }],
    ["a closed registration", { registrationById: async () => ({ ...openRegistration, state: "closed" }) }],
    [
      "an expired registration",
      { registrationById: async () => ({ ...openRegistration, expiresAt: new Date(Date.now() - 1).toISOString() }) },
    ],
    ["an unreadable registration", { registrationById: async () => Promise.reject(new Error("storage unavailable")) }],
  ])("stamps a refused admission for %s", async (_label, options) => {
    const { body } = await stamped(options);
    expect(body.admission).toEqual({ source: null });
  });
});
