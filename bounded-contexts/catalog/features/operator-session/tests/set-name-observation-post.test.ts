import { afterEach, describe, expect, it, vi } from "vitest";
import { tcgplayerSingleCardUnitConstraints } from "../../source-observations/api/providers/tcgplayer/adapter";
import { setNamesProbeUnitConstraints } from "../domain/extension/set-names/probe";
import {
  parseTcgplayerSetNameObservationPost,
  tcgplayerSetNameObservationAuthority,
  tcgplayerSetNameObservationLimits,
  tcgplayerSetNameProductLineIds,
  tcgplayerSetNameUnitKeyForProductLineId,
  tcgplayerSetNameUnits,
  type TcgplayerSetNameEntry,
} from "../domain/extension/set-names/contract";
import {
  createTcgplayerSetNameObservationPost,
  type ObservationGrant,
  type TcgplayerSetNameObservationRecorder,
} from "../api/set-name-observations";
import { OperatorSessionRequestError } from "../api/request";
import {
  createInMemoryObservationStore,
  postRequest,
  provenance,
  salvage,
  setNameEntry,
  setNamePost,
  testContext,
  unicodeControlSets,
} from "./set-name-observation-fixture";

afterEach(() => {
  vi.useRealTimers();
});

const pokemonLine = 3;
const validPost = () => setNamePost(pokemonLine, [setNameEntry(pokemonLine, 1)]);
const scalars = (count: number, scalar = "a") => scalar.repeat(count);

describe("set-name unit binding", () => {
  it("binds exactly the four authority-qualified product lines and keeps Lorcana unresolved", () => {
    expect(tcgplayerSetNameUnits).toEqual([
      { unitKey: "tcgplayer:mtg:single-card:source-observation-import", productLineId: 1 },
      { unitKey: "tcgplayer:yugioh:single-card:source-observation-import", productLineId: 2 },
      { unitKey: "tcgplayer:pokemon:single-card:source-observation-import", productLineId: 3 },
      { unitKey: "tcgplayer:one-piece:single-card:source-observation-import", productLineId: 68 },
      { unitKey: "tcgplayer:lorcana:single-card:source-observation-import", productLineId: null },
    ]);
    expect(tcgplayerSetNameProductLineIds).toEqual([1, 2, 3, 68]);
    expect(new Set(tcgplayerSetNameUnits.map((unit) => unit.unitKey))).toEqual(
      new Set(tcgplayerSingleCardUnitConstraints.map((unit) => unit.unitKey)),
    );
    for (const lorcanaCandidate of [82, 71]) {
      expect(tcgplayerSetNameUnitKeyForProductLineId(lorcanaCandidate)).toBeNull();
    }
  });

  it("pins the bound probe report and leaves the supplemental Lorcana report unbound", () => {
    expect(tcgplayerSetNameObservationAuthority).toEqual({
      reportSha256: "973c4a89869c9f14b3ea67acae9210123a235d7ff6c1f5040d0aa9b229cd989b",
      buildCommit: "042e14c3151e5cf7da6c3d3da63ebfacd93aed10",
      lorcanaSupplementalReportSha256: null,
    });
    // The probe keeps its own fixture ids; the contract binds only the qualified ones.
    for (const probed of setNamesProbeUnitConstraints) {
      const bound = tcgplayerSetNameUnits.find((unit) => unit.unitKey === probed.unitKey)!;
      expect(bound.productLineId === null ? null : String(bound.productLineId)).toBe(
        probed.unitKey.includes(":lorcana:") ? null : probed.productLineId,
      );
    }
  });
});

describe("parseTcgplayerSetNameObservationPost positive controls", () => {
  it.each([
    ["date-only", "2024-02-29"],
    ["measured local date-time", "2024-02-09T00:00:00"],
    ["local date-time at the clock bounds", "9999-12-31T23:59:59"],
    ["first Gregorian year", "0001-01-01T00:00:00"],
    ["UTC Instant", "2024-02-09T00:00:00Z"],
    ["millisecond Instant", "2024-02-09T00:00:00.000Z"],
    ["nanosecond Instant with offset", "2024-02-09T00:00:00.123456789+09:00"],
    ["negative offset Instant", "2024-02-09T18:30:00-07:00"],
    ["null", null],
  ] as const)("keeps a %s releaseDate unchanged", (_label, releaseDate) => {
    const post = setNamePost(pokemonLine, [setNameEntry(pokemonLine, 1, { releaseDate })]);
    const parsed = parseTcgplayerSetNameObservationPost(post);
    expect(parsed).toEqual({ ok: true, post, unitKey: "tcgplayer:pokemon:single-card:source-observation-import" });
  });

  it("passes Cc/Cf/Co/Cn text and keeps leading-FEFF identities distinct from equal display names", () => {
    expect([..."\u0007"].every((scalar) => /\p{Cc}/u.test(scalar))).toBe(true);
    expect(["​", "­", "﻿"].every((scalar) => /\p{Cf}/u.test(scalar))).toBe(true);
    expect(/\p{Co}/u.test("")).toBe(true);
    expect(/\p{Cn}/u.test("͸")).toBe(true);
    const post = setNamePost(pokemonLine, unicodeControlSets);
    const parsed = parseTcgplayerSetNameObservationPost(post);
    expect(parsed.ok && parsed.post.sets).toEqual(unicodeControlSets);
    expect(parsed.ok && parsed.post.sets.map((set) => set.cleanSetName)).toContain("﻿Synthetic Base");
    expect(parsed.ok && parsed.post.sets.map((set) => set.cleanSetName)).toContain("Synthetic Base");
  });

  it("accepts every field at its upper bound and the complete 5,000-entry list", () => {
    const widest = setNameEntry(pokemonLine, tcgplayerSetNameObservationLimits.maxIdentifier, {
      name: scalars(128, "\u{1F0A1}"),
      cleanSetName: scalars(128, "\u{1F0A1}"),
      urlName: scalars(160),
      abbreviation: scalars(32),
      isSupplemental: true,
      active: false,
    });
    expect(parseTcgplayerSetNameObservationPost(setNamePost(pokemonLine, [widest])).ok).toBe(true);
    const complete = Array.from({ length: 5_000 }, (_, index) => setNameEntry(pokemonLine, index + 1));
    const parsed = parseTcgplayerSetNameObservationPost(setNamePost(pokemonLine, complete));
    expect(parsed.ok && parsed.post.sets).toHaveLength(5_000);
  });
});

type Mutation = (post: Record<string, unknown>, entry: Record<string, unknown>) => void;

const invalidBodies: readonly (readonly [string, Mutation])[] = [
  ["an unknown top-level key", (post) => (post.extra = 1)],
  ["a missing top-level key", (post) => delete post.observedAt],
  ["an inherited __proto__ key", (post) => Object.defineProperty(post, "__proto__", { value: {}, enumerable: true })],
  ["an unknown nested set key", (_post, entry) => (entry.productLineName = "Pokemon")],
  ["a missing nested set key", (_post, entry) => delete entry.abbreviation],
  ["contractVersion 2", (post) => (post.contractVersion = 2)],
  ["a string productLineId", (post) => (post.productLineId = "3")],
  ["productLineId 0", (post) => (post.productLineId = 0)],
  ["productLineId above 2^31-1", (post) => (post.productLineId = 2_147_483_648)],
  ["a fractional productLineId", (post) => (post.productLineId = 3.5)],
  ["observedAt without milliseconds", (post) => (post.observedAt = "2026-10-28T13:42:00Z")],
  ["observedAt with an offset", (post) => (post.observedAt = "2026-10-28T13:42:00.953+00:00")],
  ["observedAt on February 30", (post) => (post.observedAt = "2026-02-30T13:42:00.953Z")],
  ["observedAt at hour 24", (post) => (post.observedAt = "2026-10-28T24:00:00.000Z")],
  ["empty sets", (post) => (post.sets = [])],
  ["5,001 sets", (post) => (post.sets = Array.from({ length: 5_001 }, (_, index) => setNameEntry(3, index + 1)))],
  ["a non-array sets value", (post) => (post.sets = {})],
  ["a non-object set", (post) => (post.sets = [["not", "an", "object"]])],
  ["a categoryId mismatch", (_post, entry) => (entry.categoryId = 1)],
  ["a duplicate setNameId", (post, entry) => (post.sets = [entry, { ...entry, cleanSetName: "Other" }])],
  ["a duplicate exact cleanSetName", (post, entry) => (post.sets = [entry, { ...entry, setNameId: 2 }])],
  ["setNameId 0", (_post, entry) => (entry.setNameId = 0)],
  ["setNameId above 2^31-1", (_post, entry) => (entry.setNameId = 2_147_483_648)],
  ["a string setNameId", (_post, entry) => (entry.setNameId = "1")],
  ["an empty name", (_post, entry) => (entry.name = "")],
  ["an empty cleanSetName", (_post, entry) => (entry.cleanSetName = "")],
  ["an empty urlName", (_post, entry) => (entry.urlName = "")],
  ["a 129-scalar name", (_post, entry) => (entry.name = scalars(129))],
  ["a 129-scalar cleanSetName", (_post, entry) => (entry.cleanSetName = scalars(129, "\u{1F0A1}"))],
  ["a 161-scalar urlName", (_post, entry) => (entry.urlName = scalars(161))],
  ["a 33-scalar abbreviation", (_post, entry) => (entry.abbreviation = scalars(33))],
  ["a NUL in name", (_post, entry) => (entry.name = "Synthetic\u0000Set")],
  ["a NUL in cleanSetName", (_post, entry) => (entry.cleanSetName = "\u0000")],
  ["a NUL in urlName", (_post, entry) => (entry.urlName = "synthetic\u0000")],
  ["a NUL in abbreviation", (_post, entry) => (entry.abbreviation = "\u0000")],
  ["an unpaired high surrogate", (_post, entry) => (entry.name = "Synthetic\uD83C")],
  ["an unpaired low surrogate", (_post, entry) => (entry.cleanSetName = "\uDCA1Synthetic")],
  ["a numeric name", (_post, entry) => (entry.name = 7)],
  ["a numeric abbreviation", (_post, entry) => (entry.abbreviation = 7)],
  ["a string isSupplemental", (_post, entry) => (entry.isSupplemental = "false")],
  ["a null active", (_post, entry) => (entry.active = null)],
  ["a local date-time without seconds", (_post, entry) => (entry.releaseDate = "2024-02-09T00:00")],
  ["a space-separated date-time", (_post, entry) => (entry.releaseDate = "2024-02-09 00:00:00")],
  ["a local date-time with a fraction", (_post, entry) => (entry.releaseDate = "2024-02-09T00:00:00.000")],
  ["a local date-time on February 30", (_post, entry) => (entry.releaseDate = "2024-02-30T00:00:00")],
  ["a non-leap February 29", (_post, entry) => (entry.releaseDate = "2023-02-29")],
  ["year 0000", (_post, entry) => (entry.releaseDate = "0000-01-01T00:00:00")],
  ["a local date-time at hour 24", (_post, entry) => (entry.releaseDate = "2024-02-09T24:00:00")],
  ["a leap second", (_post, entry) => (entry.releaseDate = "2024-02-09T23:59:60")],
  ["an offset hour 24", (_post, entry) => (entry.releaseDate = "2024-02-09T00:00:00+24:00")],
  ["a ten-digit fraction Instant", (_post, entry) => (entry.releaseDate = "2024-02-09T00:00:00.1234567890Z")],
  ["full-width digits", (_post, entry) => (entry.releaseDate = "２０２４-02-09")],
  ["a slash date", (_post, entry) => (entry.releaseDate = "02/09/2024")],
  ["an empty releaseDate", (_post, entry) => (entry.releaseDate = "")],
];

describe("parseTcgplayerSetNameObservationPost refusals", () => {
  it.each(invalidBodies)("refuses %s as invalid-body", (_label, mutate) => {
    const entry: Record<string, unknown> = { ...setNameEntry(pokemonLine, 1) };
    const post: Record<string, unknown> = { ...setNamePost(pokemonLine, []), sets: [entry] };
    mutate(post, entry);
    expect(parseTcgplayerSetNameObservationPost(post)).toEqual({ ok: false, code: "invalid-body" });
  });

  it.each([82, 71, 4, 2_147_483_647])("refuses a well-formed post for unbound product line %i", (productLineId) => {
    const post = setNamePost(productLineId, [setNameEntry(productLineId, 1)]);
    expect(parseTcgplayerSetNameObservationPost(post)).toEqual({ ok: false, code: "product-line-unsupported" });
  });

  it.each([null, [], "post", 1])("refuses a non-object body %j", (value) => {
    expect(parseTcgplayerSetNameObservationPost(value)).toEqual({ ok: false, code: "invalid-body" });
  });
});

function harness(
  input: {
    authorize?: (request: Request) => Promise<ObservationGrant>;
    record?: TcgplayerSetNameObservationRecorder | null;
  } = {},
) {
  const events: string[] = [];
  const authorize = vi.fn(
    input.authorize ??
      (async () => {
        events.push("authorize");
        return provenance;
      }),
  );
  const record = vi.fn<TcgplayerSetNameObservationRecorder>(
    input.record ??
      (async (call) => {
        events.push("record");
        return { observationCount: call.sets.length, newObservationCount: call.sets.length, mappingsProposed: 0 };
      }),
  );
  const serializeCalls = vi.fn();
  const handler = createTcgplayerSetNameObservationPost({
    authorizeObservationGrant: authorize,
    record: input.record === null ? undefined : record,
    serializeWrites: <T>(work: () => Promise<T>) => {
      serializeCalls();
      events.push("serialize");
      return work();
    },
  });
  const serializeWrites = serializeCalls;
  return { handler, authorize, record, serializeWrites, events };
}

function trackedBody(text: string) {
  const state = { pulls: 0 };
  const bytes = new TextEncoder().encode(text);
  // A zero high-water mark means the stream is pulled only when the handler reads it.
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulls++;
        controller.enqueue(bytes);
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

async function expectRefusal(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  await expect(response.json()).resolves.toEqual({ code });
}

describe("tcgplayer set-name post guard", () => {
  it("records one valid post with grant provenance and returns only the three counts", async () => {
    const h = harness();
    const post = setNamePost(pokemonLine, unicodeControlSets);
    const response = await h.handler(postRequest(post));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      observationCount: 6,
      newObservationCount: 6,
      mappingsProposed: 0,
    });
    expect(h.events).toEqual(["authorize", "serialize", "record"]);
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls[0]![0]).toEqual({
      unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
      productLineId: pokemonLine,
      sets: unicodeControlSets,
      provenance,
      context: {
        tenantId: "tnt_identity",
        audit: { performedByUserId: provenance.creatorUserId, forAccountId: "acc_identity_system" },
      },
    });
  });

  it.each([
    ["an unknown grant", new OperatorSessionRequestError("grant-invalid", 401), 401, "grant-invalid"],
    ["a lost creator authority", new OperatorSessionRequestError("authority-lost", 403), 403, "authority-lost"],
    [
      "an unavailable grant store",
      new OperatorSessionRequestError("custody-unavailable", 503),
      503,
      "custody-unavailable",
    ],
    ["an unexpected authorization failure", new Error("raw driver text"), 503, "custody-unavailable"],
  ] as const)("refuses %s before reading the body or touching the store", async (_label, error, status, code) => {
    const h = harness({
      authorize: async () => {
        throw error;
      },
    });
    const body = trackedBody(JSON.stringify(validPost()));
    await expectRefusal(await h.handler(postRequest(body.stream)), status, code);
    expect(body.state.pulls).toBe(0);
    expect(h.serializeWrites).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it("refuses without authorizing when no observation store is composed", async () => {
    const h = harness({ record: null });
    await expectRefusal(await h.handler(postRequest(validPost())), 503, "scope-observations-unavailable");
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it.each(invalidBodies)("refuses %s with invalid-body and no write", async (_label, mutate) => {
    const h = harness();
    const entry: Record<string, unknown> = { ...setNameEntry(pokemonLine, 1) };
    const post: Record<string, unknown> = { ...setNamePost(pokemonLine, []), sets: [entry] };
    mutate(post, entry);
    await expectRefusal(await h.handler(postRequest(JSON.stringify(post))), 400, "invalid-body");
    expect(h.authorize).toHaveBeenCalledTimes(1);
    expect(h.serializeWrites).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{"],
    ["an empty body", ""],
    ["JSON text with a trailing value", `${JSON.stringify(validPost())} 1`],
    ["invalid UTF-8", new Uint8Array([0x7b, 0xff, 0x7d])],
  ] as const)("refuses %s with invalid-body and no write", async (_label, body) => {
    const h = harness();
    await expectRefusal(await h.handler(postRequest(body)), 400, "invalid-body");
    expect(h.record).not.toHaveBeenCalled();
  });

  it("refuses an unbound Lorcana candidate line with product-line-unsupported and no write", async () => {
    for (const productLineId of [82, 71]) {
      const h = harness();
      const post = setNamePost(productLineId, [setNameEntry(productLineId, 1)]);
      await expectRefusal(await h.handler(postRequest(post)), 422, "product-line-unsupported");
      expect(h.record).not.toHaveBeenCalled();
    }
  });

  it("accepts the largest valid encoded post at the 2 MiB cap and refuses cap+1 with no write", async () => {
    const cap = tcgplayerSetNameObservationLimits.maxPostBytes;
    const empty = JSON.stringify(setNamePost(pokemonLine, []));
    const [head, tail] = [empty.slice(0, -2), empty.slice(-2)];
    const sets: TcgplayerSetNameEntry[] = [];
    const parts: string[] = [];
    let size = Buffer.byteLength(head) + Buffer.byteLength(tail);
    for (let index = 1; index <= 5_000; index++) {
      const candidate = setNameEntry(pokemonLine, index, {
        name: `${index}-${"n".repeat(127)}`.slice(0, 128),
        cleanSetName: `${index}-${"c".repeat(127)}`.slice(0, 128),
        urlName: `${index}-${"u".repeat(159)}`.slice(0, 160),
        abbreviation: "a".repeat(32),
      });
      const json = JSON.stringify(candidate);
      const added = Buffer.byteLength(json) + (parts.length > 0 ? 1 : 0);
      if (size + added > cap) break;
      sets.push(candidate);
      parts.push(json);
      size += added;
    }
    const encoded = `${head}${parts.join(",")}${tail}`;
    expect(Buffer.byteLength(encoded)).toBe(size);
    const atCap = encoded + " ".repeat(cap - size);
    expect(Buffer.byteLength(atCap)).toBe(cap);

    const accepted = harness();
    const response = await accepted.handler(postRequest(atCap));
    expect(response.status).toBe(200);
    expect(accepted.record.mock.calls[0]![0].sets).toEqual(sets);

    const refused = harness();
    await expectRefusal(await refused.handler(postRequest(`${atCap} `)), 413, "body-too-large");
    expect(refused.record).not.toHaveBeenCalled();
  });

  it("refuses an endless body at the read deadline with no write", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    const endless = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"contractVersion":1,'));
      },
    });
    const pending = h.handler(postRequest(endless));
    await vi.advanceTimersByTimeAsync(5_000);
    await expectRefusal(await pending, 408, "request-timeout");
    expect(h.record).not.toHaveBeenCalled();
  });

  it("returns a fixed code when the store fails or the write lock is unavailable", async () => {
    const failing = harness({
      record: async () => {
        throw new Error('duplicate key value violates unique constraint "raw driver detail"');
      },
    });
    const response = await failing.handler(postRequest(validPost()));
    expect(await response.clone().text()).not.toContain("raw driver detail");
    await expectRefusal(response, 503, "scope-observations-unavailable");

    const locked = createTcgplayerSetNameObservationPost({
      authorizeObservationGrant: async () => provenance,
      record: vi.fn<TcgplayerSetNameObservationRecorder>(),
      serializeWrites: async () => {
        throw new OperatorSessionRequestError("custody-unavailable", 503);
      },
    });
    await expectRefusal(await locked(postRequest(validPost())), 503, "custody-unavailable");
  });
});

describe("recordExtensionScopeObservations against an in-memory observation store", () => {
  it("records Magic and One Piece exactly as the removed collectTargetOptions path plus three provenance keys", async () => {
    const store = createInMemoryObservationStore();
    for (const unit of salvage.units) {
      const result = await store.runtime.recordExtensionScopeObservations({
        unitKey: unit.unitKey,
        productLineId: unit.productLineId,
        sets: unit.sets,
        provenance,
        context: testContext,
      });
      expect(result).toEqual({
        observationCount: unit.observations.length,
        newObservationCount: unit.observations.length,
        mappingsProposed: unit.observations.length,
      });
    }
    const expected = salvage.units.flatMap((unit) =>
      unit.observations.map((observation) => ({
        ...observation,
        metadata: { ...observation.metadata, ...provenance },
      })),
    );
    const stored = store.observations().map(({ observationHash: _hash, ...observation }) => observation);
    expect(stored).toEqual(expected);
    expect(store.runs.map((run) => run.triggeredBy)).toEqual([
      `operator-extension-grant:${provenance.grantId}`,
      `operator-extension-grant:${provenance.grantId}`,
    ]);
    expect(store.commands).toHaveLength(expected.length);
  });

  it("keeps Unicode controls, leading-FEFF ids, local dates and nulls unchanged and converges on repeat", async () => {
    const store = createInMemoryObservationStore();
    const unitKey = "tcgplayer:pokemon:single-card:source-observation-import";
    const input = { unitKey, productLineId: pokemonLine, sets: unicodeControlSets, provenance, context: testContext };
    await store.runtime.recordExtensionScopeObservations(input);
    const stored = store.observations();
    expect(stored.map((observation) => observation.externalId)).toEqual(
      unicodeControlSets.map((set) => set.cleanSetName),
    );
    expect(stored.map((observation) => observation.label)).toEqual(unicodeControlSets.map((set) => set.name));
    expect(stored.map((observation) => observation.scopeKind)).toEqual(Array(6).fill("expansion"));
    expect(stored.map((observation) => observation.metadata.releaseDate)).toEqual(
      unicodeControlSets.map((set) => set.releaseDate),
    );
    expect(stored.map((observation) => observation.metadata.abbreviation)).toEqual(
      unicodeControlSets.map((set) => set.abbreviation),
    );
    expect(stored.map((observation) => observation.metadata.urlName)).toEqual(
      unicodeControlSets.map((set) => set.urlName),
    );

    const commands = store.commands.length;
    await expect(store.runtime.recordExtensionScopeObservations(input)).resolves.toEqual({
      observationCount: 6,
      newObservationCount: 0,
      mappingsProposed: 0,
    });
    expect(store.observations()).toHaveLength(6);
    expect(store.commands).toHaveLength(commands);
  });

  it("drops inactive sets and records a failed run with a fixed code when the store fails", async () => {
    const store = createInMemoryObservationStore();
    const sets = [setNameEntry(pokemonLine, 1), setNameEntry(pokemonLine, 2, { active: false })];
    await store.runtime.recordExtensionScopeObservations({
      unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
      productLineId: pokemonLine,
      sets,
      provenance,
      context: testContext,
    });
    expect(store.observations().map((observation) => observation.metadata.setNameId)).toEqual(["1"]);

    const failing = createInMemoryObservationStore();
    const query = failing.db.query.bind(failing.db);
    (failing.db as { query: unknown }).query = async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("INSERT INTO catalog_provider_scope_observations")) throw new Error("raw driver detail");
      return query(sql, params as unknown[]);
    };
    await expect(
      failing.runtime.recordExtensionScopeObservations({
        unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
        productLineId: pokemonLine,
        sets,
        provenance,
        context: testContext,
      }),
    ).rejects.toMatchObject({ code: "scope-observations-unavailable" });
    expect(failing.runs).toEqual([
      expect.objectContaining({ status: "failed", error: "scope-observations-unavailable" }),
    ]);
  });

  it("resolves a discovery target for every bound unit", async () => {
    for (const unit of tcgplayerSetNameUnits.filter((candidate) => candidate.productLineId !== null)) {
      const store = createInMemoryObservationStore();
      await expect(
        store.runtime.recordExtensionScopeObservations({
          unitKey: unit.unitKey,
          productLineId: unit.productLineId!,
          sets: [setNameEntry(unit.productLineId!, 1)],
          provenance,
          context: testContext,
        }),
      ).resolves.toMatchObject({ observationCount: 1 });
    }
  });
});
