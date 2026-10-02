import { describe, expect, it, vi } from "vitest";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import * as envelope from "@chase-sets/platform-runtime/secret-envelope";
import { describeTcgplayerAutomationConfigForLogs } from "@chase-sets/platform-runtime/config-schema";
import { createPostgresCatalogOperatorSessionStore } from "../api/store";
import { createTcgplayerAutomationRuntime } from "../api/runtime";
import { createTcgplayerProviderAdapter } from "../../source-observations/api/providers/tcgplayer/adapter";
import type { TcgplayerAutomationStageFact } from "../../source-observations/api/providers/tcgplayer-automation-client";
import {
  createInMemoryTcgplayerAutomationHttpConfigStore,
  createTcgplayerAutomationHttpClients,
} from "../../source-observations/api/providers/tcgplayer-automation-client";

const marker = "SYNTHETIC_HOSTILE_OPERATOR_MARKER_8450";
const keyring = { activeKeyId: "synthetic", keys: new Map([["synthetic", new Uint8Array(32).fill(7)]]) };
const input = { expectedRevision: 0, value: marker, observedAt: "2026-10-01T00:00:00.000Z", browserExpiresAt: null };

// This query recorder proves crypto and sink boundaries only. PostgreSQL CAS is exercised by the DB suites.
function recorder() {
  let row: Record<string, unknown> | undefined;
  const writes: unknown[] = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    if (sql.startsWith("SELECT *")) return { rows: row ? [row] : [] };
    if (sql.startsWith("INSERT") || sql.includes("SET state = 'stored'")) {
      writes.push(values);
      row = {
        provider_key: values[0],
        version: values[1],
        state: "stored",
        revision: String(values[2]),
        key_id: values[3],
        ciphertext: values[4],
        iv: values[5],
        tag: values[6],
        observed_at: values[7],
        browser_expires_at: values[8],
        stored_at: input.observedAt,
      };
      return { rows: [{ revision: String(values[2]) }] };
    }
    if (sql.includes("SET state = 'cleared'")) {
      writes.push({ sql, values });
      row = {
        ...row,
        state: "cleared",
        revision: String(values[3]),
        ciphertext: null,
        iv: null,
        tag: null,
        stored_at: null,
        observed_at: null,
        browser_expires_at: null,
      };
      return { rows: [{ revision: String(values[3]) }] };
    }
    return { rows: [] };
  });
  const db: PgQueryable = {
    async query<Row>(sql: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>> {
      return (await query(sql, values)) as PgQueryResult<Row>;
    },
  };
  return { db, query, writes, row: () => row! };
}

describe("operator-session ciphertext custody", () => {
  it("resolves once per attempt and keeps header and fact identity together across retries", async () => {
    const store = createInMemoryTcgplayerAutomationHttpConfigStore({ maxRetries: 1 });
    const initial = await store.loadConfig();
    let revision = 0;
    const load = vi.spyOn(store, "loadConfig").mockImplementation(async () => {
      revision += 1;
      return {
        ...initial,
        auth: {
          ...initial.auth,
          tcgAuthCookie: `credential-${revision}`,
          credential: { source: "operator-session", revision },
        },
      };
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("retry", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const clients = createTcgplayerAutomationHttpClients(store, { fetch, sleep: async () => undefined });
    const facts: TcgplayerAutomationStageFact[] = [];
    await clients.infiniteApi.get("/synthetic", {}, { onStage: (fact) => facts.push(fact) });
    expect(load).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map((call) => new Headers(call[1]?.headers).get("Cookie"))).toEqual([
      "TCGAuthTicket_Production=credential-1;",
      "TCGAuthTicket_Production=credential-2;",
    ]);
    expect(
      facts
        .filter((fact) => fact.stage === "fetch-start")
        .map((fact) => ({ attempt: fact.attempt, credential: fact.credential })),
    ).toEqual([
      { attempt: 1, credential: { source: "operator-session", revision: 1 } },
      { attempt: 2, credential: { source: "operator-session", revision: 2 } },
    ]);
  });
  it("key-only rotation re-seals rather than treating equal plaintext as unchanged", async () => {
    const capture = recorder();
    await createPostgresCatalogOperatorSessionStore(capture.db, keyring).accept(input);
    const rotated = createPostgresCatalogOperatorSessionStore(capture.db, {
      activeKeyId: "rotated",
      keys: new Map([...keyring.keys, ["rotated", new Uint8Array(32).fill(8)]]),
    });
    expect(await rotated.accept({ ...input, expectedRevision: 1 })).toEqual({ outcome: "stored", revision: 2 });
    expect(capture.row().key_id).toBe("rotated");
    expect(await rotated.resolve()).toEqual({ value: marker, revision: 2 });
  });

  it("PT02: overflow returns only the bounded code with zero write attempts", async () => {
    const capture = recorder();
    const store = createPostgresCatalogOperatorSessionStore(capture.db, keyring);
    await store.accept(input);
    capture.row().revision = String(Number.MAX_SAFE_INTEGER);
    capture.writes.length = 0;
    await expect(store.accept({ ...input, expectedRevision: Number.MAX_SAFE_INTEGER })).rejects.toMatchObject({
      code: "revision-exhausted",
    });
    await expect(
      store.clear({ expectedRevision: Number.MAX_SAFE_INTEGER, expectedKeyId: keyring.activeKeyId }),
    ).rejects.toMatchObject({ code: "revision-exhausted" });
    expect(capture.writes).toEqual([]);
  });

  it("PT05: clearing after key loss never calls the decrypt primitive", async () => {
    const capture = recorder();
    await createPostgresCatalogOperatorSessionStore(capture.db, keyring).accept(input);
    const lost = createPostgresCatalogOperatorSessionStore(capture.db, null);
    const open = vi.spyOn(envelope, "openSecretEnvelope");
    try {
      expect(await lost.clear({ expectedRevision: 1, expectedKeyId: keyring.activeKeyId })).toEqual({
        outcome: "cleared",
        revision: 2,
      });
      expect(await lost.resolve()).toBeNull();
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });
  it.each(["http", "parse", "transport", "primitive", "property"])(
    "never exposes an opaque credential echoed through %s errors",
    async (failure) => {
      const store = createInMemoryTcgplayerAutomationHttpConfigStore({
        auth: {
          tcgAuthCookie: marker,
          userAgent: "synthetic",
          credential: { source: "operator-session", revision: 1 },
        },
        maxRetries: 0,
      });
      const clients = createTcgplayerAutomationHttpClients(store, {
        fetch: async () => {
          if (failure === "transport") throw new Error(marker);
          if (failure === "primitive") throw marker;
          if (failure === "property") throw Object.assign(new Error("transport-failed"), { detail: marker });
          return new Response(marker, { status: failure === "http" ? 403 : 200 });
        },
      });
      let error: unknown;
      try {
        await clients.infiniteApi.get("/synthetic");
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      expect(String(error)).not.toContain(marker);
      expect(JSON.stringify(error)).not.toContain(marker);
    },
  );
  it("persists ciphertext only, authenticates the fence, and zeroes temporary buffers", async () => {
    const capture = recorder();
    const store = createPostgresCatalogOperatorSessionStore(capture.db, keyring);
    const seal = vi.spyOn(envelope, "sealSecretEnvelope");
    const open = vi.spyOn(envelope, "openSecretEnvelope");
    try {
      expect(await store.accept(input)).toEqual({ outcome: "stored", revision: 1 });
      expect(JSON.stringify(capture.writes)).not.toContain(marker);
      expect(capture.row().ciphertext).not.toEqual(Buffer.from(marker));
      expect(seal.mock.calls[0]![2]).toEqual(Buffer.alloc(marker.length));
      expect(await store.resolve()).toEqual({ value: marker, revision: 1 });
      expect(open.mock.results[0]!.value).toEqual(Buffer.alloc(marker.length));
      capture.row().revision = "2";
      expect(await store.resolve()).toEqual({ unavailable: "custody" });
    } finally {
      seal.mockRestore();
      open.mockRestore();
    }
  });

  it.each([";", "\r", "\n", " ", ",", '"', "\\", "", "x".repeat(4097)])(
    "rejects forbidden values before any database access (%#)",
    async (value) => {
      const capture = recorder();
      const store = createPostgresCatalogOperatorSessionStore(capture.db, keyring);
      await expect(store.accept({ ...input, value })).rejects.toMatchObject({
        code: "invalid-session-value",
        message: "invalid-session-value",
      });
      expect(capture.query).not.toHaveBeenCalled();
    },
  );

  it("does not expose the hostile marker through metadata, readiness, descriptions, receipts, facts or errors", async () => {
    const capture = recorder();
    const runtime = createTcgplayerAutomationRuntime({ pool: capture.db, config: null, keyring })!;
    expect(capture.query).not.toHaveBeenCalled();
    const receipt = await runtime.store.accept(input);
    const metadata = await runtime.store.readMetadata();
    const readiness = await createTcgplayerProviderAdapter({
      client: runtime.catalogClient,
      loadProfileVersions: async () => [],
    }).getCredentialReadiness!();
    const config = await runtime.configStore.loadConfig();
    const description = describeTcgplayerAutomationConfigForLogs(config);
    const facts: TcgplayerAutomationStageFact[] = [];
    const fetch = vi.fn();
    const unavailable = createTcgplayerAutomationRuntime(
      { pool: capture.db, config: { auth: { tcgAuthCookie: "environment", userAgent: "synthetic" } }, keyring: null },
      { fetch },
    )!;
    let error: unknown;
    try {
      await unavailable.httpClients.mpApi.get("/synthetic", {}, { onStage: (fact) => facts.push(fact) });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "credential-unavailable", message: "credential-unavailable" });
    expect(error).not.toHaveProperty("status");
    expect(fetch).not.toHaveBeenCalled();
    expect(facts.at(-1)).toMatchObject({ failureCode: "credential-unavailable", credential: null });
    const safeSinks = {
      receipt,
      metadata,
      readiness,
      description,
      facts,
      error,
      logFields: { ...description, error: String(error) },
    };
    expect(JSON.stringify(safeSinks)).not.toContain(marker);
    expect(JSON.stringify(safeSinks)).not.toContain(Buffer.from(marker).toString("base64"));
    expect(readiness).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: "configured", sourceKind: "operator-session" })]),
    );
    capture.query.mockRejectedValueOnce(new Error(marker));
    await expect(runtime.store.readMetadata()).rejects.toMatchObject({ message: "custody-unavailable" });
  });

  it("keyring-only boot does not read custody and missing credentials refuse without fetch", async () => {
    const capture = recorder();
    const fetch = vi.fn();
    const runtime = createTcgplayerAutomationRuntime({ pool: capture.db, config: null, keyring }, { fetch })!;
    expect(capture.query).not.toHaveBeenCalled();
    await expect(runtime.httpClients.mpApi.get("/synthetic")).rejects.toMatchObject({ code: "credential-unavailable" });
    expect(fetch).not.toHaveBeenCalled();
    expect(await runtime.catalogClient.resolveCredentialReadiness()).toEqual({
      sourceKind: "environment-secret",
      state: "missing",
    });
    expect(createTcgplayerAutomationRuntime({ pool: capture.db, config: null, keyring: null })).toBeUndefined();
  });

  it("readiness resolves every call and keeps an unavailable environment source distinct from custody", async () => {
    const capture = recorder();
    const fetch = vi.fn();
    const runtime = createTcgplayerAutomationRuntime(
      { pool: capture.db, config: { auth: { tcgAuthCookie: "invalid;environment", userAgent: "synthetic" } }, keyring },
      { fetch },
    )!;
    expect(await runtime.catalogClient.resolveCredentialReadiness()).toEqual({
      sourceKind: "environment-secret",
      state: "missing",
    });
    await expect(runtime.httpClients.infiniteApi.get("/synthetic")).rejects.toMatchObject({
      code: "credential-unavailable",
    });
    expect(fetch).not.toHaveBeenCalled();
    await runtime.store.accept(input);
    expect(await runtime.catalogClient.resolveCredentialReadiness()).toEqual({
      sourceKind: "operator-session",
      state: "configured",
    });
    await runtime.store.clear({ expectedRevision: 1, expectedKeyId: keyring.activeKeyId });
    expect(await runtime.catalogClient.resolveCredentialReadiness()).toEqual({
      sourceKind: "environment-secret",
      state: "missing",
    });
    await runtime.store.accept({ ...input, expectedRevision: 2 });
    expect(await runtime.catalogClient.resolveCredentialReadiness()).toEqual({
      sourceKind: "operator-session",
      state: "configured",
    });
  });
});
