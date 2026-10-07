import { captureEvidenceWindow } from "./capture-evidence-window.mjs";
import { assertBrowserAdmission, openConfinedBrowser } from "./test-window-browser.mjs";
import { assertReviewedWorktree, parseLaunchArguments } from "./test-window-admission.mjs";
import { createTestWindowDriver } from "./test-window-driver.mjs";

const refused = (claimed) => ({
  version: "provider-lifecycle-capture/v1",
  classification: claimed ? "invalid" : "refused",
  code: claimed ? "cleanup-obligation-retained" : "authority-unavailable",
  replayQualified: false,
});

// The capture owner supplies private admission, claim, reader and provider closures.
// Omission is non-authority, never a default provider transport or fixture source.
export async function runTestWindow(args = process.argv.slice(2), launch) {
  let request;
  let browser;
  let driver;
  let claimed = false;
  let result;
  let timer;
  let closing;
  const close = () => (browser ? (closing ??= Promise.resolve().then(() => browser.close())) : Promise.resolve());
  const authority = new AbortController();
  const cancel = () => {
    authority.abort();
    void close().catch(() => {});
  };
  try {
    request = parseLaunchArguments(args);
    await assertBrowserAdmission({ operator: true });
    if (
      !launch ||
      ["admit", "claim", "readFixtures", "readCredential", "open"].some((key) => typeof launch[key] !== "function")
    )
      throw new Error("authority-unavailable");
    assertReviewedWorktree(request.candidateHead);
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    result = await captureEvidenceWindow({
      admit: async () => {
        const admission = await launch.admit(request);
        if (admission?.reviewedHead !== request.candidateHead || admission?.executedHead !== request.candidateHead)
          throw new Error("authority-unavailable");
        return admission;
      },
      open: async (admission) => {
        await assertBrowserAdmission({ operator: true });
        assertReviewedWorktree(request.candidateHead);
        const remaining = Date.parse(admission.expiresAt) - Date.now();
        if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 3600000)
          throw new Error("authority-unavailable");
        timer = setTimeout(cancel, remaining);
        await launch.claim(request, admission);
        claimed = true;
        browser = await openConfinedBrowser();
        authority.signal.throwIfAborted();
        const fixtures = await launch.readFixtures({ signal: authority.signal });
        authority.signal.throwIfAborted();
        const credential = await launch.readCredential({ signal: authority.signal });
        authority.signal.throwIfAborted();
        driver = await createTestWindowDriver(admission, {
          browser: { newContext: (...args) => browser.newContext(...args), close },
          authoritySignal: authority.signal,
          open: ({ signal }) => launch.open({ admission, fixtures, credential, browser, signal }),
        });
        return driver;
      },
    });
    if (claimed && result.classification === "refused") result = refused(true);
  } catch {
    result = refused(claimed);
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    authority.abort();
    try {
      await driver?.dispose();
    } catch {
      result = refused(claimed);
    }
    try {
      await close();
    } catch {
      result = refused(claimed);
    }
  }
  return { ...result, ...(claimed ? { manifestDigest: request.manifestDigest } : {}) };
}
