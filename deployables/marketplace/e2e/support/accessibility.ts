import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo } from "@playwright/test";

export type AxeRuleExclusion = Readonly<{
  ruleId: string;
  reason: string;
}>;

export async function expectAxeScan(
  page: Page,
  testInfo: TestInfo,
  surface: string,
  exclusions: readonly AxeRuleExclusion[] = [],
): Promise<void> {
  const results = await new AxeBuilder({ page }).include("main").analyze();
  const excludedRuleIds = new Set(exclusions.map(({ ruleId }) => ruleId));
  const unexpectedViolations = results.violations.filter(({ id }) => !excludedRuleIds.has(id));
  const report = {
    surface,
    scope: "main",
    url: page.url(),
    violations: results.violations,
    exclusions,
    passes: results.passes.length,
    incomplete: results.incomplete,
  };

  await testInfo.attach(`axe-${surface}.json`, {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });

  expect(unexpectedViolations, `${surface} has unlisted axe accessibility violations`).toEqual([]);
}
