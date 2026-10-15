import { describe, expect, it } from "vitest";
import { resolvePricingGoal } from "../../features/repricing-policies/domain/domain";
import {
  createPricingGoalRegistry,
  type GoalDecision,
  type PricingGoalDefinition,
} from "../../features/repricing-policies/domain/goals/registry";
import { goalDeclarations } from "./goal-declarations";
import { goalConformanceProperties, goalVersionKey } from "./goal-properties";
import { recordRegistrations, registrationCoverage, runConformance, type ConformanceSuite } from "./kit";

const incumbent = resolvePricingGoal("fixed-percentile", 1)!;
const properties = goalConformanceProperties(goalDeclarations);

const failedProperties = async (goal: PricingGoalDefinition) =>
  (
    await runConformance({
      registry: createPricingGoalRegistry,
      entries: () => [goal],
      key: goalVersionKey,
      properties,
    })
  ).map(({ property }) => property);

describe("Conformance Kit negative controls", () => {
  it("fails an empty registry instead of passing it", async () => {
    expect(
      await runConformance({
        registry: createPricingGoalRegistry,
        entries: () => createPricingGoalRegistry().definitions(),
        key: goalVersionKey,
        properties,
      }),
    ).toEqual([
      { entry: null, property: "registered-entries", message: "No registered entries; an empty run proves nothing." },
    ]);
  });

  it("fails repeated entry keys", async () => {
    expect(
      await runConformance({
        registry: createPricingGoalRegistry,
        entries: () => [incumbent, incumbent],
        key: goalVersionKey,
        properties,
      }),
    ).toEqual([{ entry: null, property: "registered-entries", message: "Repeated entry keys: fixed-percentile@1." }]);
  });

  it("passes the registered goal it starts from", async () => {
    expect(await failedProperties(incumbent)).toEqual([]);
  });

  it("fails a goal that decides differently on the same captured inputs", async () => {
    let calls = 0;
    const drifting: PricingGoalDefinition = {
      ...incumbent,
      solve: (input) => {
        const result = incumbent.solve(input);
        calls += 1;
        return result.kind === "decision" && calls % 2 === 0
          ? { ...result, equivalentPercentile: result.equivalentPercentile + 1 }
          : result;
      },
    };
    expect(await failedProperties(drifting)).toContain("decides deterministically over frozen captured inputs");
  });

  it("fails a goal that writes to its captured inputs", async () => {
    const mutating: PricingGoalDefinition = {
      ...incumbent,
      solve: (input) => {
        (input.parameters as Record<string, number>).percentile = 50;
        return incumbent.solve(input);
      },
    };
    expect(await failedProperties(mutating)).toContain("decides deterministically over frozen captured inputs");
  });

  it("fails a goal whose price falls when it claims to scale with the curve", async () => {
    const inverted: PricingGoalDefinition = {
      ...incumbent,
      solve: (input) =>
        incumbent.solve({
          ...input,
          curve: {
            ...input.curve,
            points: input.curve.points.map((point) => ({
              ...point,
              priceAmount: (100 / Number(point.priceAmount)).toFixed(2),
            })),
          },
        }),
    };
    expect(await failedProperties(inverted)).toContain("responds monotonically to curve prices where it claims to");
  });

  it("fails a goal whose explanation names another Goal Version", async () => {
    const misattributed: PricingGoalDefinition = {
      ...incumbent,
      explain: (decision: GoalDecision) => ({ ...incumbent.explain(decision), goalVersion: 2 }),
    };
    expect(await failedProperties(misattributed)).toContain("explains every decision with its own identity and values");
  });

  it("fails a goal that ignores a curve feature it declares as required", async () => {
    const undeclared: PricingGoalDefinition = { ...incumbent, requiredCurveFeatures: ["storeWinShare"] };
    expect(await failedProperties(undeclared)).toContain(
      "answers a stable unavailable result for each missing input it declares",
    );
  });
});

// The reviewer's synthetic registry (9654-review-r1 F2): a production composition
// registers two entries, and a run exercises them or a hand-written subset.
type SyntheticStyle = Readonly<{ id: string; conforms: boolean }>;
function createSyntheticStyles(initial: readonly SyntheticStyle[] = []) {
  const styles = new Map<string, SyntheticStyle>();
  const registerSyntheticStyle = (style: SyntheticStyle): void => {
    styles.set(style.id, style);
  };
  initial.forEach(registerSyntheticStyle);
  return { registerSyntheticStyle, definitions: () => [...styles.values()] };
}
const covered = { id: "synthetic-covered", conforms: true };
const uncovered = { id: "synthetic-uncovered", conforms: true };
const recordedStyles = () =>
  recordRegistrations({ createSyntheticStyles }, "createSyntheticStyles").createSyntheticStyles;
const styleSuite = (
  registry: typeof createSyntheticStyles,
  entries: () => readonly SyntheticStyle[],
  extra: Partial<ConformanceSuite<SyntheticStyle>> = {},
): ConformanceSuite<SyntheticStyle> => ({
  registry,
  entries,
  key: (style) => style.id,
  properties: [
    {
      name: "synthetic entry contract",
      check: (style) => {
        if (!style.conforms) throw new Error("SYNTHETIC registered entry violates its contract");
      },
    },
  ],
  ...extra,
});
const notExercised = (entry: string) => ({
  entry,
  property: "production-registrations",
  message: "Registered in production but not exercised by this run.",
});

describe("Conformance Kit production-registration binding", () => {
  it("passes a run that exercises exactly the recorded production registrations", async () => {
    const registry = recordedStyles();
    const production = registry([covered, uncovered]);

    expect(registry.name).toBe("createSyntheticStyles");
    expect(await registrationCoverage(styleSuite(registry, () => production.definitions()))).toEqual([]);
  });

  it("fails the reviewer's omitted-entry run that exercises a hand-written subset", async () => {
    const registry = recordedStyles();
    const production = registry([covered, uncovered]);

    expect(await registrationCoverage(styleSuite(registry, () => [production.definitions()[0]!]))).toEqual([
      notExercised("synthetic-uncovered"),
    ]);
  });

  it("records entries registered later through the registry's register member", async () => {
    const registry = recordedStyles();
    const production = registry([covered]);
    production.registerSyntheticStyle({ id: "synthetic-late", conforms: true });

    expect(await registrationCoverage(styleSuite(registry, () => [covered]))).toEqual([notExercised("synthetic-late")]);
  });

  it("fails an exercised entry production never registered unless the run declares it unregistered", async () => {
    const registry = recordedStyles();
    registry([covered]);
    const sentinel = { id: "synthetic-sentinel", conforms: true };

    expect(await registrationCoverage(styleSuite(registry, () => [covered, sentinel]))).toEqual([
      {
        entry: "synthetic-sentinel",
        property: "production-registrations",
        message: "Exercised but neither registered in production nor declared in unregisteredKeys.",
      },
    ]);
    expect(
      await registrationCoverage(
        styleSuite(registry, () => [covered, sentinel], { unregisteredKeys: ["synthetic-sentinel"] }),
      ),
    ).toEqual([]);
    expect(
      await registrationCoverage(
        styleSuite(registry, () => [covered, sentinel], {
          unregisteredKeys: ["synthetic-sentinel", "synthetic-covered"],
        }),
      ),
    ).toEqual([
      {
        entry: "synthetic-covered",
        property: "production-registrations",
        message: "Declared in unregisteredKeys but registered in production.",
      },
    ]);
  });

  it("fails a registry that was not recorded, or that no production composition constructed", async () => {
    expect(await registrationCoverage(styleSuite(createSyntheticStyles, () => [covered]))).toEqual([
      {
        entry: null,
        property: "production-registrations",
        message:
          "createSyntheticStyles is not recorded; vi.mock its module through recordRegistrations so the run reads every production registration.",
      },
    ]);
    expect(await registrationCoverage(styleSuite(recordedStyles(), () => [covered]))).toEqual([
      {
        entry: null,
        property: "production-registrations",
        message:
          "No production composition constructed createSyntheticStyles; load the composition that registers its entries.",
      },
    ]);
  });

  it("still fails a registered entry that violates its contract once the run exercises it", async () => {
    const registry = recordedStyles();
    const production = registry([covered, { ...uncovered, conforms: false }]);
    const suite = styleSuite(registry, () => production.definitions());

    expect(await registrationCoverage(suite)).toEqual([]);
    expect(await runConformance(suite)).toEqual([
      {
        entry: "synthetic-uncovered",
        property: "synthetic entry contract",
        message: "SYNTHETIC registered entry violates its contract",
      },
    ]);
  });
});
