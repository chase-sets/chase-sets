import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { checkGrammar, deriveGrammar, grammarPath, runCli, stableJson } from "./authority.mjs";

export function run(argv) {
  if (argv[argv.indexOf("--playwright-version") + 1] !== "1.60.0") throw new Error("PLAYWRIGHT_VERSION_REFUSED");
  const grammar = deriveGrammar();
  if (argv.includes("--write")) writeFileSync(grammarPath, stableJson(grammar));
  else if (argv.includes("--check")) checkGrammar(grammar);
  else throw new Error("DERIVATION_MODE_REQUIRED");
  return { status: "PASS", members: grammar.members.length, digest: grammar.digests.coreBundle };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) runCli("grammar derivation", run);
