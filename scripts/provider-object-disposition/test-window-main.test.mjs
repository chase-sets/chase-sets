import { afterEach, beforeEach, expect, test, vi } from "vitest";
const boundary = vi.hoisted(() => ({ assert: vi.fn(), open: vi.fn(), reviewed: vi.fn() }));
vi.mock("./test-window-browser.mjs", () => ({
  assertBrowserAdmission: boundary.assert,
  openConfinedBrowser: boundary.open,
}));
vi.mock("./test-window-admission.mjs", async (original) => ({
  ...(await original()),
  assertReviewedWorktree: boundary.reviewed,
}));
import { runTestWindow } from "./test-window-main.mjs";
import { SCENARIO_FIXTURES } from "./validate-provider-object-disposition.mjs";
import { resolve } from "node:path";

const args = [
  "--candidate-head",
  "a".repeat(40),
  "--manifest-path",
  resolve("synthetic-manifest.json"),
  "--manifest-sha256",
  "d".repeat(64),
  "--authorize-one-test-window",
];
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());
function fixture() {
  const order = [];
  const browser = {
    newContext: vi.fn(),
    close: vi.fn(async () => {
      order.push("close");
    }),
  };
  boundary.assert.mockImplementation(async () => {
    order.push("boundary");
  });
  boundary.reviewed.mockImplementation(() => {
    order.push("reviewed");
  });
  boundary.open.mockImplementation(async () => {
    order.push("browser");
    return browser;
  });
  const driver = {
    journal: { readWindow: async () => [] },
    scenarios: [
      "customer",
      "setup-embedded",
      "payment-saved",
      "connect-setup",
      "connect-manage",
      "connect-notification",
    ].map((mapper) => ({
      mapper,
      original: async () => {
        throw new Error("SYNTHETIC_PRIVATE_MARKER");
      },
    })),
    dispose: vi.fn(async () => structuredClone(SCENARIO_FIXTURES.cleanupFailureOverBudget)),
  };
  const admission = {
    deploymentEnvironment: "test",
    providerMode: "test",
    reviewedHead: args[1],
    executedHead: args[1],
    journalHead: "b".repeat(40),
    deployedHead: "c".repeat(40),
    expiresAt: new Date(Date.now() + 1000).toISOString(),
    apiVersion: "2026-01-28.clover",
    configDigest: "d".repeat(64),
    maxHttpAttempts: 32,
    maxObjects: 6,
  };
  const launch = {
    admit: vi.fn(async () => {
      order.push("admit");
      return admission;
    }),
    claim: vi.fn(async () => {
      order.push("claim");
    }),
    readFixtures: vi.fn(async () => {
      order.push("fixtures");
      return "SYNTHETIC_PRIVATE_MARKER";
    }),
    readCredential: vi.fn(async () => {
      order.push("credential");
      return "SYNTHETIC_PRIVATE_MARKER";
    }),
    open: vi.fn(async () => {
      order.push("open");
      return driver;
    }),
  };
  return { order, browser, driver, launch, admission };
}
test("operator refusal precedes all private closures and emits only closed fields", async () => {
  const f = fixture();
  boundary.assert.mockRejectedValue(new Error("SYNTHETIC_PRIVATE_MARKER"));
  const result = await runTestWindow(args, f.launch);
  expect(result).toEqual({
    version: "provider-lifecycle-capture/v1",
    classification: "refused",
    code: "authority-unavailable",
    replayQualified: false,
  });
  for (const method of Object.values(f.launch)) expect(method).not.toHaveBeenCalled();
  expect(boundary.open).not.toHaveBeenCalled();
});
test("missing composition cannot claim authority even with synthetic admission", async () => {
  fixture();
  expect((await runTestWindow(args)).classification).toBe("refused");
  expect(boundary.open).not.toHaveBeenCalled();
});
test("inert capture rechecks before claim, opens boundary before private readers and disposes once", async () => {
  const f = fixture();
  const result = await runTestWindow(args, f.launch);
  expect(f.order).toEqual([
    "boundary",
    "reviewed",
    "admit",
    "boundary",
    "reviewed",
    "claim",
    "browser",
    "fixtures",
    "credential",
    "open",
    "close",
  ]);
  expect(f.driver.dispose).toHaveBeenCalledTimes(1);
  expect(f.browser.close).toHaveBeenCalledTimes(1);
  expect(boundary.assert).toHaveBeenNthCalledWith(1, { operator: true });
  expect(boundary.assert).toHaveBeenNthCalledWith(2, { operator: true });
  expect(result.manifestDigest).toBe(args[5]);
  expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_MARKER");
});
test("repeated admission and head drift refuse before claim and private readers", async () => {
  for (const failure of ["boundary", "head"]) {
    const f = fixture();
    if (failure === "boundary")
      boundary.assert.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("private"));
    else
      boundary.reviewed
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {
          throw new Error("private");
        });
    expect((await runTestWindow(args, f.launch)).classification).toBe("refused");
    expect(f.launch.claim).not.toHaveBeenCalled();
    expect(f.launch.readFixtures).not.toHaveBeenCalled();
  }
});
test("expiry after claim closes boundary, stops readers and retains cleanup obligation", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.launch.readFixtures.mockImplementation(async () => {
    await vi.advanceTimersByTimeAsync(1000);
    return "private";
  });
  const result = await runTestWindow(args, f.launch);
  expect(result.code).toBe("cleanup-obligation-retained");
  expect(f.launch.readCredential).not.toHaveBeenCalled();
  expect(f.launch.open).not.toHaveBeenCalled();
  expect(f.browser.close).toHaveBeenCalledTimes(1);
});
