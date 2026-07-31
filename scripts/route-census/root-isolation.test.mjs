import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compareCaptures } from "./comparison.mts";
import { loadTargetHonoAuthority } from "./target-authority.mts";
import { makeCapture, repoRoot, syntheticContext } from "./test-support.mjs";

const execute = promisify(execFile);

describe("target-root isolation", () => {
  it("resolves the authority from the explicit target under a foreign cwd", async () => {
    const script = `import { loadTargetHonoAuthority } from ${JSON.stringify(new URL("./target-authority.mts", import.meta.url).href)}; const a=await loadTargetHonoAuthority(${JSON.stringify(repoRoot)}); process.stdout.write(JSON.stringify({p:a.moduleRealpath,v:a.packageVersion}))`;
    const { stdout } = await execute(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: path.parse(repoRoot).root,
      encoding: "utf8",
      windowsHide: true,
    });
    const result = JSON.parse(stdout);
    expect(result.v).toBe("4.12.18");
    expect(result.p.toLowerCase()).toContain(repoRoot.toLowerCase());
  });

  it("reports exactly one target route difference from independently built primitives", async () => {
    const context = await syntheticContext();
    const base = await makeCapture(context, { routes: ["/one"] });
    const candidate = await makeCapture(context, { routes: ["/one", "/two"] });
    const comparison = compareCaptures(base, candidate, "nonempty");
    expect(comparison.censusDiffs).toEqual([expect.objectContaining({ kind: "added", candidateIndex: 2 })]);
  });

  it("contains no static product or Hono imports and uses URL-safe absolute imports", async () => {
    const captureSource = await readFile(new URL("./capture.mts", import.meta.url), "utf8");
    const targetSource = await readFile(new URL("./target-authority.mts", import.meta.url), "utf8");
    expect(`${captureSource}\n${targetSource}`).not.toMatch(/from ["'](?:hono|@chase-sets\/)/);
    expect(captureSource).toContain("pathToFileURL");
    expect(targetSource).toContain("pathToFileURL");
  });

  it("binds all four helpers to one target module namespace", async () => {
    const authority = await loadTargetHonoAuthority(repoRoot);
    expect(Object.values(authority.helpers)).toHaveLength(4);
    expect(new Set(authority.helperExports)).toEqual(
      new Set(["mergePath", "checkOptionalParameter", "splitRoutingPath", "getPattern"]),
    );
  });
});
