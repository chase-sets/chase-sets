import {
  createForecastKindRegistry,
  forecastKindDefinitions,
  type ForecastCurve,
  type ForecastInput,
  type ForecastKindDefinition,
} from "../../features/forecast-ledger/domain/forecast-kinds";
import { expect, it } from "vitest";
import { deepFreeze, describeConformance, runConformance, type ConformanceProperty } from "./kit";
import { parityCurve } from "../../features/repricing-engine/tests/curve-objective-fixture";

const pricedAt = "2026-10-13T12:00:00.000Z";
const conditionSales = [
  { weekStart: "2026-10-01", transactionCount: 2 },
  { weekStart: "2026-09-24", transactionCount: 1 },
] as const;

const curve: ForecastCurve = {
  modelVersion: "fixture-curve-v1",
  points: parityCurve.points,
  conditionSales,
};

const validInput = (overrides: Partial<ForecastInput> = {}): ForecastInput => ({
  priceAmount: "12.00",
  pricedAt,
  goalForecast: { medianSellDays: 19.408121055678468, status: "interpolated" },
  curve,
  ...overrides,
});

const expectValidForecast = (kind: ForecastKindDefinition, input: ForecastInput) => {
  const frozen = deepFreeze(structuredClone(input));
  const first = kind.forecast(frozen);
  expect(first, `${kind.name} should forecast for the valid fixture`).not.toBeNull();
  expect(first!.medianSellDays).toBeGreaterThan(0);
  expect(Number.isFinite(first!.medianSellDays)).toBe(true);
  expect(first!.model.length).toBeGreaterThan(0);
  expect(kind.forecast(frozen)).toEqual(first);
};

const forecastKindProperties: readonly ConformanceProperty<ForecastKindDefinition>[] = [
  {
    name: "keeps evaluation-producer money, time and curve invariants in the suite domain",
    check: () => {
      expect(validInput().priceAmount).toMatch(/^\d+\.\d{2}$/);
      expect(Number.isFinite(Date.parse(validInput().pricedAt))).toBe(true);
      expect(curve.points.length).toBeGreaterThan(0);
      expect(curve.points.every((point) => /^\d+\.\d{2}$/.test(point.priceAmount))).toBe(true);
    },
  },
  {
    name: "returns a stable finite positive forecast for valid evaluation inputs",
    check: (kind) => expectValidForecast(kind, validInput()),
  },
  {
    name: "returns null when the evaluated curve is absent",
    check: (kind) => expect(kind.forecast(validInput({ curve: null, goalForecast: null }))).toBeNull(),
  },
  {
    name: "does not read the goal read-back unless the curve kind needs it",
    check: (kind) => {
      const missing = validInput({ goalForecast: null });
      const unavailable = validInput({ goalForecast: { medianSellDays: null, status: "unavailable" } });
      if (kind.name === "curve") {
        expect(kind.forecast(missing)).toBeNull();
        expect(kind.forecast(unavailable)).toBeNull();
      } else {
        expectValidForecast(kind, missing);
        expectValidForecast(kind, unavailable);
      }
    },
  },
  {
    name: "returns null only for buyer-choice when buyer-choice evidence is unusable",
    check: (kind) => {
      const noBuyerArrival = {
        ...curve,
        points: curve.points.map((point) => ({ ...point, buyerArrivalIntervalDays: null })),
      };
      const input = validInput({ curve: noBuyerArrival, goalForecast: validInput().goalForecast });
      if (kind.name === "buyer-choice") expect(kind.forecast(input)).toBeNull();
      else expectValidForecast(kind, input);
    },
  },
  {
    name: "returns null only for condition-rate when condition-rate evidence is unusable",
    check: (kind) => {
      const noSales = validInput({ curve: { ...curve, conditionSales: [] }, goalForecast: validInput().goalForecast });
      const noStoreWinShare = validInput({
        curve: { ...curve, points: curve.points.map((point) => ({ ...point, storeWinShare: null })) },
        goalForecast: validInput().goalForecast,
      });
      for (const input of [noSales, noStoreWinShare]) {
        if (kind.name === "condition-rate") expect(kind.forecast(input)).toBeNull();
        else expectValidForecast(kind, input);
      }
    },
  },
  {
    name: "rejects malformed scalars only for kinds that read them",
    check: (kind) => {
      const malformedPrice = validInput({ priceAmount: "" });
      const malformedTime = validInput({ pricedAt: "not-a-timestamp" });
      const malformedCurve = validInput({
        curve: { ...curve, points: curve.points.map((point) => ({ ...point, percentile: Number.NaN })) },
      });
      if (kind.name === "curve") {
        expectValidForecast(kind, malformedPrice);
        expectValidForecast(kind, malformedTime);
        expectValidForecast(kind, malformedCurve);
      } else {
        if (kind.name === "buyer-choice") expect(kind.forecast(malformedPrice)).toBeNull();
        if (kind.name === "condition-rate") {
          expect(kind.forecast(malformedTime)).toBeNull();
          expect(kind.forecast(malformedCurve)).toBeNull();
        } else {
          expectValidForecast(kind, malformedTime);
          expectValidForecast(kind, malformedCurve);
        }
      }
    },
  },
];

// The factory's own module constructs the registry, so the run binds that
// construction's enumeration as `production`. The inputs mirror the producer:
// money and time are evaluated trace scalars, and points are builder output.
describeConformance({
  registry: createForecastKindRegistry,
  production: forecastKindDefinitions,
  entries: forecastKindDefinitions,
  key: (kind) => kind.name,
  properties: forecastKindProperties,
});

it("Step 9 — Prove every registered Forecast Kind through the Conformance Kit", async () => {
  expect(
    await runConformance({
      registry: createForecastKindRegistry,
      production: forecastKindDefinitions,
      entries: forecastKindDefinitions,
      key: (kind) => kind.name,
      properties: forecastKindProperties,
    }),
  ).toEqual([]);
});
