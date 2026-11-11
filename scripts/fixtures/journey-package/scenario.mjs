import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "@playwright/test";

export { expect, test };

// Synthetic, browserless test bodies for the journey package tests. The test
// writes plan.json into the temporary root; the generated spec files there
// import this module, so every title, attachment and ending comes from the plan.
// The specs call test() themselves: when every test in a file is declared in a
// module with another extension, Playwright moves the file suite's location to
// that module, and the reporter would no longer see the target spec.
const root = process.env.JOURNEY_PACKAGE_FIXTURE_ROOT;
const plan = JSON.parse(readFileSync(path.join(root, "plan.json"), "utf8"));

async function runStep(step, testInfo, inlineAssertion) {
  if (step.attach) {
    const contentType = step.contentType ?? (step.json === undefined ? "image/png" : "application/json");
    if (step.mode === "path") await testInfo.attach(step.attach, { path: path.join(root, step.file), contentType });
    else {
      const body =
        step.json !== undefined
          ? JSON.stringify(step.json)
          : step.text !== undefined
            ? step.text
            : readFileSync(path.join(root, step.file));
      await testInfo.attach(step.attach, { body, contentType });
    }
    return;
  }
  if (step.do === "skip") test.skip(true, "synthetic fixture skip");
  if (step.do === "assert") expect(1, "synthetic fixture assertion").toBe(2);
  if (step.do === "inline-assert") inlineAssertion();
  if (step.do === "throw") throw new Error(step.message);
  if (step.do === "fail-first-attempt" && testInfo.retry === 0) throw new Error("synthetic first attempt failure");
  if (step.do === "hang") await new Promise(() => {});
  if (step.do === "touch") writeFileSync(path.join(root, step.file), "touched");
  if (step.do === "wait-for-file") {
    while (!existsSync(path.join(root, step.file))) await sleep(50);
    await sleep(step.thenMs ?? 0);
  }
}

// Returns [title, body] pairs for the generated target spec to declare.
export function journeyFixtureTests({ inlineAssertion }) {
  const titles = plan.duplicate ? [plan.title, `${plan.title} duplicate`] : [plan.title];
  return titles.map((title) => [
    title,
    async ({}, testInfo) => {
      if (plan.expectFailure) test.fail();
      if (plan.timeoutMs) test.setTimeout(plan.timeoutMs);
      for (const step of plan.steps) await runStep(step, testInfo, inlineAssertion);
    },
  ]);
}

export function otherFixtureTests() {
  return [
    [
      "synthetic other test",
      async ({}, testInfo) => {
        for (const step of plan.other ?? []) await runStep(step, testInfo, () => {});
      },
    ],
  ];
}
