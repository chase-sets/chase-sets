import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { namespaceProbe, launch, restriction } = vi.hoisted(() => ({
  namespaceProbe: vi.fn(),
  launch: vi.fn(),
  restriction: { value: "1\n" },
}));
vi.mock("node:child_process", () => ({ execFile: namespaceProbe }));
vi.mock("@playwright/test", () => ({
  chromium: { launch, executablePath: () => "/synthetic/chromium" },
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original();
  return {
    ...actual,
    readFile: (path, ...args) =>
      path === "/proc/sys/kernel/apparmor_restrict_unprivileged_userns"
        ? Promise.resolve(restriction.value)
        : actual.readFile(path, ...args),
  };
});
import { openConfinedBrowser } from "./test-window-browser.mjs";

beforeEach(() => {
  const originalProcess = process;
  vi.stubGlobal(
    "process",
    new Proxy(originalProcess, {
      get(target, key) {
        if (key === "platform") return "linux";
        if (key === "getuid") return () => 1001;
        return Reflect.get(target, key);
      },
    }),
  );
  namespaceProbe.mockImplementation((_path, _args, _options, callback) => callback(null, "", ""));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("AC-02 entrypoint / browser admission: namespace errno is observable before Chromium, without child markers", async () => {
  const marker = "SYNTHETIC_6733_PRIVATE_CHILD_FAILURE";
  namespaceProbe.mockImplementation((_path, _args, _options, callback) =>
    callback(
      Object.assign(new Error(marker), {
        stderr: `unshare: unshare failed: Operation not permitted\n${marker}`,
      }),
    ),
  );
  const error = await openConfinedBrowser().catch((error) => error);
  expect(error.message).toContain('"stage":"user-network-namespace"');
  expect(error.message).toContain('"errorClass":"Error"');
  expect(error.message).toContain('"message":"unshare: unshare failed: Operation not permitted"');
  expect(error.message).toContain('"errno":"EPERM"');
  expect(error.message).toContain('"userNamespaceRestriction":1');
  expect(error.message).not.toContain(marker);
  expect(error.cause).toBeUndefined();
  expect(launch).not.toHaveBeenCalled();
  expect(namespaceProbe).toHaveBeenCalledWith(
    "/usr/bin/unshare",
    ["--user", "--map-current-user", "--net", "--", "/usr/bin/true"],
    expect.objectContaining({ env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } }),
    expect.any(Function),
  );
});

it("AC-02 entrypoint / browser admission: missing unshare and sandbox failure remain distinct, with no fallback", async () => {
  namespaceProbe.mockImplementationOnce((_path, _args, _options, callback) =>
    callback(Object.assign(new Error("SYNTHETIC_6733_PRIVATE_PATH"), { code: "ENOENT" })),
  );
  await expect(openConfinedBrowser()).rejects.toThrow('"message":"executable-not-found","errno":"ENOENT"');
  expect(launch).not.toHaveBeenCalled();
  launch.mockRejectedValue(new Error("browserType.launch: No usable sandbox! SYNTHETIC_6733_PRIVATE_PATH"));
  const error = await openConfinedBrowser().catch((error) => error);
  expect(error.message).toContain('"stage":"sandboxed-chromium"');
  expect(error.message).toContain('"message":"No usable sandbox!"');
  expect(error.message).not.toContain("SYNTHETIC_6733_PRIVATE_PATH");
  expect(launch).toHaveBeenCalledTimes(1);
  const options = launch.mock.calls[0][0];
  expect(options.chromiumSandbox).toBe(true);
  expect(options.executablePath).toBe("/usr/bin/unshare");
  expect(options.args.slice(0, 4)).toEqual(["--user", "--map-current-user", "--net", "--"]);
  expect(options.args).not.toContain("--no-sandbox");
});

it("AC-06 markers / browser admission: unknown launch output is not reflected or attached as a cause", async () => {
  launch.mockRejectedValue(new Error("SYNTHETIC_6733_PRIVATE_CHILD_FAILURE"));
  const error = await openConfinedBrowser().catch((error) => error);
  expect(error.message).toContain('"message":"unclassified-launch-failure"');
  expect(error.message).not.toContain("SYNTHETIC_6733_PRIVATE_CHILD_FAILURE");
  expect(error.cause).toBeUndefined();
});
