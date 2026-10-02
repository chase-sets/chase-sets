import { describe, expect, it, vi } from "vitest";
import type { PgTransactionalPool, PgQueryResult } from "@chase-sets/event-core-postgres";
import * as envelope from "@chase-sets/platform-runtime/secret-envelope";
import { describeTcgplayerAutomationConfigForLogs } from "@chase-sets/platform-runtime/config-schema";
import { createPostgresCatalogOperatorSessionStore } from "../api/store";
import { createTcgplayerAutomationRuntime } from "../api/runtime";
import { validateOperatorSessionValue } from "../domain/value";
import {
  createTcgplayerProviderAdapter,
  TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "../../source-observations/api/providers/tcgplayer/adapter";
import { createTcgplayerAutomationCatalogClient } from "../../source-observations/api/providers/tcgplayer-automation-catalog-client";
import { tcgplayerAutomationResponseFixtures } from "../../source-observations/api/providers/tcgplayer-automation-response-fixtures.test-data";
import { getCatalogProviderIntegrationProfileVersion } from "../../source-observations/api/provider-integration-profiles";
import { prepareProviderAdapterSourceObservationPayload } from "../../source-observations/api/source-observation-promotion-execution";
import { requireCatalogProviderSourceObservation } from "../../source-observations/api/promotion/provider-source-observation-normalizer";
import {
  decideSourceObservation,
  evolveSourceObservation,
  initialSourceObservationState,
} from "../../source-observations/domain/domain";
import type { TcgplayerAutomationStageFact } from "../../source-observations/api/providers/tcgplayer-automation-client";
import {
  createInMemoryTcgplayerAutomationHttpConfigStore,
  createTcgplayerAutomationHttpClients,
} from "../../source-observations/api/providers/tcgplayer-automation-client";

const marker = "SYNTHETIC_HOSTILE_OPERATOR_MARKER_8450";
const keyring = { activeKeyId: "synthetic", keys: new Map([["synthetic", new Uint8Array(32).fill(7)]]) };
const input = { expectedRevision: 0, value: marker, observedAt: "2026-10-01T00:00:00.000Z", browserExpiresAt: null };

async function successfulResponseHarness(durable: boolean, body: string, value = marker) {
  const custody = createPostgresCatalogOperatorSessionStore(recorder().db, keyring);
  await custody.accept({ ...input, value });
  const resolved = await custody.resolve();
  if (!resolved || "unavailable" in resolved) throw new Error("synthetic custody setup failed");
  const store = createInMemoryTcgplayerAutomationHttpConfigStore({
    auth: {
      tcgAuthCookie: resolved.value,
      userAgent: "synthetic",
      credential: { source: "operator-session", revision: resolved.revision },
    },
    maxRetries: 0,
  });
  const load = vi.spyOn(store, "loadConfig");
  const release = vi.fn(async () => undefined);
  const admit = vi.fn(async () => ({
    domainKey: "infiniteApi" as const,
    requestDelayMs: 200,
    floorRequestDelayMs: 200,
    granted: true,
    leaseId: "synthetic-lease",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    admittedAt: new Date().toISOString(),
    notBefore: new Date().toISOString(),
    epoch: 1,
  }));
  const authority = durable
    ? {
        ...store,
        admitDomainRequest: admit,
        renewDomainLease: async () => true,
        releaseDomainLease: release,
        recordDomainRateLimit: store.loadDomainConfig,
        recordDomainSuccess: store.loadDomainConfig,
      }
    : store;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body, { status: 200 }));
  return { clients: createTcgplayerAutomationHttpClients(authority, { fetch }), load, fetch, admit, release };
}

const escapedMarker = [...marker]
  .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
  .join("");

type MatchingCase = Readonly<{ name: string; credential: string; body: string; refuses: boolean }>;

function jsonCase(name: string, credential: string, value: unknown, refuses: boolean): MatchingCase {
  return { name, credential, body: JSON.stringify(value), refuses };
}

function unicodeEscaped(value: string): string {
  return [...value].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
}

const matchingCases: MatchingCase[] = [
  ...["a", "id", "true", "0"].flatMap((credential) => [
    jsonCase("short equality: whole string", credential, credential, true),
    jsonCase("short equality: unknown member name", credential, { [credential]: "ordinary" }, true),
    jsonCase("short equality: nested array string", credential, { outer: [{ inner: [credential] }] }, true),
  ]),
  jsonCase(
    "short coincidence: shippingCategoryId and longer text",
    "a",
    { shippingCategoryId: 42, text: "ordinary data" },
    false,
  ),
  jsonCase("short coincidence: untrue", "true", { text: "untrue" }, false),
  jsonCase("short coincidence: productId", "id", { productId: 42 }, false),
  ...[true, false, null, 1, 0].flatMap((value) => {
    const credential = JSON.stringify(value);
    return [
      jsonCase("primitive distinction: typed value", credential, value, false),
      jsonCase(
        "primitive distinction: nested typed values and array indices",
        credential,
        { values: [value, 0, 1] },
        false,
      ),
      jsonCase("primitive distinction: quoted value", credential, credential, true),
      jsonCase("primitive distinction: member name", credential, { [credential]: 42 }, true),
    ];
  }),
  jsonCase("long typed primitive: number", "1234567890123456", 1234567890123456, false),
  jsonCase("long typed primitive: quoted number", "1234567890123456", "1234567890123456", true),
  ...[15, 16].flatMap((length) => {
    const credential = "X".repeat(length);
    return [
      jsonCase(`boundary ${length}: exact string`, credential, credential, true),
      jsonCase(`boundary ${length}: exact key`, credential, { [credential]: 42 }, true),
      jsonCase(`boundary ${length}: contained string`, credential, `prefix-${credential}-suffix`, length === 16),
      jsonCase(`boundary ${length}: contained key`, credential, { [`prefix-${credential}-suffix`]: 42 }, length === 16),
    ];
  }),
  jsonCase("maximum value: exact", "X".repeat(4096), "X".repeat(4096), true),
  jsonCase("maximum value: embedded", "X".repeat(4096), `prefix-${"X".repeat(4096)}-suffix`, true),
  jsonCase("maximum value: clean", "X".repeat(4096), { evidence: "ordinary" }, false),
  jsonCase("case/normalization: different case", "Ab", "ab", false),
  jsonCase("case/normalization: no trimming", "Ab", " Ab ", false),
  jsonCase("case/normalization: exact", "Ab", "Ab", true),
  ...["a", "true", marker].flatMap((credential) => [
    {
      name: "escaped JSON: nested value",
      credential,
      body: `{"outer":[{"value":"${unicodeEscaped(credential)}"}]}`,
      refuses: true,
    },
    { name: "escaped JSON: nested key", credential, body: `[{"${unicodeEscaped(credential)}":42}]`, refuses: true },
    jsonCase(
      "embedded JSON strings: encoded object",
      credential,
      { document: `{"${unicodeEscaped(credential)}":42}` },
      true,
    ),
    jsonCase("embedded JSON strings: encoded string", credential, JSON.stringify(credential), true),
    jsonCase(
      "embedded JSON strings: two encoding layers",
      credential,
      JSON.stringify(JSON.stringify({ value: credential })),
      true,
    ),
  ]),
  {
    name: "escaped JSON: short substring control",
    credential: "a",
    body: '{"text":"d\\u0061t\\u0061"}',
    refuses: false,
  },
  { name: "escaped JSON: typed control", credential: "true", body: '{"v\\u0061lue":true}', refuses: false },
  ...[true, false, null, 0, 1].map((value) =>
    jsonCase(
      "embedded JSON strings: nested primitive stays typed",
      JSON.stringify(value),
      JSON.stringify({ values: [value] }),
      false,
    ),
  ),
  jsonCase(
    "embedded JSON strings: original long containment checked before decoding",
    "1234567890123456",
    JSON.stringify({ values: [1234567890123456] }),
    true,
  ),
  jsonCase("long containment: prose value", marker, { value: `provider says ${marker}` }, true),
  jsonCase("long containment: member name", marker, { [`prefix-${marker}-suffix`]: 42 }, true),
  {
    name: "long containment: escaped nested value",
    credential: marker,
    body: `{"outer":[{"value":"prefix-${escapedMarker}-suffix"}]}`,
    refuses: true,
  },
  ...["prefix-a-suffix", "Cookie: TCGAuthTicket_Production=a;"].map((value) =>
    jsonCase("known missed echo: accepted short concatenation", "a", { value }, false),
  ),
];

const stringSurfaceCases: MatchingCase[] = [
  ...["a", "true"].flatMap((credential) => [
    { name: "text/raw exact short: literal", credential, body: credential, refuses: true },
    { name: "text/raw exact short: JSON quoted", credential, body: JSON.stringify(credential), refuses: true },
    { name: "text/raw exact short: JSON escaped", credential, body: `"${unicodeEscaped(credential)}"`, refuses: true },
    { name: "text/raw coincidence: ordinary longer text", credential, body: "ordinary data is untrue", refuses: false },
    jsonCase(
      "text/raw coincidence: unchanged fixture with boolean true",
      credential,
      tcgplayerAutomationResponseFixtures.productDetail,
      false,
    ),
    jsonCase("text/raw coincidence: nested typed primitive", credential, { value: true }, false),
  ]),
  ...["prefix-a-suffix", "Cookie: TCGAuthTicket_Production=a;"].map((body) => ({
    name: "known missed echo: accepted short concatenation body",
    credential: "a",
    body,
    refuses: false,
  })),
  ...[
    marker,
    `provider says ${marker}`,
    `{"prefix-${escapedMarker}-suffix":42}`,
    `{"value":"prefix-${escapedMarker}-suffix"}`,
  ].map((body) => ({
    name: "long containment: literal or escaped body",
    credential: marker,
    body,
    refuses: true,
  })),
];

describe.each([false, true])("explicit credential matching contract (durable=%s)", (durable) => {
  async function assertResponse(testCase: MatchingCase, responseType: "json" | "text" | "raw", response?: Response) {
    const { credential, body, refuses } = testCase;
    expect(() => validateOperatorSessionValue(credential)).not.toThrow();
    const harness = await successfulResponseHarness(durable, body, credential);
    if (response) harness.fetch.mockResolvedValueOnce(response);
    const facts: TcgplayerAutomationStageFact[] = [];
    const request = harness.clients.infiniteApi.get(
      "/synthetic",
      {},
      { responseType, onStage: (fact) => facts.push(fact) },
    );
    if (refuses) {
      const error: unknown = await request.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toBe("Error: tcgplayer-automation-request-failed");
      expect(Reflect.ownKeys(error as Error).sort()).toEqual(["message", "stack"]);
      expect(JSON.stringify(error)).toBe("{}");
      expect(facts.filter((fact) => fact.stage === "terminal")).toMatchObject([{ outcome: "failure" }]);
      if (!durable) expect(facts.some((fact) => fact.stage === "parse-failure")).toBe(true);
    } else {
      const result = await request;
      if (responseType === "raw") {
        if (response) expect(result).toBe(response);
        expect((result as Response).bodyUsed).toBe(false);
        expect(await (result as Response).text()).toBe(body);
      } else {
        expect(result).toEqual(responseType === "text" ? body : JSON.parse(body));
      }
      expect(facts.filter((fact) => fact.stage === "terminal")).toMatchObject([{ outcome: "success" }]);
    }
    expect(facts.filter((fact) => fact.stage === "fetch-start")).toMatchObject([
      { attempt: 1, credential: { source: "operator-session", revision: 1 } },
    ]);
    for (const fact of facts) {
      for (const forbidden of ["body", "response", "headers", "cookie", "error", "cause"])
        expect(fact).not.toHaveProperty(forbidden);
    }
    expect(new Headers(harness.fetch.mock.calls[0]![1]?.headers).get("Cookie")).toBe(
      `TCGAuthTicket_Production=${credential};`,
    );
    expect(harness.load).toHaveBeenCalledTimes(1);
    expect(harness.fetch).toHaveBeenCalledTimes(1);
    expect(harness.release).toHaveBeenCalledTimes(durable ? 1 : 0);
  }

  it.each(["a", "id", "true", "SYNTHETIC_UNRELATED_CREDENTIAL"])("unchanged r2 control: %s", async (credential) => {
    await assertResponse(
      jsonCase("unchanged r2 control", credential, tcgplayerAutomationResponseFixtures.productDetail, false),
      "json",
    );
  });

  it.each(matchingCases)("$name (case %#)", async (testCase) => assertResponse(testCase, "json"));

  describe.each(["text", "raw"] as const)("%s strings", (responseType) => {
    it.each(stringSurfaceCases)("$name (case %#)", async (testCase) => assertResponse(testCase, responseType));
  });

  it("maximum value: 4097 rejected before write", async () => {
    const capture = recorder();
    await expect(
      createPostgresCatalogOperatorSessionStore(capture.db, keyring).accept({ ...input, value: "X".repeat(4097) }),
    ).rejects.toMatchObject({ code: "invalid-session-value", message: "invalid-session-value" });
    expect(capture.query).not.toHaveBeenCalled();
  });

  it("undefined 204 payload has no string to inspect", async () => {
    const harness = await successfulResponseHarness(durable, "", "0");
    harness.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(harness.clients.infiniteApi.get("/synthetic")).resolves.toBeUndefined();
    expect(harness.release).toHaveBeenCalledTimes(durable ? 1 : 0);
  });

  it.each([401, 403, 429])("diagnostics/status: preserves HTTP %i and bounded failure facts", async (status) => {
    const harness = await successfulResponseHarness(durable, marker);
    harness.fetch.mockResolvedValueOnce(new Response(marker, { status }));
    const facts: TcgplayerAutomationStageFact[] = [];
    const request = harness.clients.infiniteApi.get("/synthetic", {}, { onStage: (fact) => facts.push(fact) });
    const error: unknown = await request.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      status,
      message: `TCGplayer automation request to infiniteApi failed with HTTP ${status}.`,
    });
    expect(JSON.stringify({ error, facts })).not.toContain(marker);
    expect(facts.filter((fact) => fact.stage === "terminal")).toMatchObject([{ outcome: "failure" }]);
    expect(facts.some((fact) => fact.stage === "parse-start")).toBe(false);
    expect(harness.fetch).toHaveBeenCalledTimes(1);
    expect(harness.load).toHaveBeenCalledTimes(1);
    expect(harness.release).toHaveBeenCalledTimes(durable ? 1 : 0);
  });

  it.each<Omit<MatchingCase, "body"> & Pick<ResponseInit, "headers" | "statusText"> & { url?: string }>([
    { name: "exact short header value", credential: "a", headers: { "x-evidence": "a" }, refuses: true },
    { name: "exact short header name", credential: "a", headers: { a: "ordinary" }, refuses: true },
    { name: "exact short statusText", credential: "true", statusText: "true", refuses: true },
    {
      name: "long header containment",
      credential: marker,
      headers: { "x-evidence": `prefix-${marker}-suffix` },
      refuses: true,
    },
    { name: "long URL containment", credential: marker, url: `https://synthetic.invalid/${marker}`, refuses: true },
    {
      name: "short metadata coincidence",
      credential: "a",
      headers: { "x-data": "data" },
      statusText: "ordinary",
      url: "https://synthetic.invalid/data",
      refuses: false,
    },
    {
      name: "nonmatching metadata",
      credential: marker,
      headers: { "x-data": "data" },
      statusText: "OK",
      url: "https://synthetic.invalid/data",
      refuses: false,
    },
  ])("raw metadata: $name", async ({ name, credential, headers, statusText, url, refuses }) => {
    const body = "{}";
    const response = new Response(body, { status: 200, headers, statusText });
    if (url) Object.defineProperty(response, "url", { value: url });
    await assertResponse({ name, credential, body, refuses }, "raw", response);
  });
});

describe.each([false, true])("successful-response custody boundary (durable=%s)", (durable) => {
  it.each(["json", "raw"] as const)(
    "checks only the current attempt's resolved value without caching or resolving again (%s)",
    async (responseType) => {
      const body = JSON.stringify({ evidence: marker });
      const harness = await successfulResponseHarness(durable, body);
      const config = await harness.load();
      harness.load.mockClear();
      harness.load.mockResolvedValueOnce({
        ...config,
        auth: {
          ...config.auth,
          tcgAuthCookie: "SYNTHETIC_OTHER_CREDENTIAL",
          credential: { source: "operator-session", revision: 2 },
        },
      });
      const facts: TcgplayerAutomationStageFact[] = [];
      const options = { responseType, onStage: (fact: TcgplayerAutomationStageFact) => facts.push(fact) };
      const result = await harness.clients.infiniteApi.get("/synthetic", {}, options);
      if (responseType === "raw") {
        expect((result as Response).bodyUsed).toBe(false);
        expect(await (result as Response).text()).toBe(body);
      } else {
        expect(result).toEqual({ evidence: marker });
      }
      await expect(harness.clients.infiniteApi.get("/synthetic", {}, options)).rejects.toThrow(
        "tcgplayer-automation-request-failed",
      );
      expect(harness.load).toHaveBeenCalledTimes(2);
      expect(harness.fetch.mock.calls.map((call) => new Headers(call[1]?.headers).get("Cookie"))).toEqual([
        "TCGAuthTicket_Production=SYNTHETIC_OTHER_CREDENTIAL;",
        `TCGAuthTicket_Production=${marker};`,
      ]);
      expect(harness.release).toHaveBeenCalledTimes(durable ? 2 : 0);
      expect(facts.filter((fact) => fact.stage === "fetch-start").map((fact) => fact.credential)).toEqual([
        { source: "operator-session", revision: 2 },
        { source: "operator-session", revision: 1 },
      ]);
    },
  );

  it.each(["text", "raw"] as const)(
    "refuses plain %s echo but preserves ordinary non-JSON text",
    async (responseType) => {
      const echo = await successfulResponseHarness(durable, `provider echo: ${marker}`);
      await expect(echo.clients.infiniteApi.get("/synthetic", {}, { responseType })).rejects.toThrow(
        "tcgplayer-automation-request-failed",
      );
      const clean = await successfulResponseHarness(durable, "ordinary provider text");
      const result = await clean.clients.infiniteApi.get("/synthetic", {}, { responseType });
      expect(responseType === "raw" ? await (result as Response).text() : result).toBe("ordinary provider text");
    },
  );

  it.each(["clean", "echo", "nested-escaped", "short-exact", "short-coincidence", "typed-coincidence"])(
    "%s provider evidence cannot contaminate events or snapshots",
    async (kind) => {
      const credential = kind.startsWith("short") ? "a" : kind === "typed-coincidence" ? "true" : marker;
      const refuses = ["echo", "nested-escaped", "short-exact"].includes(kind);
      const detail = {
        ...tcgplayerAutomationResponseFixtures.productDetail,
        ordinaryEvidence: "synthetic-clean-evidence",
        ...(refuses ? { syntheticCredentialEcho: { nested: [credential] } } : {}),
      };
      const body = JSON.stringify(detail).replaceAll(marker, kind === "nested-escaped" ? escapedMarker : marker);
      const harness = await successfulResponseHarness(durable, body, credential);
      const profile = getCatalogProviderIntegrationProfileVersion("tcgplayer", "2026.06.05", {
        profileKey: "pokemon-single-card-product-sku",
      })!;
      const adapter = createTcgplayerProviderAdapter({
        client: createTcgplayerAutomationCatalogClient(harness.clients),
        loadProfileVersions: async () => [profile],
      });
      const plan = await adapter.planImport({
        unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        scopeKey: "product-id",
        values: { productId: "610001" },
      });
      const envelopes = [];
      let error: unknown;
      try {
        for await (const payload of adapter.fetchPayloads(plan)) envelopes.push(payload);
      } catch (caught) {
        error = caught;
      }
      expect(harness.load).toHaveBeenCalledTimes(1);
      expect(new Headers(harness.fetch.mock.calls[0]![1]?.headers).get("Cookie")).toBe(
        `TCGAuthTicket_Production=${credential};`,
      );
      expect(harness.admit).toHaveBeenCalledTimes(durable ? 1 : 0);
      expect(harness.release).toHaveBeenCalledTimes(durable ? 1 : 0);
      const recorded = envelopes.map((envelope) => {
        const prepared = prepareProviderAdapterSourceObservationPayload({
          payload: envelope.payload,
          providerProfile: profile.profile,
        });
        if (prepared.kind !== "payload") throw new Error("synthetic payload preparation failed");
        const contract = profile.executableMappingContract;
        if (!contract?.sourceObservation) throw new Error("synthetic source observation mapping missing");
        const observation = requireCatalogProviderSourceObservation({
          contract: { ...contract, sourceObservation: contract.sourceObservation },
          payload: prepared.payload,
          observedAt: input.observedAt,
        });
        const events = decideSourceObservation(initialSourceObservationState, {
          type: "RecordSourceObservation",
          ...observation,
        });
        const snapshot = events.reduce(evolveSourceObservation, initialSourceObservationState);
        for (const evidence of [events, snapshot]) {
          expect(JSON.stringify(evidence), "credential must not enter domain events or snapshots").not.toContain(
            marker,
          );
          expect(JSON.stringify(evidence), "exact short echo must not enter domain events or snapshots").not.toContain(
            '"syntheticCredentialEcho"',
          );
          expect(JSON.stringify(evidence)).toContain("synthetic-clean-evidence");
        }
        expect(events.map((event) => event.type)).toEqual(["catalog.source-observation.recorded"]);
        expect(observation.sourcePayload).toEqual(detail);
        expect(snapshot.sourcePayload).toEqual(detail);
        return { events, snapshot };
      });
      if (refuses) {
        expect(envelopes, "contaminated payload must not reach normalization or recording").toHaveLength(0);
        expect(recorded).toEqual([]);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toBe("Error: tcgplayer-automation-request-failed");
        expect(JSON.stringify(error)).not.toContain(marker);
        return;
      }
      expect(error).toBeUndefined();
      expect(envelopes).toHaveLength(1);
      expect(recorded).toHaveLength(1);
      expect(envelopes[0]!.payload).toEqual({ kind: "product-detail", detail });
    },
  );

  describe.each(["json", "text", "raw"] as const)("%s response", (responseType) => {
    it.each([
      ["literal", JSON.stringify({ echo: marker })],
      ["nested escaped value", `{"nested":[{"echo":"${escapedMarker}"}]}`],
      ["escaped key", `{"${escapedMarker}":"ordinary"}`],
      ["embedded JSON string", JSON.stringify({ nested: `{"echo":"${escapedMarker}"}` })],
    ])("refuses %s without echoed errors or diagnostics", async (_name, body) => {
      const harness = await successfulResponseHarness(durable, body);
      const facts: TcgplayerAutomationStageFact[] = [];
      await expect(
        harness.clients.infiniteApi.get(
          "/synthetic",
          {},
          {
            responseType,
            onStage: (fact) => facts.push(fact),
          },
        ),
      ).rejects.toThrow("tcgplayer-automation-request-failed");
      expect(JSON.stringify(facts)).not.toContain(marker);
      expect(facts.filter((fact) => fact.stage === "terminal")).toMatchObject([{ outcome: "failure" }]);
      expect(harness.load).toHaveBeenCalledTimes(1);
      expect(harness.fetch).toHaveBeenCalledTimes(1);
      expect(harness.release).toHaveBeenCalledTimes(durable ? 1 : 0);
    });

    it("preserves clean content and raw body readability", async () => {
      const body = JSON.stringify({ nested: ["synthetic-clean-evidence"] });
      const harness = await successfulResponseHarness(durable, body);
      const result = await harness.clients.infiniteApi.get("/synthetic", {}, { responseType });
      if (responseType === "raw") {
        expect(result).toBeInstanceOf(Response);
        expect((result as Response).bodyUsed).toBe(false);
        expect(await (result as Response).text()).toBe(body);
      } else {
        expect(result).toEqual(responseType === "text" ? body : JSON.parse(body));
      }
      expect(harness.load).toHaveBeenCalledTimes(1);
    });
  });
});

// This query recorder proves crypto and sink boundaries only. PostgreSQL CAS is exercised by the DB suites.
function recorder() {
  let row: Record<string, unknown> | undefined;
  const writes: unknown[] = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    if (sql.includes("row_to_json(outcome)")) return { rows: [{ ...row, outcome: null }] };
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
  const db: PgTransactionalPool = {
    async connect() {
      return { query: db.query, release() {} };
    },
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
      diagnosticCode: "credential-missing",
    });
    expect(
      await createTcgplayerAutomationRuntime({
        pool: capture.db,
        config: null,
        keyring: null,
      }).catalogClient.resolveCredentialReadiness(),
    ).toEqual({ sourceKind: "environment-secret", state: "missing", diagnosticCode: "credential-missing" });
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
      diagnosticCode: "credential-missing",
    });
    await expect(runtime.httpClients.infiniteApi.get("/synthetic")).rejects.toMatchObject({
      code: "credential-unavailable",
    });
    expect(fetch).not.toHaveBeenCalled();
    await runtime.store.accept(input);
    expect(await runtime.catalogClient.resolveCredentialReadiness()).toEqual({
      sourceKind: "operator-session",
      state: "configured",
      diagnosticCode: null,
    });
    await runtime.store.clear({ expectedRevision: 1, expectedKeyId: keyring.activeKeyId });
    expect(await runtime.catalogClient.resolveCredentialReadiness()).toEqual({
      sourceKind: "environment-secret",
      state: "missing",
      diagnosticCode: "credential-missing",
    });
    await runtime.store.accept({ ...input, expectedRevision: 2 });
    expect(await runtime.catalogClient.resolveCredentialReadiness()).toEqual({
      sourceKind: "operator-session",
      state: "configured",
      diagnosticCode: null,
    });
  });
});
