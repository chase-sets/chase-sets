import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  addUtcMonths,
  evaluateSellerComplianceCohort as evaluateDomain,
  type CohortEvaluationInput,
} from "./cohort-window";
import {
  SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE,
  decodeSellerComplianceCohortPolicyValue,
  type SellerComplianceCohortPolicyValue,
} from "./seller-compliance-cohort-policy";

const identity = {
  policyKey: "platform-operations.seller-compliance-cohort",
  documentId: "policy-test",
  eventId: "policy-test-revision",
  streamVersion: 1,
};
function evaluateSellerComplianceCohort(
  input: Omit<CohortEvaluationInput, "observedAt" | "policyIdentity"> &
    Partial<Pick<CohortEvaluationInput, "observedAt" | "policyIdentity">>,
) {
  return evaluateDomain({ observedAt: input.evaluationAt, policyIdentity: identity, ...input });
}

const policy: SellerComplianceCohortPolicyValue = {
  ...SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE,
  activated: true,
  currencyCode: "USD",
  qualifyingTransactionCount: 2,
  qualifyingGrossCents: "500000",
  disclosureGrossCents: "2000000",
  windowMonths: 1,
  lookbackMonths: 2,
  comparisonIsInclusive: true,
  saleUnit: "captured-order",
  qualifyingGrossBasis: "item-gross",
  refundTreatment: "exclude-refunded" as const,
  postCaptureCancellationTreatment: "exclude-cancelled" as const,
  mixedLineTreatment: "exclude-mixed" as const,
  unclassifiableTreatment: "exclude-unclassifiable" as const,
  classificationRules: [{ source: "productId", value: "card" }],
};

function sale(id: string, occurredAt: string, gross: string, overrides: Record<string, unknown> = {}) {
  return {
    paymentId: `pay-${id}`,
    orderId: `ord-${id}`,
    sellerAccountId: "seller",
    saleState: "captured" as const,
    occurredAt,
    currencyCode: "USD",
    itemGrossCents: gross,
    shippingChargeCents: "0",
    salesTaxCents: "0",
    authenticityFeeCents: "0",
    protectionCents: "0",
    orderTotalCents: gross,
    marketplaceSalesFeeCents: "0",
    sellerItemNetCents: gross,
    sellerPayoutCents: gross,
    refundedOrderTotalCents: null,
    orderRefundCapCents: null,
    cancelledAt: null,
    captureAnomalies: [],
    refundAnomalies: [],
    reconciliationMismatches: [],
    classificationInputs: [{ productId: "card" }],
    classificationInputsVersion: 1,
    changeSequence: "1",
    revision: "1",
    ...overrides,
  };
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

type ScanSale = Readonly<{ sale: ReturnType<typeof sale>; at: number; qualifying: boolean; gross: bigint }>;

/**
 * 200 seeded sales over the 24 months of 2024-2025 with uneven monthly volume, mixed gross and a share of
 * foreign-currency, unclassified and fully refunded sales, plus one burst.
 * All month-end days are eligible, including leap day and intraday milliseconds.
 */
function generateScanSales(): readonly ScanSale[] {
  const monthlyCounts = [12, 3, 9, 14, 2, 8, 11, 4, 13, 6, 1, 10, 9, 12, 2, 7, 15, 3, 8, 11, 5, 12, 9, 14];
  const random = mulberry32(7146);
  const amounts = ["50000", "80000", "120000", "200000"];
  const scan: ScanSale[] = [];
  monthlyCounts.forEach((count, month) => {
    for (let index = 0; index < count; index++) {
      const days = new Date(Date.UTC(2024, month + 1, 0)).getUTCDate();
      const at = Date.UTC(2024, month, 1 + Math.floor(random() * days)) + Math.floor(random() * 86_399_998);
      const amount = amounts[Math.floor(random() * amounts.length)]!;
      const roll = random();
      const kind = roll < 0.1 ? "foreign" : roll < 0.18 ? "unclassified" : roll < 0.25 ? "refunded" : "qualifying";
      const overrides =
        kind === "foreign"
          ? { currencyCode: "EUR" }
          : kind === "unclassified"
            ? { classificationInputs: [{ productId: "other" }] }
            : kind === "refunded"
              ? { refundedOrderTotalCents: amount, orderRefundCapCents: amount }
              : {};
      const id = `scan-${String(scan.length).padStart(3, "0")}`;
      scan.push({
        sale: sale(id, new Date(at).toISOString(), amount, overrides),
        at,
        qualifying: kind === "qualifying",
        gross: BigInt(amount),
      });
    }
  });
  // A burst inside the December 2024 gap re-enters the seller and raises the band within one observation.
  for (let index = 0; index < 7; index++) {
    const at = Date.UTC(2024, 11, 9, 10 + index);
    scan.push({
      sale: sale(`burst-${index}`, new Date(at).toISOString(), "200000"),
      at,
      qualifying: true,
      gross: 200000n,
    });
  }
  return scan;
}

/** Clamped calendar-month addition on epoch milliseconds, written independently of the evaluator. */
function addMonthsMs(at: number, months: number): number {
  const date = new Date(at);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(
    year,
    month,
    Math.min(date.getUTCDate(), lastDay),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  );
}

type LifecycleEntry = Readonly<{
  at: string;
  state: string;
  band: string;
  windowStart: string | null;
  windowEnd: string | null;
  qualifyingCount: number;
  qualifyingGrossCents: string;
  transitions: readonly (readonly [string, string | null])[];
}>;

/**
 * Independent continuous oracle: enumerate every UTC day, intersect the
 * half-open containing intervals of all sales, and tally each constant set
 * directly. No production helper or production candidate generator is used.
 */
function oracleLifecycle(
  scan: readonly ScanSale[],
  rule: Readonly<{ count: number; gross: bigint; disclosure: bigint; windowMonths: number; lookbackMonths: number }>,
  ticks: readonly number[],
  mutant?: "sale-only" | "entries-only" | "inverse" | "closed-end",
): LifecycleEntry[] {
  const ordered = [...scan].sort(
    (a, b) =>
      a.at - b.at || a.sale.paymentId.localeCompare(b.sale.paymentId) || a.sale.orderId.localeCompare(b.sale.orderId),
  );
  const windows: {
    start: number;
    last: number;
    offset: number;
    admissibleThrough: number;
    members: readonly ScanSale[];
  }[] = [];
  const dayMs = 86_400_000;
  const lower = Math.floor((ordered[0]!.at - (rule.windowMonths * 32 + 3) * dayMs) / dayMs) * dayMs;
  for (let day = lower; day <= ordered.at(-1)!.at; day += dayMs) {
    const offset = addMonthsMs(day, rule.windowMonths) - day;
    const lOffset = addMonthsMs(day, rule.lookbackMonths) - day;
    const cuts = [day, day + dayMs];
    for (const entry of ordered) {
      for (const cut of [entry.at + 1, entry.at - offset + (mutant === "closed-end" ? 0 : 1)])
        if (cut > day && cut < day + dayMs) cuts.push(cut);
    }
    const points = [...new Set(cuts)].sort((a, b) => a - b);
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i]!;
      const last = points[i + 1]! - 1;
      const members = ordered.filter(
        (entry) =>
          entry.qualifying &&
          entry.at >= start &&
          (mutant === "closed-end" ? entry.at <= start + offset : entry.at < start + offset),
      );
      if (members.length >= rule.count)
        windows.push({ start, last, offset: lOffset, admissibleThrough: last + lOffset, members });
    }
  }
  if (mutant === "sale-only") {
    windows.splice(
      0,
      windows.length,
      ...ordered.map((entry) => ({
        start: entry.at,
        last: entry.at,
        offset: addMonthsMs(entry.at, rule.lookbackMonths) - entry.at,
        admissibleThrough: addMonthsMs(entry.at, rule.lookbackMonths),
        members: ordered.filter(
          (sale) => sale.qualifying && sale.at >= entry.at && sale.at < addMonthsMs(entry.at, rule.windowMonths),
        ),
      })),
    );
  }
  if (mutant === "entries-only") for (const window of windows) window.last = window.start;
  const eligibleStart = (window: (typeof windows)[number], at: number) =>
    Math.max(window.start, mutant === "inverse" ? addMonthsMs(at, -rule.lookbackMonths) : at - window.offset);
  const visible = (entry: ScanSale, at: number, inclusive: boolean) => (inclusive ? entry.at <= at : entry.at < at);
  const tally = (members: readonly ScanSale[], at: number, inclusive: boolean) => {
    let count = 0;
    let gross = 0n;
    for (const entry of members) {
      if (!visible(entry, at, inclusive)) break;
      count += 1;
      gross += entry.gross;
    }
    return { count, gross };
  };
  const meets = (value: { count: number; gross: bigint }, gross: bigint) =>
    value.count >= rule.count && value.gross >= gross;
  const verdict = (at: number, inclusive: boolean) => {
    const sliding = windows.find(
      (window) =>
        eligibleStart(window, at) <= window.last &&
        eligibleStart(window, at) < at &&
        meets(tally(window.members, at, inclusive), rule.gross),
    );
    if (!sliding) return { member: false, band: "none", window: null };
    const totals = tally(sliding.members, at, inclusive);
    return {
      member: true,
      band: totals.gross >= rule.disclosure ? "disclosure" : "none",
      window: {
        start: eligibleStart(sliding, at),
        end: addMonthsMs(eligibleStart(sliding, at), rule.windowMonths),
        ...totals,
        members: sliding.members,
      },
    };
  };
  const crossing = (members: readonly ScanSale[], at: number, gross: bigint) => {
    let count = 0;
    let total = 0n;
    for (const entry of members) {
      if (entry.at >= at) break;
      count += 1;
      total += entry.gross;
      if (count >= rule.count && total >= gross) return entry.at;
    }
    throw new Error("The winning window never crosses its threshold.");
  };
  const grid = [
    ...new Set([
      ...ordered.flatMap((entry) => {
        const end = addMonthsMs(entry.at, rule.windowMonths);
        const expiry = addMonthsMs(entry.at, rule.lookbackMonths);
        return [entry.at - 1, entry.at, entry.at + 1, end - 1, end, end + 1, expiry, expiry + 1, expiry + 2];
      }),
      ...windows.flatMap((window) => [
        window.start - 1,
        window.start,
        addMonthsMs(window.start, rule.windowMonths),
        window.admissibleThrough,
        window.admissibleThrough + 1,
      ]),
    ]),
  ].sort((a, b) => a - b);
  const firstInstant = (lower: number, upper: number, holds: (value: ReturnType<typeof verdict>) => boolean) => {
    const instants = [...new Set([lower + 1, ...grid.filter((at) => at > lower && at < upper), upper])].sort(
      (a, b) => a - b,
    );
    const found = instants.find((at) => holds(verdict(at, false)));
    if (found === undefined) throw new Error("The oracle found no transition instant.");
    return ordered.some((entry) => entry.at + 1 === found) && found - 1 > lower ? found - 1 : found;
  };
  const iso = (at: number) => new Date(at).toISOString();
  let previous: { member: boolean; band: string; since: number } | null = null;
  return ticks.map((tick) => {
    const now = verdict(tick, false);
    const transitions: [string, number][] = [];
    if (previous === null) {
      if (now.window) {
        transitions.push(["entered", crossing(now.window.members, tick, rule.gross)]);
        if (now.band === "disclosure")
          transitions.push(["band:disclosure", crossing(now.window.members, tick, rule.disclosure)]);
      }
    } else if (previous.member && !now.member) {
      transitions.push(["exited", firstInstant(previous.since, tick, (value) => !value.member)]);
    } else if (!previous.member && now.member) {
      const entry = firstInstant(previous.since, tick, (value) => value.member);
      transitions.push(["entered", entry]);
      if (now.band === "disclosure")
        transitions.push(["band:disclosure", firstInstant(entry - 1, tick, (value) => value.band === "disclosure")]);
    } else if (previous.member && now.member && previous.band !== now.band) {
      transitions.push([`band:${now.band}`, firstInstant(previous.since, tick, (value) => value.band === now.band)]);
    }
    if (transitions.length > 0) previous = { member: now.member, band: now.band, since: transitions.at(-1)![1] };
    return {
      at: iso(tick),
      state: now.member ? "member" : "outside",
      band: now.band,
      windowStart: now.window ? iso(now.window.start) : null,
      windowEnd: now.window ? iso(now.window.end) : null,
      qualifyingCount: now.window?.count ?? 0,
      qualifyingGrossCents: (now.window?.gross ?? 0n).toString(),
      transitions: transitions.map(([kind, at]) => [kind, iso(at)] as const),
    };
  });
}

/** Drives the evaluator tick by tick, feeding each verdict back as the previous state, as the runtime does. */
function evaluatorLifecycle(
  sales: readonly ReturnType<typeof sale>[],
  scanPolicy: SellerComplianceCohortPolicyValue,
  ticks: readonly number[],
): LifecycleEntry[] {
  let previous:
    | {
        state: "outside" | "member";
        band: "none" | "disclosure";
        entryEffectiveAt: string | null;
        exitEffectiveAt: string | null;
        transitionEffectiveAt: string | null;
      }
    | undefined;
  return ticks.map((tick) => {
    const at = new Date(tick).toISOString();
    const result = evaluateSellerComplianceCohort({ sales, policy: scanPolicy, evaluationAt: at, previous });
    const transitions: [string, string | null][] = [];
    const priorState = previous?.state ?? "outside";
    if (priorState !== result.state) {
      if (result.state === "member") {
        transitions.push(["entered", result.entryEffectiveAt]);
        if (result.band === "disclosure") transitions.push(["band:disclosure", result.bandEffectiveAt]);
      } else transitions.push(["exited", result.exitEffectiveAt]);
    } else if (result.state === "member" && result.band !== previous?.band) {
      transitions.push([`band:${result.band}`, result.bandEffectiveAt]);
    }
    if (transitions.length > 0)
      previous = {
        state: result.state,
        band: result.band,
        entryEffectiveAt: result.entryEffectiveAt,
        exitEffectiveAt: result.exitEffectiveAt,
        transitionEffectiveAt: transitions.at(-1)![1],
      };
    return {
      at,
      state: result.state,
      band: result.band,
      windowStart: result.windowStart,
      windowEnd: result.windowEnd,
      qualifyingCount: result.qualifyingCount,
      qualifyingGrossCents: result.qualifyingGrossCents,
      transitions,
    };
  });
}

type ReviewRow = readonly [
  window: number,
  lookback: number,
  count: number,
  anchor: number,
  gross: string,
  disclosure: string,
  sales: readonly (readonly [number, string])[],
  ticks: readonly number[],
];

/** Synthetic, source-free reproduction of the review's floating-point LCG and draw order. */
function generateReviewBaselineRows(): ReviewRow[] {
  let state = 1090;
  const draw = (n: number) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return Math.floor((state / 2147483647) * n);
  };
  const anchors = ["2023-12-20", "2024-01-20", "2025-01-20", "2025-07-20", "2024-10-25"].map(Date.parse);
  return Array.from({ length: 700 }, () => {
    const w = 1 + draw(3);
    const l = w + draw(3);
    const c = 1 + draw(3);
    const anchor = anchors[draw(5)]!;
    const n = 1 + draw(6);
    const sales = Array.from(
      { length: n },
      () => [anchor + draw(480) * 21600000, String(100 * (1 + draw(4)))] as const,
    );
    const g = 100 * (c + draw(3));
    const d = g + 100 * draw(4);
    const latest = Math.max(...sales.map(([at]) => at));
    const ticks = Array.from({ length: 6 }, () => latest + 21600000 * draw(124 * (l + 1)) + [-1, 0, 1, 2][draw(4)]!);
    return [w, l, c, anchor, String(g), String(d), sales, ticks] as const;
  });
}

/** Direct grid census, independent calendar arithmetic and sums; no evaluator helpers. */
function bruteReviewVerdict(
  sales: readonly (readonly [number, string])[],
  p: SellerComplianceCohortPolicyValue,
  tau: number,
) {
  const visible = sales.filter(([at]) => at < tau);
  const h = 21600000;
  const w = p.windowMonths!;
  const l = p.lookbackMonths!;
  let winner: { start: number; count: number; gross: bigint } | null = null;
  let lastExpiry = -Infinity;
  const meets = (count: number, gross: bigint, threshold: string) =>
    p.comparisonIsInclusive
      ? count >= p.qualifyingTransactionCount! && gross >= BigInt(threshold)
      : count > p.qualifyingTransactionCount! && gross > BigInt(threshold);
  for (let grid = Math.floor((tau - (31 * l + 4) * 86400000) / h) * h; grid <= tau + h; grid += h) {
    for (const delta of [-1, 0, 1, 2]) {
      const start = grid + delta;
      if (start >= tau) continue;
      const end = addMonthsMs(start, w);
      let count = 0;
      let gross = 0n;
      for (const [at, amount] of visible) {
        if (at >= start && at < end) {
          count++;
          gross += BigInt(amount);
        }
      }
      if (!meets(count, gross, p.qualifyingGrossCents!)) continue;
      const expiry = addMonthsMs(start, l);
      if (expiry < tau) continue;
      lastExpiry = Math.max(lastExpiry, expiry);
      winner ??= { start, count, gross };
    }
  }
  return {
    state: winner === null ? "outside" : "member",
    band: winner !== null && meets(winner.count, winner.gross, p.disclosureGrossCents!) ? "disclosure" : "none",
    windowStart: winner === null ? null : new Date(winner.start).toISOString(),
    qualifyingCount: winner?.count ?? 0,
    qualifyingGrossCents: String(winner?.gross ?? 0n),
    exit: lastExpiry + 1,
  };
}

describe("seller compliance cohort window", () => {
  it("brute-force equivalence reproduces the review baseline", () => {
    const rows = generateReviewBaselineRows();
    expect(createHash("sha256").update(JSON.stringify(rows), "utf8").digest("hex")).toBe(
      "6514991a0edbb05226fb5b25c3a3761711a94d8fb2c63dc51215258f1b092889",
    );
    let verdicts = 0;
    let members = 0;
    let exits = 0;
    let dues = 0;
    let mismatches = 0;
    for (const [w, l, c, , g, d, pairs, ticks] of rows) {
      const p = {
        ...policy,
        windowMonths: w,
        lookbackMonths: l,
        qualifyingTransactionCount: c,
        qualifyingGrossCents: g,
        disclosureGrossCents: d,
      };
      const sales = pairs.map(([at, gross], j) =>
        sale(String(j), new Date(at).toISOString(), gross, {
          paymentId: `p-${j}`,
          orderId: `o-${j}`,
          sellerAccountId: "s",
        }),
      );
      for (const tau of ticks) {
        const expected = bruteReviewVerdict(pairs, p, tau);
        const at = new Date(tau).toISOString();
        const actual = evaluateSellerComplianceCohort({ sales, policy: p, evaluationAt: at });
        const { exit, ...verdict } = expected;
        for (const key of ["state", "band", "windowStart", "qualifyingCount", "qualifyingGrossCents"] as const)
          if (actual[key] !== verdict[key]) mismatches++;
        expect(actual).toMatchObject(verdict);
        verdicts++;
        if (expected.state !== "member") continue;
        members++;
        // Only dating/due census requires all sales visible. Verdicts above never do.
        if (Math.max(...pairs.map(([time]) => time)) >= tau) continue;
        const dated = evaluateSellerComplianceCohort({
          sales,
          policy: p,
          evaluationAt: new Date(exit + 40 * 86400000).toISOString(),
          previous: {
            state: "member",
            band: expected.band as "none" | "disclosure",
            entryEffectiveAt: at,
            transitionEffectiveAt: at,
          },
        });
        expect(dated.state).toBe("outside");
        expect(dated.exitEffectiveAt).toBe(new Date(exit).toISOString());
        exits++;
        const due = Date.parse(actual.nextReevaluationAt!);
        expect(due).toBeGreaterThan(tau);
        expect(due).toBeLessThanOrEqual(exit);
        for (const tick of [due - 1, Math.floor((tau + due) / 2)]) {
          expect(bruteReviewVerdict(pairs, p, tick)).toMatchObject({ state: expected.state, band: expected.band });
          dues++;
        }
      }
    }
    expect({ verdicts, members, exits, dues, mismatches }).toEqual({
      verdicts: 4200,
      members: 1625,
      exits: 1619,
      dues: 3238,
      mismatches: 0,
    });
    console.info("synthetic review baseline census", { verdicts, members, exits, dues, mismatches });
  });

  it("brute-force dating across sale and policy boundaries", () => {
    const random = mulberry32(11022);
    const totals = { exit: 0, reentry: 0, band: 0, policyBoundary: 0 };
    let mismatches = 0;
    for (let i = 0; i < 320; i++) {
      const month = Math.floor(random() * 24);
      const base = Date.UTC(2024, month, 1);
      const at = (day: number) => new Date(base + (day - 1) * 86400000).toISOString();
      const strict = i % 2 === 0;
      const needed = strict ? 2 : 1;
      const keepRefund = i % 4 === 0;
      const keepCancellation = i % 5 === 0;
      const p: SellerComplianceCohortPolicyValue = {
        ...policy,
        windowMonths: 1,
        lookbackMonths: 1,
        qualifyingTransactionCount: 1,
        qualifyingGrossCents: "100",
        disclosureGrossCents: "500",
        comparisonIsInclusive: !strict,
        refundTreatment: keepRefund ? "count-refunded" : policy.refundTreatment,
        postCaptureCancellationTreatment: keepCancellation
          ? "count-cancelled"
          : policy.postCaptureCancellationTreatment,
      };
      for (const family of ["exit", "reentry", "band"] as const) {
        const scan: ScanSale[] = [];
        const append = (id: string, day: number, amount: string, qualifying = true, overrides = {}) => {
          const s = sale(id, at(day), amount, overrides);
          scan.push({ sale: s, at: Date.parse(s.occurredAt), gross: BigInt(amount), qualifying });
        };
        if (family !== "reentry") for (let n = 0; n < needed; n++) append(`initial-${n}`, 10, "200");
        append("refund", 12, "0", keepRefund, { refundedOrderTotalCents: "0", orderRefundCapCents: "0" });
        append("cancelled", 13, "0", keepCancellation, { cancelledAt: at(13) });
        for (let n = 0; n < needed; n++) append(`later-${n}`, 15, family === "exit" ? "0" : "400");
        const lower = Date.parse(at(11));
        const upperAt = family === "exit" ? addMonthsMs(base, 2) : Date.parse(at(20));
        const oracle = oracleLifecycle(
          scan,
          {
            count: needed,
            gross: strict ? 101n : 100n,
            disclosure: strict ? 501n : 500n,
            windowMonths: 1,
            lookbackMonths: 1,
          },
          [lower, upperAt],
        );
        const expected = oracle[1]!;
        const previous = {
          state: family === "reentry" ? ("outside" as const) : ("member" as const),
          band: "none" as const,
          entryEffectiveAt: family === "reentry" ? null : at(10),
          exitEffectiveAt: family === "reentry" ? at(11) : null,
          transitionEffectiveAt: at(11),
        };
        const actual = evaluateSellerComplianceCohort({
          sales: scan.map((row) => row.sale),
          policy: p,
          evaluationAt: new Date(upperAt).toISOString(),
          previous,
          revisionEffectiveAt: at(18),
          priorPolicies: [
            { effectiveFrom: at(1), policy: { ...p, qualifyingGrossCents: "99" } },
            { effectiveFrom: at(14), policy: p },
          ],
        });
        const expectedDate = expected.transitions.find(
          ([kind]) => kind === (family === "exit" ? "exited" : family === "reentry" ? "entered" : "band:disclosure"),
        )?.[1];
        expect(expectedDate).toBeTruthy();
        const actualDate =
          family === "exit"
            ? actual.exitEffectiveAt
            : family === "reentry"
              ? actual.entryEffectiveAt
              : actual.bandEffectiveAt;
        if (actualDate !== expectedDate) mismatches++;
        expect(actualDate).toBe(expectedDate);
        expect(actual).toMatchObject({ state: expected.state, band: expected.band });
        totals[family]++;

        // A changed PRIOR segment, not the evaluated revision, causes this transition.
        const before =
          family === "reentry"
            ? { ...p, qualifyingTransactionCount: 999 }
            : family === "band"
              ? { ...p, disclosureGrossCents: "2000000" }
              : p;
        const after = family === "exit" ? { ...p, qualifyingTransactionCount: 999 } : p;
        const qualifiedPairs = scan.filter((row) => row.qualifying).map((row) => [row.at, String(row.gross)] as const);
        const boundary = Date.parse(at(16));
        const beforeBoundary = bruteReviewVerdict(qualifiedPairs, before, boundary - 1);
        const afterBoundary = bruteReviewVerdict(qualifiedPairs, after, boundary);
        expect(beforeBoundary).toMatchObject({ state: previous.state, band: previous.band });
        expect(afterBoundary).toMatchObject({ state: expected.state, band: expected.band });
        const policyCaused = evaluateSellerComplianceCohort({
          sales: scan.map((row) => row.sale),
          policy: after,
          evaluationAt: at(20),
          previous,
          revisionEffectiveAt: at(18),
          priorPolicies: [
            { effectiveFrom: at(1), policy: before },
            { effectiveFrom: at(16), policy: after },
          ],
        });
        const policyDate =
          family === "exit"
            ? policyCaused.exitEffectiveAt
            : family === "reentry"
              ? policyCaused.entryEffectiveAt
              : policyCaused.bandEffectiveAt;
        if (policyDate !== at(16)) mismatches++;
        expect(policyDate).toBe(at(16));
        totals.policyBoundary++;
      }
    }
    expect(totals).toEqual({ exit: 320, reentry: 320, band: 320, policyBoundary: 960 });
    expect(mismatches).toBe(0);
    console.info("synthetic crossing census", { ...totals, mismatches });
  });
  it.each(["deactivation", "count", "disclosure", "re-entry"] as const)(
    "transition dating stays within twenty single evaluations at 2,000 sales: %s",
    (kind) => {
      // Synthetic cost controls, not production or provider evidence.
      const start = Date.UTC(2024, 0, 1);
      const span = Date.UTC(2025, 0, 1) - start;
      const sales = Array.from({ length: 2000 }, (_, i) =>
        sale(String(i), new Date(start + Math.floor((i * span) / 2000) + 3600000).toISOString(), "5000"),
      );
      const p = {
        ...policy,
        windowMonths: 12,
        lookbackMonths: 24,
        qualifyingTransactionCount: 200,
        disclosureGrossCents: "2000000000",
      };
      const t = "2025-01-02T00:00:00.000Z";
      const revisionEffectiveAt = "2025-01-02T01:00:00.000Z";
      const evaluationAt = "2025-01-03T00:00:00.000Z";
      const entry = evaluateSellerComplianceCohort({ sales, policy: p, evaluationAt: t }).entryEffectiveAt;
      const datedInput = {
        sales,
        evaluationAt,
        revisionEffectiveAt,
        policy:
          kind === "deactivation"
            ? { ...p, activated: false }
            : kind === "count"
              ? { ...p, qualifyingTransactionCount: 2001 }
              : kind === "disclosure"
                ? { ...p, disclosureGrossCents: "500000" }
                : p,
        previous:
          kind === "re-entry"
            ? {
                state: "outside" as const,
                band: "none" as const,
                entryEffectiveAt: null,
                exitEffectiveAt: "2024-01-01T00:00:00.000Z",
                transitionEffectiveAt: "2024-01-01T00:00:00.000Z",
              }
            : {
                state: "member" as const,
                band: "none" as const,
                entryEffectiveAt: entry,
                transitionEffectiveAt: entry,
              },
        priorPolicies: [
          {
            effectiveFrom: kind === "re-entry" ? "2023-01-01T00:00:00.000Z" : "2024-01-01T00:00:00.000Z",
            policy: kind === "re-entry" ? { ...p, qualifyingTransactionCount: 2001 } : p,
          },
        ],
      };
      const dated = () => {
        const result = evaluateSellerComplianceCohort(datedInput);
        const date =
          kind === "re-entry"
            ? result.entryEffectiveAt
            : kind === "disclosure"
              ? result.bandEffectiveAt
              : result.exitEffectiveAt;
        expect(date, kind).toBe(revisionEffectiveAt);
      };
      const undated = () => evaluateSellerComplianceCohort({ sales, policy: p, evaluationAt });
      dated();
      undated();
      const measure = (run: () => unknown) => {
        const before = performance.now();
        run();
        return performance.now() - before;
      };
      const datedTimes: number[] = [];
      const undatedTimes: number[] = [];
      for (let i = 0; i < 3; i++) {
        datedTimes.push(measure(dated));
        undatedTimes.push(measure(undated));
      }
      const median = (times: number[]) => [...times].sort((a, b) => a - b)[1]!;
      const ratio = median(datedTimes) / median(undatedTimes);
      console.info("transition dating synthetic timing", { kind, datedTimes, undatedTimes, ratio });
      expect(ratio).toBeLessThanOrEqual(20);
    },
  );

  it("negative qualifying amounts fall back to the boundary walk", () => {
    const result = evaluateSellerComplianceCohort({
      sales: [sale("a", "2025-01-10T00:00:00.000Z", "100"), sale("c", "2025-01-15T00:00:00.000Z", "-1")],
      policy: {
        ...policy,
        windowMonths: 1,
        lookbackMonths: 1,
        qualifyingTransactionCount: 1,
        qualifyingGrossCents: "100",
        disclosureGrossCents: "1000",
      },
      evaluationAt: "2025-03-01T00:00:00.000Z",
      previous: {
        state: "member",
        band: "none",
        entryEffectiveAt: "2025-01-10T00:00:00.000Z",
        transitionEffectiveAt: "2025-01-10T00:00:00.000Z",
      },
    });
    expect(result.exitEffectiveAt).toBe("2025-01-15T00:00:00.000Z");
  });

  it("fails closed when an inert or changed policy has no revision instant", () => {
    const sales = [sale("guard", "2025-01-10T00:00:00.000Z", "500000")];
    const active = { ...policy, qualifyingTransactionCount: 1 };
    const previous = { state: "member" as const, band: "none" as const, entryEffectiveAt: "2025-01-10T00:00:00.000Z" };
    const input = { sales, policy: active, previous, evaluationAt: "2025-01-20T00:00:00.000Z" };
    expect(() => evaluateSellerComplianceCohort({ ...input, policy: { ...active, activated: false } })).toThrow();
    expect(
      evaluateSellerComplianceCohort({
        ...input,
        policy: { ...active, activated: false },
        revisionEffectiveAt: "2025-01-15T00:00:00.000Z",
        priorPolicies: [{ effectiveFrom: "2025-01-01T00:00:00.000Z", policy: active }],
      }).exitEffectiveAt,
    ).toBe("2025-01-15T00:00:00.000Z");
    const unchanged = evaluateSellerComplianceCohort(input);
    expect(evaluateSellerComplianceCohort({ ...input, previous: { ...previous, policyIdentity: identity } })).toEqual(
      unchanged,
    );
    for (const differing of [
      null,
      { ...identity, policyKey: "another" },
      { ...identity, documentId: "another" },
      { ...identity, eventId: "another" },
      { ...identity, streamVersion: 2 },
    ]) {
      for (const state of ["member", "outside"] as const)
        expect(() =>
          evaluateSellerComplianceCohort({ ...input, previous: { ...previous, state, policyIdentity: differing } }),
        ).toThrow();
    }
    expect(
      evaluateSellerComplianceCohort({
        ...input,
        policyIdentity: null,
        previous: { ...previous, policyIdentity: null },
      }).state,
    ).toBe("member");
    expect(() =>
      evaluateSellerComplianceCohort({
        ...input,
        policyIdentity: null,
        previous: { ...previous, policyIdentity: identity },
      }),
    ).toThrow();
  });

  it("continuous oracle pins every clamp-piece row, exact exit and omission mutants", () => {
    const sales = [
      sale("jan", "2025-01-31T00:00:00.000Z", "250000"),
      sale("feb", "2025-02-28T12:00:00.000Z", "250000"),
    ];
    const scan = sales.map((sale) => ({ sale, at: Date.parse(sale.occurredAt), qualifying: true, gross: 250000n }));
    const rule = { count: 2, gross: 500000n, disclosure: 2000000n, windowMonths: 1, lookbackMonths: 2 };
    const rows = [
      ["2025-03-05T00:00:00.000Z", "2025-01-28T12:00:00.001Z"],
      ["2025-03-29T18:00:00.000Z", "2025-01-29T18:00:00.000Z"],
      ["2025-03-30T12:00:00.001Z", "2025-01-30T12:00:00.001Z"],
      ["2025-03-30T12:00:00.002Z", "2025-01-30T12:00:00.002Z"],
      ["2025-03-30T18:00:00.000Z", "2025-01-30T18:00:00.000Z"],
      ["2025-03-30T23:59:59.999Z", "2025-01-30T23:59:59.999Z"],
      ["2025-03-31T00:00:00.000Z", null],
    ] as const;
    const ticks = rows.map(([at]) => Date.parse(at));
    const oracle = oracleLifecycle(scan, rule, ticks);
    expect(oracle.map((value) => [value.at, value.windowStart])).toEqual(rows);
    expect(evaluatorLifecycle(sales, policy, ticks)).toEqual(oracle);
    expect(oracle.at(-1)!.transitions).toEqual([["exited", "2025-03-31T00:00:00.000Z"]]);
    for (const mutant of ["sale-only", "closed-end"] as const)
      expect(
        oracleLifecycle(scan, rule, [ticks[0]!], mutant).map((value) => value.windowStart),
        mutant,
      ).not.toEqual([rows[0][1]]);
    expect(oracleLifecycle(scan, rule, [ticks[4]!], "entries-only")[0]!.state).toBe("outside");
  });

  it("continuous oracle preserves Feb28 forward expiry and kills the inverse mutant", () => {
    const fact = sale("feb28", "2025-02-28T06:00:00.000Z", "500000");
    const scan = [{ sale: fact, at: Date.parse(fact.occurredAt), qualifying: true, gross: 500000n }];
    const rule = { count: 1, gross: 500000n, disclosure: 2000000n, windowMonths: 1, lookbackMonths: 1 };
    const ticks = [
      "2025-03-28T06:00:00.000Z",
      "2025-03-28T06:00:00.001Z",
      "2025-03-29T06:00:00.000Z",
      "2025-03-30T06:00:00.000Z",
      "2025-03-31T06:00:00.000Z",
    ].map(Date.parse);
    const oracle = oracleLifecycle(scan, rule, ticks);
    expect(oracle.map((entry) => entry.state)).toEqual(["member", "outside", "outside", "outside", "outside"]);
    expect(oracle[1]!.transitions).toEqual([["exited", "2025-03-28T06:00:00.001Z"]]);
    expect(evaluatorLifecycle([fact], { ...policy, qualifyingTransactionCount: 1, lookbackMonths: 1 }, ticks)).toEqual(
      oracle,
    );
    expect(oracleLifecycle(scan, rule, [ticks[2]!], "inverse")[0]!.state).toBe("member");
  });

  it("sale/read and causal-envelope: strict visibility, injected observation and policy identity", () => {
    const fact = sale("visible", "2025-01-01T12:00:00.000Z", "500000");
    const one = { ...policy, qualifyingTransactionCount: 1 };
    const exact = evaluateSellerComplianceCohort({ sales: [fact], policy: one, evaluationAt: fact.occurredAt });
    expect(exact.state).toBe("outside");
    const visible = evaluateSellerComplianceCohort({
      sales: [fact],
      policy: one,
      evaluationAt: "2025-01-01T12:00:00.001Z",
      observedAt: "2025-01-02T00:00:00.000Z",
    });
    expect(visible).toMatchObject({
      state: "member",
      effectiveAt: fact.occurredAt,
      observedAt: "2025-01-02T00:00:00.000Z",
      policyIdentity: identity,
    });
  });

  it("revision-time: deactivation exits at its causal revision, not the late observation", () => {
    const sales = [sale("one", "2025-01-01T00:00:00.000Z", "500000")];
    const active = { ...policy, qualifyingTransactionCount: 1 };
    const entry = evaluateSellerComplianceCohort({ sales, policy: active, evaluationAt: "2025-01-02T00:00:00.000Z" });
    const result = evaluateSellerComplianceCohort({
      sales,
      policy: { ...active, activated: false },
      evaluationAt: "2025-02-20T00:00:00.000Z",
      observedAt: "2025-02-21T00:00:00.000Z",
      previous: entry,
      revisionEffectiveAt: "2025-02-10T00:00:00.000Z",
      priorPolicies: [{ effectiveFrom: "2025-01-01T00:00:00.000Z", policy: active }],
    });
    expect(result).toMatchObject({
      state: "outside",
      band: "none",
      effectiveAt: "2025-02-10T00:00:00.000Z",
      exitEffectiveAt: "2025-02-10T00:00:00.000Z",
      observedAt: "2025-02-21T00:00:00.000Z",
      nextReevaluationAt: null,
    });
  });

  it("due lifecycle: every no-sale due advances through steady state to exact expiry", () => {
    const facts = [
      sale("jan", "2025-01-31T00:00:00.000Z", "250000"),
      sale("feb", "2025-02-28T12:00:00.000Z", "250000"),
    ];
    let result = evaluateSellerComplianceCohort({ sales: facts, policy, evaluationAt: "2025-03-05T00:00:00.000Z" });
    for (let step = 0; step < 20 && result.nextReevaluationAt !== null; step++) {
      const due = result.nextReevaluationAt;
      const next = evaluateSellerComplianceCohort({
        sales: facts,
        policy,
        evaluationAt: due,
        previous: { ...result, transitionEffectiveAt: result.entryEffectiveAt },
      });
      expect(next.nextReevaluationAt === null || next.nextReevaluationAt > due).toBe(true);
      result = next;
    }
    expect(result).toMatchObject({
      state: "outside",
      nextReevaluationAt: null,
      exitEffectiveAt: "2025-03-31T00:00:00.000Z",
    });
  });

  it("evaluates continuous starts for the AC3 intraday clamp example", () => {
    const result = evaluateSellerComplianceCohort({
      sales: [sale("jan", "2025-01-31T00:00:00.000Z", "250000"), sale("feb", "2025-02-28T12:00:00.000Z", "250000")],
      policy: { ...policy, qualifyingTransactionCount: 2, qualifyingGrossCents: "500000" },
      evaluationAt: "2025-03-05T00:00:00.000Z",
    });
    expect(result.state).toBe("member");
    expect(result.windowStart).toBe("2025-01-28T12:00:00.001Z");
    expect(result.windowEnd).toBe("2025-02-28T12:00:00.001Z");
  });

  it("clamps UTC month arithmetic", () => {
    expect(addUtcMonths("2025-01-31T00:00:00.000Z", 1)).toBe("2025-02-28T00:00:00.000Z");
    expect(addUtcMonths("2024-01-31T00:00:00.000Z", 1)).toBe("2024-02-29T00:00:00.000Z");
    expect(addUtcMonths("2024-02-29T00:00:00.000Z", -12)).toBe("2023-02-28T00:00:00.000Z");
  });

  it("enters only at the exact transaction and gross edges", () => {
    // One fixed policy for every pair; each pair differs only in the single value under test.
    const edgePolicy = {
      ...policy,
      qualifyingTransactionCount: 200,
      qualifyingGrossCents: "500000",
      disclosureGrossCents: "2000000",
    };
    const repeat = (count: number, amount: string) => Array.from({ length: count }, () => amount);
    const run = (amounts: readonly string[]) => {
      const sales = amounts.map((amount, index) =>
        sale(String(index), `2025-01-${String((index % 20) + 1).padStart(2, "0")}T00:00:00.000Z`, amount),
      );
      const total = amounts.reduce((sum, amount) => sum + BigInt(amount), 0n).toString();
      const result = evaluateSellerComplianceCohort({
        sales,
        policy: edgePolicy,
        evaluationAt: "2025-01-31T00:00:00.000Z",
      });
      return {
        count: amounts.length,
        total,
        state: result.state,
        band: result.band,
        gross: result.qualifyingGrossCents,
      };
    };
    // Transaction count: 199 versus 200 sales at the same 500000 cents.
    expect(run([...repeat(198, "2500"), "5000"])).toEqual({
      count: 199,
      total: "500000",
      state: "outside",
      band: "none",
      gross: "0",
    });
    const exact = { count: 200, total: "500000", state: "member", band: "none", gross: "500000" };
    expect(run(repeat(200, "2500"))).toEqual(exact);
    // Qualifying gross: 499999 versus 500000 cents across the same 200 sales.
    expect(run([...repeat(199, "2500"), "2499"])).toEqual({
      count: 200,
      total: "499999",
      state: "outside",
      band: "none",
      gross: "0",
    });
    // Disclosure gross: 1999999 versus 2000000 cents across the same 200 sales.
    expect(run([...repeat(199, "10000"), "9999"])).toEqual({
      count: 200,
      total: "1999999",
      state: "member",
      band: "none",
      gross: "1999999",
    });
    expect(run(repeat(200, "10000"))).toEqual({
      count: 200,
      total: "2000000",
      state: "member",
      band: "disclosure",
      gross: "2000000",
    });
  });

  it("rejects activated policy with unresolved interpretation", () => {
    expect(() => decodeSellerComplianceCohortPolicyValue({ ...policy, refundTreatment: null })).toThrow();
    expect(() => decodeSellerComplianceCohortPolicyValue({ ...policy, windowMonths: true })).toThrow();
    expect(() =>
      decodeSellerComplianceCohortPolicyValue({ ...policy, classificationRules: [{ source: "unknown", value: "x" }] }),
    ).toThrow();
    expect(() => decodeSellerComplianceCohortPolicyValue({ ...policy, lookbackMonths: 1, windowMonths: 2 })).toThrow();
    expect(() =>
      decodeSellerComplianceCohortPolicyValue({ ...policy, qualifyingGrossCents: "500", disclosureGrossCents: "499" }),
    ).toThrow();
    expect(() => decodeSellerComplianceCohortPolicyValue({ ...policy, refundTreatment: "count-cancelled" })).toThrow();
    expect(() =>
      decodeSellerComplianceCohortPolicyValue({ ...policy, mixedLineTreatment: "count-refunded" }),
    ).toThrow();
    expect(() =>
      decodeSellerComplianceCohortPolicyValue({ ...policy, unclassifiableTreatment: "count-mixed" }),
    ).toThrow();
  });

  it("pins every window and month-arithmetic edge in UTC", () => {
    expect(addUtcMonths("2025-03-31T00:00:00.000Z", -1)).toBe("2025-02-28T00:00:00.000Z");
    const edge = evaluateSellerComplianceCohort({
      sales: [sale("edge", "2025-01-20T00:00:00.000Z", "500000")],
      policy: { ...policy, lookbackMonths: 1 },
      evaluationAt: "2025-01-20T00:00:00.000Z",
    });
    const floor = evaluateSellerComplianceCohort({
      sales: [sale("floor", "2024-11-20T00:00:00.000Z", "500000")],
      policy: { ...policy, qualifyingTransactionCount: 1 },
      evaluationAt: "2025-01-20T00:00:00.000Z",
    });
    expect(edge.state).toBe("outside");
    expect(floor.state).toBe("member");
    const start = sale("start", "2025-01-01T00:00:00.000Z", "500000");
    const end = sale("end", "2025-02-01T00:00:00.000Z", "500000");
    expect(
      evaluateSellerComplianceCohort({
        sales: [start],
        policy: { ...policy, qualifyingTransactionCount: 1 },
        evaluationAt: "2025-02-01T00:00:00.000Z",
      }).state,
    ).toBe("member");
    expect(
      evaluateSellerComplianceCohort({
        sales: [end],
        policy: { ...policy, qualifyingTransactionCount: 1 },
        evaluationAt: "2025-02-01T00:00:00.000Z",
      }).state,
    ).toBe("outside");
    expect(
      evaluateSellerComplianceCohort({
        sales: [
          sale("window-start", "2025-01-01T00:00:00.000Z", "250000"),
          sale("window-end", "2025-02-01T00:00:00.000Z", "250000"),
        ],
        policy: { ...policy, qualifyingTransactionCount: 2 },
        evaluationAt: "2025-03-01T00:00:00.000Z",
      }).state,
    ).toBe("outside");
    expect(
      evaluateSellerComplianceCohort({
        sales: [sale("at", "2025-02-02T00:00:00.000Z", "500000")],
        policy: { ...policy, qualifyingTransactionCount: 1 },
        evaluationAt: "2025-02-02T00:00:00.000Z",
      }).state,
    ).toBe("outside");

    const previous = {
      state: "member" as const,
      band: "none" as const,
      entryEffectiveAt: "2025-01-15T00:00:00.000Z",
    };
    const sales = [
      sale("a", "2025-01-01T00:00:00.000Z", "250000"),
      sale("b", "2025-01-15T00:00:00.000Z", "250000"),
      sale("c", "2025-02-20T00:00:00.000Z", "1"),
    ];
    const onTime = evaluateSellerComplianceCohort({
      sales,
      policy,
      evaluationAt: "2025-03-05T00:00:00.000Z",
      previous,
    });
    const late = evaluateSellerComplianceCohort({ sales, policy, evaluationAt: "2025-03-10T00:00:00.000Z", previous });
    expect(onTime.exitEffectiveAt).toBe("2025-03-01T00:00:00.001Z");
    expect(late.exitEffectiveAt).toBe(onTime.exitEffectiveAt);

    const single = { ...policy, qualifyingTransactionCount: 1 };
    const rows = [
      {
        row: "next reevaluation is the first inadmissible instant, lookback instant + 1 ms",
        input: "sale 2025-01-01T00:00:00.000Z evaluated 2025-02-15T00:00:00.000Z",
        parameter: "lookbackMonths 2",
        actual: evaluateSellerComplianceCohort({
          sales: [sale("next", "2025-01-01T00:00:00.000Z", "500000")],
          policy: single,
          evaluationAt: "2025-02-15T00:00:00.000Z",
        }).nextReevaluationAt,
        expected: "2025-03-01T00:00:00.001Z",
      },
      {
        row: "an exited seller that still does not qualify keeps its recorded exit instant",
        input: "no qualifying sale, evaluated 2025-05-20T00:00:00.000Z",
        parameter: "previous exit 2025-03-01T00:00:00.001Z",
        actual: evaluateSellerComplianceCohort({
          sales: [sale("lone", "2025-05-01T00:00:00.000Z", "1")],
          policy,
          evaluationAt: "2025-05-20T00:00:00.000Z",
          previous: {
            state: "outside",
            band: "none",
            entryEffectiveAt: null,
            exitEffectiveAt: "2025-03-01T00:00:00.001Z",
          },
        }).exitEffectiveAt,
        expected: "2025-03-01T00:00:00.001Z",
      },
    ];
    for (const { row, input, parameter, actual, expected } of rows)
      expect({ row, input, parameter, actual }).toEqual({ row, input, parameter, actual: expected });
  });

  it("continuous candidate windows agree with an exhaustive sliding scan under shuffled input", () => {
    const scan = generateScanSales();
    expect(scan.length).toBeGreaterThanOrEqual(200);
    expect(new Set(scan.map((entry) => entry.sale.occurredAt.slice(0, 7))).size).toBe(24);
    const scanPolicy = {
      ...policy,
      qualifyingTransactionCount: 6,
      qualifyingGrossCents: "600000",
      disclosureGrossCents: "1200000",
      windowMonths: 1,
      lookbackMonths: 2,
    };
    const rule = { count: 6, gross: 600000n, disclosure: 1200000n, windowMonths: 1, lookbackMonths: 2 };
    const sales = scan.map((entry) => entry.sale);
    // Sweeps every 4 and every 12 days, from before the first sale until every window has rolled off: a later
    // observation cadence must reproduce the same effective instants for every transition it observes.
    const lifecycles = [4, 12].map((days) => {
      const ticks: number[] = [];
      for (let at = Date.UTC(2024, 0, 3); at <= Date.UTC(2026, 2, 3); at += days * 86_400_000) ticks.push(at);
      const oracle = oracleLifecycle(scan, rule, ticks);
      const actual = evaluatorLifecycle(sales, scanPolicy, ticks);
      // The oracle owns the continuous verdict, counts, gross and winning
      // window. Transition dating has its own causal-envelope fixtures below;
      // keeping those concerns separate prevents a shared boundary convention
      // from masking a verdict mismatch.
      expect(actual).toEqual(oracle);
      return { ticks, oracle, actual };
    });
    // The fixture exercises every lifecycle edge rather than a constant verdict.
    for (const { oracle } of lifecycles) {
      const kinds = oracle.flatMap((entry) => entry.transitions.map(([kind]) => kind));
      for (const kind of ["entered", "exited", "band:disclosure", "band:none"])
        expect(kinds.filter((value) => value === kind).length, kind).toBeGreaterThanOrEqual(3);
    }
    expect(lifecycles[0]!.oracle.some((entry) => entry.transitions.some(([kind]) => kind === "band:disclosure"))).toBe(
      true,
    );
    // Ten shuffles of the input rows reproduce the whole 12-day lifecycle, winning windows included.
    const { ticks, actual } = lifecycles[1]!;
    const random = mulberry32(10746);
    for (let shuffle = 0; shuffle < 10; shuffle++) {
      const shuffled = [...sales];
      for (let index = shuffled.length - 1; index > 0; index--) {
        const swap = Math.floor(random() * (index + 1));
        [shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
      }
      expect(evaluatorLifecycle(shuffled, scanPolicy, ticks)).toEqual(actual);
    }
  });

  it("counts only classified, reconciled, policy-currency sales", () => {
    const foreign = { ...sale("foreign", "2025-01-01T00:00:00.000Z", "500000"), currencyCode: "EUR" };
    const unreconciled = {
      ...sale("unreconciled", "2025-01-01T00:00:00.000Z", "500000"),
      reconciliationMismatches: [{ code: "x" }] as never,
    };
    const unclassified = {
      ...sale("unclassified", "2025-01-01T00:00:00.000Z", "500000"),
      classificationInputs: [{ productId: "other" }],
    };
    const moneyRejected = {
      ...sale("money-rejected", "2025-01-01T00:00:00.000Z", "500000"),
      captureAnomalies: ["canonical-money-invalid"] as never,
    };
    const result = evaluateSellerComplianceCohort({
      sales: [foreign, unreconciled, moneyRejected, unclassified, sale("good", "2025-01-02T00:00:00.000Z", "500000")],
      policy: { ...policy, qualifyingTransactionCount: 2 },
      evaluationAt: "2025-01-03T00:00:00.000Z",
    });
    expect(result.state).toBe("outside");
    expect(result.unclassifiableCount).toBe(1);
    expect(
      evaluateSellerComplianceCohort({
        sales: [unclassified],
        policy: { ...policy, qualifyingTransactionCount: 1, unclassifiableTreatment: "count-unclassifiable" },
        evaluationAt: "2025-01-03T00:00:00.000Z",
      }),
    ).toMatchObject({ state: "member", qualifyingCount: 1, unclassifiableCount: 1 });
    expect(
      evaluateSellerComplianceCohort({
        sales: [
          sale("selected-option", "2025-01-02T00:00:00.000Z", "500000", {
            classificationInputs: [{ selectedOptions: [{ optionId: "option-1" }] }],
          }),
        ],
        policy: {
          ...policy,
          qualifyingTransactionCount: 1,
          classificationRules: [{ source: "selectedOptionId", value: "option-1" }],
        },
        evaluationAt: "2025-01-03T00:00:00.000Z",
      }).state,
    ).toBe("member");
    expect(
      evaluateSellerComplianceCohort({
        sales: [
          sale("cross-field", "2025-01-02T00:00:00.000Z", "500000", {
            classificationInputs: [{ productId: "option-1" }],
          }),
        ],
        policy: {
          ...policy,
          qualifyingTransactionCount: 1,
          classificationRules: [{ source: "selectedOptionId", value: "option-1" }],
        },
        evaluationAt: "2025-01-03T00:00:00.000Z",
      }).state,
    ).toBe("outside");
  });

  it("applies every interpretive treatment branch distinctly", () => {
    const refunded = {
      ...sale("refund", "2025-01-01T00:00:00.000Z", "500000"),
      refundedOrderTotalCents: "500000",
      orderRefundCapCents: "500000",
    };
    const excluded = evaluateSellerComplianceCohort({
      sales: [refunded],
      policy: { ...policy, qualifyingTransactionCount: 1 },
      evaluationAt: "2025-01-02T00:00:00.000Z",
    });
    const counted = evaluateSellerComplianceCohort({
      sales: [refunded],
      policy: { ...policy, qualifyingTransactionCount: 1, refundTreatment: "count-refunded" },
      evaluationAt: "2025-01-02T00:00:00.000Z",
    });
    expect(excluded.state).toBe("outside");
    expect(counted.state).toBe("member");

    const cancelled = {
      ...sale("cancelled", "2025-01-01T00:00:00.000Z", "500000"),
      cancelledAt: "2025-01-01T01:00:00.000Z",
    };
    const cancelledAndRefunded = {
      ...cancelled,
      refundedOrderTotalCents: "500000",
      orderRefundCapCents: "500000",
    };
    expect(
      evaluateSellerComplianceCohort({
        sales: [cancelled],
        policy: { ...policy, qualifyingTransactionCount: 1, postCaptureCancellationTreatment: "exclude-cancelled" },
        evaluationAt: "2025-01-02T00:00:00.000Z",
      }).state,
    ).toBe("outside");
    expect(
      evaluateSellerComplianceCohort({
        sales: [cancelled],
        policy: {
          ...policy,
          qualifyingTransactionCount: 1,
          postCaptureCancellationTreatment: "exclude-if-fully-refunded",
        },
        evaluationAt: "2025-01-02T00:00:00.000Z",
      }).state,
    ).toBe("member");
    expect(
      evaluateSellerComplianceCohort({
        sales: [cancelledAndRefunded],
        policy: {
          ...policy,
          qualifyingTransactionCount: 1,
          refundTreatment: "count-refunded",
          postCaptureCancellationTreatment: "exclude-if-fully-refunded",
        },
        evaluationAt: "2025-01-02T00:00:00.000Z",
      }).state,
    ).toBe("outside");
    expect(
      evaluateSellerComplianceCohort({
        sales: [cancelledAndRefunded],
        policy: {
          ...policy,
          qualifyingTransactionCount: 1,
          refundTreatment: "count-refunded",
          postCaptureCancellationTreatment: "count-cancelled",
        },
        evaluationAt: "2025-01-02T00:00:00.000Z",
      }).state,
    ).toBe("member");
    expect(
      evaluateSellerComplianceCohort({
        sales: [cancelled],
        policy: { ...policy, qualifyingTransactionCount: 1, postCaptureCancellationTreatment: "count-cancelled" },
        evaluationAt: "2025-01-02T00:00:00.000Z",
      }).state,
    ).toBe("member");

    const mixed = {
      ...sale("mixed", "2025-01-01T00:00:00.000Z", "500000"),
      classificationInputs: [{ productId: "card" }, { productId: "other" }],
    };
    expect(
      evaluateSellerComplianceCohort({
        sales: [mixed],
        policy: { ...policy, qualifyingTransactionCount: 1, mixedLineTreatment: "exclude-mixed" },
        evaluationAt: "2025-01-02T00:00:00.000Z",
      }).state,
    ).toBe("outside");
    expect(
      evaluateSellerComplianceCohort({
        sales: [mixed],
        policy: { ...policy, qualifyingTransactionCount: 1, mixedLineTreatment: "count-mixed" },
        evaluationAt: "2025-01-02T00:00:00.000Z",
      }).state,
    ).toBe("member");
    const unknown = {
      ...sale("unknown", "2025-01-01T00:00:00.000Z", "500000"),
      classificationInputs: [{ productId: "other" }],
    };
    expect(
      evaluateSellerComplianceCohort({
        sales: [unknown],
        policy: { ...policy, qualifyingTransactionCount: 1, unclassifiableTreatment: "exclude-unclassifiable" },
        evaluationAt: "2025-01-02T00:00:00.000Z",
      }).state,
    ).toBe("outside");
    expect(
      evaluateSellerComplianceCohort({
        sales: [unknown],
        policy: { ...policy, qualifyingTransactionCount: 1, unclassifiableTreatment: "count-unclassifiable" },
        evaluationAt: "2025-01-02T00:00:00.000Z",
      }).state,
    ).toBe("member");

    const grossBasisSales = [
      sale("gross-a", "2025-01-02T00:00:00.000Z", "250000"),
      sale("gross-b", "2025-01-03T00:00:00.000Z", "249999", { shippingChargeCents: "1" }),
    ];
    expect(
      evaluateSellerComplianceCohort({
        sales: grossBasisSales,
        policy: { ...policy, qualifyingGrossBasis: "item-gross" },
        evaluationAt: "2025-01-04T00:00:00.000Z",
      }),
    ).toMatchObject({ state: "outside", qualifyingCount: 0, qualifyingGrossCents: "0" });
    expect(
      evaluateSellerComplianceCohort({
        sales: grossBasisSales,
        policy: { ...policy, qualifyingGrossBasis: "item-gross-plus-shipping" },
        evaluationAt: "2025-01-04T00:00:00.000Z",
      }),
    ).toMatchObject({ state: "member", qualifyingCount: 2, qualifyingGrossCents: "500000" });

    const exactComparisonSales = [
      sale("comparison-a", "2025-01-02T00:00:00.000Z", "250000"),
      sale("comparison-b", "2025-01-03T00:00:00.000Z", "250000"),
    ];
    expect(
      evaluateSellerComplianceCohort({
        sales: exactComparisonSales,
        policy: { ...policy, comparisonIsInclusive: true },
        evaluationAt: "2025-01-04T00:00:00.000Z",
      }).state,
    ).toBe("member");
    expect(
      evaluateSellerComplianceCohort({
        sales: exactComparisonSales,
        policy: { ...policy, comparisonIsInclusive: false },
        evaluationAt: "2025-01-04T00:00:00.000Z",
      }).state,
    ).toBe("outside");
    expect(
      evaluateSellerComplianceCohort({
        sales: [...exactComparisonSales, sale("comparison-c", "2025-01-03T01:00:00.000Z", "1")],
        policy: { ...policy, comparisonIsInclusive: false },
        evaluationAt: "2025-01-04T00:00:00.000Z",
      }),
    ).toMatchObject({
      state: "member",
      qualifyingCount: 3,
      qualifyingGrossCents: "500001",
      entryEffectiveAt: "2025-01-03T01:00:00.000Z",
      effectiveAt: "2025-01-03T01:00:00.000Z",
    });
  });

  it("expires on the first inadmissible instant after the due chain", () => {
    const previous = { state: "member" as const, band: "none" as const, entryEffectiveAt: "2025-01-15T00:00:00.000Z" };
    const result = evaluateSellerComplianceCohort({
      sales: [sale("a", "2025-01-01T00:00:00.000Z", "250000"), sale("b", "2025-01-15T00:00:00.000Z", "250000")],
      policy,
      evaluationAt: "2025-03-15T00:00:00.000Z",
      previous,
    });
    expect(result.exitEffectiveAt).toBe("2025-03-01T00:00:00.001Z");
    expect(result.nextReevaluationAt).toBeNull();
  });

  it("uses the clamped anchor expiry and the next reevaluation instant plus one millisecond", () => {
    const previous = {
      state: "member" as const,
      band: "none" as const,
      entryEffectiveAt: "2025-04-01T00:00:00.000Z",
    };
    const clamped = evaluateSellerComplianceCohort({
      sales: [
        sale("clamped-a", "2025-03-31T00:00:00.000Z", "250000"),
        sale("clamped-b", "2025-03-31T01:00:00.000Z", "250000"),
      ],
      policy: { ...policy, lookbackMonths: 1 },
      evaluationAt: "2025-05-01T00:00:00.000Z",
      previous,
    });
    // March 30's rightmost millisecond is a qualifying start for both sales;
    // its forward L expiry is later than the March 31 sale anchor's expiry.
    const clampFacts = [
      sale("clamped-a", "2025-03-31T00:00:00.000Z", "250000"),
      sale("clamped-b", "2025-03-31T01:00:00.000Z", "250000"),
    ];
    const clampOracle = oracleLifecycle(
      clampFacts.map((sale) => ({ sale, at: Date.parse(sale.occurredAt), gross: 250000n, qualifying: true })),
      { count: 2, gross: 500000n, disclosure: 2000000n, windowMonths: 1, lookbackMonths: 1 },
      [Date.parse("2025-04-01T00:00:00.000Z"), Date.parse("2025-05-01T00:00:00.000Z")],
    );
    expect(clampOracle[1]!.transitions).toEqual([["exited", "2025-05-01T00:00:00.000Z"]]);
    expect(clamped.exitEffectiveAt).toBe(clampOracle[1]!.transitions[0]![1]);

    const due = evaluateSellerComplianceCohort({
      sales: [sale("due", "2025-02-01T00:00:00.000Z", "500000")],
      policy: { ...policy, qualifyingTransactionCount: 1 },
      evaluationAt: "2025-02-15T00:00:00.000Z",
    });
    expect(due.nextReevaluationAt).toBe("2025-03-01T00:00:00.000Z");
    const corrected = evaluateSellerComplianceCohort({
      sales: [
        sale("corrected", "2025-01-01T00:00:00.000Z", "500000", {
          refundedOrderTotalCents: "500000",
          orderRefundCapCents: "500000",
        }),
      ],
      policy: { ...policy, qualifyingTransactionCount: 1 },
      evaluationAt: "2025-02-01T00:00:00.000Z",
      previous: {
        state: "member",
        band: "none",
        entryEffectiveAt: "2025-01-01T00:00:00.000Z",
      },
    });
    expect(corrected.exitEffectiveAt).toBe("2025-01-01T00:00:00.001Z");
  });

  it("stamps a revision-only exit at the revision instant", () => {
    const result = evaluateSellerComplianceCohort({
      sales: [sale("a", "2025-01-01T00:00:00.000Z", "250000"), sale("b", "2025-01-15T00:00:00.000Z", "250000")],
      policy: { ...policy, qualifyingGrossCents: "1000000" },
      evaluationAt: "2025-02-10T00:00:00.000Z",
      previous: { state: "member", band: "none", entryEffectiveAt: "2025-01-15T00:00:00.000Z" },
      revisionEffectiveAt: "2025-02-10T00:00:00.000Z",
      priorPolicies: [{ effectiveFrom: "2025-01-01T00:00:00.000Z", policy }],
    });
    expect(result.state).toBe("outside");
    expect(result.exitEffectiveAt).toBe("2025-02-10T00:00:00.000Z");
  });

  const raised = { ...policy, qualifyingGrossCents: "1000000" };
  const priorBase = [{ effectiveFrom: "2025-01-01T00:00:00.000Z", policy }];

  it("re-enters strictly after the previous exit at a revision that alone restores the window", () => {
    const sales = [
      sale("one", "2025-05-01T00:00:00.000Z", "250000"),
      sale("two", "2025-05-10T00:00:00.000Z", "250000"),
    ];
    const entry = evaluateSellerComplianceCohort({ sales, policy, evaluationAt: "2025-05-11T00:00:00.000Z" });
    expect([entry.state, entry.entryEffectiveAt]).toEqual(["member", "2025-05-10T00:00:00.000Z"]);
    // A threshold-raising revision effective May 15 exits the seller at its own instant.
    const exit = evaluateSellerComplianceCohort({
      sales,
      policy: raised,
      evaluationAt: "2025-05-16T00:00:00.000Z",
      previous: { ...entry, transitionEffectiveAt: entry.entryEffectiveAt },
      revisionEffectiveAt: "2025-05-15T00:00:00.000Z",
      priorPolicies: priorBase,
    });
    expect([exit.state, exit.exitEffectiveAt]).toEqual(["outside", "2025-05-15T00:00:00.000Z"]);
    // A May 18 sale is not enough under the raised policy; the May 19 lowering revision alone restores the window.
    const later = [...sales, sale("three", "2025-05-18T00:00:00.000Z", "250000")];
    const reentry = evaluateSellerComplianceCohort({
      sales: later,
      policy,
      evaluationAt: "2025-05-20T00:00:00.000Z",
      previous: { ...exit, transitionEffectiveAt: exit.exitEffectiveAt },
      revisionEffectiveAt: "2025-05-19T00:00:00.000Z",
      priorPolicies: [...priorBase, { effectiveFrom: "2025-05-15T00:00:00.000Z", policy: raised }],
    });
    expect([reentry.state, reentry.entryEffectiveAt, reentry.band]).toEqual([
      "member",
      "2025-05-19T00:00:00.000Z",
      "none",
    ]);
    // With disclosure 700000, the earliest winning window [2025-04-10..., 2025-05-10...) stays below the threshold, so no band rises at re-entry.
    const reentryWithBand = evaluateSellerComplianceCohort({
      sales: later,
      policy: { ...policy, disclosureGrossCents: "700000" },
      evaluationAt: "2025-05-20T00:00:00.000Z",
      previous: { ...exit, transitionEffectiveAt: exit.exitEffectiveAt },
      revisionEffectiveAt: "2025-05-19T00:00:00.000Z",
      priorPolicies: [...priorBase, { effectiveFrom: "2025-05-15T00:00:00.000Z", policy: raised }],
    });
    expect([reentryWithBand.entryEffectiveAt, reentryWithBand.band, reentryWithBand.bandEffectiveAt]).toEqual([
      "2025-05-19T00:00:00.000Z",
      "none",
      null,
    ]);
  });

  it("re-enters at the later sale that restores a window still holding a pre-exit sale", () => {
    const sales = [
      sale("first", "2025-01-01T00:00:00.000Z", "300000"),
      sale("second", "2025-01-15T00:00:00.000Z", "300000"),
      sale("pre-exit", "2025-02-05T00:00:00.000Z", "100000"),
      sale("restoring", "2025-03-03T00:00:00.000Z", "400000"),
    ];
    const entry = evaluateSellerComplianceCohort({ sales, policy, evaluationAt: "2025-01-16T00:00:00.000Z" });
    expect(entry.entryEffectiveAt).toBe("2025-01-15T00:00:00.000Z");
    const exit = evaluateSellerComplianceCohort({
      sales,
      policy,
      evaluationAt: "2025-03-02T00:00:00.000Z",
      previous: { ...entry, transitionEffectiveAt: entry.entryEffectiveAt },
    });
    expect(exit.exitEffectiveAt).toBe("2025-03-01T00:00:00.001Z");
    // The February sale still counts in the window it anchors; the March 3 sale completes it after the exit.
    const reentry = evaluateSellerComplianceCohort({
      sales,
      policy,
      evaluationAt: "2025-03-10T00:00:00.000Z",
      previous: { ...exit, transitionEffectiveAt: exit.exitEffectiveAt },
    });
    expect([reentry.state, reentry.entryEffectiveAt, reentry.windowStart, reentry.qualifyingGrossCents]).toEqual([
      "member",
      "2025-03-03T00:00:00.000Z",
      "2025-02-03T00:00:00.001Z",
      "500000",
    ]);
  });

  it("dates a band-only roll-off at the disclosure boundary however late the sweep runs", () => {
    const sales = [
      sale("band-one", "2025-01-01T00:00:00.000Z", "1000000"),
      sale("band-two", "2025-01-10T00:00:00.000Z", "1000000"),
      sale("band-three", "2025-02-01T00:00:00.000Z", "250000"),
      sale("band-four", "2025-02-10T00:00:00.000Z", "250000"),
    ];
    const entry = evaluateSellerComplianceCohort({ sales, policy, evaluationAt: "2025-01-11T00:00:00.000Z" });
    expect([entry.state, entry.band, entry.entryEffectiveAt, entry.bandEffectiveAt]).toEqual([
      "member",
      "disclosure",
      "2025-01-10T00:00:00.000Z",
      "2025-01-10T00:00:00.000Z",
    ]);
    const previous = { ...entry, transitionEffectiveAt: entry.bandEffectiveAt };
    const at = (evaluationAt: string) => {
      const result = evaluateSellerComplianceCohort({ sales, policy, evaluationAt, previous });
      return [result.state, result.band, result.bandEffectiveAt];
    };
    expect(at("2025-03-01T00:00:00.000Z")).toEqual(["member", "disclosure", null]);
    for (const late of ["2025-03-01T00:00:00.001Z", "2025-03-12T00:00:00.000Z", "2025-03-20T00:00:00.000Z"])
      expect(at(late)).toEqual(["member", "none", "2025-03-01T00:00:00.001Z"]);
    expect(
      evaluateSellerComplianceCohort({ sales, policy, evaluationAt: "2025-03-12T00:00:00.000Z", previous }),
    ).toMatchObject({
      effectiveAt: "2025-03-01T00:00:00.001Z",
      observedAt: "2025-03-12T00:00:00.000Z",
      state: "member",
      band: "none",
    });
    // Exit still clears the band in one transition: the outside verdict carries band none.
    const exit = evaluateSellerComplianceCohort({
      sales,
      policy,
      evaluationAt: "2025-04-20T00:00:00.000Z",
      previous: { ...previous, band: "none", transitionEffectiveAt: "2025-03-01T00:00:00.001Z" },
    });
    expect([exit.state, exit.band, exit.exitEffectiveAt]).toEqual(["outside", "none", "2025-04-01T00:00:00.001Z"]);
    expect(exit).toMatchObject({ effectiveAt: "2025-04-01T00:00:00.001Z", observedAt: "2025-04-20T00:00:00.000Z" });
  });

  it("keeps an ordinary roll-off exit when a later revision is evaluated", () => {
    const sales = [
      sale("roll-one", "2025-01-01T00:00:00.000Z", "250000"),
      sale("roll-two", "2025-01-10T00:00:00.000Z", "250000"),
    ];
    const entry = evaluateSellerComplianceCohort({ sales, policy, evaluationAt: "2025-01-11T00:00:00.000Z" });
    const previous = { ...entry, transitionEffectiveAt: entry.entryEffectiveAt };
    const ordinary = evaluateSellerComplianceCohort({
      sales,
      policy,
      evaluationAt: "2025-03-20T00:00:00.000Z",
      previous,
    });
    expect(ordinary.exitEffectiveAt).toBe("2025-03-01T00:00:00.001Z");
    // Neither an identical-value nor a threshold-raising revision effective after the roll-off moves that instant.
    for (const revised of [policy, raised])
      expect(
        evaluateSellerComplianceCohort({
          sales,
          policy: revised,
          evaluationAt: "2025-03-20T00:00:00.000Z",
          previous,
          revisionEffectiveAt: "2025-03-10T00:00:00.000Z",
          priorPolicies: priorBase,
        }).exitEffectiveAt,
      ).toBe(ordinary.exitEffectiveAt);
  });

  it("exits at a threshold-raising revision instant while the old policy still qualifies", () => {
    const sales = [
      sale("raise-one", "2025-04-01T00:00:00.000Z", "250000"),
      sale("raise-two", "2025-04-15T00:00:00.000Z", "250000"),
    ];
    const previous = {
      state: "member" as const,
      band: "none" as const,
      entryEffectiveAt: "2025-04-15T00:00:00.000Z",
      transitionEffectiveAt: "2025-04-15T00:00:00.000Z",
    };
    // Control: the old policy still holds the seller at the tick.
    expect(
      evaluateSellerComplianceCohort({ sales, policy, evaluationAt: "2025-05-20T00:00:00.000Z", previous }).state,
    ).toBe("member");
    for (const evaluationAt of ["2025-05-10T00:00:00.000Z", "2025-05-20T00:00:00.000Z"])
      expect(
        evaluateSellerComplianceCohort({
          sales,
          policy: raised,
          evaluationAt,
          previous,
          revisionEffectiveAt: "2025-05-10T00:00:00.000Z",
          priorPolicies: priorBase,
        }).exitEffectiveAt,
      ).toBe("2025-05-10T00:00:00.000Z");
    // Without the prior policy segment the evaluator remains fail-closed at
    // the revision boundary; replay/poison durability is owned by the sibling.
    expect(
      evaluateSellerComplianceCohort({
        sales,
        policy: raised,
        evaluationAt: "2025-05-20T00:00:00.000Z",
        previous,
        revisionEffectiveAt: "2025-05-10T00:00:00.000Z",
      }),
    ).toMatchObject({ state: "outside", exitEffectiveAt: "2025-05-10T00:00:00.000Z" });
  });
});
