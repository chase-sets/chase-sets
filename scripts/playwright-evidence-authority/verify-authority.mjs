import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildRelease, releasePath, runCli, stableJson, verifyAuthority } from "./authority.mjs";

export function verify(argv = []) {
  if (!argv.includes("--write-release")) return verifyAuthority(argv);
  const release = buildRelease();
  writeFileSync(releasePath, stableJson(release));
  return { status: "PASS", headBinding: release.headBinding.mode, receiptDigest: release.receiptDigest };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) runCli("authority verification", verify);
