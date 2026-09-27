import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { openConfinedBrowser } from "../provider-object-disposition/test-window-browser.mjs";

const SOURCE = "6cc23a77fdd0e35f6d04b51a6f6c9526cf5439dc";
const OUTPUT = "artifacts/8255-h1-diagnostic/admission.json";
const require = createRequire(import.meta.url);
const allowed = {
  stage: new Set(["linux-required", "nonroot-required", "user-network-namespace", "sandboxed-chromium"]),
  errorClass: new Set(["Error", "TypeError", "TimeoutError", "unknown"]),
  message: new Set([
    "unshare: unshare failed: Operation not permitted",
    "unshare: unshare failed: Permission denied",
    "unshare: unshare failed: No space left on device",
    "unshare: unshare failed: Invalid argument",
    "No usable sandbox!",
    "Running as root without --no-sandbox is not supported",
    "Failed to move to new namespace",
    "Target page, context or browser has been closed",
    "executable-not-found",
    "unclassified-launch-failure",
  ]),
  errno: new Set([null, "EPERM", "EACCES", "ENOENT", "ENOSPC", "EINVAL", "EAGAIN"]),
  userNamespaceRestriction: new Set([0, 1, "unknown"]),
};

function limited(value, pattern) {
  return typeof value === "string" && value.length <= 100 && pattern.test(value) ? value : "unknown";
}

function version(command, args, pattern) {
  try {
    const output = execFileSync(command, args, {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C", LC_ALL: "C" },
    }).trim();
    return limited(output, pattern);
  } catch {
    return "unknown";
  }
}

function closedDiagnostic(error) {
  const prefix = "browser-mediation-unavailable: ";
  if (typeof error?.message !== "string" || !error.message.startsWith(prefix) || error.message.length > 2048) {
    return { stage: "unknown", failureCode: "unclassified-failure" };
  }
  try {
    const parsed = JSON.parse(error.message.slice(prefix.length));
    if (
      !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !== "errno,errorClass,message,stage,userNamespaceRestriction" ||
      Object.entries(allowed).some(([key, values]) => !values.has(parsed[key]))
    ) return { stage: "unknown", failureCode: "unclassified-failure" };
    return {
      stage: parsed.stage,
      errorClass: parsed.errorClass,
      message: parsed.message,
      errno: parsed.errno,
      userNamespaceRestriction: parsed.userNamespaceRestriction,
    };
  } catch {
    return { stage: "unknown", failureCode: "unclassified-failure" };
  }
}

const restrictionText = await readFile("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").catch(() => "");
const restriction = ["0", "1"].includes(restrictionText.trim()) ? Number(restrictionText.trim()) : "unknown";
const osRelease = await readFile("/etc/os-release", "utf8").catch(() => "");
const ubuntu2404 = /^ID=ubuntu$/m.test(osRelease) && /^VERSION_ID="?24\.04"?$/m.test(osRelease);
const nonRoot = typeof process.getuid === "function" && process.getuid() !== 0;
let playwright = "unknown";
let chromium = "unknown";
try {
  playwright = limited(require("@playwright/test/package.json").version, /^[0-9]+(?:\.[0-9]+){2}$/);
  const { chromium: executable } = await import("@playwright/test");
  chromium = version(executable.executablePath(), ["--version"], /^Chromium [0-9]+(?:\.[0-9]+){2,3}$/);
} catch {
  // Missing tooling is an unknown version, not a raw diagnostic.
}

const result = {
  source: SOURCE,
  diagnosticCommit: limited(process.env.GITHUB_SHA, /^[a-f0-9]{40}$/),
  runId: limited(process.env.GITHUB_RUN_ID, /^[0-9]+$/),
  runAttempt: limited(process.env.GITHUB_RUN_ATTEMPT, /^1$/),
  jobKey: limited(process.env.GITHUB_JOB, /^h1-admission$/),
  jobId: "unknown (resolved from hosted job metadata after completion)",
  runner: {
    image: limited(process.env.ImageOS, /^[A-Za-z0-9._-]+$/),
    imageVersion: limited(process.env.ImageVersion, /^[A-Za-z0-9._-]+$/),
    ubuntu2404,
    kernel: version("/usr/bin/uname", ["-r"], /^[A-Za-z0-9._+-]+$/),
    nonRoot,
  },
  versions: {
    node: limited(process.version, /^v[0-9]+(?:\.[0-9]+){2}$/),
    pnpm: version("pnpm", ["--version"], /^[0-9]+(?:\.[0-9]+){2}$/),
    playwright,
    chromium,
  },
  startedAt: new Date().toISOString(),
  namespace: "unknown/not-reached",
  restriction,
  chromiumStage: "NOT RUN",
  browserOpen: "not-reached",
  close: "not-reached",
  cleanup: "not-reached",
  exit: "failure",
};

try {
  if (!ubuntu2404 || !nonRoot || result.runAttempt !== "1") {
    result.failure = "image-or-admission-mismatch";
  } else {
    let browser;
    try {
      browser = await openConfinedBrowser();
      result.namespace = "passed";
      result.chromiumStage = "opened";
      result.browserOpen = "opened";
    } catch (error) {
      const diagnostic = closedDiagnostic(error);
      result.diagnostic = diagnostic;
      if (diagnostic.stage === "user-network-namespace") result.namespace = "failed";
      if (diagnostic.stage === "sandboxed-chromium") {
        result.namespace = "passed";
        result.chromiumStage = "failed";
      }
    }
    if (browser) {
      try {
        await browser.close();
        result.close = "succeeded";
        result.cleanup = "succeeded";
        result.exit = "success";
      } catch {
        result.close = "failed";
        result.cleanup = "unknown";
        result.failure = "close-or-cleanup-failure";
      }
    }
  }
} finally {
  result.finishedAt = new Date().toISOString();
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > 65536) throw new Error("closed-result-size-limit");
  await mkdir("artifacts/8255-h1-diagnostic", { recursive: true });
  await writeFile(OUTPUT, serialized, { flag: "wx" });
}

if (result.exit !== "success") process.exitCode = 1;
