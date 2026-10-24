import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { errors } from "@playwright/test";
import { ADMISSION, TRANSITION } from "./browser-boundary/protocol.mjs";

const { execute, launch, acquire, state } = vi.hoisted(() => ({
  execute: vi.fn(),
  launch: vi.fn(),
  acquire: vi.fn(),
  state: { unsafe: null },
}));
vi.mock("../lib/heavy-slot.mjs", () => ({ acquireHeavySlot: acquire }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: execute }),
}));
vi.mock("@playwright/test", () => ({
  chromium: { launch },
  errors: { TimeoutError: class TimeoutError extends Error {} },
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original();
  return {
    ...actual,
    lstat: async (path) => ({
      uid: state.unsafe === path ? 1001 : 0,
      mode: path.endsWith("/launcher") ? 0o100750 : 0o40755,
      isFile: () => path.endsWith("/launcher"),
      isDirectory: () => !path.endsWith("/launcher"),
    }),
    realpath: async (path) => path,
    readFile: (path, ...args) =>
      path === "/proc/sys/kernel/apparmor_restrict_unprivileged_userns" ? "1\n" : actual.readFile(path, ...args),
  };
});
import {
  assertBrowserAdmission,
  BROWSER_LAUNCHER,
  confinedBrowserLaunchOptions,
  openConfinedBrowser,
} from "./test-window-browser.mjs";
import { mediationDiagnostic } from "./browser-boundary/protocol.mjs";

beforeEach(() => {
  const original = process;
  vi.stubGlobal(
    "process",
    new Proxy(original, {
      get(target, key) {
        if (key === "platform") return "linux";
        if (key === "getuid") return () => 1001;
        return Reflect.get(target, key);
      },
    }),
  );
  state.unsafe = null;
  execute.mockResolvedValue({ stdout: Buffer.from(TRANSITION + ADMISSION), stderr: Buffer.alloc(0) });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("operator admission refuses before any fixture, credential, child, or slot", async () => {
  await expect(assertBrowserAdmission({ operator: true })).rejects.toThrow("operator-installation-unavailable");
  expect(execute).not.toHaveBeenCalled();
  expect(acquire).not.toHaveBeenCalled();
});

it("each direct probe acquires exact-owner heavy admission before native execution", async () => {
  await assertBrowserAdmission();
  await assertBrowserAdmission();
  expect(acquire).toHaveBeenCalledTimes(2);
  expect(acquire).toHaveBeenCalledWith("playwright");
  expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]);
  expect(execute).toHaveBeenCalledWith(BROWSER_LAUNCHER, ["probe", expect.stringMatching(/^[a-f0-9]{64}$/)], {
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    timeout: 5000,
    maxBuffer: 4096,
    encoding: "buffer",
  });
});

it("exit 73 admission refusal is not executed or consumed as native proof", async () => {
  acquire.mockImplementation(() => {
    throw new Error("NOT EXECUTED: 73");
  });
  await expect(assertBrowserAdmission()).rejects.toThrow("NOT EXECUTED: 73");
  expect(execute).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});

it.each(["/", "/usr", "/usr/local", "/usr/local/lib", "/usr/local/lib/chase-sets-provider-window", BROWSER_LAUNCHER])(
  "mutable path refuses before execution: %s",
  async (path) => {
    state.unsafe = path;
    await expect(openConfinedBrowser()).rejects.toThrow("installed-boundary");
    expect(execute).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  },
);

it("browser has no fallback, inherited environment, persistent context or optional sandbox", async () => {
  const close = vi.fn().mockResolvedValue(undefined);
  const newContext = vi.fn();
  launch.mockResolvedValue({ close, newContext });
  const browser = await openConfinedBrowser();
  browser.newContext({ serviceWorkers: "allow" });
  await Promise.all([browser.close(), browser.close()]);
  expect(close).toHaveBeenCalledTimes(1);
  expect(newContext).toHaveBeenCalledWith({
    serviceWorkers: "block",
    acceptDownloads: false,
    offline: true,
    permissions: [],
  });
  expect(launch).toHaveBeenCalledWith({
    executablePath: BROWSER_LAUNCHER,
    ignoreDefaultArgs: true,
    args: ["browser", expect.stringMatching(/^[a-f0-9]{64}$/)],
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    chromiumSandbox: true,
    timeout: 5000,
  });
});

it.each([
  [
    "spawn",
    new Error("browserType.launch: Failed to launch: SYNTHETIC_PRIVATE_MARKER"),
    { class: "spawn-failed", window: "partial", exitCode: null, exitSignal: null, refusal: null },
  ],
  [
    "timeout",
    new errors.TimeoutError("SYNTHETIC_PRIVATE_MARKER"),
    { class: "timeout", window: "partial", exitCode: null, exitSignal: null, refusal: null },
  ],
  [
    "exit-before-ready",
    Object.assign(
      new Error(
        [
          "<launched> pid=42",
          "[pid=42][err] provider-boundary-refused:source-identity",
          "[pid=42] <process did exit: exitCode=78, signal=null>",
        ].join("\n"),
      ),
      { code: 78 },
    ),
    { class: "exited", window: "from-launch", exitCode: 78, exitSignal: null, refusal: "source-identity" },
  ],
])("AC4 openConfinedBrowser classifies the real mocked %s rejection", async (_name, error, expected) => {
  launch.mockRejectedValue(error);
  let failure;
  try {
    await openConfinedBrowser();
  } catch (caught) {
    failure = caught;
  }
  expect(failure).toBeInstanceOf(Error);
  {
    expect(mediationDiagnostic(failure).launch).toMatchObject(expected);
    expect(failure.message).not.toContain("SYNTHETIC_PRIVATE_MARKER");
  }
  expect(launch).toHaveBeenCalledWith({
    ...confinedBrowserLaunchOptions("0".repeat(64)),
    args: ["browser", expect.any(String)],
  });
});

it("AC4 shares exactly one launch-options function with the producer", () => {
  expect(confinedBrowserLaunchOptions("a".repeat(64))).toEqual({
    executablePath: BROWSER_LAUNCHER,
    ignoreDefaultArgs: true,
    args: ["browser", "a".repeat(64)],
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    chromiumSandbox: true,
    timeout: 5000,
  });
});

it("CP-T without CP-A cannot release Chromium", async () => {
  execute.mockResolvedValue({ stdout: Buffer.from(TRANSITION), stderr: Buffer.alloc(0) });
  await expect(openConfinedBrowser()).rejects.toThrow("installed-boundary");
  expect(launch).not.toHaveBeenCalled();
});
