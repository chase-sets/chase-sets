import { describe, expect, it, vi } from "vitest";
import {
  parseTcgplayerSetNameObservationPost,
  tcgplayerSetNameObservationAuthority,
  tcgplayerSetNameObservationLimits,
} from "../../../domain/extension/set-names/contract";
import { reduceTcgplayerSetNames } from "../../../domain/extension/set-names/reducer";
import { runTcgplayerSetNames } from "../../../domain/extension/set-names/run";
import type { SetNamesPost } from "../../../domain/extension/set-names/transport";
import { counts, entry, largestPostSets, observedAt, response } from "./fixture";

describe("lossless SetNames reducer", () => {
  it("publishes a value-free receipt before rejecting a synthetic JSON category object", () => {
    const body: unknown = JSON.parse(
      JSON.stringify({ errors: [], results: [{ ...entry(), categoryId: { toString: null } }] }),
    );
    const onReceipt = vi.fn();
    const reduced = reduceTcgplayerSetNames(response(body), 3, observedAt, onReceipt);
    expect(reduced).toMatchObject({ outcome: "unqualified", code: "invalid-body" });
    expect(onReceipt).toHaveBeenCalledExactlyOnceWith(reduced.receipt);
    expect(reduced.receipt).toMatchObject({ resultCount: 1, activeCount: 1, errorsCount: 0 });
    expect(JSON.stringify(reduced.receipt)).not.toMatch(/toString|Synthetic|synthetic-pokemon/);
    expect(reduceTcgplayerSetNames(response(), 3, observedAt)).toMatchObject({ outcome: "qualified" });
  });
  it("pins the accepted report hash without inventing supplemental authority", () => {
    expect(tcgplayerSetNameObservationAuthority.reportSha256).toBe(
      "973c4a89869c9f14b3ea67acae9210123a235d7ff6c1f5040d0aa9b229cd989b",
    );
    expect(tcgplayerSetNameObservationAuthority.lorcanaSupplementalReportSha256).toBeNull();
  });
  it("preserves synthetic Pokemon Unicode, raw identities, nulls, flags and local dates through the real parser", () => {
    const opaque = "Synthetic\u0007\u200b\ue000\u0378";
    const sets = [
      entry({ name: opaque, cleanSetName: opaque, urlName: opaque }),
      entry({
        setNameId: 2,
        name: opaque,
        cleanSetName: `\ufeff${opaque}`,
        abbreviation: "",
        releaseDate: null,
        active: false,
        isSupplemental: true,
      }),
      entry({ setNameId: 3, cleanSetName: ` ${opaque} `, releaseDate: "0001-01-01T00:00:00" }),
    ];
    const reduced = reduceTcgplayerSetNames(response({ errors: [], results: sets }), 3, observedAt);
    expect(reduced.outcome).toBe("qualified");
    if (reduced.outcome !== "qualified") throw new Error("expected-qualified");
    expect(reduced.post.sets).toEqual(sets);
    expect(parseTcgplayerSetNameObservationPost(reduced.post)).toMatchObject({ ok: true, post: { sets } });
  });
  it("captures the receipt and receipt-time observedAt before reduction, then posts once", async () => {
    const order: string[] = [];
    const result = response();
    const body = result.body as { results: unknown[] };
    const original = body.results;
    const receipt = vi.fn(() => {
      order.push("receipt");
    });
    const post = vi.fn<SetNamesPost>(async (_environment, candidate) => {
      order.push("post");
      expect(candidate.observedAt).toBe(observedAt);
      return { outcome: "recorded" as const, ...counts };
    });
    await runTcgplayerSetNames({
      environment: "staging",
      productLineId: 3,
      request: async () => {
        order.push("fetch");
        return result;
      },
      now: () => {
        order.push("clock");
        return observedAt;
      },
      onReceipt: receipt,
      post,
    });
    expect(order).toEqual(["fetch", "clock", "receipt", "post"]);
    expect(original).toEqual([entry()]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(receipt).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 200,
        resultCount: 1,
        activeCount: 1,
        errorsCount: 0,
        missingFieldCounts: expect.objectContaining({ name: 0 }),
      }),
    );
  });
  it("a receipt callback can inspect the receipt before an invalid entry is rejected", () => {
    const candidate: Record<string, unknown> = { ...entry() };
    const result = response({ errors: [], results: [candidate] });
    const receipt = vi.fn(() => {
      candidate.name = 9;
    });
    expect(reduceTcgplayerSetNames(result, 3, observedAt, receipt)).toMatchObject({
      outcome: "unqualified",
      code: "invalid-body",
    });
    expect(receipt).toHaveBeenCalledOnce();
  });
  it.each([
    ["non-2xx", () => response(undefined, { status: 503 })],
    ["not ok", () => response(undefined, { ok: false })],
    ["non-json", () => response(undefined, { contentClass: "non-json" })],
    ["errors", () => response({ errors: ["Cookie TCGAuthTicket=private"], results: [entry()] })],
    ["errors missing", () => response({ results: [entry()] })],
    ["errors mistyped", () => response({ errors: {}, results: [entry()] })],
    ["unknown envelope key", () => response({ errors: [], results: [entry()], extra: true })],
    ["results missing", () => response({ errors: [] })],
    ["results mistyped", () => response({ errors: [], results: {} })],
    ["empty", () => response({ errors: [], results: [] })],
    ["cap", () => response(null, { ok: false, code: "body-cap-exceeded" })],
    ["timeout", () => response(null, { ok: false, code: "timeout" })],
    ["duplicate raw identity", () => response({ errors: [], results: [entry(), entry({ setNameId: 2 })] })],
    ["duplicate numeric id", () => response({ errors: [], results: [entry(), entry({ cleanSetName: "other" })] })],
    ["calendar", () => response({ errors: [], results: [entry({ releaseDate: "2023-02-29T00:00:00" })] })],
    ["clock", () => response({ errors: [], results: [entry({ releaseDate: "2024-02-29T24:00:00" })] })],
    ["NUL", () => response({ errors: [], results: [entry({ name: "x\u0000" })] })],
    ["surrogate", () => response({ errors: [], results: [entry({ cleanSetName: "x\ud800" })] })],
    ["text bound", () => response({ errors: [], results: [entry({ urlName: "x".repeat(161) })] })],
    ["category mismatch", () => response({ errors: [], results: [entry({ categoryId: 1 })] })],
    ["id bound", () => response({ errors: [], results: [entry({ setNameId: 0 })] })],
    ["unknown entry key", () => response({ errors: [], results: [{ ...entry(), extra: true }] })],
    [
      "5001 entries",
      () =>
        response({
          errors: [],
          results: Array.from({ length: 5001 }, (_, index) =>
            entry({ setNameId: index + 1, cleanSetName: String(index) }),
          ),
        }),
    ],
  ] as const)(
    "refuses %s with a fixed code and zero posts (valid governing-input control posts)",
    async (_label, invalid) => {
      const post = vi.fn<SetNamesPost>(async () => ({ outcome: "recorded" as const, ...counts }));
      const input = { environment: "staging" as const, productLineId: 3, now: () => observedAt, post };
      const rejected = await runTcgplayerSetNames({ ...input, request: async () => invalid() });
      expect(rejected).toMatchObject({
        outcome: "unqualified",
        code: expect.stringMatching(/^(response-unqualified|invalid-body|body-too-large)$/),
      });
      expect(post).not.toHaveBeenCalled();
      expect(JSON.stringify(rejected)).not.toMatch(/TCGAuthTicket|Cookie|Synthetic/);
      await expect(runTcgplayerSetNames({ ...input, request: async () => response() })).resolves.toMatchObject({
        outcome: "recorded",
      });
      expect(post).toHaveBeenCalledOnce();
    },
  );
  it.each(Object.keys(entry()))("rejects missing and mistyped %s with no partial post", async (field) => {
    for (const mode of ["missing", "mistyped"]) {
      const candidate: Record<string, unknown> = { ...entry() };
      if (mode === "missing") delete candidate[field];
      else candidate[field] = {};
      const post = vi.fn();
      expect(
        await runTcgplayerSetNames({
          environment: "staging",
          productLineId: 3,
          request: async () =>
            response({ errors: [], results: [entry({ setNameId: 2, cleanSetName: "valid" }), candidate] }),
          post,
        }),
      ).toMatchObject({ outcome: "unqualified", code: "invalid-body" });
      expect(post).not.toHaveBeenCalled();
    }
  });
  it("accepts the complete 5000-entry post at the encoded post cap and rejects cap plus one without dropping entries", async () => {
    const sets = largestPostSets();
    const base = { contractVersion: 1, productLineId: 3, observedAt, sets };
    const gap = tcgplayerSetNameObservationLimits.maxPostBytes - new TextEncoder().encode(JSON.stringify(base)).length;
    expect(gap).toBeGreaterThan(0);
    let remaining = gap;
    for (let index = 0; remaining > 0 && index < sets.length; index++) {
      const added = Math.min(128, remaining);
      sets[index] = entry({ ...sets[index], urlName: "u".repeat(32 + added) });
      remaining -= added;
    }
    expect(remaining).toBe(0);
    const post = vi.fn<SetNamesPost>(async () => ({ outcome: "recorded" as const, ...counts }));
    const input = {
      environment: "staging" as const,
      productLineId: 3,
      now: () => observedAt,
      post,
      request: async () => response({ errors: [], results: sets }),
    };
    expect(new TextEncoder().encode(JSON.stringify(base)).length).toBe(tcgplayerSetNameObservationLimits.maxPostBytes);
    await expect(runTcgplayerSetNames(input)).resolves.toMatchObject({ outcome: "recorded" });
    expect(post.mock.calls[0]).toEqual(["staging", base]);
    sets[sets.length - 1] = { ...sets[sets.length - 1]!, urlName: sets[sets.length - 1]!.urlName + "u" };
    post.mockClear();
    await expect(runTcgplayerSetNames(input)).resolves.toMatchObject({
      outcome: "unqualified",
      code: "body-too-large",
    });
    expect(post).not.toHaveBeenCalled();
  });
});
