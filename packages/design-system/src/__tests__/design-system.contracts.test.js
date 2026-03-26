import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectShowcaseSourceViolations } from "../../scripts/showcase-source-contract.mjs";

const currentDir = dirname(fileURLToPath(import.meta.url));
const designSystemPackageJsonPath = resolve(currentDir, "../../package.json");
const showcaseSourcePath = resolve(
  currentDir,
  "../../../../deployables/design-system-showcase/src"
);

describe("design system contracts", () => {
  it("keeps the explicit styles.css package export wired to a real file", async () => {
    const packageJson = JSON.parse(
      await readFile(designSystemPackageJsonPath, "utf8")
    );
    const stylesheetExport = packageJson.exports?.["./styles.css"];

    expect(stylesheetExport).toBe("./src/styles/tailwind.css");
    await access(resolve(dirname(designSystemPackageJsonPath), stylesheetExport));
  });

  it("keeps showcase sources free of custom className usage and raw layout html", async () => {
    expect(await collectShowcaseSourceViolations(showcaseSourcePath)).toEqual([]);
  });
});
