import { describe, expect, it } from "vitest";
import { addUtcMonths, evaluateSellerComplianceCohort } from "./cohort-window";
import {
  SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE,
  decodeSellerComplianceCohortPolicyValue,
  type SellerComplianceCohortPolicyValue,
} from "./seller-compliance-cohort-policy";

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
 * foreign-currency, unclassified and fully refunded sales, plus one burst. Days stay within 1-28: the clamped month-end anchors
 * are pinned by the AC2 edge test, and the issue's slide-right argument assumes month addition preserves order.
 */
function generateScanSales(): readonly ScanSale[] {
  const monthlyCounts = [12, 3, 9, 14, 2, 8, 11, 4, 13, 6, 1, 10, 9, 12, 2, 7, 15, 3, 8, 11, 5, 12, 9, 14];
  const random = mulberry32(7146);
  const amounts = ["50000", "80000", "120000", "200000"];
  const scan: ScanSale[] = [];
  monthlyCounts.forEach((count, month) => {
    for (let index = 0; index < count; index++) {
      const at = Date.UTC(2024, month, 1 + Math.floor(random() * 28)) + Math.floor(random() * 86_399_998);
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
 * Brute-force lifecycle oracle. A verdict slides the window start across every sale instant and one millisecond
 * either side of it; a transition instant is the first instant of a dense grid (every sale instant +/- 1 ms and
 * every window-end and lookback boundary +/- 1 ms) after the last recorded transition at which the new verdict
 * holds, counting sales at that instant. First admission uses the issue's entry and band formulas.
 */
function oracleLifecycle(
  scan: readonly ScanSale[],
  rule: Readonly<{ count: number; gross: bigint; disclosure: bigint; windowMonths: number; lookbackMonths: number }>,
  ticks: readonly number[],
): LifecycleEntry[] {
  const ordered = [...scan].sort(
    (a, b) =>
      a.at - b.at || a.sale.paymentId.localeCompare(b.sale.paymentId) || a.sale.orderId.localeCompare(b.sale.orderId),
  );
  const windows = [...new Set(ordered.flatMap((entry) => [entry.at - 1, entry.at, entry.at + 1]))]
    .sort((a, b) => a - b)
    .map((start) => {
      const end = addMonthsMs(start, rule.windowMonths);
      return {
        start,
        admissibleThrough: addMonthsMs(start, rule.lookbackMonths),
        members: ordered.filter((entry) => entry.qualifying && entry.at >= start && entry.at < end),
      };
    });
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
      (window) => at <= window.admissibleThrough && meets(tally(window.members, at, inclusive), rule.gross),
    );
    if (!sliding) return { member: false, band: "none", window: null };
    // The winning sale-anchored window starts at the first sale at or after the earliest qualifying start.
    const anchor = ordered.find((entry) => entry.at >= sliding.start && visible(entry, at, inclusive))!;
    const anchored = windows.find((window) => window.start === anchor.at)!;
    const totals = tally(anchored.members, at, inclusive);
    if (!meets(totals, rule.gross) || at > anchored.admissibleThrough)
      throw new Error(`No sale-anchored window matches the sliding window at ${new Date(at).toISOString()}.`);
    return {
      member: true,
      band: totals.gross >= rule.disclosure ? "disclosure" : "none",
      window: {
        start: anchor.at,
        end: addMonthsMs(anchor.at, rule.windowMonths),
        ...totals,
        members: anchored.members,
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
    ...new Set(
      ordered.flatMap((entry) => {
        const end = addMonthsMs(entry.at, rule.windowMonths);
        const expiry = addMonthsMs(entry.at, rule.lookbackMonths);
        return [entry.at - 1, entry.at, entry.at + 1, end - 1, end, end + 1, expiry, expiry + 1, expiry + 2];
      }),
    ),
  ].sort((a, b) => a - b);
  const firstInstant = (lower: number, upper: number, holds: (value: ReturnType<typeof verdict>) => boolean) => {
    const instants = [...new Set([lower + 1, ...grid.filter((at) => at > lower && at < upper), upper])].sort(
      (a, b) => a - b,
    );
    const found = instants.find((at) => holds(verdict(at, at !== upper)));
    if (found === undefined) throw new Error("The oracle found no transition instant.");
    return found;
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

describe("seller compliance cohort window", () => {
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

  it("sale-anchored windows agree with an exhaustive sliding scan under shuffled input", () => {
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
      expect(actual).toEqual(oracle);
      return { ticks, oracle, actual };
    });
    // The fixture exercises every lifecycle edge rather than a constant verdict.
    for (const { oracle } of lifecycles) {
      const kinds = oracle.flatMap((entry) => entry.transitions.map(([kind]) => kind));
      for (const kind of ["entered", "exited", "band:disclosure", "band:none"])
        expect(kinds.filter((value) => value === kind).length, kind).toBeGreaterThanOrEqual(3);
    }
    expect(lifecycles[0]!.oracle.some((entry) => entry.transitions.length === 2)).toBe(true);
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
    expect(clamped.exitEffectiveAt).toBe("2025-04-30T00:00:00.001Z");

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
    // When that revision also lowers the disclosure threshold, the band rises at the same re-entry instant.
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
      "disclosure",
      "2025-05-19T00:00:00.000Z",
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
      "2025-02-05T00:00:00.000Z",
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
    // Exit still clears the band in one transition: the outside verdict carries band none.
    const exit = evaluateSellerComplianceCohort({
      sales,
      policy,
      evaluationAt: "2025-04-20T00:00:00.000Z",
      previous: { ...previous, band: "none", transitionEffectiveAt: "2025-03-01T00:00:00.001Z" },
    });
    expect([exit.state, exit.band, exit.exitEffectiveAt]).toEqual(["outside", "none", "2025-04-01T00:00:00.001Z"]);
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
    // Without the policy that was in force before the revision the cause cannot be decided, so evaluation fails closed.
    expect(() =>
      evaluateSellerComplianceCohort({
        sales,
        policy: raised,
        evaluationAt: "2025-05-20T00:00:00.000Z",
        previous,
        revisionEffectiveAt: "2025-05-10T00:00:00.000Z",
      }),
    ).toThrow(/policy in force before the revision/);
  });
});
