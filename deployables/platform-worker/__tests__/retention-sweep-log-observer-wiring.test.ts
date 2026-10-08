import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("retention sweep worker observer wiring", () => {
  it("passes the bounded production observer and never logs a raw sweep error", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const composition = source.match(/retentionSweep: \(\) => \(\{\n([\s\S]*?)\n\s*\}\),\n/)?.[1];
    expect(composition?.trim().split(/\n\s*/)).toEqual([
      "targets: collectRetentionSweepTargets(runtime, pools.control),",
      "observer: createRetentionSweepLogObserver(logger),",
    ]);
    expect(source).not.toContain("retention.sweep.failed");
  });
});
