import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { expect, it } from "vitest";
import { scanRetainedArtifacts } from "../e2e/retained-artifacts";

it("keeps product secret setup outside automatic traces and retains a sanitized failure trace", () => {
  const source = readFileSync(new URL("../e2e/chromium-authority.spec.ts", import.meta.url), "utf8");
  const assertTraceOwnership = (candidate: string) => {
    expect(candidate).toContain('test.use({ trace: "off", screenshot: "off" });');
    expect(candidate).toContain("context.tracing.start({ screenshots: false, snapshots: false, sources: false })");
    expect(candidate).toContain('context.tracing.stop({ path: join(output, "failure.zip") })');
    expect(candidate).toContain("scanRetainedArtifacts(output, platform.forbidden())");
    expect(candidate.indexOf("await context.addCookies(")).toBeLessThan(candidate.indexOf("context.tracing.start("));
  };
  assertTraceOwnership(source);
  expect(() => assertTraceOwnership(source.replace('trace: "off"', 'trace: "on"'))).toThrow();
  expect(() => assertTraceOwnership(source.replace("snapshots: false", "snapshots: true"))).toThrow();
});

it("extension-retained-artifact-scan extracts compressed failure evidence and kills a secret mutant", () => {
  const folder = mkdtempSync(join(tmpdir(), "connector-artifact-scan-"));
  const trace = join(folder, "failure.zip");
  writeFileSync(trace, zipSync({ "resources/trace.network": strToU8("safe failure evidence") }));
  expect(scanRetainedArtifacts(folder, ["synthetic-secret-marker"])).toBe(1);
  writeFileSync(trace, zipSync({ "resources/trace.network": strToU8("synthetic-secret-marker") }));
  expect(() => scanRetainedArtifacts(folder, ["synthetic-secret-marker"])).toThrow(
    "connector-retained-artifact-secret",
  );
});
