import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const distAssetsDir = new URL("../dist/assets/", import.meta.url);
const requiredSelectors = [
  ".flex",
  ".bg-background",
  ".rounded-tokenLg",
  ".shadow-tokenSm"
];

async function findCssBundle() {
  const distAssetsPath = fileURLToPath(distAssetsDir);
  const assetNames = await readdir(distAssetsPath);
  const cssName = assetNames.find((name) => name.endsWith(".css"));

  if (!cssName) {
    throw new Error("Missing CSS bundle in dist/assets.");
  }

  return join(distAssetsPath, cssName);
}

async function main() {
  const cssBundlePath = await findCssBundle();
  const css = await readFile(cssBundlePath, "utf8");
  const missingSelectors = requiredSelectors.filter(
    (selector) => !css.includes(selector)
  );

  if (missingSelectors.length > 0) {
    throw new Error(
      `Generated CSS is missing required selectors: ${missingSelectors.join(", ")}`
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
