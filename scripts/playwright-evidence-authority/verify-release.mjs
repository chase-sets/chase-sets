import { pathToFileURL } from "node:url";
import { checkRelease, runCli } from "./authority.mjs";

export function verify(argv) {
  const expectedHead = argv[argv.indexOf("--expected-head") + 1];
  if (!expectedHead) throw new Error("EXPECTED_HEAD_REQUIRED");
  return { status: "PASS", receiptDigest: checkRelease({ expectedHead, requireIndependentPass: true }).receiptDigest };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) runCli("release verification", verify);
