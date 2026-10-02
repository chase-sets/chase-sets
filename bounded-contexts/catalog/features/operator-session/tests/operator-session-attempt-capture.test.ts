import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryTcgplayerAutomationHttpConfigStore,
  TcgplayerAutomationDomainHttpClient,
  type TcgplayerAutomationHttpConfigStore,
} from "../../source-observations/api/providers/tcgplayer-automation-client";

describe.each([false, true])("operator-session attempt capture (durable=%s)", (durable) => {
  it("binds the header identity before fetch even if the retained config object changes", async () => {
    const memory = createInMemoryTcgplayerAutomationHttpConfigStore({ maxRetries: 0 });
    const base = await memory.loadConfig();
    const auth = {
      tcgAuthCookie: "labeled-synthetic-original",
      userAgent: "labeled-synthetic",
      credential: { source: "operator-session" as const, revision: 1 },
      custodyRevision: 1,
    };
    const recordCredentialOutcome = vi.fn(async () => undefined);
    const store: TcgplayerAutomationHttpConfigStore = {
      ...memory,
      loadConfig: async () => ({ ...base, auth }),
      recordCredentialOutcome,
    };
    const authority: TcgplayerAutomationHttpConfigStore = durable
      ? {
          ...store,
          admitDomainRequest: async (domainKey) => {
            const admittedAt = new Date().toISOString();
            return {
              domainKey,
              granted: true,
              leaseId: "labeled-synthetic-lease",
              epoch: 0,
              admittedAt,
              notBefore: admittedAt,
              leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
              requestDelayMs: 200,
              floorRequestDelayMs: 200,
            };
          },
          renewDomainLease: async () => true,
          releaseDomainLease: async () => undefined,
          recordDomainRateLimit: store.loadDomainConfig,
          recordDomainSuccess: store.loadDomainConfig,
        }
      : store;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get("Cookie")).toBe("TCGAuthTicket_Production=labeled-synthetic-original;");
      auth.credential.revision = 3;
      auth.custodyRevision = 3;
      auth.tcgAuthCookie = "labeled-synthetic-new";
      return new Response("{}", { status: 200 });
    });
    const client = new TcgplayerAutomationDomainHttpClient(
      "infiniteApi",
      "https://labeled-synthetic.invalid",
      authority,
      {
        fetch,
        sleep: async (_ms, signal) => {
          if (signal)
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        },
      },
    );
    await client.get("/labeled-synthetic");
    expect(fetch).toHaveBeenCalledOnce();
    expect(recordCredentialOutcome).toHaveBeenCalledExactlyOnceWith({
      identity: { source: "operator-session", revision: 1, custodyRevision: 1 },
      status: 200,
      rateBudgetContext: durable ? "retained" : "unknown",
    });
  });
});
