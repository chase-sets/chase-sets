import { fileURLToPath } from "node:url";
import { collectShowcaseSourceViolations } from "../../../packages/design-system/scripts/showcase-source-contract.mjs";

async function main() {
  const findings = await collectShowcaseSourceViolations(
    fileURLToPath(new URL("../src/", import.meta.url))
  );

  if (findings.length > 0) {
    throw new Error(findings.join("\n"));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
