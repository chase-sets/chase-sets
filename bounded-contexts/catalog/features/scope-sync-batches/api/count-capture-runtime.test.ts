import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { readCountCaptureEvidence } from "./count-capture-lifecycle";
import { pageOneEvidence } from "../tests/count-capture-planner-fixture";
import { captureCountsFixture } from "../tests/count-capture-counts-fixture";
import { captureSession } from "../tests/count-capture-session-fixture";
import {
  CountCaptureStopped,
  countCaptureTransport,
} from "../../source-observations/api/providers/count-capture-transport";
import { validateCountLifecycleReceipt } from "../domain/count-lifecycle-receipt";
import { captureNow } from "../tests/count-capture-planner-fixture";
import { captureActor, captureAuthority, captureScope } from "../tests/count-capture-session-fixture";
import {
  captureStoreMutant,
  captureLifecycleMutant,
  captureEffectsMutant,
} from "../tests/count-capture-counts-mutants";

type Fixture = ReturnType<typeof captureCountsFixture>;
const sealInput = { dispatchId: "synthetic-dispatch", runnerRunId: "300", runnerRunAttempt: 1 } as const;
const boundCollection = (collectedAt: string) => ({
  ...captureAuthority().collection,
  outcome: "bound" as const,
  collectedAt,
});
// The causal close: seal, then one completion of the acknowledged run.
async function close(f: Fixture, collection = boundCollection(f.clock.now)) {
  const sealed = await f.lifecycle.freeze(captureSession(), sealInput);
  return f.lifecycle.complete(captureSession(), { runId: sealed.runId, ...sealInput, collection });
}

describe("capture reads and freeze", () => {
  it.each(["overflow", "malformed-result", "uncommitted-result"] as const)(
    "local evidence %s is bounded unknown, not a truncated complete projection",
    async (mode) => {
      const f = captureCountsFixture();
      const row = {
        debit_id: "synthetic-cards-debit",
        count_kind: "cards",
        recorded_at: f.clock.now,
        result: { outcome: "complete", evidence: { ...pageOneEvidence("cards"), query: f.quote.targets[0]!.query } },
      };
      const query = vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            { payload: { remainingCredits: 30, totalCredits: 30, observedAt: f.clock.now, attemptState: "checked" } },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ debits: "0", reserved: "0" }] })
        .mockResolvedValueOnce({
          rows:
            mode === "overflow"
              ? [row, row, row]
              : [{ ...row, result: mode === "uncommitted-result" ? null : { ...row.result, unexpected: true } }],
        });
      const evidence = await readCountCaptureEvidence({ query } as PgQueryable, "synthetic-slot", f.quote);
      expect(evidence.complete).toBe(false);
      expect(evidence.acquisitions.length).toBeLessThanOrEqual(2);
      expect(query).toHaveBeenCalledTimes(3);
      expect(query.mock.calls[2]![0]).toContain("LIMIT 3");
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );

  it("retains exactly one request-bound preview and pre-confirm row", async () => {
    const f = captureCountsFixture();
    await f.acquire();
    f.clock.now = captureNow;
    const preview = await f.lifecycle.preview(captureSession(), { selection: f.selection, budget: f.budget });
    await f.lifecycle.preConfirm(captureSession(), {
      selection: f.selection,
      budget: f.budget,
      planFingerprint: preview.planFingerprint,
    });
    const reads = f.run().reads;
    expect(reads.map((read) => read.phase)).toEqual(["preview", "pre-confirm"]);
    expect(reads[1]!.comparedFingerprint).toBe(reads[0]!.planFingerprint);
    for (const read of reads) {
      expect(read.winners.map((winner) => winner.source?.sourceId)).toEqual([
        "synthetic-cards-debit",
        "synthetic-sealed-debit",
      ]);
      expect(f.run().sends.filter((send) => send.requestId === read.requestId)).toHaveLength(3);
    }
    expect(f.writer.preview).toHaveBeenCalledTimes(1);
    expect(f.writer.preConfirmPlannerRead).toHaveBeenCalledTimes(1);
    const calls = f.fetch.mock.calls.length;
    f.clock.now = "2026-10-13T08:04:11.000Z";
    const { receipt } = await close(f);
    expect(validateCountLifecycleReceipt(receipt).valid).toBe(true);
    expect(receipt.classification).toMatchObject({ verdict: "CONFORMING" });
    expect(f.fetch).toHaveBeenCalledTimes(calls);
  });
  it("retains the same request's preview and requires its fingerprint before pre-confirm", async () => {
    const f = captureCountsFixture();
    await f.ready();
    const quote = await f.lifecycle.quote(captureSession(), { selection: f.selection, budget: f.budget });
    await f.lifecycle.quoteReadback(captureSession());
    await f.lifecycle.finalNotice(captureSession());
    await f.lifecycle.acquire(captureSession(), { quoteId: quote.quoteId, fingerprint: quote.fingerprint });
    await expect(
      f.lifecycle.preConfirm(captureSession(), {
        selection: f.selection,
        budget: f.budget,
        planFingerprint: "f".repeat(64),
      }),
    ).rejects.toThrow(CountCaptureStopped);
    expect(f.writer.preConfirmPlannerRead).not.toHaveBeenCalled();
    expect(f.run().reads).toEqual([]);
  });

  it("freezes a closed receipt without provider I/O and refuses every later action", async () => {
    const f = captureCountsFixture();
    await f.ready();
    const before = f.fetch.mock.calls.length;
    const { receipt } = await close(f);
    expect(validateCountLifecycleReceipt(receipt).valid).toBe(true);
    expect(receipt.classification.verdict).toBe("INCOMPLETE");
    expect(f.run().status).toBe("frozen");
    const runId = f.run().runId;
    const actions = [
      () => f.lifecycle.baseline(captureSession(), { scopeRecordId: captureScope, authority: captureAuthority() }),
      () => f.lifecycle.initialNotice(captureSession()),
      () => f.lifecycle.usage(captureSession()),
      () => f.lifecycle.quote(captureSession(), { selection: f.selection, budget: f.budget }),
      () => f.lifecycle.quoteReadback(captureSession()),
      () => f.lifecycle.finalNotice(captureSession()),
      () => f.lifecycle.acquire(captureSession(), { quoteId: f.quote.quoteId, fingerprint: f.quote.fingerprint }),
      () => f.lifecycle.preview(captureSession(), { selection: f.selection, budget: f.budget }),
      () =>
        f.lifecycle.preConfirm(captureSession(), {
          selection: f.selection,
          budget: f.budget,
          planFingerprint: "a".repeat(64),
        }),
      () => f.lifecycle.freeze(captureSession(), sealInput),
      () => f.lifecycle.complete(captureSession(), { runId, ...sealInput, collection: boundCollection(f.clock.now) }),
    ];
    for (const action of actions) await expect(action()).rejects.toThrow(CountCaptureStopped);
    expect(f.fetch).toHaveBeenCalledTimes(before);
  });

  it("stale-preview guard-disabled mutant retains the prohibited pre-confirm row", async () => {
    const attempt = async (f: ReturnType<typeof captureCountsFixture>) => {
      await f.acquire();
      f.clock.now = captureNow;
      await f.lifecycle.preview(captureSession(), { selection: f.selection, budget: f.budget });
      return f.lifecycle.preConfirm(captureSession(), {
        selection: f.selection,
        budget: f.budget,
        planFingerprint: "f".repeat(64),
      });
    };
    const real = captureCountsFixture();
    await expect(attempt(real)).rejects.toThrow(CountCaptureStopped);
    expect(real.writer.preConfirmPlannerRead).not.toHaveBeenCalled();
    expect(real.run().reads).toHaveLength(1);
    const mutant = captureCountsFixture({
      lifecycle: captureLifecycleMutant([["input.planFingerprint !== run.reads[0]?.planFingerprint", "false"]]),
      store: captureStoreMutant([
        ['(binding.phase === "pre-confirm" && parsed.comparedFingerprint !== run.reads[0]?.planFingerprint)', "false"],
      ]),
    });
    await expect(attempt(mutant)).resolves.toMatchObject({ eligible: false });
    expect(mutant.run().reads).toHaveLength(2);
  });

  it("request-binding disabled mutant retains a foreign request's row", async () => {
    const source = captureCountsFixture();
    await source.acquire();
    source.clock.now = captureNow;
    await source.lifecycle.preview(captureSession(), { selection: source.selection, budget: source.budget });
    const row = source.run().reads[0]!;
    const attempt = async (f: ReturnType<typeof captureCountsFixture>) => {
      await f.acquire();
      f.clock.now = captureNow;
      const binding = await f.store.begin(f.run().runId, "preview");
      return f.store.retainPlannerRead(binding, row);
    };
    await expect(attempt(captureCountsFixture())).rejects.toThrow(CountCaptureStopped);
    const mutant = captureCountsFixture({
      store: captureStoreMutant([["parsed.requestId !== binding.requestId", "false"]]),
    });
    await expect(attempt(mutant)).resolves.toBeUndefined();
    expect(mutant.run().reads[0]?.requestId).toBe(row.requestId);
  });

  it("freeze no-I/O guard-disabled mutant allows an unbudgeted usage refresh", async () => {
    const attempt = async (f: ReturnType<typeof captureCountsFixture>) => {
      await f.acquire();
      f.clock.now = captureNow;
      const preview = await f.lifecycle.preview(captureSession(), { selection: f.selection, budget: f.budget });
      await f.lifecycle.preConfirm(captureSession(), {
        selection: f.selection,
        budget: f.budget,
        planFingerprint: preview.planFingerprint,
      });
      const read = f.readCountEvidence.getMockImplementation()!;
      f.readCountEvidence.mockImplementation(async () => {
        await (countCaptureTransport("scrydex", "usage", f.fetch) ?? f.fetch)(
          "https://api.scrydex.com/account/v1/usage",
        );
        return read();
      });
      return close(f);
    };
    const real = captureCountsFixture();
    await expect(attempt(real)).rejects.toThrow(CountCaptureStopped);
    expect(real.fetch).toHaveBeenCalledTimes(8);
    const mutant = captureCountsFixture({
      lifecycle: captureLifecycleMutant([
        [
          'return runCountCaptureRequest(\n      { binding: { runId: run.runId, requestId: randomUUID(), phase: "quote" }, ledger: deps.store.ledger },\n      work,\n    );',
          "return work();",
        ],
      ]),
    });
    await expect(attempt(mutant)).resolves.toBeDefined();
    expect(mutant.fetch).toHaveBeenCalledTimes(9);
  });

  it.each(["effects", "evidence"] as const)(
    "unknown %s stays INCOMPLETE, never a zero-effect claim",
    async (missing) => {
      const f = captureCountsFixture();
      await f.acquire();
      f.clock.now = captureNow;
      const preview = await f.lifecycle.preview(captureSession(), { selection: f.selection, budget: f.budget });
      await f.lifecycle.preConfirm(captureSession(), {
        selection: f.selection,
        budget: f.budget,
        planFingerprint: preview.planFingerprint,
      });
      if (missing === "effects") f.readEffects.mockRejectedValueOnce(new Error("Unknown local effects."));
      else f.readCountEvidence.mockResolvedValueOnce({ ...(await f.readCountEvidence()), complete: false });
      const { receipt } = await close(f);
      expect(validateCountLifecycleReceipt(receipt).valid).toBe(true);
      expect(receipt.classification.verdict).toBe("INCOMPLETE");
      if (missing === "effects" && "evidence" in receipt) expect(receipt.evidence.effects).toBeUndefined();
    },
  );

  it.each(["batches", "reservations", "jobs", "enqueues", "imports"] as const)(
    "retains actual %s drift as FAILED under the unchanged #9583 classifier",
    async (effect) => {
      const f = captureCountsFixture();
      await f.ready();
      const baseline = await f.readEffects(f.clock.now);
      f.readEffects.mockResolvedValueOnce({ ...baseline, [effect]: baseline[effect] + 1 });
      const { receipt } = await close(f);
      expect(validateCountLifecycleReceipt(receipt).valid).toBe(true);
      expect(receipt.classification).toMatchObject({
        verdict: "FAILED",
        reasons: expect.arrayContaining(["unexpected-effects"]),
      });
    },
  );

  it("does not turn a stopped run into a conforming freeze", async () => {
    const f = captureCountsFixture();
    await f.acquire();
    await expect(
      f.lifecycle.preConfirm(captureSession(), {
        selection: f.selection,
        budget: f.budget,
        planFingerprint: "f".repeat(64),
      }),
    ).rejects.toThrow(CountCaptureStopped);
    const { receipt } = await close(f);
    expect(validateCountLifecycleReceipt(receipt).valid).toBe(true);
    expect(receipt).toMatchObject({ reason: "capture-stopped", phase: "freeze" });
    expect(receipt.classification.verdict).toBe("FAILED");
    expect(f.run().seal).toEqual({ from: "stopped", runnerRunId: "300", runnerRunAttempt: 1 });
  });

  it("post-freeze guard-disabled mutant reopens the sealed run", async () => {
    const attempt = async (f: ReturnType<typeof captureCountsFixture>) => {
      await f.ready();
      await f.lifecycle.freeze(captureSession(), sealInput);
      return f.lifecycle.quote(captureSession(), { selection: f.selection, budget: f.budget });
    };
    await expect(attempt(captureCountsFixture())).rejects.toThrow(CountCaptureStopped);
    const mutant = captureCountsFixture({
      store: captureStoreMutant([
        ['run.status === "open" && Date.parse(run.expiresAt)', 'run.status !== "stopped" && Date.parse(run.expiresAt)'],
        [
          'if (run.status !== "open") return { accepted: false as const };',
          'if (run.status === "stopped") return { accepted: false as const };',
        ],
      ]),
    });
    await expect(attempt(mutant)).resolves.toBeDefined();
    expect(mutant.run().status).toBe("frozen");
  });

  it.each(["unknown", "drift"] as const)("freeze collection %s remains INCOMPLETE", async (condition) => {
    const f = captureCountsFixture();
    await f.acquire();
    f.clock.now = captureNow;
    const preview = await f.lifecycle.preview(captureSession(), { selection: f.selection, budget: f.budget });
    await f.lifecycle.preConfirm(captureSession(), {
      selection: f.selection,
      budget: f.budget,
      planFingerprint: preview.planFingerprint,
    });
    const collection = { ...captureAuthority().collection, outcome: "bound" as const, collectedAt: f.clock.now };
    const freezeCollection =
      condition === "unknown"
        ? { ...collection, outcome: "unknown" as const, reason: "inventory-truncated" as const, binding: null }
        : { ...collection, binding: { ...collection.binding, jobId: "201" } };
    const { receipt } = await close(f, freezeCollection);
    expect(validateCountLifecycleReceipt(receipt).valid).toBe(true);
    expect(receipt.classification).toMatchObject({
      verdict: "INCOMPLETE",
      reasons: expect.arrayContaining(["freeze-unknown-or-drift"]),
    });
    expect(f.fetch).toHaveBeenCalledTimes(8);
  });

  it("freeze-no-effect comparison disabled mutant falsely classifies a new batch as CONFORMING", async () => {
    const attempt = async (f: ReturnType<typeof captureCountsFixture>) => {
      await f.acquire();
      f.clock.now = captureNow;
      const preview = await f.lifecycle.preview(captureSession(), { selection: f.selection, budget: f.budget });
      await f.lifecycle.preConfirm(captureSession(), {
        selection: f.selection,
        budget: f.budget,
        planFingerprint: preview.planFingerprint,
      });
      f.readEffects.mockResolvedValueOnce({ ...(await f.readEffects(f.clock.now)), batches: 3 });
      return close(f);
    };
    const real = await attempt(captureCountsFixture());
    expect(real.receipt.classification.verdict).toBe("FAILED");
    const mutant = await attempt(
      captureCountsFixture({ lifecycle: captureLifecycleMutant([], captureEffectsMutant()) }),
    );
    expect(mutant.receipt.classification.verdict).toBe("CONFORMING");
    // The shipped validator rejects the mutant's false classification.
    expect(validateCountLifecycleReceipt(mutant.receipt).valid).toBe(false);
  });
});

describe("seal and exact-run completion", () => {
  async function previewed(f: Fixture) {
    await f.acquire();
    f.clock.now = captureNow;
    const preview = await f.lifecycle.preview(captureSession(), { selection: f.selection, budget: f.budget });
    await f.lifecycle.preConfirm(captureSession(), {
      selection: f.selection,
      budget: f.budget,
      planFingerprint: preview.planFingerprint,
    });
  }

  it("seals without collecting or assembling and acknowledges the server boundary", async () => {
    const f = captureCountsFixture();
    await previewed(f);
    const calls = f.fetch.mock.calls.length;
    const appended = f.memory.history.length;
    // The superseded seal-and-assemble request is refused before anything is sealed.
    await expect(
      f.lifecycle.freeze(captureSession(), {
        ...sealInput,
        collection: boundCollection(f.clock.now),
      } as typeof sealInput),
    ).rejects.toThrow();
    expect(f.memory.history).toHaveLength(appended);
    expect(f.run().status).toBe("open");
    f.clock.now = "2026-10-13T08:05:40.000Z";
    expect(await f.lifecycle.freeze(captureSession(), sealInput)).toEqual({
      runId: f.run().runId,
      frozenAt: "2026-10-13T08:05:40.000Z",
    });
    expect(f.run()).toMatchObject({
      status: "frozen",
      frozenAt: "2026-10-13T08:05:40.000Z",
      seal: { from: "open", runnerRunId: "300", runnerRunAttempt: 1 },
      receipt: null,
    });
    expect(f.memory.history).toHaveLength(appended + 1);
    expect(f.readEffects).toHaveBeenCalledTimes(1);
    expect(f.readCountEvidence).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledTimes(calls);
  });

  it("seals only for the run's own dispatch", async () => {
    const f = captureCountsFixture();
    await previewed(f);
    const appended = f.memory.history.length;
    await expect(
      f.lifecycle.freeze(captureSession(), { ...sealInput, dispatchId: "synthetic-other-dispatch" }),
    ).rejects.toThrow(CountCaptureStopped);
    expect(f.memory.history).toHaveLength(appended);
    expect(f.run().status).toBe("open");
  });

  it("qualifies the post-seal collection and retains the one receipt with the seal's boundary", async () => {
    const f = captureCountsFixture();
    await previewed(f);
    f.clock.now = "2026-10-13T08:05:40.000Z";
    const sealed = await f.lifecycle.freeze(captureSession(), sealInput);
    f.clock.now = "2026-10-13T08:05:41.250Z";
    const { receipt } = await f.lifecycle.complete(captureSession(), {
      runId: sealed.runId,
      ...sealInput,
      collection: boundCollection(f.clock.now),
    });
    expect(validateCountLifecycleReceipt(receipt)).toMatchObject({
      valid: true,
      classification: { verdict: "CONFORMING" },
    });
    expect(receipt).toMatchObject({
      frozenAt: sealed.frozenAt,
      freezeCollection: { collectedAt: "2026-10-13T08:05:41.250Z" },
    });
    expect(f.run()).toMatchObject({ status: "frozen", frozenAt: sealed.frozenAt, receipt });
  });

  it("retains a genuinely pre-boundary collection as INCOMPLETE, never CONFORMING", async () => {
    const f = captureCountsFixture();
    await previewed(f);
    f.clock.now = "2026-10-13T08:05:40.000Z";
    const sealed = await f.lifecycle.freeze(captureSession(), sealInput);
    const { receipt } = await f.lifecycle.complete(captureSession(), {
      runId: sealed.runId,
      ...sealInput,
      collection: boundCollection("2026-10-13T08:05:39.999Z"),
    });
    expect(validateCountLifecycleReceipt(receipt)).toMatchObject({
      valid: true,
      classification: { verdict: "INCOMPLETE", reasons: ["freeze-unknown-or-drift"] },
    });
  });

  it("refuses every foreign, malformed or repeated completion without touching the sealed history", async () => {
    const f = captureCountsFixture();
    await previewed(f);
    const sealed = await f.lifecycle.freeze(captureSession(), sealInput);
    const genuine = { runId: sealed.runId, ...sealInput, collection: boundCollection(f.clock.now) };
    const calls = f.fetch.mock.calls.length;
    const appended = f.memory.history.length;
    const sealedRun = f.run();
    const refused = [
      () =>
        f.lifecycle.complete(
          captureSession({ actor: captureActor({ sessionId: "synthetic-other-session" }) }),
          genuine,
        ),
      () => f.lifecycle.complete(captureSession(), { ...genuine, runId: "00000000-0000-4000-8000-0000000000ff" }),
      () => f.lifecycle.complete(captureSession(), { ...genuine, dispatchId: "synthetic-other-dispatch" }),
      () => f.lifecycle.complete(captureSession(), { ...genuine, runnerRunId: "301" }),
      () => f.lifecycle.complete(captureSession(), { ...genuine, runnerRunAttempt: 2 }),
      () => f.lifecycle.complete(captureSession(), { ...genuine, collection: undefined } as never),
      () =>
        f.lifecycle.complete(captureSession(), {
          ...genuine,
          collection: { ...genuine.collection, collectedAt: "2026-10-13" },
        }),
      () => f.lifecycle.complete(captureSession(), { ...genuine, frozenAt: f.clock.now } as never),
    ];
    for (const attempt of refused) await expect(attempt()).rejects.toThrow();
    expect(f.memory.history).toHaveLength(appended);
    expect(f.run()).toEqual(sealedRun);
    const { receipt } = await f.lifecycle.complete(captureSession(), genuine);
    expect(f.memory.history).toHaveLength(appended + 1);
    const completed = f.run();
    // A duplicate cannot replace the receipt, move the boundary, reopen or send.
    await expect(f.lifecycle.complete(captureSession(), genuine)).rejects.toThrow(CountCaptureStopped);
    await expect(
      f.lifecycle.complete(captureSession(), { ...genuine, collection: boundCollection("2026-10-13T08:09:00.000Z") }),
    ).rejects.toThrow(CountCaptureStopped);
    await expect(f.lifecycle.freeze(captureSession(), sealInput)).rejects.toThrow(CountCaptureStopped);
    expect(f.memory.history).toHaveLength(appended + 1);
    expect(f.run()).toEqual(completed);
    expect(f.run()).toMatchObject({ status: "frozen", frozenAt: sealed.frozenAt, receipt });
    expect(f.fetch).toHaveBeenCalledTimes(calls);
  });

  it("leaves an interrupted collection sealed, receipt-free and refusing every day-after action", async () => {
    const f = captureCountsFixture();
    await previewed(f);
    const sealed = await f.lifecycle.freeze(captureSession(), sealInput);
    const calls = f.fetch.mock.calls.length;
    const appended = f.memory.history.length;
    const interrupted = f.run();
    expect(interrupted).toMatchObject({ status: "frozen", receipt: null });
    f.clock.now = "2026-10-14T08:05:00.000Z";
    const actions = [
      () => f.lifecycle.baseline(captureSession(), { scopeRecordId: captureScope, authority: captureAuthority() }),
      () => f.lifecycle.initialNotice(captureSession()),
      () => f.lifecycle.usage(captureSession()),
      () => f.lifecycle.quote(captureSession(), { selection: f.selection, budget: f.budget }),
      () => f.lifecycle.quoteReadback(captureSession()),
      () => f.lifecycle.finalNotice(captureSession()),
      () => f.lifecycle.acquire(captureSession(), { quoteId: f.quote.quoteId, fingerprint: f.quote.fingerprint }),
      () => f.lifecycle.preview(captureSession(), { selection: f.selection, budget: f.budget }),
      () =>
        f.lifecycle.preConfirm(captureSession(), {
          selection: f.selection,
          budget: f.budget,
          planFingerprint: "a".repeat(64),
        }),
      () => f.lifecycle.freeze(captureSession(), sealInput),
      // Past the run's lifetime even the exact-run completion refuses: the sealed run
      // can never later become CONFORMING.
      () =>
        f.lifecycle.complete(captureSession(), {
          runId: sealed.runId,
          ...sealInput,
          collection: boundCollection(f.clock.now),
        }),
    ];
    for (const action of actions) await expect(action()).rejects.toThrow();
    expect(f.memory.history).toHaveLength(appended);
    expect(f.run()).toEqual(interrupted);
    expect(f.fetch).toHaveBeenCalledTimes(calls);
  });
});
