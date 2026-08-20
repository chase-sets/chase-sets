import { pathToFileURL } from "node:url";
import { checkCorpus, importCapturedCorpus } from "./authority.mjs";

export function run(argv) {
  const manifest = argv.includes("--import") ? importCapturedCorpus() : argv.includes("--check") ? checkCorpus() : null;
  if (!manifest) throw new Error("CORPUS_MODE_REQUIRED");
  process.stdout.write(`${JSON.stringify({ status: "PASS", payloads: manifest.payloads.length, bytes: manifest.payloads.reduce((sum, row) => sum + row.bytes, 0) })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) try { run(process.argv.slice(2)); } catch (error) { process.stderr.write(`corpus builder failed (${String(error.message).replace(/[^A-Z_]/g, "")}).\n`); process.exitCode = 1; }
