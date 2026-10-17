import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { operatorEvidenceIdentity } from "../../../../scripts/prepare-operator-extension-evidence.mjs";

export default class OperatorArtifactReporter implements Reporter {
  private readonly root = resolve(import.meta.dirname, "../../../..");
  private readonly identity = operatorEvidenceIdentity(this.root);
  private readonly tests: {
    id: "build" | "chromium";
    retry: number;
    status: TestResult["status"];
    durationMs: number;
  }[] = [];
  private invalid = false;

  onTestEnd(test: TestCase, result: TestResult) {
    const id =
      test.title === "operator-extension-deterministic-build @tcgplayer-operator-extension"
        ? "build"
        : test.title ===
            "operator-extension-chromium: opaque UI, exact-host cookies and retained reload @tcgplayer-operator-extension"
          ? "chromium"
          : null;
    if (!id) {
      this.invalid = true;
      return;
    }
    this.tests.push({ id, retry: result.retry, status: result.status, durationMs: Math.round(result.duration) });
    console.log(`Operator ${id} attempt ${result.retry}: ${result.status}`);
  }

  async onEnd(result: FullResult) {
    const evidence = join(this.root, "artifacts/operator-extension");
    mkdirSync(evidence, { recursive: true });
    const status = this.invalid ? "failed" : result.status;
    writeFileSync(
      join(evidence, "producer.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          identity: this.identity,
          status,
          tests: this.tests,
        },
        null,
        2,
      ) + "\n",
    );
    return { status };
  }
}
