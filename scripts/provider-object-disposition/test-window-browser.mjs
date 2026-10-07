import { readFile, lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { acquireHeavySlot } from "../lib/heavy-slot.mjs";
import { admissionProof, mediationFailure } from "./browser-boundary/protocol.mjs";

const execute = promisify(execFile);
export const BROWSER_LAUNCHER = "/usr/local/lib/chase-sets-provider-window/launcher";
export const SOURCE_FILES = Object.freeze([
  "browser-boundary/launcher.c",
  "browser-boundary/apparmor.profile",
  "browser-boundary/install-ci.sh",
  "browser-boundary/ownership.py",
  "browser-boundary/protocol.mjs",
  "test-window-browser.mjs",
]);
const CHILD_ENVIRONMENT = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });

export async function assertBrowserAdmission({ operator = false } = {}) {
  // Operator-host authority is separate. Never run a probe for that entry.
  if (operator) throw mediationFailure("operator-installation-unavailable");
  if (process.platform !== "linux" || typeof process.getuid !== "function") throw mediationFailure("linux-required");
  if (process.getuid() === 0) throw mediationFailure("nonroot-required");
  acquireHeavySlot("playwright");
  let restriction = "unknown";
  try {
    const value = await readFile("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8");
    if (/^[01]\n$/.test(value)) restriction = Number(value.trim());
  } catch {
    // A missing sysctl observation grants no authority; the native proof is required.
  }
  try {
    for (const path of [
      "/",
      "/usr",
      "/usr/local",
      "/usr/local/lib",
      "/usr/local/lib/chase-sets-provider-window",
      BROWSER_LAUNCHER,
    ]) {
      const stat = await lstat(path);
      if (
        stat.uid !== 0 ||
        (stat.mode & 0o6022) !== 0 ||
        (path === BROWSER_LAUNCHER ? !stat.isFile() || (stat.mode & 0o007) !== 0 : !stat.isDirectory()) ||
        (await realpath(path)) !== path
      )
        throw new Error("installation-identity");
    }
    const source = await Promise.all(
      SOURCE_FILES.map(async (path) => {
        const data = await readFile(new URL(path, import.meta.url));
        return `${createHash("sha256").update(data).digest("hex")}  ${path}\n`;
      }),
    );
    const sourceDigest = createHash("sha256").update(source.join("")).digest("hex");
    const { stdout, stderr } = await execute(BROWSER_LAUNCHER, ["probe", sourceDigest], {
      env: CHILD_ENVIRONMENT,
      timeout: 5000,
      maxBuffer: 4096,
      encoding: "buffer",
    });
    if (!admissionProof(stdout, stderr)) throw Object.assign(new Error("admission-proof"), { stdout, stderr, code: 0 });
    return { sourceDigest, userNamespaceRestriction: restriction };
  } catch (error) {
    throw mediationFailure("installed-boundary", error, restriction);
  }
}

export async function openConfinedBrowser() {
  const { sourceDigest, userNamespaceRestriction } = await assertBrowserAdmission();
  const { chromium } = await import("@playwright/test");
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: BROWSER_LAUNCHER,
      ignoreDefaultArgs: true,
      args: ["browser", sourceDigest],
      env: CHILD_ENVIRONMENT,
      chromiumSandbox: true,
      timeout: 5000,
    });
  } catch (error) {
    throw mediationFailure("sandboxed-chromium", error, userNamespaceRestriction);
  }
  let closing;
  return {
    newContext: () => browser.newContext({ serviceWorkers: "block", acceptDownloads: false }),
    close: () => {
      closing ??= browser.close();
      return closing;
    },
  };
}
