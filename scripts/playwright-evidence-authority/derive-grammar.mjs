import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { checkGrammar, deriveGrammar, grammarPath, stableJson } from "./authority.mjs";

export function run(argv) {
  const version = argv[argv.indexOf("--playwright-version") + 1];
  if (version !== "1.60.0") throw new Error("PLAYWRIGHT_VERSION_REFUSED");
  const grammar = deriveGrammar();
  if (argv.includes("--write")) writeFileSync(grammarPath, stableJson(grammar));
  else if (argv.includes("--check")) checkGrammar(grammar);
  else throw new Error("DERIVATION_MODE_REQUIRED");
  process.stdout.write(`${JSON.stringify({ status: "PASS", members: grammar.members.length, digest: grammar.digests.coreBundle })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) try { run(process.argv.slice(2)); } catch (error) { process.stderr.write(`grammar derivation failed (${String(error.message).replace(/[^A-Z_]/g, "")}).\n`); process.exitCode = 1; }
