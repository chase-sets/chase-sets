import { writeFileSync } from "node:fs";
import { relative } from "node:path";
import { test } from "@playwright/test";
import { buildHarness } from "./coordinator-observation";
import { launchInstallation } from "./extension-installation";

// #10109-AC4 leg 1. No test.use here, so the package's shipped trace: "on" governs this file;
// Playwright refuses that override inside a describe group of the trace-off probe file. This leg
// never signs in, pairs or creates a pairing code, and the probe file's final test scans its output.

let extension: string;

async function settle<T>(work: () => Promise<T>) {
  try {
    return { resolved: await work() };
  } catch (error) {
    return { rejected: (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 240) };
  }
}

test.beforeAll(async () => {
  extension = await buildHarness("operation");
});

test("connector-routing-facts-probe AC4 leg 1 shipped trace", async ({ trace }, testInfo) => {
  const rows: Record<string, unknown>[] = [];
  try {
    const installation = await launchInstallation(extension);
    try {
      rows.push({
        ac: "AC4",
        leg: "environment",
        trace,
        node: process.version,
        playwright: testInfo.config.version,
        browser: installation.context.browser()?.version() ?? null,
        run: process.env.GITHUB_RUN_ID ?? "local-diagnostic",
        attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        job: process.env.GITHUB_JOB ?? null,
        sha: process.env.GITHUB_SHA ?? null,
      });
      const start = await settle(() => installation.context.tracing.start({ snapshots: false }));
      const stop = await settle(() => installation.context.tracing.stop());
      const close = await settle(() => installation.context.close());
      const reclose = "rejected" in close ? await settle(() => installation.context.close()) : null;
      rows.push({
        ac: "AC4",
        leg: "leg-1-shipped-trace",
        trace,
        tracingStart: start,
        pathlessTracingStop: stop,
        contextClose: close,
        contextReclose: reclose,
        outputDirectory: relative(testInfo.project.outputDir, testInfo.outputDir),
      });
    } finally {
      await installation.context.close().catch(() => undefined);
    }
  } catch (error) {
    rows.push({ ac: "AC4", leg: "probe-aborted", error: String(error).split("\n")[0]!.slice(0, 240) });
    throw error;
  } finally {
    const lines = rows.map((row) => JSON.stringify({ issue: 10109, ...row }));
    writeFileSync(testInfo.outputPath("receipt.jsonl"), `${lines.join("\n")}\n`);
    for (const line of lines) console.log(`CONNECTOR_10109_RECEIPT ${line}`);
  }
});
