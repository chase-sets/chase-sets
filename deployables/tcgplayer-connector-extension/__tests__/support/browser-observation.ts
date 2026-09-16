import { chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";

declare global {
  var restartProbe: {
    state: {
      pendingFetch: boolean;
      pendingTransaction: boolean;
      transactionCompleted: boolean;
      refusal: string | null;
    };
    prepare(): Promise<void>;
    startTwo(): Promise<void>;
  };
}

export async function launchFixture(extensionRoot: string, userDataDir: string) {
  // The package's trace: "on" owns recording, including persistent-context relaunches.
  return chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [`--load-extension=${extensionRoot}`],
  });
}

export async function fixtureWorker(context: BrowserContext): Promise<Worker> {
  return (
    context.serviceWorkers().find((worker) => worker.url().endsWith("/worker.js")) ??
    context.waitForEvent("serviceworker", {
      predicate: (worker) => worker.url().endsWith("/worker.js"),
      timeout: 10_000,
    })
  );
}

export async function observer(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/observer.html`);
  return page;
}

export async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const records = await new Promise<{ id: string; state: string; at?: string }[]>((resolve, reject) => {
      const request = indexedDB.open("restart-probe", 1);
      request.onupgradeneeded = () => {
        request.transaction!.abort();
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        const transaction = database.transaction("records", "readonly");
        const read = transaction.objectStore("records").getAll();
        read.onsuccess = () => resolve(read.result);
        read.onerror = () => reject(read.error);
        transaction.oncomplete = () => database.close();
      };
    });
    const local = await chrome.storage.local.get(["localCanary", "fires", "scheduledAt"]);
    const session = await chrome.storage.session.get("sessionCanary");
    return {
      records,
      localCanary: local.localCanary ?? null,
      sessionCanary: session.sessionCanary ?? null,
      fires: (local.fires ?? []) as string[],
      scheduledAt: local.scheduledAt as number,
    };
  });
}

export async function observeUntil(predicate: () => boolean | Promise<boolean>, milliseconds: number) {
  const deadline = Date.now() + milliseconds;
  do {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return predicate();
}
