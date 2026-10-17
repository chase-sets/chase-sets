import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";

export const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function parseLaunchArguments(args) {
  if (
    !Array.isArray(args) ||
    args.length !== 7 ||
    args[0] !== "--candidate-head" ||
    args[2] !== "--manifest-path" ||
    args[4] !== "--manifest-sha256" ||
    args[6] !== "--authorize-one-test-window" ||
    !/^[a-f0-9]{40}$/.test(args[1]) ||
    !/^[a-f0-9]{64}$/.test(args[5]) ||
    typeof args[3] !== "string" ||
    !isAbsolute(args[3]) ||
    /^[\\/]{2}/.test(args[3])
  )
    throw new Error("authority-unavailable");
  return Object.freeze({ candidateHead: args[1], manifestPath: args[3], manifestDigest: args[5] });
}

export function assertReviewedWorktree(candidateHead) {
  const options = { cwd: REPOSITORY_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 65536 };
  if (
    !/^[a-f0-9]{40}$/.test(candidateHead) ||
    execFileSync("git", ["rev-parse", "HEAD"], options).trim() !== candidateHead ||
    execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], options).trim()
  )
    throw new Error("authority-unavailable");
}
