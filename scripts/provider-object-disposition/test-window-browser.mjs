import { readFile, lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BROWSER_BOOTSTRAP, createBrowserBootstrapTransport } from "./test-window-policy.mjs";

const COMPONENTS = Object.freeze({
  "connect-setup": "account-onboarding",
  "connect-manage": "account-management",
  "connect-notification": "notification-banner",
});

const execute = promisify(execFile);
export const BROWSER_LAUNCHER = "/usr/local/lib/chase-sets-provider-window/launcher";
const SOURCE_FILES = [
  "browser-boundary/launcher.c",
  "browser-boundary/apparmor.profile",
  "browser-boundary/install-ci.sh",
  "test-window-browser.mjs",
];
const CHILD_ENVIRONMENT = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });
const LAUNCH_MESSAGES = Object.freeze([
  ...[
    "attachment",
    "source-identity",
    "launcher-identity",
    "dependency-identity",
    "inventory-identity",
    "principal",
    "automation-pipes",
    "automation-peer",
    "user-namespace",
    "mapping-open",
    "mapping-write",
    "child-namespaces",
    "host-rejoin",
    "external-interface",
    "loopback",
    "private-mounts",
    "private-tmp",
    "private-shm",
    "private-proc",
    "private-root",
    "securebits",
    "bounding-capabilities",
    "capabilities",
    "no-new-privileges",
    "nested-user-namespace",
    "nested-network-namespace",
    "nested-sandbox",
    "namespace-attachment",
    "browser-exit",
  ].map((stage) => [`provider-boundary-refused:${stage}`, null]),
  ["unshare: unshare failed: Operation not permitted", "EPERM"],
  ["unshare: unshare failed: Permission denied", "EACCES"],
  ["unshare: unshare failed: No space left on device", "ENOSPC"],
  ["unshare: unshare failed: Invalid argument", "EINVAL"],
  ["No usable sandbox!", null],
  ["Running as root without --no-sandbox is not supported", null],
  ["Failed to move to new namespace", null],
  ["Target page, context or browser has been closed", null],
]);

function mediationFailure(stage, error, userNamespaceRestriction = "unknown") {
  // Only pre-SDK system diagnostics are classified. Never retain the original
  // exception, Playwright call log, argv, child output or arbitrary marker text.
  const text = `${typeof error?.message === "string" ? error.message : ""}\n${typeof error?.stderr === "string" ? error.stderr : ""}`;
  const matched = LAUNCH_MESSAGES.find(([message]) => text.includes(message));
  const errorClass = ["Error", "TypeError", "TimeoutError"].includes(error?.name) ? error.name : "unknown";
  const errno = ["EPERM", "EACCES", "ENOENT", "ENOSPC", "EINVAL", "EAGAIN"].includes(error?.code)
    ? error.code
    : (matched?.[1] ?? null);
  const diagnostic = {
    stage,
    errorClass,
    message: matched?.[0] ?? (errno === "ENOENT" ? "executable-not-found" : "unclassified-launch-failure"),
    errno,
    userNamespaceRestriction,
  };
  return new Error(`browser-mediation-unavailable: ${JSON.stringify(diagnostic)}`);
}

/**
 * The browser has no external network namespace. All permitted bytes arrive via
 * the automation pipe after the parent applies the one-resource policy. Routing
 * alone does not confine WebRTC, background clients or Chromium's network service.
 */
export async function assertBrowserAdmission({ operator = false } = {}) {
  if (process.platform !== "linux" || typeof process.getuid !== "function") throw mediationFailure("linux-required");
  if (process.getuid() === 0) throw mediationFailure("nonroot-required");
  const restriction = await readFile("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").catch(
    () => "unknown",
  );
  const userNamespaceRestriction = ["0", "1"].includes(restriction.trim()) ? Number(restriction.trim()) : "unknown";
  let sourceDigest;
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
        const bytes = await readFile(new URL(path, import.meta.url));
        return `${createHash("sha256").update(bytes).digest("hex")}  ${path}\n`;
      }),
    );
    sourceDigest = createHash("sha256").update(source.join("")).digest("hex");
    // The installed binary rechecks its own identity, every immutable dependency,
    // effective attachment and all namespaces. No writable executable is hashed
    // and then executed, and the same checks run again in browser mode.
    const { stdout } = await execute(BROWSER_LAUNCHER, ["probe", sourceDigest], {
      env: CHILD_ENVIRONMENT,
      timeout: 5000,
      maxBuffer: 4096,
    });
    const expected = {
      admitted: true,
      nonroot: true,
      network: "isolated",
      hostRejoin: "denied",
      capabilities: "dropped",
      nestedSandbox: true,
      handles: "closed",
    };
    if (JSON.stringify(JSON.parse(stdout)) !== JSON.stringify(expected)) throw new Error("admission-proof");
    // This build/install route has CI authority only. Operator enablement belongs
    // to the separately admitted host installation, not a passing CI receipt.
    if (operator) throw new Error("operator-installation-unavailable");
  } catch (error) {
    throw mediationFailure("installed-boundary", error, userNamespaceRestriction);
  }
  return { sourceDigest, userNamespaceRestriction };
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
    });
  } catch (error) {
    throw mediationFailure("sandboxed-chromium", error, userNamespaceRestriction);
  }
  let closing;
  return {
    newContext: (options) => browser.newContext(options),
    close: () => {
      closing ??= browser.close();
      return closing;
    },
  };
}

export async function observeConnectComponent({
  browser,
  mapper,
  publishableKey,
  clientSecret,
  expiresAt,
  deadlineAt,
  budget,
  send,
  signal,
}) {
  const component = COMPONENTS[mapper];
  const result = {
    component,
    attempted: false,
    outcome: "unknown",
    usability: "unknown",
    callbackInvocations: 0,
    loaderStarted: false,
    created: false,
    mounted: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    elapsedMilliseconds: 0,
  };
  const start = performance.now();
  let context;
  let blocked = false;
  let failed = false;
  const deadline = Math.min(Date.parse(deadlineAt), Date.parse(expiresAt));
  if (!component || !Number.isFinite(deadline) || deadline <= Date.now()) return result;
  const session = new AbortController();
  const transport = createBrowserBootstrapTransport({
    budget,
    send,
    signal: signal ? AbortSignal.any([signal, session.signal]) : session.signal,
  });
  try {
    const sdkRoot = new URL("../../bounded-contexts/settlement/node_modules/@stripe/connect-js/", import.meta.url);
    const sdkPackage = JSON.parse(await readFile(new URL("package.json", sdkRoot), "utf8"));
    if (sdkPackage.version !== "3.4.5") throw new Error("browser-mediation-unavailable");
    const sdk = await readFile(new URL("dist/pure.js", sdkRoot), "utf8");
    context = await browser.newContext({
      serviceWorkers: "block",
      offline: true,
      acceptDownloads: false,
      permissions: [],
    });
    const close = () => {
      session.abort();
      void context.close().catch(() => {});
    };
    signal?.addEventListener("abort", close, { once: true });
    try {
      await context.routeWebSocket(/.*/, (socket) => {
        try {
          budget.take("browser");
          budget.deny({ method: "GET", url: socket.url() });
          blocked = true;
        } catch {
          close();
        } finally {
          socket.close();
        }
      });
      await context.route(/.*/, async (route) => {
        const request = route.request();
        if (request.isNavigationRequest()) {
          try {
            budget.take("browser");
            budget.deny({ method: request.method(), url: request.url() });
            blocked = true;
            await route.abort("blockedbyclient");
          } catch {
            close();
          }
          return;
        }
        try {
          const response = await transport(async () => {
            const form = { url: request.url(), method: request.method(), headers: {}, body: null };
            if (form.url !== BROWSER_BOOTSTRAP || form.method !== "GET") return form;
            // Reserve before asynchronous metadata retrieval. Forbidden bodies
            // are never requested from the child; negotiation headers are dropped.
            const headers = await request.allHeaders();
            form.headers = Object.fromEntries(
              Object.entries(headers).filter(([name]) =>
                ["authorization", "cookie", "referer", "referrer"].includes(name),
              ),
            );
            form.body = request.postData();
            return form;
          });
          if (response.outcome === "loaded") {
            await route.fulfill({ status: 200, contentType: "application/javascript", body: response.bytes });
          } else {
            blocked ||= response.outcome === "policy-blocked";
            failed ||= response.outcome === "error";
            await route.abort("blockedbyclient");
          }
        } catch {
          close();
        }
      });
      context.on("page", (page) => {
        page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));
        page.on("download", (download) => void download.cancel().catch(() => {}));
      });
      const page = await context.newPage();
      await page.setContent('<!doctype html><meta name="referrer" content="no-referrer"><main id="component"></main>');
      await page.addScriptTag({
        content: `{ const exports = {}; ${sdk}\nwindow.__captureInitialize = exports.loadConnectAndInitialize; }`,
      });
      const remaining = Math.max(1, deadline - Date.now());
      page.setDefaultTimeout(remaining);
      result.attempted = true;
      const timer = setTimeout(close, remaining);
      try {
        // This is the Connect loader's real initialize/create/mount integration,
        // not the application's loader-start visibility flag as a readiness test.
        await page.evaluate(
          async ({ component, publishableKey, clientSecret }) => {
            const state = {
              callbackInvocations: 0,
              loaderStarted: false,
              created: false,
              mounted: false,
              error: false,
            };
            window.__captureState = state;
            const connect = window.__captureInitialize({
              publishableKey,
              fetchClientSecret: async () => {
                state.callbackInvocations++;
                if (state.callbackInvocations !== 1) throw new Error("session-consumed");
                return clientSecret;
              },
            });
            const element = connect.create(component);
            state.created = true;
            element.setOnLoaderStart(() => {
              state.loaderStarted = true;
            });
            element.setOnLoadError(() => {
              state.error = true;
            });
            document.getElementById("component").appendChild(element);
            state.mounted = true;
          },
          { component, publishableKey, clientSecret },
        );
        do {
          const state = await page.evaluate(() => {
            const state = window.__captureState;
            return {
              callbackInvocations: Number.isSafeInteger(state.callbackInvocations)
                ? Math.max(0, Math.min(2, state.callbackInvocations))
                : 0,
              loaderStarted: state.loaderStarted === true,
              created: state.created === true,
              mounted: state.mounted === true,
              error: state.error === true,
            };
          });
          result.callbackInvocations = state.callbackInvocations;
          result.loaderStarted = state.loaderStarted;
          result.created = state.created;
          result.mounted = state.mounted;
          failed ||= state.error;
          await page.waitForTimeout(Math.max(0, Math.min(20, deadline - Date.now() - 10)));
        } while (Date.now() + 10 < deadline);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      signal?.removeEventListener("abort", close);
    }
  } catch {
    failed = true;
  } finally {
    session.abort();
    await context?.close().catch(() => {});
    result.finishedAt = new Date().toISOString();
    result.elapsedMilliseconds = Math.max(0, Math.floor(performance.now() - start));
    result.outcome = Date.now() >= deadline ? "deadline" : failed ? "error" : blocked ? "policy-blocked" : "unknown";
  }
  // SDK 3.4.5 has no sufficient common provider-ready predicate for these three
  // integrations. No actual provider-rendered readiness is inferred from creation,
  // mounting, loader callbacks, an empty denial list, or private page content.
  return result;
}
