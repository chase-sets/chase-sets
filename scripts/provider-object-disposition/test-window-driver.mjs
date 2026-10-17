import { parseStrictRfc3339 } from "./validate-provider-object-disposition.mjs";
import { DISPOSITION_RECEIPT_POLICY } from "./disposition-receipt-policy.mjs";

export async function createTestWindowDriver(admission, { browser, open, authoritySignal }) {
  const deadline = parseStrictRfc3339(admission?.expiresAt);
  if (
    !deadline ||
    !admission.expiresAt.endsWith("Z") ||
    deadline.ms <= Date.now() ||
    deadline.ms - Date.now() > 3600000 ||
    typeof open !== "function" ||
    typeof browser?.close !== "function"
  )
    throw new Error("authority-unavailable");
  const controller = new AbortController();
  let closing;
  const close = () => (closing ??= Promise.resolve().then(() => browser.close()));
  const expire = () => {
    controller.abort();
    void close().catch(() => {});
  };
  const live = () => {
    if (controller.signal.aborted || authoritySignal?.aborted || Date.now() >= deadline.ms) {
      expire();
      throw new Error("authority-unavailable");
    }
  };
  const timer = setTimeout(expire, deadline.ms - Date.now());
  authoritySignal?.addEventListener("abort", expire, { once: true });
  const release = () => {
    clearTimeout(timer);
    authoritySignal?.removeEventListener("abort", expire);
  };
  let driver;
  try {
    live();
    driver = await open({ browser, signal: controller.signal });
    if (
      typeof driver?.dispose !== "function" ||
      !Array.isArray(driver.scenarios) ||
      typeof driver.journal?.readWindow !== "function"
    )
      throw new Error("authority-unavailable");
    live();
  } catch (error) {
    release();
    expire();
    try {
      await driver?.dispose(DISPOSITION_RECEIPT_POLICY);
    } catch {
      /* Preserve the opening failure. */
    }
    try {
      await close();
    } catch {
      /* The caller retains the cleanup obligation. */
    }
    throw error;
  }
  const scenarios = driver.scenarios.map((scenario) => {
    const guarded = { mapper: scenario.mapper };
    for (const method of ["original", "restartAndReplay", "repeatSameSlot", "twoTabs", "initializeIntendedComponent"]) {
      if (typeof scenario[method] === "function")
        guarded[method] = async (...args) => {
          live();
          const result = await scenario[method](...args);
          live();
          return result;
        };
    }
    return guarded;
  });
  let disposal;
  return {
    journal: driver.journal,
    scenarios,
    dispose: (policy = DISPOSITION_RECEIPT_POLICY) =>
      (disposal ??= (async () => {
        let result;
        let primary;
        try {
          result = await driver.dispose(policy);
        } catch (error) {
          primary = error;
        } finally {
          release();
          expire();
          try {
            await close();
          } catch (error) {
            primary ??= error;
          }
        }
        if (primary) throw primary;
        return result;
      })()),
  };
}
