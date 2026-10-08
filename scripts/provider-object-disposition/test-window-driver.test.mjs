import { afterEach, expect, test, vi } from "vitest";
import { createTestWindowDriver } from "./test-window-driver.mjs";
import { DISPOSITION_RECEIPT_POLICY } from "./disposition-receipt-policy.mjs";

afterEach(() => vi.useRealTimers());
const admission = () => ({ expiresAt: new Date(Date.now() + 1000).toISOString() });
function fixture() {
  const browser = { close: vi.fn(async () => {}) };
  const original = vi.fn(async () => "inert");
  const driver = {
    journal: { readWindow: async () => [] },
    scenarios: [{ mapper: "customer", original }],
    dispose: vi.fn(async () => "disposed"),
  };
  const open = vi.fn(async () => driver);
  return { browser, original, driver, open };
}
test("expiry closes once, refuses subsequent scenario calls and retains disposition policy", async () => {
  vi.useFakeTimers();
  const source = fixture();
  const driver = await createTestWindowDriver(admission(), source);
  expect(await driver.scenarios[0].original()).toBe("inert");
  await vi.advanceTimersByTimeAsync(1000);
  await expect(driver.scenarios[0].original()).rejects.toThrow("authority-unavailable");
  expect(source.original).toHaveBeenCalledTimes(1);
  expect(await driver.dispose()).toBe("disposed");
  expect(await driver.dispose()).toBe("disposed");
  expect(source.driver.dispose).toHaveBeenCalledExactlyOnceWith(DISPOSITION_RECEIPT_POLICY);
  expect(source.browser.close).toHaveBeenCalledTimes(1);
});
test("cancellation during opening disposes the late driver and closes once", async () => {
  const source = fixture();
  const authority = new AbortController();
  source.open.mockImplementation(async () => {
    authority.abort();
    return source.driver;
  });
  await expect(createTestWindowDriver(admission(), { ...source, authoritySignal: authority.signal })).rejects.toThrow(
    "authority-unavailable",
  );
  expect(source.driver.dispose).toHaveBeenCalledExactlyOnceWith(DISPOSITION_RECEIPT_POLICY);
  expect(source.browser.close).toHaveBeenCalledTimes(1);
});
test("already cancelled and invalid authority never construct the private driver", async () => {
  for (const expiresAt of ["2000-01-01T00:00:00Z", "2099-01-01T00:00:00Z", "2026-01-01", "private"]) {
    const source = fixture();
    await expect(createTestWindowDriver({ expiresAt }, source)).rejects.toThrow("authority-unavailable");
    expect(source.open).not.toHaveBeenCalled();
  }
  const source = fixture();
  await expect(
    createTestWindowDriver(admission(), { ...source, authoritySignal: AbortSignal.abort() }),
  ).rejects.toThrow("authority-unavailable");
  expect(source.open).not.toHaveBeenCalled();
});
test("disposal preserves the first failure over close failure, including repeated disposal", async () => {
  const source = fixture();
  const first = new Error("synthetic-disposition-failure");
  source.driver.dispose.mockRejectedValue(first);
  source.browser.close.mockRejectedValue(new Error("synthetic-close-failure"));
  const driver = await createTestWindowDriver(admission(), source);
  await expect(driver.dispose()).rejects.toBe(first);
  await expect(driver.dispose()).rejects.toBe(first);
  expect(source.driver.dispose).toHaveBeenCalledTimes(1);
  expect(source.browser.close).toHaveBeenCalledTimes(1);
});
