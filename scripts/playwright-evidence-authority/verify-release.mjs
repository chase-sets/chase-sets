import { pathToFileURL } from "node:url";
import { checkRelease } from "./authority.mjs";

export function verify(argv) {
  const expectedHead = argv[argv.indexOf("--expected-head") + 1];
  if (!expectedHead) throw new Error("EXPECTED_HEAD_REQUIRED");
  const release = checkRelease({ expectedHead, requireIndependentPass: true });
  return { status: "PASS", receiptDigest: release.receiptDigest };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) try { process.stdout.write(`${JSON.stringify(verify(process.argv.slice(2)))}\n`); } catch (error) { process.stderr.write(`release verification failed (${String(error.message).replace(/[^A-Z_]/g, "")}).\n`); process.exitCode = 1; }
