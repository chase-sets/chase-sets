import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { expect, it } from "vitest";
import { scanRetainedArtifacts } from "../e2e/retained-artifacts";

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
