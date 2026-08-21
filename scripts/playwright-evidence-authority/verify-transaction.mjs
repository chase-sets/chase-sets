import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyTransactionHarness } from "./transaction.mjs";

export function verify(argv) {
  const source = argv[argv.indexOf("--candidate-root") + 1];
  if (!source) throw new Error("CANDIDATE_ROOT_REQUIRED");
  const transactionRoot = mkdtempSync(path.join(tmpdir(), "playwright-authority-candidate-"));
  try {
    return verifyTransactionHarness({ source: path.resolve(source), transactionRoot });
  } finally {
    rmSync(transactionRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.stdout.write(`${JSON.stringify(verify(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`transaction verification failed (${String(error.message).replace(/[^A-Z_]/g, "")}).\n`);
    process.exitCode = 1;
  }
}
