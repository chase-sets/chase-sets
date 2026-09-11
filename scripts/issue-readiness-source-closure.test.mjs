import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("imports the exact trusted workflow source bundle without checkout dependencies", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const workflow = readFileSync(path.join(root, ".github/workflows/issue-readiness.yml"), "utf8");
  const manifest = workflow.match(/const sourcePaths = (\[[\s\S]*?\]);/);
  expect(manifest).not.toBeNull();
  const sources = [...manifest[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const isolated = mkdtempSync(path.join(tmpdir(), "readiness-source-closure-"));
  try {
    for (const source of sources) {
      const target = path.join(isolated, source);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(root, source), target);
    }
    const checker = pathToFileURL(path.join(isolated, "scripts/issue-readiness.mjs")).href;
    expect(() =>
      execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(checker)})`], {
        cwd: isolated,
        timeout: 15000,
        stdio: "pipe",
      }),
    ).not.toThrow();
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});
