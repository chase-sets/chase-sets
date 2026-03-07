import { access, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const distAssetsDir = new URL("../dist/assets/", import.meta.url);
const designSystemPackageUrl = new URL(
  "../../../packages/design-system/package.json",
  import.meta.url
);
const requiredCssContractSnippets = [
  "[data-chase-theme][data-color-mode=light]",
  "[data-chase-theme][data-color-mode=dark]",
  "--color-background:",
  "--font-body:",
  ".modern-surface",
  ".focus-ring:focus-visible"
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
  const packageJsonPath = fileURLToPath(designSystemPackageUrl);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const stylesheetExport = packageJson.exports?.["./styles.css"];

  if (typeof stylesheetExport !== "string") {
    throw new Error(
      "Missing ./styles.css export in packages/design-system/package.json."
    );
  }

  await access(resolve(dirname(packageJsonPath), stylesheetExport));

  const cssBundlePath = await findCssBundle();
  const css = await readFile(cssBundlePath, "utf8");
  const missingContractSnippets = requiredCssContractSnippets.filter(
    (selector) => !css.includes(selector)
  );

  if (missingContractSnippets.length > 0) {
    throw new Error(
      `Generated CSS is missing required design-system contract snippets: ${missingContractSnippets.join(", ")}`
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
