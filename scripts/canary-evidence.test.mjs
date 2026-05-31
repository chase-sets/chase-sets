import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { evaluateCanaryAnalysis } from "./canary-analysis.mjs";
import { buildCanaryEvidence, collectCanaryEvidence, REQUIRED_CANARY_SIGNALS } from "./canary-evidence.mjs";

const releaseCommit = "0123456789abcdef0123456789abcdef01234567";

describe("canary evidence collector", () => {
  it("builds passing canary-analysis evidence when every required signal has telemetry", () => {
    const telemetry = Object.fromEntries(
      REQUIRED_CANARY_SIGNALS.map((signal) => [
        signal.name,
        {
          baseline: 1,
          canary: 1,
          maxIncrease: signal.maxIncrease,
          source: `test ${signal.source}`,
          threshold: `<= baseline + ${signal.maxIncrease}`,
        },
      ]),
    );

    const evidence = buildCanaryEvidence({
      releaseCommit,
      checkedAt: "2026-05-31T12:00:00.000Z",
      observationWindowSeconds: 300,
      telemetry,
    });

    const analysis = evaluateCanaryAnalysis(evidence);

    expect(evidence.schemaVersion).toBe("canary-analysis/v1");
    expect(evidence.signals).toHaveLength(REQUIRED_CANARY_SIGNALS.length);
    expect(evidence.signals[0]).toMatchObject({
      source: expect.stringContaining("test"),
      threshold: "<= baseline + 0",
    });
    expect(analysis.passesCanaryAnalysisGate).toBe(true);
  });

  it("marks unsupported required signals missing so analysis fails closed", () => {
    const evidence = buildCanaryEvidence({
      releaseCommit,
      checkedAt: "2026-05-31T12:00:00.000Z",
      observationWindowSeconds: 300,
      telemetry: {
        "app-platform-deployment-phase": { status: "pass", source: "workflow deployment summary" },
      },
    });

    const analysis = evaluateCanaryAnalysis(evidence);

    expect(evidence.signals.find((signal) => signal.name === "route-error-rate")).toMatchObject({
      status: "missing",
      source: "HTTP telemetry by route and host",
    });
    expect(analysis.passesCanaryAnalysisGate).toBe(false);
    expect(analysis.errors).toContain("Required canary signal route-error-rate did not pass: missing.");
  });

  it("keeps threshold failures visible after collecting source files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-canary-evidence-"));
    const sourceFile = join(directory, "telemetry.json");
    const outFile = join(directory, "canary-analysis.json");
    const signals = Object.fromEntries(
      REQUIRED_CANARY_SIGNALS.map((signal) => [
        signal.name,
        {
          baseline: 0,
          canary: signal.name === "route-latency-p95" ? 75 : 0,
          maxIncrease: signal.name === "route-latency-p95" ? 50 : signal.maxIncrease,
          source: signal.source,
        },
      ]),
    );
    await writeFile(sourceFile, `${JSON.stringify({ signals }, null, 2)}\n`);

    const result = await collectCanaryEvidence({
      outPath: outFile,
      releaseCommit,
      checkedAt: "2026-05-31T12:00:00.000Z",
      observationWindowSeconds: 300,
      sourceFiles: [sourceFile],
    });

    expect(result.analysis.passesCanaryAnalysisGate).toBe(false);
    expect(result.analysis.errors).toContain("Required canary signal route-latency-p95 did not pass: fail.");
    expect(JSON.parse(await readFile(outFile, "utf8")).signals).toEqual(result.evidence.signals);
  });
});
