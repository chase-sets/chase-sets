import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyDevTargetEnvOverrides, buildPlatformChildEnvironment } from "./dev-system-config.mjs";
import { completeDevSystemStartupFailure, createDevSystemLauncher } from "./dev-system-launch.mjs";
import { buildPackageManagerInvocation, spawnCommand, terminateProcessTree } from "./lib/process.mjs";

const directories = [];
const realChildren = [];
const workerArgs = ["--filter", "@chase-sets/app-platform-worker", "run", "dev:ci"];
const secretMarker = "synthetic-8882-secret-do-not-log";
const worker = { name: "platform-worker", workspace: "@chase-sets/app-platform-worker", env: {} };

afterEach(() => {
  for (const child of realChildren.splice(0)) terminateProcessTree(child, "SIGKILL");
  for (const directory of directories.splice(0)) {
    expect(path.dirname(directory)).toBe(tmpdir());
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function fixtureDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "chase-sets-8882-"));
  directories.push(directory);
  return directory;
}

function fakeChild({ exited = false } = {}) {
  return Object.assign(new EventEmitter(), {
    pid: 424242,
    exitCode: exited ? 0 : null,
    signalCode: null,
    kill: vi.fn(() => true),
  });
}

function spawnFailure() {
  const error = new Error(`spawn EINVAL ${secretMarker}`);
  error.code = "EINVAL";
  error.syscall = "spawn";
  return error;
}

function startWithOuterCatch(launcher, definition, options, errors, onFailure) {
  try {
    return launcher.launch(definition, options);
  } catch (error) {
    // Main's outer catch is the negative control, not a missing-module failure.
    errors.push(error.message);
    onFailure();
    return null;
  }
}

function messageFrom(child) {
  return new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`fixture exited before ready: ${code}`)));
  });
}

function closedWithin(child, milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), milliseconds);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

describe("dev system launcher", () => {
  it("resolves the Windows CI worker through the canonical package manager", () => {
    const directory = fixtureDirectory();
    const cli = path.join(directory, "pnpm.cjs");
    writeFileSync(cli, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    const resolveInvocation = vi.fn((args) =>
      buildPackageManagerInvocation(args, {
        platform: "win32",
        env: { PNPM_HOME: directory },
        exists: (candidate) => candidate === cli,
      }),
    );
    const spawn = vi.fn(() => fakeChild());
    const launcher = createDevSystemLauncher({ children: [], resolveInvocation, spawn });
    const [definition] = applyDevTargetEnvOverrides("browser-e2e", [worker], {
      ci: true,
      platform: "win32",
      environment: {},
    });
    const options = { cwd: directory, env: {}, inheritEnv: false, prefix: definition.name };
    launcher.launch(definition, options);
    expect(resolveInvocation).toHaveBeenCalledExactlyOnceWith(workerArgs);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(process.execPath, [cli, ...workerArgs], options);
    expect(options).not.toHaveProperty("shell");
  });

  it.runIf(process.platform === "win32")(
    "launches the resolved Windows CI worker at the real spawn boundary",
    async () => {
      const directory = fixtureDirectory();
      const cli = path.join(directory, "pnpm.cjs");
      writeFileSync(cli, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
      const children = [];
      const launcher = createDevSystemLauncher({
        children,
        resolveInvocation: (args) =>
          buildPackageManagerInvocation(args, { platform: "win32", env: { PNPM_HOME: directory } }),
      });
      const [definition] = applyDevTargetEnvOverrides("browser-e2e", [worker], {
        ci: true,
        platform: "win32",
        environment: {},
      });
      const child = launcher.launch(definition, { cwd: directory, env: {}, inheritEnv: false });
      expect(child).not.toBeNull();
      realChildren.push(child);
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      expect(await closedWithin(child, 5_000)).toBe(0);
      expect(JSON.parse(output)).toEqual(workerArgs);
    },
  );

  it.each(["linux", "darwin", "freebsd"])("preserves the exact non-Windows CI worker invocation on %s", (platform) => {
    const [definition] = applyDevTargetEnvOverrides("browser-e2e", [worker], { ci: true, platform, environment: {} });
    const resolveInvocation = vi.fn();
    const spawn = vi.fn(() => fakeChild());
    createDevSystemLauncher({ children: [], resolveInvocation, spawn }).launch(definition, { inheritEnv: false });
    expect(resolveInvocation).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledExactlyOnceWith("pnpm", workerArgs, { inheritEnv: false });
  });

  it.each(["win32", "linux"])("preserves watch, other targets, explicit commands and environment on %s", (platform) => {
    const definition = { ...worker, env: { PORT: "6183" } };
    const [watch] = applyDevTargetEnvOverrides("browser-e2e", [definition], { ci: false, platform, environment: {} });
    expect(watch).not.toHaveProperty("script");
    expect(watch).not.toHaveProperty("command");
    expect(applyDevTargetEnvOverrides("all", [definition], { ci: true, platform })).toEqual([definition]);
    const resolver = vi.fn(() => ({ command: "synthetic-pnpm", args: [] }));
    const spawn = vi.fn(() => fakeChild());
    const logError = vi.fn();
    const launcher = createDevSystemLauncher({ children: [], resolveInvocation: resolver, spawn, logError });
    const env = buildPlatformChildEnvironment(
      {
        PATH: "synthetic-path",
        PROVIDER_SECRET: secretMarker,
        SEED_PACKS_SPACES_SECRET_KEY: secretMarker,
        PGHOSTADDR: "203.0.113.42",
      },
      watch.env,
    );
    expect(env).toMatchObject({ PATH: "synthetic-path", PROVIDER_SECRET: secretMarker, PORT: "6183" });
    expect(env).not.toHaveProperty("SEED_PACKS_SPACES_SECRET_KEY");
    expect(env).not.toHaveProperty("PGHOSTADDR");
    launcher.launch(watch, { env, inheritEnv: false, prefix: watch.name });
    expect(resolver).toHaveBeenCalledExactlyOnceWith(["--filter", worker.workspace, "run", "dev"]);
    const direct = { name: "direct", command: "node", args: ["inert.cjs"] };
    launcher.launch(direct, { env, prefix: "direct" });
    expect(spawn).toHaveBeenLastCalledWith("node", ["inert.cjs"], { env, prefix: "direct" });
    expect(logError).not.toHaveBeenCalled();
  });

  it.each(["owned", "no-owned-child", "already-exited"])(
    "handles synchronous throws and repeated cleanup: %s",
    (state) => {
      const owned = fakeChild({ exited: state === "already-exited" });
      const children = state === "no-owned-child" ? [] : [owned];
      const errors = [];
      let exitCode = 0;
      const onFailure = vi.fn(() => {
        exitCode = 1;
      });
      const spawn = vi.fn(() => {
        throw spawnFailure();
      });
      const launcher = createDevSystemLauncher({
        children,
        onFailure,
        spawn,
        logError: (line) => errors.push(line),
        terminate: (child) => terminateProcessTree(child, "SIGTERM", { platform: "linux" }),
      });
      const definition = { name: "platform-worker", command: process.execPath, args: ["inert.cjs", secretMarker] };
      const options = { cwd: path.resolve("."), env: { PROVIDER_SECRET: secretMarker }, inheritEnv: false };
      expect(startWithOuterCatch(launcher, definition, options, errors, onFailure)).toBeNull();
      expect(exitCode).toBe(1);
      expect(owned.kill).toHaveBeenCalledTimes(state === "owned" ? 1 : 0);
      expect(launcher.launch({ name: "later", command: "node" }, {})).toBeNull();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(onFailure).toHaveBeenCalledTimes(1);
      const diagnostics = errors.join("\n");
      const context = JSON.parse(errors[0].slice(errors[0].indexOf("{")));
      expect(diagnostics).toContain("platform-worker");
      expect(context).toMatchObject({ command: process.execPath, args: ["inert.cjs", "[redacted]"], cwd: options.cwd });
      expect(diagnostics).toContain("EINVAL");
      expect(diagnostics).toContain("spawn");
      expect(diagnostics).toContain("at ");
      expect(diagnostics).not.toContain(secretMarker);
    },
  );

  it.each([false, true])(
    "excludes the entire multiline message before accepting frames (unseparable=%s)",
    (unseparable) => {
      const marker = "synthetic-message-only-multiline-marker";
      const error = new Error(`synthetic failure\n    at ${marker}`);
      error.name = "SyntheticError";
      if (unseparable) error.stack = `untrusted header\n    at ${marker}`;
      const logError = vi.fn();
      createDevSystemLauncher({
        spawn: () => {
          throw error;
        },
        onFailure: vi.fn(),
        logError,
      }).launch({ name: "worker", command: "node" }, { env: {} });
      const diagnostics = logError.mock.calls.flat().join("\n");
      expect(diagnostics).not.toContain(marker);
      expect(diagnostics).not.toContain("synthetic failure");
      expect(diagnostics).toContain(unseparable ? "dev-system-launch.mjs" : "dev-system-launch.test.mjs");
      expect(logError.mock.calls.length).toBeLessThanOrEqual(7);
      for (const [frame] of logError.mock.calls.slice(1)) expect(frame.length).toBeLessThanOrEqual(256);
    },
  );

  it.each([false, true])("completes startup failure with connected=%s", (connected) => {
    const runtime = { connected, exitCode: 0, disconnect: vi.fn(() => expect(runtime.exitCode).toBe(1)) };
    completeDevSystemStartupFailure(runtime);
    expect(runtime.exitCode).toBe(1);
    expect(runtime.disconnect).toHaveBeenCalledTimes(connected ? 1 : 0);
  });

  it.each([false, true])("exits 1 within five seconds with a connected parent (owned=%s)", async (owned) => {
    const directory = fixtureDirectory();
    const fixture = path.join(directory, "ipc-launcher.mjs");
    const launcherUrl = new URL("./dev-system-launch.mjs", import.meta.url).href;
    writeFileSync(
      fixture,
      `
import { completeDevSystemStartupFailure, createDevSystemLauncher } from ${JSON.stringify(launcherUrl)};
let ownedCleaned = false;
const launcher = createDevSystemLauncher({
  children: ${owned ? "[{synthetic:true}]" : "[]"},
  terminate() { ownedCleaned = true; },
  spawn() { throw Object.assign(new Error("inert launch failure"), {code:"EINVAL",syscall:"spawn"}); },
  logError() {},
  onFailure: () => {
    process.stdout.write(JSON.stringify({ownedCleaned,connected:process.connected}) + "\\n");
    completeDevSystemStartupFailure();
  },
});
process.once("message", () => launcher.launch({name:"worker",command:"synthetic-node"}, {env:{}}));
process.send({ready:true});
`,
    );
    const child = spawnCommand(process.execPath, [fixture], {
      env: {},
      inheritEnv: false,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    realChildren.push(child);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    await messageFrom(child);
    expect(child.connected).toBe(true);
    const start = performance.now();
    const closed = closedWithin(child, 5_000);
    child.send({ fail: true });
    expect(await closed).toBe(1);
    expect(performance.now() - start).toBeLessThan(5_000);
    expect(JSON.parse(output)).toEqual({ ownedCleaned: owned, connected: true });
  });

  it("continues owned cleanup and reports nonzero without leaking a cleanup exception", () => {
    const children = [fakeChild(), fakeChild()];
    const terminate = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error(secretMarker);
      })
      .mockReturnValue(true);
    const logError = vi.fn();
    const onFailure = vi.fn();
    const launcher = createDevSystemLauncher({
      children,
      terminate,
      logError,
      onFailure,
      spawn: () => {
        throw spawnFailure();
      },
    });
    expect(launcher.launch({ name: "worker", command: "node" }, { env: { SECRET: secretMarker } })).toBeNull();
    expect(terminate.mock.calls).toEqual(children.map((child) => [child, "SIGTERM"]));
    expect(onFailure).toHaveBeenCalledOnce();
    expect(logError.mock.calls.flat().join("\n")).not.toContain(secretMarker);
    expect(logError).toHaveBeenCalledWith("[dev] Failed to stop an owned child after startup failure.");
  });

  it.runIf(process.platform === "win32")(
    "fails fast and cleans up only owned children after a synchronous spawn failure",
    async () => {
      const directory = fixtureDirectory();
      const shim = path.join(directory, "inert.cmd");
      writeFileSync(shim, "@echo off\r\nexit /b 0\r\n");
      const sentinel = spawnCommand(process.execPath, ["-e", "process.send({ready:true}); setInterval(()=>{},1000)"], {
        env: {},
        inheritEnv: false,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      realChildren.push(sentinel);
      await messageFrom(sentinel);
      const fixture = path.join(directory, "launcher.mjs");
      const launcherUrl = new URL("./dev-system-launch.mjs", import.meta.url).href;
      const processUrl = new URL("./lib/process.mjs", import.meta.url).href;
      writeFileSync(
        fixture,
        `
import { completeDevSystemStartupFailure, createDevSystemLauncher } from ${JSON.stringify(launcherUrl)};
import { spawnCommand } from ${JSON.stringify(processUrl)};
const children = [];
const errors = [];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { if(e.code === "ESRCH") return false; throw e; } };
let descendantPid;
let stoppedBeforeExit = false;
const launcher = createDevSystemLauncher({ children, logError: line => errors.push(line), onFailure: () => {
  stoppedBeforeExit = children.every(child => !alive(child.pid)) && !alive(descendantPid);
  completeDevSystemStartupFailure();
} });
const rootCode = 'const {spawn}=require("node:child_process"); const c=spawn(process.execPath,["-e","process.send({ready:true});setInterval(()=>{},1000)"],{env:{},windowsHide:true,stdio:["ignore","ignore","ignore","ipc"]}); c.once("message",()=>process.send({descendantPid:c.pid})); setInterval(()=>{},1000)';
const root = launcher.launch({name:"platform-api",command:process.execPath,args:["-e",rootCode]}, {env:{},inheritEnv:false,stdio:["ignore","ignore","ignore","ipc"]});
children.push(root);
root.once("message", message => { descendantPid=message.descendantPid; process.send({rootPid:root.pid,descendantPid}); });
process.once("message", () => {
  const threwAt = performance.now();
  try { launcher.launch({name:"platform-worker",command:${JSON.stringify(shim)},args:[]}, {cwd:${JSON.stringify(directory)},env:{PROVIDER_SECRET:${JSON.stringify(secretMarker)}},inheritEnv:false}); }
  catch(error) { errors.push(error.message); process.exitCode=1; }
  const later = launcher.launch({name:"later",command:process.execPath,args:["-e","setInterval(()=>{},1000)"]}, {env:{},inheritEnv:false});
  if(later) children.push(later);
  process.stdout.write(JSON.stringify({stoppedBeforeExit,elapsed:performance.now()-threwAt,laterStarted:Boolean(later),errors}) + "\\n");
});
`,
      );
      const fixtureChild = spawnCommand(process.execPath, [fixture], {
        cwd: directory,
        env: {},
        inheritEnv: false,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      realChildren.push(fixtureChild);
      const owned = await messageFrom(fixtureChild);
      expect(isAlive(owned.rootPid)).toBe(true);
      expect(isAlive(owned.descendantPid)).toBe(true);
      let output = "";
      fixtureChild.stdout.on("data", (chunk) => {
        output += chunk;
      });
      const start = performance.now();
      const closed = closedWithin(fixtureChild, 5_000);
      fixtureChild.send({ fail: true });
      const code = await closed;
      const result = JSON.parse(output);
      expect({ code, stoppedBeforeExit: result.stoppedBeforeExit, laterStarted: result.laterStarted }).toEqual({
        code: 1,
        stoppedBeforeExit: true,
        laterStarted: false,
      });
      expect(performance.now() - start).toBeLessThan(5_000);
      expect(result.elapsed).toBeLessThan(5_000);
      expect(isAlive(owned.rootPid)).toBe(false);
      expect(isAlive(owned.descendantPid)).toBe(false);
      expect(isAlive(sentinel.pid)).toBe(true);
      const diagnostics = result.errors.join("\n");
      const context = JSON.parse(result.errors[0].slice(result.errors[0].indexOf("{")));
      expect(context).toMatchObject({ command: shim, args: [], cwd: directory, code: "EINVAL", syscall: "spawn" });
      for (const value of ["platform-worker", "EINVAL", "spawn", "at "]) expect(diagnostics).toContain(value);
      expect(diagnostics).not.toContain(secretMarker);
    },
  );

  it("preserves launcher admission, normal shutdown and readiness deadlines", () => {
    const source = readFileSync(new URL("./dev-system.mjs", import.meta.url), "utf8");
    expect(source).toContain("acquireDevSystemHeavySlot(mode, target, acquireHeavySlot);");
    expect(source).toContain("shuttingDown = true;\n      completeDevSystemStartupFailure();");
    for (const signal of ["SIGINT", "SIGTERM"])
      expect(source).toContain(`process.once("${signal}", () => shutdown("${signal}", 0))`);
    expect(source).toContain('message.type === "browser-e2e-probe-shutdown"');
    expect(source).toContain("setTimeout(() => process.exit(exitCode), 100).unref()");
    expect(source).toContain("lifecycleRecorder?.observe(definition.name, child)");
    const config = readFileSync(fileURLToPath(new URL("../playwright.config.ts", import.meta.url)), "utf8");
    expect(config.match(/timeout: 600_000/g)).toHaveLength(2);
  });
});
