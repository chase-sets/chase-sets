import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo } from "@playwright/test";

export type AxeRuleExclusion = Readonly<{
  ruleId: string;
  targets: readonly string[];
  reason: string;
}>;

export type AxeViolationNode = Readonly<{ target: readonly string[] }>;
export type AxeViolation = Readonly<{ id: string; nodes: readonly AxeViolationNode[] }>;

function targetKey(target: readonly string[]): string {
  return JSON.stringify(target);
}

/**
 * An exclusion only masks a violation when the violation's rule id AND its
 * exact set of node targets match a declared exclusion. A rule id match with
 * an unexpected/extra node target is left in `unexpectedViolations`, and a
 * declared exclusion with no matching violation is reported as stale so the
 * scan fails instead of silently accepting drift.
 */
export function partitionAxeViolations(
  violations: readonly AxeViolation[],
  exclusions: readonly AxeRuleExclusion[],
): { unexpectedViolations: AxeViolation[]; staleExclusions: AxeRuleExclusion[] } {
  const matchedExclusions = new Set<AxeRuleExclusion>();

  const unexpectedViolations = violations.filter((violation) => {
    const actualTargetKeys = violation.nodes.map((node) => targetKey(node.target)).sort();

    const matchingExclusion = exclusions.find((exclusion) => {
      if (exclusion.ruleId !== violation.id || matchedExclusions.has(exclusion)) {
        return false;
      }

      const expectedTargetKeys = exclusion.targets.map((target) => targetKey([target])).sort();
      return (
        expectedTargetKeys.length === actualTargetKeys.length &&
        expectedTargetKeys.every((key, index) => key === actualTargetKeys[index])
      );
    });

    if (!matchingExclusion) {
      return true;
    }

    matchedExclusions.add(matchingExclusion);
    return false;
  });

  const staleExclusions = exclusions.filter((exclusion) => !matchedExclusions.has(exclusion));

  return { unexpectedViolations, staleExclusions };
}

export async function expectAxeScan(
  page: Page,
  testInfo: TestInfo,
  surface: string,
  exclusions: readonly AxeRuleExclusion[] = [],
): Promise<void> {
  const results = await new AxeBuilder({ page }).include("main").analyze();
  const { unexpectedViolations, staleExclusions } = partitionAxeViolations(results.violations, exclusions);

  const report = {
    surface,
    scope: "main",
    url: page.url(),
    violations: results.violations,
    exclusions,
    staleExclusions,
    passes: results.passes.length,
    incomplete: results.incomplete,
  };

  await testInfo.attach(`axe-${surface}.json`, {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });

  expect(unexpectedViolations, `${surface} has unlisted axe accessibility violations`).toEqual([]);
  expect(staleExclusions, `${surface} declares axe exclusions that no longer match any violation`).toEqual([]);
}
