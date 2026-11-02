import type { RepricingFloor, RepricingPolicyScope, RepricingRule, RepricingRuleDirective } from "./domain";
import { validateParameters, type GoalParameterSchema } from "./goals/registry";

type ResolveAuthoringGoal = (
  id: string,
  version: number,
) => Readonly<{ lifecycle: string; parameterSchema: GoalParameterSchema }> | null;

export type RepricingPreset = "track-market" | "beat-lowest" | "premium" | "slow-stock";
export type AuthoringBody = Readonly<{
  scope: RepricingPolicyScope;
  excludedListingIds?: readonly string[];
  rules: readonly RepricingRule[];
  maxChangesPerDay: number;
  authoringIntent?: RepricingAuthoringIntent | null;
}>;
type AuthoringSource =
  | Readonly<{ kind: "preset"; preset: RepricingPreset; knob: number; ageDays: number }>
  | Readonly<{ kind: "goal"; goalId: string; goalVersion: number; parameters: Readonly<Record<string, number>> }>;
export type RepricingAuthoringIntent = Readonly<{
  version: 1;
  compilerVersion: 1;
  source: AuthoringSource;
  semanticBody: string;
}>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function authoringBodyKey(body: AuthoringBody): string {
  return canonical({
    scope: body.scope,
    excludedListingIds: body.excludedListingIds ?? [],
    rules: body.rules,
    maxChangesPerDay: body.maxChangesPerDay,
  });
}

export function bindAuthoringIntent<T extends AuthoringBody>(
  body: T,
  source: AuthoringSource,
): T & { authoringIntent: RepricingAuthoringIntent } {
  return { ...body, authoringIntent: { version: 1, compilerVersion: 1, source, semanticBody: authoringBodyKey(body) } };
}

export function compilePresetBody(
  input: Readonly<{
    preset: RepricingPreset;
    name: string;
    currencyCode: string;
    floor: RepricingFloor;
    knob: number;
    ageDays?: number;
    scope: RepricingPolicyScope;
  }>,
) {
  const directive: RepricingRuleDirective = {
    currencyCode: input.currencyCode,
    anchorChain:
      input.preset === "beat-lowest"
        ? [{ source: "lowest-competing-ask" }, { source: "market-estimate" }]
        : input.preset === "premium"
          ? [{ source: "comp-percentile", percentile: 75 }, { source: "market-estimate" }]
          : [{ source: "market-estimate" }, { source: "lowest-competing-ask" }, { source: "last-sold" }],
    offset: {
      mode: "percent",
      percent: input.preset === "beat-lowest" || input.preset === "slow-stock" ? -input.knob : input.knob,
    },
    floor: input.floor,
    ceiling: null,
    tolerance: { mode: "percent", percent: input.preset === "beat-lowest" ? 1 : input.preset === "premium" ? 3 : 2 },
    rounding: { mode: "none" },
    maxMovePercent: input.preset === "premium" ? 15 : input.preset === "slow-stock" ? 25 : 20,
    terminal: { kind: "hold" },
  };
  return bindAuthoringIntent(
    {
      name: input.name,
      scope: input.scope,
      excludedListingIds: [],
      maxChangesPerDay: 250,
      rules:
        input.preset === "slow-stock"
          ? [
              { conditions: [{ type: "listing-age-at-least" as const, days: input.ageDays ?? 45 }], directive },
              {
                conditions: [],
                directive: {
                  ...directive,
                  offset: { mode: "percent" as const, percent: 0 },
                  tolerance: { mode: "percent" as const, percent: 5 },
                  maxMovePercent: 10,
                },
              },
            ]
          : [{ conditions: [], directive }],
    },
    { kind: "preset", preset: input.preset, knob: input.knob, ageDays: input.ageDays ?? 45 },
  );
}

// Commands supply the registry resolver; the browser checks selectable versions
// against the account's Authoring Prerequisites before exposing simple controls.
export function recognizeAuthoringIntent(
  body: AuthoringBody,
  resolveGoal?: ResolveAuthoringGoal,
): RepricingAuthoringIntent | null {
  const intent = body.authoringIntent;
  if (!intent || intent.version !== 1 || intent.compilerVersion !== 1 || intent.semanticBody !== authoringBodyKey(body))
    return null;
  const source = intent.source;
  if (source?.kind === "preset") {
    const bounds = {
      "track-market": [-25, 25],
      "beat-lowest": [0, 15],
      premium: [0, 30],
      "slow-stock": [0, 30],
    } as const;
    const range = Object.hasOwn(bounds, source.preset) ? bounds[source.preset] : null;
    const directive = body.rules[0]?.directive;
    if (
      !range ||
      !directive?.currencyCode ||
      !Number.isFinite(source.knob) ||
      source.knob < range[0] ||
      source.knob > range[1] ||
      !Number.isInteger(source.ageDays) ||
      source.ageDays < 14 ||
      source.ageDays > 180
    )
      return null;
    const compiled = compilePresetBody({
      ...source,
      name: "",
      currencyCode: directive.currencyCode,
      floor: directive.floor,
      scope: body.scope,
    });
    return authoringBodyKey(compiled) === intent.semanticBody ? intent : null;
  }
  if (source?.kind === "goal") {
    if (!source.parameters || typeof source.parameters !== "object" || Array.isArray(source.parameters)) return null;
    const goal = resolveGoal?.(source.goalId, source.goalVersion);
    const rule = body.rules[0];
    const anchor = rule?.directive.anchorChain[0];
    if (
      (resolveGoal && goal?.lifecycle !== "selectable") ||
      body.rules.length !== 1 ||
      rule?.conditions.length !== 0 ||
      rule.directive.anchorChain.length !== 1 ||
      anchor?.source !== "curve-objective"
    )
      return null;
    if (goal) {
      const validation = validateParameters(goal.parameterSchema, source.parameters);
      if (validation.kind !== "valid" || canonical(validation.parameters) !== canonical(source.parameters)) return null;
    }
    return anchor.goalId === source.goalId &&
      anchor.goalVersion === source.goalVersion &&
      canonical(anchor.parameters) === canonical(source.parameters)
      ? intent
      : null;
  }
  return null;
}

export function bindGoalAuthoringIntent<T extends AuthoringBody>(body: T, resolveGoal: ResolveAuthoringGoal): T {
  const anchor = body.rules[0]?.directive.anchorChain[0];
  if (anchor?.source !== "curve-objective") return body;
  const bound = bindAuthoringIntent(body, {
    kind: "goal",
    goalId: anchor.goalId,
    goalVersion: anchor.goalVersion,
    parameters: anchor.parameters,
  });
  return recognizeAuthoringIntent(bound, resolveGoal) ? bound : body;
}
