import { describe, expect, it } from "vitest";
import {
  deriveTcgplayerOperatorSessionReadiness as derive,
  nextOperatorSessionOutcome as next,
  operatorSessionOutcomeFromRow,
  type OperatorSessionIdentity,
  type OperatorSessionOutcome,
  type OperatorSessionReadinessSnapshot,
} from "../domain/readiness";
import { operatorSessionRateBudgetContext } from "../domain/rate-budget-context";
import type { TcgplayerAutomationAdmissionResult } from "../../source-observations/api/providers/tcgplayer-automation-client";

const identity: OperatorSessionIdentity = { source: "operator-session", revision: 1, custodyRevision: 1 };
const start = Date.parse("2026-10-02T00:00:00.000Z");
const window = 30 * 60 * 1000;
const iso = (offset: number) => new Date(start + offset).toISOString();
const rejected = (patch: Partial<OperatorSessionOutcome> = {}): OperatorSessionOutcome => ({
  ...identity,
  state: "rejecting",
  stateSince: iso(0),
  lastRejectionAt: iso(window),
  lastRejectionStatus: 403,
  rateBudgetContext: "retained",
  everSucceeded: true,
  updatedAt: iso(window),
  ...patch,
});
const snapshot = (patch: Partial<OperatorSessionReadinessSnapshot> = {}): OperatorSessionReadinessSnapshot => ({
  custody: "stored",
  identity,
  browserExpiresAt: null,
  outcome: rejected(),
  ...patch,
});

describe("TCGplayer operator session readiness", () => {
  it("normalizes the persisted outcome without changing its bounded identity or UTC instants", () => {
    expect(
      operatorSessionOutcomeFromRow({
        source: "environment",
        revision: "0",
        custody_revision: "9007199254740991",
        state: "healthy",
        state_since: "2026-10-01T19:00:00-05:00",
        last_rejection_at: null,
        last_rejection_status: null,
        rate_budget_context: "unknown",
        ever_succeeded: true,
        updated_at: new Date(iso(0)),
      }),
    ).toEqual({
      source: "environment",
      revision: 0,
      custodyRevision: Number.MAX_SAFE_INTEGER,
      state: "healthy",
      stateSince: iso(0),
      lastRejectionAt: null,
      lastRejectionStatus: null,
      rateBudgetContext: "unknown",
      everSucceeded: true,
      updatedAt: iso(0),
    });
  });

  it.each([
    ["absent without environment", snapshot({ custody: "absent", identity: null }), "missing", "credential-missing"],
    ["cleared without environment", snapshot({ custody: "cleared", identity: null }), "missing", "credential-missing"],
    [
      "unreadable custody never falls back",
      snapshot({ custody: "unavailable", identity: null }),
      "unknown",
      "operator-session-custody-unavailable",
    ],
    ["expiry at now", snapshot({ browserExpiresAt: iso(window) }), "expired", "operator-session-expired"],
    ["nullable expiry", snapshot(), "invalid", "credential-refresh-needed"],
    [
      "expiry one millisecond ahead",
      snapshot({ browserExpiresAt: iso(window + 1), outcome: null }),
      "configured",
      null,
    ],
    [
      "401 immediate",
      snapshot({ outcome: rejected({ lastRejectionStatus: 401, stateSince: iso(window) }) }),
      "invalid",
      "credential-refresh-needed",
    ],
    ["short 403 by one millisecond", snapshot({ outcome: rejected({ stateSince: iso(1) }) }), "configured", null],
    ["sustained retained 403", snapshot(), "invalid", "credential-refresh-needed"],
    [
      "fresh never-succeeded 403",
      snapshot({ outcome: rejected({ everSucceeded: false }) }),
      "unknown",
      "rejected-after-refresh",
    ],
    [
      "unknown budget is not expiry",
      snapshot({ outcome: rejected({ rateBudgetContext: "unknown" }) }),
      "unknown",
      "adapter-authentication-failed",
    ],
    ["untested", snapshot({ outcome: null }), "configured", null],
    ["healthy", snapshot({ outcome: next(identity, null, 200, "unknown", iso(0)) }), "configured", null],
    ["wrong fence", snapshot({ outcome: rejected({ custodyRevision: 3 }) }), "configured", null],
    ["wrong revision", snapshot({ outcome: rejected({ revision: 3 }) }), "configured", null],
    ["wrong source", snapshot({ outcome: rejected({ source: "environment", revision: 0 }) }), "configured", null],
  ] as const)("%s", (_name, value, state, diagnosticCode) => {
    expect(derive(value, start + window)).toMatchObject({ state, diagnosticCode });
  });

  it.each([0, 2])(
    "environment revision zero retains custody fence %i and needs no prior success",
    (custodyRevision) => {
      const env: OperatorSessionIdentity = { source: "environment", revision: 0, custodyRevision };
      const value = snapshot({
        custody: custodyRevision ? "cleared" : "absent",
        identity: env,
        browserExpiresAt: iso(0),
        outcome: rejected({ ...env, everSucceeded: false }),
      });
      expect(derive(value, start + window)).toEqual({
        sourceKind: "environment-secret",
        state: "invalid",
        diagnosticCode: "credential-refresh-needed",
      });
      expect(derive({ ...value, outcome: null }, start + window).state).toBe("configured");
    },
  );

  it("keeps the exact stale boundary, ages 403 out after silence, and never ages 401 out", () => {
    expect(derive(snapshot(), start + 2 * window).state).toBe("invalid");
    expect(derive(snapshot(), start + 2 * window + 1).state).toBe("configured");
    expect(derive(snapshot(), start + 4 * window).state).toBe("configured");
    expect(derive(snapshot({ outcome: rejected({ lastRejectionStatus: 401 }) }), start + 4 * window).state).toBe(
      "invalid",
    );
  });

  it("throttles 1,000 identical outcomes, promotes 401/context immediately and restarts after silence", () => {
    let current = next(identity, null, 403, "unknown", iso(0))!;
    let writes = 0;
    for (let n = 1; n <= 1000; n++) {
      const update = next(identity, current, 403, "unknown", iso(n * 300));
      if (update) {
        current = update;
        writes++;
      }
    }
    expect(writes).toBe(1);
    current = next(identity, current, 403, "retained", iso(300001))!;
    expect(current.rateBudgetContext).toBe("retained");
    current = next(identity, current, 401, "retained", iso(300002))!;
    expect(current.lastRejectionStatus).toBe(401);
    expect(next(identity, current, 403, "retained", iso(300003))).toBeNull();
    const restarted = next(identity, rejected(), 403, "retained", iso(4 * window))!;
    expect(restarted.stateSince).toBe(iso(4 * window));
    expect(restarted.everSucceeded).toBe(true);
    const healthy = next(identity, current, 204, "retained", iso(300004))!;
    expect(healthy).toMatchObject({
      state: "healthy",
      everSucceeded: true,
      lastRejectionStatus: null,
      lastRejectionAt: null,
    });
    expect(next(identity, healthy, 200, "unknown", iso(300005))).toBeNull();
    expect(next(identity, healthy, 429, "retained", iso(300006))).toBeNull();
    expect(next({ ...identity, revision: 3, custodyRevision: 3 }, healthy, 403, "unknown", iso(300007))).toMatchObject({
      everSucceeded: false,
      stateSince: iso(300007),
    });
  });
});

describe("same-attempt retained rate-budget evidence", () => {
  const admission: TcgplayerAutomationAdmissionResult = {
    granted: true,
    domainKey: "infiniteApi",
    leaseId: "labeled-synthetic-lease",
    admittedAt: iso(0),
    notBefore: iso(0),
    leaseExpiresAt: iso(60000),
    epoch: 1,
    requestDelayMs: 200,
    floorRequestDelayMs: 200,
  };
  it("qualifies the exact grant once", () => {
    const used = new Set<string>();
    expect(operatorSessionRateBudgetContext(admission, "infiniteApi", used, start)).toBe("retained");
    expect(operatorSessionRateBudgetContext(admission, "infiniteApi", used, start)).toBe("unknown");
  });
  it.each([
    null,
    { ...admission, domainKey: "mpApi" as const },
    { ...admission, leaseId: "" },
    { ...admission, epoch: -1 },
    { ...admission, epoch: 1.5 },
    { ...admission, epoch: Infinity },
    { ...admission, granted: false },
    { ...admission, admittedAt: "invalid" },
    { ...admission, notBefore: iso(1) },
    { ...admission, leaseExpiresAt: iso(0) },
    { ...admission, requestDelayMs: NaN },
    { ...admission, requestDelayMs: 199 },
    { ...admission, floorRequestDelayMs: 0 },
    { ...admission, floorRequestDelayMs: Infinity },
  ])("fails closed for missing, uncorrelated or invalid admission %#", (invalid) => {
    expect(operatorSessionRateBudgetContext(invalid, "infiniteApi", new Set(), start)).toBe("unknown");
  });
  it("does not retain an expired grant", () => {
    expect(operatorSessionRateBudgetContext(admission, "infiniteApi", new Set(), start + 60000)).toBe("unknown");
  });
});
