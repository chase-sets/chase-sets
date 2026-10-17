import { describe, expect, it, vi } from "vitest";
import { captureCountsFixture } from "../tests/count-capture-counts-fixture";
import { captureSession, captureRoster } from "../tests/count-capture-session-fixture";
import { CountCaptureStopped } from "../../source-observations/api/providers/count-capture-transport";
import { captureStoreMutant, captureLifecycleMutant } from "../tests/count-capture-counts-mutants";
import { pageOneEvidence } from "../tests/count-capture-planner-fixture";
import { countFingerprint } from "../domain/count-acquisition";

describe("capture-bound counts", () => {
  it("binds the final quote", async () => {
    const f = captureCountsFixture();
    await f.ready();
    const quote = await f.lifecycle.quote(captureSession(), { selection: f.selection, budget: f.budget });
    const readback = await f.lifecycle.quoteReadback(captureSession());
    expect(readback.quote).toEqual(quote);
    const { notice } = await f.lifecycle.finalNotice(captureSession());
    expect(notice.body).toMatchObject({
      quoteId: quote.quoteId,
      fingerprint: quote.fingerprint,
      plannedCount: 2,
      serverCap: 2,
      remainingTotal: 10,
    });
    expect(f.run().finalNotice).toEqual(notice);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.writer.quoteCounts).toHaveBeenCalledTimes(1);
  });
  it("acquires once through the writer after the read-back final notice", async () => {
    const f = captureCountsFixture();
    await f.ready();
    const quote = await f.lifecycle.quote(captureSession(), { selection: f.selection, budget: f.budget });
    await f.lifecycle.quoteReadback(captureSession());
    await f.lifecycle.finalNotice(captureSession());
    await expect(
      f.lifecycle.acquire(captureSession(), { quoteId: quote.quoteId, fingerprint: quote.fingerprint }),
    ).resolves.toMatchObject({ retained: true });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.run().sends.map((send) => [send.phase, send.category])).toEqual([
      ["acquisition", "cards"],
      ["acquisition", "sealed"],
    ]);
    await expect(
      f.lifecycle.acquire(captureSession(), { quoteId: quote.quoteId, fingerprint: quote.fingerprint }),
    ).rejects.toThrow(CountCaptureStopped);
    expect(f.writer.acquireCounts).toHaveBeenCalledTimes(1);
  });

  it.each([{ kinds: [] }, { kinds: ["cards"] }, { kinds: ["cards", "sealed"] }] as const)(
    "lowers cap to P for reuse $kinds without re-quoting",
    async ({ kinds }) => {
      const f = captureCountsFixture({ reused: kinds });
      await f.acquire();
      expect(f.run().quote?.cap).toBe(2 - kinds.length);
      expect(f.run().finalNotice?.body.remainingTotal).toBe(10 - kinds.length);
      expect(f.fetch).toHaveBeenCalledTimes(2 - kinds.length);
      expect(f.writer.quoteCounts).toHaveBeenCalledTimes(1);
    },
  );

  const quoteGuards = [
    [
      "cap",
      "quote.cap !== missing",
      (f: ReturnType<typeof captureCountsFixture>) => {
        f.quote.cap = 1;
      },
    ],
    [
      "membership",
      "target.scopeRecordId !== run.scopeRecordId",
      (f: ReturnType<typeof captureCountsFixture>) => {
        f.quote.targets[0]!.scopeRecordId = "foreign-scope";
      },
    ],
    [
      "account revision",
      "target.query.accountRevision !== baseline.selection.accountRevision",
      (f: ReturnType<typeof captureCountsFixture>) => {
        f.quote.targets[0]!.query.accountRevision = "foreign-revision";
      },
    ],
    [
      "profile",
      "target.query.profileVersion !== unit.profileVersion",
      (f: ReturnType<typeof captureCountsFixture>) => {
        f.quote.targets[0]!.query.profileVersion = "foreign-version";
      },
    ],
    [
      "expiry",
      "Date.parse(quote.expiresAt) < Date.parse(at)",
      (f: ReturnType<typeof captureCountsFixture>) => {
        f.quote.expiresAt = "2026-10-13T08:01:59.000Z";
      },
    ],
    [
      "headroom",
      "quote.authority.headroom < remainingCountCaptureCap(missing)",
      (f: ReturnType<typeof captureCountsFixture>) => {
        f.quote.authority.headroom = 9;
      },
    ],
  ] as const;
  it.each(quoteGuards)("rejects a hostile %s quote; disabling that guard admits it", async (_name, needle, corrupt) => {
    const attempt = async (f: ReturnType<typeof captureCountsFixture>) => {
      await f.ready();
      corrupt(f);
      return f.lifecycle.quote(captureSession(), { selection: f.selection, budget: f.budget });
    };
    const real = captureCountsFixture();
    await expect(attempt(real)).rejects.toThrow(CountCaptureStopped);
    expect(real.fetch).not.toHaveBeenCalled();
    expect(real.writer.quoteCounts).toHaveBeenCalledTimes(1);
    const mutant = captureCountsFixture({ store: captureStoreMutant([[needle, "false"]]) });
    await expect(attempt(mutant)).resolves.toBeDefined();
  });

  it.each(["quote", "authority", "membership", "expiry"] as const)(
    "stops changed %s after quote without silent re-quote",
    async (changed) => {
      const f = captureCountsFixture();
      await f.ready();
      await f.lifecycle.quote(captureSession(), { selection: f.selection, budget: f.budget });
      if (changed === "quote")
        f.writer.getCountQuote.mockResolvedValueOnce({ ...f.quote, membershipFingerprint: "b".repeat(64) });
      if (changed === "authority")
        f.deps.countAuthority = vi.fn(async () => ({ ...f.quote.authority, fingerprint: "b".repeat(64) }));
      if (changed === "membership")
        f.readRoster.mockImplementation(async () => {
          const roster = captureRoster();
          return {
            ...roster,
            records: roster.records.map((record) => ({ ...record, updated_at: "2026-10-13T08:01:00.000Z" })),
          };
        });
      if (changed === "expiry") {
        f.quote.expiresAt = "2026-10-13T08:01:59.000Z";
      }
      await expect(f.lifecycle.quoteReadback(captureSession())).rejects.toThrow(CountCaptureStopped);
      expect(f.run().status).toBe("stopped");
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.writer.quoteCounts).toHaveBeenCalledTimes(1);
    },
  );

  it("requires final-notice read-back before the first send; guard-disabled bypass sends", async () => {
    const attempt = async (f: ReturnType<typeof captureCountsFixture>) => {
      await f.ready();
      await f.lifecycle.quote(captureSession(), { selection: f.selection, budget: f.budget });
      await f.lifecycle.quoteReadback(captureSession());
      return f.lifecycle.acquire(captureSession(), { quoteId: f.quote.quoteId, fingerprint: f.quote.fingerprint });
    };
    const real = captureCountsFixture();
    await expect(attempt(real)).rejects.toThrow(CountCaptureStopped);
    expect(real.fetch).not.toHaveBeenCalled();
    const mutant = captureCountsFixture({
      store: captureStoreMutant([
        [
          "run.quote.fingerprint !== fingerprint ||\n          run.approvalAt ||\n          !run.finalNotice?.readBackAt",
          "run.quote.fingerprint !== fingerprint || run.approvalAt",
        ],
        [
          "!run.approvalAt ||\n              !run.finalNotice?.readBackAt ||\n              inPhase.length",
          "!run.approvalAt || inPhase.length",
        ],
      ]),
    });
    await expect(attempt(mutant)).resolves.toBeDefined();
    expect(mutant.fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects an acquisition that bypasses the ledger; guard-disabled bypass falsely retains it", async () => {
    const attempt = async (f: ReturnType<typeof captureCountsFixture>) => {
      await f.ready();
      await f.lifecycle.quote(captureSession(), { selection: f.selection, budget: f.budget });
      await f.lifecycle.quoteReadback(captureSession());
      await f.lifecycle.finalNotice(captureSession());
      f.writer.acquireCounts.mockImplementation(async () => ({
        ...f.quote,
        state: "complete",
        targets: f.quote.targets.map((target) => ({
          ...target,
          source: { ...pageOneEvidence(target.query.kind), query: target.query, observedAt: f.clock.now },
        })),
      }));
      return f.lifecycle.acquire(captureSession(), { quoteId: f.quote.quoteId, fingerprint: f.quote.fingerprint });
    };
    await expect(attempt(captureCountsFixture())).rejects.toThrow(CountCaptureStopped);
    const mutant = captureCountsFixture({
      store: captureStoreMutant([
        ["sends.length !== run.quote?.plannedCredits || sends.some((send) => send.status === null)", "false"],
      ]),
    });
    await expect(attempt(mutant)).resolves.toEqual({ retained: true });
    expect(mutant.fetch).not.toHaveBeenCalled();
  });

  it("detects changed authority at read-back; the disabled binding accepts it", async () => {
    const attempt = async (f: ReturnType<typeof captureCountsFixture>) => {
      await f.ready();
      await f.lifecycle.quote(captureSession(), { selection: f.selection, budget: f.budget });
      f.deps.countAuthority = vi.fn(async () => ({
        ...f.quote.authority,
        fingerprint: countFingerprint("foreign-authority"),
      }));
      return f.lifecycle.quoteReadback(captureSession());
    };
    await expect(attempt(captureCountsFixture())).rejects.toThrow(CountCaptureStopped);
    await expect(
      attempt(
        captureCountsFixture({
          lifecycle: captureLifecycleMutant([["authority.fingerprint !== run.quote.authority.fingerprint", "false"]]),
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("single-acquisition guard-disabled mutant admits the prohibited second writer call", async () => {
    const attempt = async (f: ReturnType<typeof captureCountsFixture>) => {
      await f.acquire();
      return f.lifecycle.acquire(captureSession(), { quoteId: f.quote.quoteId, fingerprint: f.quote.fingerprint });
    };
    await expect(attempt(captureCountsFixture())).rejects.toThrow(CountCaptureStopped);
    const mutant = captureCountsFixture({
      store: captureStoreMutant([
        ["(last !== undefined && phaseOrder(phase) <= phaseOrder(last))", "false"],
        ["index === 0 || phaseOrder(run.phases[index - 1]!) < phaseOrder(phase)", "true"],
        [
          "run.quote.fingerprint !== fingerprint ||\n          run.approvalAt ||\n          !run.finalNotice?.readBackAt",
          "run.quote.fingerprint !== fingerprint || !run.finalNotice?.readBackAt",
        ],
        [
          "inPhase.length >= countCapturePhaseCaps[phase]",
          "(phase !== 'acquisition' && inPhase.length >= countCapturePhaseCaps[phase])",
        ],
        ["inPhase.length >= run.quote.cap", "false"],
        ["inPhase.some((entry) => entry.category === send.category)", "false"],
      ]),
    });
    await expect(attempt(mutant)).resolves.toEqual({ retained: true });
    expect(mutant.writer.acquireCounts).toHaveBeenCalledTimes(2);
    expect(mutant.fetch).toHaveBeenCalledTimes(4);
  });

  it("quote-binding disabled mutant accepts a changed retained quote", async () => {
    const attempt = async (f: ReturnType<typeof captureCountsFixture>) => {
      await f.ready();
      await f.lifecycle.quote(captureSession(), { selection: f.selection, budget: f.budget });
      f.writer.getCountQuote.mockResolvedValueOnce({ ...f.quote, membershipFingerprint: "b".repeat(64) });
      return f.lifecycle.quoteReadback(captureSession());
    };
    await expect(attempt(captureCountsFixture())).rejects.toThrow(CountCaptureStopped);
    const mutant = captureCountsFixture({
      lifecycle: captureLifecycleMutant([["countFingerprint(normalized) !== countFingerprint(run.quote)", "false"]]),
      store: captureStoreMutant([["countFingerprint(run.quote) !== countFingerprint(quote)", "false"]]),
    });
    await expect(attempt(mutant)).resolves.toBeDefined();
    expect(mutant.writer.quoteCounts).toHaveBeenCalledTimes(1);
  });

  it("baseline-membership disabled mutant accepts roster drift", async () => {
    const attempt = async (f: ReturnType<typeof captureCountsFixture>) => {
      await f.ready();
      await f.lifecycle.quote(captureSession(), { selection: f.selection, budget: f.budget });
      const roster = captureRoster();
      f.readRoster.mockResolvedValue({
        ...roster,
        records: roster.records.map((row) => ({ ...row, updated_at: "2026-10-13T08:01:00.000Z" })),
      });
      return f.lifecycle.quoteReadback(captureSession());
    };
    await expect(attempt(captureCountsFixture())).rejects.toThrow(CountCaptureStopped);
    const mutant = captureCountsFixture({
      lifecycle: captureLifecycleMutant([
        [
          "countFingerprint(roster) !== countFingerprint({ selection: run.baseline.selection, units: run.baseline.units })",
          "false",
        ],
      ]),
    });
    await expect(attempt(mutant)).resolves.toBeDefined();
  });

  it("refuses a cap raised after final notice without another quote or send", async () => {
    const f = captureCountsFixture();
    await f.ready();
    await f.lifecycle.quote(captureSession(), { selection: f.selection, budget: f.budget });
    await f.lifecycle.quoteReadback(captureSession());
    await f.lifecycle.finalNotice(captureSession());
    f.writer.getCountQuote.mockResolvedValueOnce({ ...f.quote, cap: 3 });
    await expect(
      f.lifecycle.acquire(captureSession(), { quoteId: f.quote.quoteId, fingerprint: f.quote.fingerprint }),
    ).rejects.toThrow(CountCaptureStopped);
    expect(f.writer.acquireCounts).not.toHaveBeenCalled();
    expect(f.writer.quoteCounts).toHaveBeenCalledTimes(1);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("per-kind cap disabled mutant debits the same kind twice", async () => {
    const attempt = async (f: ReturnType<typeof captureCountsFixture>) => {
      await f.ready();
      await f.lifecycle.quote(captureSession(), { selection: f.selection, budget: f.budget });
      await f.lifecycle.quoteReadback(captureSession());
      await f.lifecycle.finalNotice(captureSession());
      const binding = await f.store.begin(f.run().runId, "acquisition");
      await f.store.approveAcquisition(binding, f.quote.quoteId, f.quote.fingerprint);
      const send = { category: "cards" as const, requestFingerprint: f.quote.targets[0]!.query.requestFingerprint };
      await f.store.ledger.result(binding, await f.store.ledger.debit(binding, send), 200);
      return f.store.ledger.debit(binding, send);
    };
    await expect(attempt(captureCountsFixture())).rejects.toThrow(CountCaptureStopped);
    const mutant = captureCountsFixture({
      store: captureStoreMutant([["inPhase.some((entry) => entry.category === send.category)", "false"]]),
    });
    await expect(attempt(mutant)).resolves.toBe(2);
    expect(mutant.run().sends.map((send) => send.category)).toEqual(["cards", "cards"]);
  });
});
