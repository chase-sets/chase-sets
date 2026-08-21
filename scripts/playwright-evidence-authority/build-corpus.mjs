import { pathToFileURL } from "node:url";
import { checkCorpus, importCapturedCorpus, runCli } from "./authority.mjs";

export function run(argv) {
  const manifest = argv.includes("--import") ? importCapturedCorpus() : argv.includes("--check") ? checkCorpus() : null;
  if (!manifest) throw new Error("CORPUS_MODE_REQUIRED");
  return {
    status: "PASS",
    payloads: manifest.payloads.length,
    bytes: manifest.payloads.reduce((sum, row) => sum + row.bytes, 0),
    observedMembers: manifest.coverage.observed.length,
    declaredControls: manifest.coverage.declared.length,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) runCli("corpus builder", run);
