import path from "node:path";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TESTED_DESIGN_SYSTEM_ROOT_EXPORTS,
  RUNTIME_IMPORT_DEADLINE_MS,
  collectDesignSystemRuntimeExports,
  compareDesignSystemExportCoverage,
  formatDesignSystemExportCoverageFailure,
  runDesignSystemExportCoverageCheck,
} from "./check-design-system-export-coverage.mjs";

describe("design-system export coverage guard", () => {
  it("enumerates the complete runtime namespace through the supplied module loader", async () => {
    const rootDir = path.resolve("immutable-fixture");
    const importRuntimeModule = vi.fn().mockResolvedValue({
      default: "ignored",
      Button: {},
      Accordion: {},
    });

    const runtimeExports = await collectDesignSystemRuntimeExports({
      rootDir,
      entrypoint: "src/index.ts",
      importRuntimeModule,
    });

    expect(runtimeExports).toEqual(["Accordion", "Button"]);
    expect(importRuntimeModule).toHaveBeenCalledOnce();
    expect(importRuntimeModule.mock.calls[0][0]).toBe(pathToFileURL(path.join(rootDir, "src/index.ts")).href);
  });

  it("propagates runtime module loader errors instead of accepting partial discovery", async () => {
    const loaderError = new Error("runtime module load failed");

    await expect(
      collectDesignSystemRuntimeExports({
        rootDir: "D:/immutable-fixture",
        entrypoint: "src/index.ts",
        importRuntimeModule: vi.fn().mockRejectedValue(loaderError),
      }),
    ).rejects.toBe(loaderError);
  });

  it("passes when runtime exports match the tested allowlist regardless of order", () => {
    const result = compareDesignSystemExportCoverage({
      runtimeExports: ["Banner", "Button", "Breadcrumbs"],
      testedExports: ["Button", "Breadcrumbs", "Banner"],
    });

    expect(result.passed).toBe(true);
    expect(result.actualExports).toEqual(["Banner", "Breadcrumbs", "Button"]);
    expect(result.untestedExports).toEqual([]);
    expect(result.staleTestedExports).toEqual([]);
  });

  it("reports new runtime exports and stale allowlist entries", () => {
    const result = compareDesignSystemExportCoverage({
      runtimeExports: ["Banner", "Button", "Pagination"],
      testedExports: ["Banner", "Button", "RemovedComponent"],
    });

    expect(result.passed).toBe(false);
    expect(result.untestedExports).toEqual(["Pagination"]);
    expect(result.staleTestedExports).toEqual(["RemovedComponent"]);
    expect(formatDesignSystemExportCoverageFailure(result)).toContain(
      "Add focused behavior or smoke coverage for each export before adding it to the allowlist.",
    );
  });

  it("keeps the checked allowlist stable, sorted, and unique", () => {
    const sorted = [...TESTED_DESIGN_SYSTEM_ROOT_EXPORTS].sort();

    expect(TESTED_DESIGN_SYSTEM_ROOT_EXPORTS).toEqual(sorted);
    expect(new Set(TESTED_DESIGN_SYSTEM_ROOT_EXPORTS).size).toBe(TESTED_DESIGN_SYSTEM_ROOT_EXPORTS.length);
    expect(TESTED_DESIGN_SYSTEM_ROOT_EXPORTS).toContain("Breadcrumbs");
    expect(TESTED_DESIGN_SYSTEM_ROOT_EXPORTS).toContain("Pagination");
    expect(TESTED_DESIGN_SYSTEM_ROOT_EXPORTS).toContain("useMediaQuery");
  });

  it("returns a failing process code with actionable output when coverage drifts", async () => {
    const stderr = vi.fn();

    const exitCode = await runDesignSystemExportCoverageCheck({
      collectRuntimeExports: async () => ["Button", "NewExport"],
      testedExports: ["Button"],
      stdout: vi.fn(),
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("NewExport"));
  });
});

describe("runtime import child lifetime", () => {
  const roots = [];
  const children = [];
  const fixture = (source) => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "design-system-export-"));
    roots.push(rootDir);
    const directory = path.join(rootDir, "packages/design-system/src");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), '{"type":"module"}');
    writeFileSync(path.join(directory, "index.ts"), source);
    return rootDir;
  };
  const trackRealChild = () => {
    const spawn = childProcess.spawn;
    const observation = { closed: false };
    vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
      const child = spawn(...args);
      children.push(child);
      observation.child = child;
      child.once("close", (code, signal) => Object.assign(observation, { closed: true, code, signal }));
      return child;
    });
    return observation;
  };
  const fakeChild = () => {
    const child = new EventEmitter();
    child.pid = 123456;
    child.kill = vi.fn();
    vi.spyOn(childProcess, "spawn").mockReturnValue(child);
    return child;
  };
  const sendResult = (child, keys = ["Button", "default", "Accordion"]) =>
    child.emit("message", { type: "design-system-runtime-exports", keys });
  const close = (child, code = 0, signal = null) => {
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  };

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Test cleanup UNKNOWN for PID ${child.pid}`)), 5000);
          child.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
          child.kill();
        });
      }
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("keeps the fixed deadline and CLI without a duration override", () => {
    expect(RUNTIME_IMPORT_DEADLINE_MS).toBe(60000);
    const source = readFileSync(new URL("./check-design-system-export-coverage.mjs", import.meta.url), "utf8");
    expect(source.match(/60000/g)).toHaveLength(1);
    expect(source).toContain("process.exitCode = await runDesignSystemExportCoverageCheck();");
    expect(source).not.toMatch(/process\.env|process\.exit\(/);
  });

  it("rejects a pending injected loader at 60000ms, not 59999ms", async () => {
    vi.useFakeTimers();
    const rejected = vi.fn();
    const outcome = collectDesignSystemRuntimeExports({ importRuntimeModule: () => new Promise(() => {}) }).catch(
      rejected,
    );
    await vi.advanceTimersByTimeAsync(59999);
    expect(rejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(rejected).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Complete runtime import timed out after 60000ms" }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline on injected success and error with error identity intact", async () => {
    vi.useFakeTimers();
    await collectDesignSystemRuntimeExports({ importRuntimeModule: async () => ({ Button: {} }) });
    expect(vi.getTimerCount()).toBe(0);
    const error = new Error("ordinary loader error");
    await expect(
      collectDesignSystemRuntimeExports({
        importRuntimeModule: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("terminates at the exact bound and waits for close before rejecting", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const rejected = vi.fn();
    const outcome = collectDesignSystemRuntimeExports().catch(rejected);
    await vi.advanceTimersByTimeAsync(59999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(rejected).not.toHaveBeenCalled();
    child.emit("exit", null, "SIGTERM");
    await Promise.resolve();
    expect(rejected).not.toHaveBeenCalled();
    child.emit("close", null, "SIGTERM");
    await outcome;
    expect(rejected).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Complete runtime import timed out after 60000ms" }),
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(child.eventNames()).toEqual([]);
  });

  it.each(["no-close", "kill-throws"])("reports unknown cleanup within bounded grace: %s", async (kind) => {
    vi.useFakeTimers();
    const child = fakeChild();
    if (kind === "kill-throws")
      child.kill.mockImplementation(() => {
        throw new Error("termination refused");
      });
    const rejected = vi.fn();
    const outcome = collectDesignSystemRuntimeExports().catch(rejected);
    await vi.advanceTimersByTimeAsync(60000);
    await vi.advanceTimersByTimeAsync(4999);
    expect(rejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(rejected).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("cleanup UNKNOWN: PID 123456") }),
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(child.eventNames()).toEqual([]);
  });

  it("requires the complete result, zero exit, and close before resolving", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const resolved = vi.fn();
    const outcome = collectDesignSystemRuntimeExports().then(resolved);
    sendResult(child);
    child.emit("exit", 0, null);
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    child.emit("close", 0, null);
    await outcome;
    expect(resolved).toHaveBeenCalledWith(["Accordion", "Button"]);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(child.eventNames()).toEqual([]);
  });

  it.each([
    "malformed",
    "mixed-envelope",
    "bad-error",
    "missing",
    "duplicate",
    "nonzero",
    "signal",
    "no-exit",
    "spawn-error",
  ])("rejects %s child outcomes", async (kind) => {
    vi.useFakeTimers();
    const child = fakeChild();
    const outcome = collectDesignSystemRuntimeExports();
    const assertion = expect(outcome).rejects.toThrow();
    if (kind === "malformed") child.emit("message", { type: "design-system-runtime-exports", keys: [1] });
    else if (kind === "mixed-envelope")
      child.emit("message", { type: "design-system-runtime-exports", keys: ["Button"], error: false });
    else if (kind === "bad-error")
      child.emit("message", { type: "design-system-runtime-exports", error: { message: "incomplete" } });
    else if (kind !== "missing" && kind !== "spawn-error") sendResult(child);
    if (kind === "duplicate") sendResult(child);
    if (kind === "spawn-error") child.emit("error", new Error("spawn failed"));
    if (kind === "no-exit") child.emit("close", 0, null);
    else close(child, kind === "nonzero" ? 73 : kind === "signal" ? null : 0, kind === "signal" ? "SIGTERM" : null);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline if spawning throws synchronously", async () => {
    vi.useFakeTimers();
    const error = new Error("spawn refused");
    vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      throw error;
    });
    await expect(collectDesignSystemRuntimeExports()).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not accept a valid result when close misses the deadline", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const outcome = collectDesignSystemRuntimeExports();
    const assertion = expect(outcome).rejects.toThrow("60000ms");
    sendResult(child);
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(60000);
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit("close", 0, null);
    await assertion;
  });

  it("round-trips the real complete TypeScript namespace and naturally closes", async () => {
    const rootDir = fixture('export const Button: string = "button"; export const Accordion = {}; export default {};');
    const observation = trackRealChild();
    const actual = await collectDesignSystemRuntimeExports({ rootDir });
    const supplied = await collectDesignSystemRuntimeExports({
      rootDir,
      importRuntimeModule: async () => ({ Button: "button", Accordion: {}, default: {} }),
    });
    expect(actual).toEqual(supplied);
    expect(observation).toMatchObject({ closed: true, code: 0, signal: null });
    expect(() => process.kill(observation.child.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    expect(childProcess.spawn).toHaveBeenCalledOnce();
    const [command, args, options] = childProcess.spawn.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args).toEqual([
      expect.stringContaining("check-design-system-export-coverage.mjs"),
      "--design-system-export-import-child",
      pathToFileURL(path.join(rootDir, "packages/design-system/src/index.ts")).href,
    ]);
    expect(options).toEqual({ cwd: rootDir, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  });

  it("serializes real evaluation errors and rejects after nonzero exit and close", async () => {
    const rootDir = fixture('export const Partial = {}; throw new TypeError("fixture evaluation failed");');
    const observation = trackRealChild();
    await expect(collectDesignSystemRuntimeExports({ rootDir })).rejects.toMatchObject({
      name: "TypeError",
      message: "fixture evaluation failed",
      childExitCode: 1,
      cause: { name: "TypeError", message: "fixture evaluation failed", stack: expect.stringContaining("index.ts") },
    });
    expect(observation).toMatchObject({ closed: true, code: 1 });
    expect(() => process.kill(observation.child.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });

  it("reaps a real pending module at the full deadline before rejection", async () => {
    const rootDir = fixture("export const Partial = {}; await new Promise(resolve => setTimeout(resolve, 120000));");
    const observation = trackRealChild();
    const started = performance.now();
    await expect(collectDesignSystemRuntimeExports({ rootDir })).rejects.toThrow(
      "Complete runtime import timed out after 60000ms",
    );
    expect(performance.now() - started).toBeGreaterThanOrEqual(60000);
    expect(observation.closed).toBe(true);
    expect(observation.code === 0 && observation.signal === null).toBe(false);
    expect(() => process.kill(observation.child.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });
});
