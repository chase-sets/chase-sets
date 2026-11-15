import { spawnSync } from "node:child_process";

/**
 * Complete Git listings are buffered synchronously by the script checks.
 * Keep one measured capacity for every listing executor so a growing index or
 * tree cannot fall through Node's 1 MiB default. The current maximum measured
 * listing is 1,074,383 bytes, leaving 7,314,225 bytes of headroom.
 */
export const GIT_LISTING_MAX_BUFFER = 8 * 1024 * 1024;

export function gitListingOptions(options = {}) {
  return { ...options, maxBuffer: GIT_LISTING_MAX_BUFFER };
}

const defaultGitRunner = (file, args, options) => spawnSync(file, args, options);

/**
 * Read one Git result without imposing a wall-clock deadline. The runner is
 * injectable so callers can exercise delayed, correct output without making
 * elapsed time part of the product verdict.
 */
export function readGitText({ cwd, args, runGit = defaultGitRunner }) {
  const result = runGit("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: GIT_LISTING_MAX_BUFFER,
  });
  if (!result || typeof result !== "object") throw new Error("Git inspection returned no result.");
  if (result.error) throw new Error(`Git inspection failed: ${result.error.message}`);
  if (result.signal) throw new Error(`Git inspection terminated by ${result.signal}.`);
  if (result.status !== 0) throw new Error(`Git inspection exited with status ${result.status}.`);
  if (typeof result.stdout !== "string") throw new Error("Git inspection returned malformed output.");
  return result.stdout;
}

export function readTrackedSidecarPaths({ cwd, runGit = defaultGitRunner }) {
  return readGitText({
    cwd,
    runGit,
    args: ["ls-files", "-z", "--", ":(glob)bounded-contexts/**/*.lost-update-exceptions.json"],
  });
}

export function readGitHead({ cwd, runGit = defaultGitRunner }) {
  const head = readGitText({ cwd, args: ["rev-parse", "HEAD"], runGit }).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("Git inspection returned a malformed HEAD.");
  return head;
}
