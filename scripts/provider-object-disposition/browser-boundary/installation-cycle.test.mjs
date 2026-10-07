import { afterEach, expect, it, vi } from "vitest";
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
