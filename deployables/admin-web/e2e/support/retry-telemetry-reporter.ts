import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

const retryAnnotationType = "passed-on-retry";

export default class RetryTelemetryReporter implements Reporter {
  private readonly passedOnRetry: string[] = [];

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status !== "passed" || result.retry === 0) {
      return;
    }

    const testName = test.titlePath().join(" ");
    result.annotations.push({
      type: retryAnnotationType,
      description: `Passed on retry ${result.retry}; investigate the first-attempt failure.`,
    });
    this.passedOnRetry.push(testName);
  }

  async onEnd() {
    if (this.passedOnRetry.length === 0) {
      return;
    }

    const summary = `Playwright tests passed only on retry:\n${this.passedOnRetry
      .map((testName) => `- ${testName}`)
      .join("\n")}`;
    console.warn(summary);

    if (process.env.PLAYWRIGHT_FAIL_ON_RETRY === "true") {
      throw new Error(`${summary}\nPLAYWRIGHT_FAIL_ON_RETRY=true; treating retry recovery as a failure.`);
    }
  }
}
