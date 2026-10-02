import { expect, it, vi } from "vitest";
import { createTcgplayerAutomationRuntime } from "../api/runtime";
import { createTcgplayerProviderAdapter } from "../../source-observations/api/providers/tcgplayer/adapter";
import type { TcgplayerAutomationStageFact } from "../../source-observations/api/providers/tcgplayer-automation-client";
import { describeDb, keyring, session, useOperatorSessionDatabase } from "./db-fixture";

describeDb("operator-session precedence and routine lifecycle", () => {
  const db = useOperatorSessionDatabase("operator_session_precedence");
  const config = { auth: { tcgAuthCookie: "synthetic-environment", userAgent: "synthetic-agent" }, maxRetries: 0 };

  it("PT03/05: stored wins; key-loss clear restores env revision zero, then reaccept/restart remain correct", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("{}", { headers: { "Content-Type": "application/json" } }),
    );
    const runtime = createTcgplayerAutomationRuntime({ pool: db(), config, keyring }, { fetch })!;
    const adapter = createTcgplayerProviderAdapter({
      client: runtime.catalogClient,
      loadProfileVersions: async () => [],
    });
    const facts: TcgplayerAutomationStageFact[] = [];
    const request = async (active = runtime) => {
      facts.length = 0;
      await active.httpClients.infiniteApi.get("/synthetic", {}, { onStage: (fact) => facts.push(fact) });
      return {
        cookie: new Headers(fetch.mock.lastCall![1]?.headers).get("Cookie"),
        credential: facts.at(-1)?.credential,
      };
    };
    const environmentAttempt = {
      cookie: "TCGAuthTicket_Production=synthetic-environment;",
      credential: { source: "environment", revision: 0 },
    };
    expect(await request()).toEqual(environmentAttempt);
    await runtime.store.accept(session(0));
    expect(await request()).toEqual({
      cookie: `TCGAuthTicket_Production=${session(0).value};`,
      credential: { source: "operator-session", revision: 1 },
    });
    expect(await adapter.getCredentialReadiness!()).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: "configured", sourceKind: "operator-session" })]),
    );
    const lost = createTcgplayerAutomationRuntime({ pool: db(), config, keyring: null }, { fetch })!;
    const count = fetch.mock.calls.length;
    await expect(request(lost)).rejects.toMatchObject({ code: "credential-unavailable" });
    expect(fetch).toHaveBeenCalledTimes(count);
    expect(await lost.catalogClient.resolveCredentialReadiness()).toEqual({
      state: "missing",
      sourceKind: "operator-session",
    });
    const wrong = createTcgplayerAutomationRuntime(
      {
        pool: db(),
        config,
        keyring: {
          activeKeyId: keyring.activeKeyId,
          keys: new Map([[keyring.activeKeyId, new Uint8Array(32).fill(99)]]),
        },
      },
      { fetch },
    )!;
    await expect(request(wrong)).rejects.toMatchObject({ code: "credential-unavailable" });
    expect(fetch).toHaveBeenCalledTimes(count);
    expect(await lost.store.clear({ expectedRevision: 1, expectedKeyId: keyring.activeKeyId })).toEqual({
      outcome: "cleared",
      revision: 2,
    });
    expect(await request(lost)).toEqual(environmentAttempt);
    expect(await request()).toEqual(environmentAttempt);
    expect(await adapter.getCredentialReadiness!()).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: "configured", sourceKind: "environment-secret" })]),
    );
    const loadConfig = runtime.configStore.loadConfig;
    const mutant = vi.spyOn(runtime.configStore, "loadConfig").mockImplementation(async () => {
      const loaded = await loadConfig();
      return { ...loaded, auth: { ...loaded.auth, credential: { source: "environment", revision: 2 } } };
    });
    try {
      const mutatedAttempt = await request();
      expect(() => expect(mutatedAttempt).toEqual(environmentAttempt)).toThrow();
    } finally {
      mutant.mockRestore();
    }
    await runtime.store.accept(session(2, "reaccepted"));
    const restarted = createTcgplayerAutomationRuntime({ pool: db(), config, keyring }, { fetch })!;
    expect(await request(restarted)).toEqual({
      cookie: "TCGAuthTicket_Production=reaccepted;",
      credential: { source: "operator-session", revision: 3 },
    });
    expect(await adapter.getCredentialReadiness!()).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: "configured", sourceKind: "operator-session" })]),
    );
    expect(await request(restarted)).toEqual({
      cookie: "TCGAuthTicket_Production=reaccepted;",
      credential: { source: "operator-session", revision: 3 },
    });
  });
});
