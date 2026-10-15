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
import { captureAuthority, captureScope } from "../tests/count-capture-session-fixture";
import {
  captureStoreMutant,
  captureLifecycleMutant,
  captureEffectsMutant,
} from "../tests/count-capture-counts-mutants";

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
    const { receipt } = await f.lifecycle.freeze(captureSession(), {
      runnerRunId: "300",
      runnerRunAttempt: 1,
      collection: { ...captureAuthority().collection, outcome: "bound", collectedAt: f.clock.now },
    });
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
    const { receipt } = await f.lifecycle.freeze(captureSession(), { runnerRunId: "300", runnerRunAttempt: 1 });
    expect(validateCountLifecycleReceipt(receipt).valid).toBe(true);
    expect(receipt.classification.verdict).toBe("INCOMPLETE");
    expect(f.run().status).toBe("frozen");
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
      () => f.lifecycle.freeze(captureSession(), { runnerRunId: "300", runnerRunAttempt: 1 }),
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
      return f.lifecycle.freeze(captureSession(), {
        runnerRunId: "300",
        runnerRunAttempt: 1,
        collection: { ...captureAuthority().collection, outcome: "bound", collectedAt: f.clock.now },
      });
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
      const { receipt } = await f.lifecycle.freeze(captureSession(), {
        runnerRunId: "300",
        runnerRunAttempt: 1,
        collection: { ...captureAuthority().collection, outcome: "bound", collectedAt: f.clock.now },
      });
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
      const { receipt } = await f.lifecycle.freeze(captureSession(), { runnerRunId: "300", runnerRunAttempt: 1 });
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
    const { receipt } = await f.lifecycle.freeze(captureSession(), { runnerRunId: "300", runnerRunAttempt: 1 });
    expect(validateCountLifecycleReceipt(receipt).valid).toBe(true);
    expect(receipt.classification.verdict).toBe("FAILED");
  });

  it("post-freeze guard-disabled mutant reopens the sealed run", async () => {
    const attempt = async (f: ReturnType<typeof captureCountsFixture>) => {
      await f.ready();
      await f.lifecycle.freeze(captureSession(), { runnerRunId: "300", runnerRunAttempt: 1 });
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
    const { receipt } = await f.lifecycle.freeze(captureSession(), {
      runnerRunId: "300",
      runnerRunAttempt: 1,
      collection: freezeCollection,
    });
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
      return f.lifecycle.freeze(captureSession(), {
        runnerRunId: "300",
        runnerRunAttempt: 1,
        collection: { ...captureAuthority().collection, outcome: "bound", collectedAt: f.clock.now },
      });
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
