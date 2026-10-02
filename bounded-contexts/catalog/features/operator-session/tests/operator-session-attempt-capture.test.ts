import { describe, expect, it, vi } from "vitest";
import { bypassLiveTuple, bypassCustodyReset, bypassHeadersCapture } from "./readiness-bypass-fixture";
import {
  createInMemoryTcgplayerAutomationHttpConfigStore,
  TcgplayerAutomationDomainHttpClient,
  type TcgplayerAutomationHttpConfigStore,
} from "../../source-observations/api/providers/tcgplayer-automation-client";

it("constructs each source-derived DB bypass without executing a product path", () => {
  const ran = vi.fn();
  for (const create of [bypassLiveTuple, bypassCustodyReset, bypassHeadersCapture]) {
    expect(typeof create(ran)).toBe("function");
  }
  expect(ran).not.toHaveBeenCalled();
});

describe.each([false, true])("operator-session attempt capture (durable=%s)", (durable) => {
  it.each(
    [200, 401, 429].flatMap((status) => ["success", "failure", "absent"].map((recorder) => ({ status, recorder }))),
  )("bounded recorder diagnostic preserves HTTP $status with $recorder recording", async ({ status, recorder }) => {
    const memory = createInMemoryTcgplayerAutomationHttpConfigStore({ maxRetries: 0 });
    const base = await memory.loadConfig();
    const recordCredentialOutcome = vi.fn(async () => {
      if (recorder === "failure") throw new Error("SYNTHETIC_PRIVATE_SQL_URL_BODY_CREDENTIAL");
    });
    const store: TcgplayerAutomationHttpConfigStore = {
      ...memory,
      loadConfig: async () => ({
        ...base,
        auth: {
          tcgAuthCookie: "SYNTHETIC_PRIVATE_COOKIE",
          userAgent: "labeled-synthetic",
          credential: { source: "operator-session", revision: 1 },
          custodyRevision: 1,
        },
      }),
      recordCredentialOutcome: recorder === "absent" ? undefined : recordCredentialOutcome,
      ...(durable
        ? {
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
            recordDomainRateLimit: memory.loadDomainConfig,
            recordDomainSuccess: memory.loadDomainConfig,
          }
        : {}),
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("{}", { status }));
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const client = new TcgplayerAutomationDomainHttpClient(
        "infiniteApi",
        "https://labeled-synthetic.invalid",
        store,
        {
          fetch,
          sleep: async (_ms, signal) => {
            if (signal)
              await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          },
        },
      );
      if (status === 200) await expect(client.get("/labeled-synthetic")).resolves.toEqual({});
      else await expect(client.get("/labeled-synthetic")).rejects.toMatchObject({ status });
      expect(fetch).toHaveBeenCalledOnce();
      expect(recordCredentialOutcome).toHaveBeenCalledTimes(status === 429 || recorder === "absent" ? 0 : 1);
      if (recorder === "failure" && status !== 429)
        expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
          event: "catalog.operator-session-outcome-recorder-failed",
          provider: "tcgplayer",
          status,
          source: "operator-session",
          revision: 1,
          custodyRevision: 1,
        });
      else expect(diagnostic).not.toHaveBeenCalled();
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("SYNTHETIC_PRIVATE");
    } finally {
      diagnostic.mockRestore();
    }
  });

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
