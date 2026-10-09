import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const { execute, admit } = vi.hoisted(() => ({ execute: vi.fn(), admit: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: execute }),
}));
vi.mock("../test-window-browser.mjs", () => ({ assertBrowserAdmission: admit }));
import { installationCycle, withInstallationCycle } from "./installation-cycle.mjs";

afterEach(() => vi.restoreAllMocks());

it("each completed case removes exact names before reinstalling and readmitting", async () => {
  execute
    .mockResolvedValueOnce({
      stdout: Buffer.from("provider-boundary-cleanup-stage:complete\n"),
      stderr: Buffer.alloc(0),
    })
    .mockResolvedValueOnce({
      stdout: Buffer.from("provider-boundary-setup-stage:complete\n"),
      stderr: Buffer.alloc(0),
    });
  vi.spyOn(console, "log").mockImplementation(() => {});
  await installationCycle("SYNTHETIC");
  expect(execute.mock.calls[0][1][0]).toMatch(/ci-cleanup\.sh$/);
  expect(execute.mock.calls[1][1][0]).toMatch(/ci-setup\.sh$/);
  expect(execute.mock.calls[1][1][1]).toBe("reinstall");
  expect(admit).toHaveBeenCalled();
});

it("a cleanup error never replaces the original case error or prints private diagnostics", async () => {
  const primary = new Error("original-case-error");
  primary.recovered = true;
  execute.mockRejectedValueOnce({
    code: 1,
    stdout: Buffer.from("SYNTHETIC_PRIVATE"),
    stderr: Buffer.from("SYNTHETIC_PRIVATE"),
  });
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(
    withInstallationCycle("SYNTHETIC", async () => {
      throw primary;
    }),
  ).rejects.toBe(primary);
  expect(JSON.stringify(output.mock.calls)).not.toContain("SYNTHETIC_PRIVATE");
  expect(primary.recovered).toBe(false);
});

it("verified restoration permits remaining cases without changing the original failure to PASS", async () => {
  const primary = new Error("original-case-error");
  execute
    .mockResolvedValueOnce({
      stdout: Buffer.from("provider-boundary-cleanup-stage:complete\n"),
      stderr: Buffer.alloc(0),
    })
    .mockResolvedValueOnce({
      stdout: Buffer.from("provider-boundary-setup-stage:complete\n"),
      stderr: Buffer.alloc(0),
    });
  vi.spyOn(console, "log").mockImplementation(() => {});
  await expect(
    withInstallationCycle("SYNTHETIC", async () => {
      throw primary;
    }),
  ).rejects.toBe(primary);
  expect(primary.recovered).toBe(true);
});

it("each transition terminal stimulus owns its installation cycle", () => {
  const source = readFileSync(new URL("native-controls.mjs", import.meta.url), "utf8");
  const signals = source.indexOf('for (const signal of ["SIGKILL", "SIGTERM", "deadline"])');
  const cycle = source.indexOf("await runCase(", signals);
  const concurrent = source.indexOf("await withConcurrentBrowser(", signals);
  expect(signals).toBeGreaterThan(0);
  expect(cycle).toBeGreaterThan(signals);
  expect(concurrent).toBeGreaterThan(cycle);
  expect(source.slice(signals, source.indexOf('stage("15-peer-holder")'))).toContain("`${name}-${signal}`");
});

it("a removal census refusal reproduces ready-outer cleanup failure without reinstall or readmission", async () => {
  execute.mockClear();
  admit.mockClear();
  // Synthetic bytes from the two shell emitters, not recovered historical output.
  const stdout = Buffer.from(
    "provider-boundary-cleanup-stage:remove-installation\n" +
      "provider-boundary-installer-stage:source-location\n" +
      "provider-boundary-installer-stage:remove-ownership\n" +
      "provider-boundary-cleanup-installer-status:1\n",
  );
  const stderr = Buffer.from(
    "provider-boundary-installer-refused:remove-ownership-census\n" +
      "provider-boundary-cleanup-refused:remove-installation\n",
  );
  expect([stdout.length, stderr.length]).toEqual([198, 114]);
  execute.mockRejectedValueOnce({ code: 1, stdout, stderr });
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(installationCycle("ready-outer")).rejects.toThrow("per-case-installation-incomplete");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(admit).not.toHaveBeenCalled();
  expect(output).toHaveBeenCalledWith(
    'installed-boundary per-case ready-outer cleanup: FAIL; {"status":1,"signal":null,"stdoutBytes":198,"stderrBytes":114,"redacted":true,"truncated":false}',
  );
});
