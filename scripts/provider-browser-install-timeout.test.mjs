import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { consumeTimingRecords } from "./provider-browser-install-timing.mjs";
import {
  INSTALLER_TIMEOUT_SECONDS,
  resolveInstallerIdentity,
  runHostedInstaller,
  runInstaller,
  superviseInstaller,
} from "./provider-browser-install-timeout.mjs";

const workflow = parse(readFileSync(".github/workflows/platform-pr.yml", "utf8"));
const identity = { runId: "123", runAttempt: 1, jobId: "456", headSha: "a".repeat(40) };
const env = {
  INSTALLER_TIMEOUT_SECONDS: "600",
  BOUNDARY_HEAD_SHA: identity.headSha,
  GH_TOKEN: "PRIVATE_TOKEN",
  PROVIDER_SECRET: "PRIVATE_PROVIDER",
};
const stage = (name) => `provider-boundary-setup-stage:${name}\n`;
const authority = {
  headSha: identity.headSha,
  owningJob: {
    id: 456,
    run_id: 123,
    run_attempt: 1,
    head_sha: identity.headSha,
    steps: [
      {
        name: "Install provider browser boundary",
        status: "completed",
        conclusion: "success",
        started_at: "2026-01-01T00:00:00Z",
        completed_at: "2027-01-01T00:00:00Z",
      },
    ],
  },
};

function fixture(options = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-22T00:00:00Z"));
  const child = Object.assign(new EventEmitter(), {
    pid: 4567,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    send: vi.fn(),
  });
  const spawnImpl = vi.fn(() => child);
  const signalGroupImpl = vi.fn();
  const lines = [];
  const result = runInstaller({
    identity,
    env,
    spawnImpl,
    signalGroupImpl,
    write: (line) => lines.push(line),
    ...options,
  });
  return { child, spawnImpl, signalGroupImpl, lines, result };
}

afterEach(() => vi.useRealTimers());

describe("Static Checks provider installer", () => {
  it("Static Checks setup omits optional browser dependencies before the explicit native block", () => {
    const setup = readFileSync("scripts/provider-object-disposition/browser-boundary/ci-setup.sh", "utf8");
    expect(setup).toContain("pnpm exec playwright install chromium");
    expect(setup).not.toContain("pnpm exec playwright install --with-deps chromium");
    expect(setup.indexOf("pnpm exec playwright install chromium")).toBeLessThan(setup.indexOf("sudo apt-get update"));
    expect(setup.slice(setup.indexOf("sudo apt-get update"), setup.indexOf("else"))).toBe(
      "sudo apt-get update\n  sudo apt-get install --yes gcc libc6-dev libssl-dev pax-utils apparmor\n",
    );
  });

  it("caller fence preserves manual diagnostics and the 120-second reinstall", () => {
    for (const [path, digest] of [
      [
        ".github/workflows/browser-boundary-diagnostics.yml",
        "301cca0a86c41791ca05e4361d53f2de3899e8294d28c8f60ebe55ea05ba1715",
      ],
      [
        "scripts/provider-object-disposition/browser-boundary/installation-cycle.mjs",
        "79e85116dbb83ca46eedbe9fd586b5442c4a6a1debf5bdd94cdd309107c7bd73",
      ],
    ]) {
      expect(createHash("sha256").update(readFileSync(path, "utf8").replaceAll("\r\n", "\n")).digest("hex")).toBe(
        digest,
      );
    }
    expect(workflow.jobs.static.permissions).toEqual({ contents: "read", actions: "read" });
    expect(
      createHash("sha256")
        .update(workflow.jobs.static.steps.find((step) => step.name === "Installed-boundary controls").run)
        .digest("hex"),
    ).toBe("10425e59fd1dff4e8a8d871079747f595cd9b88a491adc483864a3958009d16e");
    expect(workflow.jobs.static.steps.find((step) => step.name === "Installed-boundary controls").run).toContain(
      "node scripts/provider-object-disposition/browser-boundary/hosted-controls.mjs",
    );
    expect(readFileSync(".github/workflows/platform-pr.yml", "utf8")).not.toContain("timeout-verifier");
  });

  it("keeps the owned group leader alive through TERM and installer exit", () => {
    const runtime = Object.assign(new EventEmitter(), { pid: 777, send: vi.fn(), exit: vi.fn() });
    const installer = new EventEmitter();
    const spawnImpl = vi.fn(() => installer);
    superviseInstaller({ runtime, spawnImpl });
    runtime.emit("SIGTERM");
    installer.emit("close", 0);
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.send).toHaveBeenCalledWith({ installerStatus: 0 });
    expect(spawnImpl.mock.calls[0].slice(0, 2)).toEqual([
      "bash",
      ["scripts/provider-object-disposition/browser-boundary/ci-setup.sh"],
    ]);
    runtime.emit("message", "release");
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("passes composed installer command and args to the owned group leader", () => {
    const runtime = Object.assign(new EventEmitter(), { pid: 777, send: vi.fn(), exit: vi.fn() });
    const installer = new EventEmitter();
    const spawnImpl = vi.fn(() => installer);
    superviseInstaller({ runtime, spawnImpl, installerCommand: "node", installerArgs: ["-e", "process.exit(0)"] });
    expect(spawnImpl.mock.calls[0].slice(0, 2)).toEqual(["node", ["-e", "process.exit(0)"]]);
  });

  it("entry block decodes a composed installer spec and reports a successful child", async () => {
    const spec = Buffer.from(
      JSON.stringify({ command: process.execPath, args: ["-e", "process.exit(0)"] }),
      "utf8",
    ).toString("base64url");
    const child = spawn(
      process.execPath,
      ["scripts/provider-browser-install-timeout.mjs", "--installer-process-group", spec],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      },
    );
    const messages = [];
    const status = await new Promise((resolve, reject) => {
      child.on("message", (message) => {
        messages.push(message);
        child.send("release");
      });
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(status).toBe(0);
    expect(messages).toEqual([{ installerStatus: 0 }]);
  });

  it("terminates only its own group if its supervising owner disconnects", async () => {
    vi.useFakeTimers();
    const runtime = Object.assign(new EventEmitter(), { pid: 777, send: vi.fn(), exit: vi.fn() });
    const signalGroupImpl = vi.fn();
    superviseInstaller({ runtime, spawnImpl: () => new EventEmitter(), signalGroupImpl });
    runtime.emit("disconnect");
    expect(signalGroupImpl.mock.calls).toEqual([[777, "TERM"]]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(signalGroupImpl).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(signalGroupImpl.mock.calls).toEqual([
      [777, "TERM"],
      [777, "KILL"],
    ]);
  });

  it("static checks provider install timeout propagation", async () => {
    const job = workflow.jobs.static;
    const resolveVersion = job.steps.find((step) => step.name === "Resolve Playwright Chromium version");
    expect(resolveVersion).toEqual({
      name: "Resolve Playwright Chromium version",
      id: "playwright-version",
      run: expect.stringContaining("pnpm exec playwright --version | awk '{print $2}'"),
    });
    const restore = job.steps.find((step) => step.name === "Restore Playwright Chromium cache");
    expect(restore).toEqual({
      name: "Restore Playwright Chromium cache",
      id: "playwright-chromium-cache",
      uses: "actions/cache/restore@caa296126883cff596d87d8935842f9db880ef25",
      env: { SEGMENT_DOWNLOAD_TIMEOUT_MINS: "1" },
      with: {
        path: "/home/runner/.cache/ms-playwright",
        key: "playwright-chromium-${{ runner.os }}-${{ steps.playwright-version.outputs.version }}",
      },
    });
    expect(restore.with).not.toHaveProperty("restore-keys");
    expect(job.steps.indexOf(restore)).toBeLessThan(
      job.steps.findIndex((step) => step.name === "Install provider browser boundary"),
    );
    expect(
      workflow.jobs.static.steps
        .filter((step) => String(step.uses ?? "").startsWith("actions/cache/"))
        .map((step) => step.uses),
    ).toEqual(["actions/cache/restore@caa296126883cff596d87d8935842f9db880ef25"]);
    const install = job.steps.find((step) => step.name === "Install provider browser boundary");
    expect(INSTALLER_TIMEOUT_SECONDS).toBe(600);
    expect(job["timeout-minutes"]).toBe(30);
    expect(install.env.INSTALLER_TIMEOUT_SECONDS).toBe("600");
    expect(install.run).toBe("node scripts/provider-browser-install-timeout.mjs");
    expect(job["continue-on-error"]).toBeUndefined();
    expect(install["continue-on-error"]).toBeUndefined();
    expect(job.steps.find((step) => step.name === "Installed-boundary controls").if).toBeUndefined();
    expect(job.steps.find((step) => step.name === "Remove owned provider browser boundary").if).toBe("always()");
    const f = fixture();
    await vi.advanceTimersByTimeAsync(599_999);
    expect(f.signalGroupImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.signalGroupImpl.mock.calls).toEqual([[4567, "TERM"]]);
    // The leader exits and its pipes close; its TERM-ignoring descendant still
    // owns the group. Killing must not depend on leader exitCode or open pipes.
    f.child.exitCode = 0;
    f.child.emit("close", 0);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.signalGroupImpl.mock.calls).toEqual([
      [4567, "TERM"],
      [4567, "KILL"],
    ]);
    expect((await f.result).record.terminalOutcome).toBe("timeout");
    expect((await f.result).status).not.toBe(0);
    expect(f.spawnImpl).toHaveBeenCalledOnce();
    expect(f.spawnImpl.mock.calls[0][2].detached).toBe(true);
    expect(f.spawnImpl.mock.calls[0][1][1]).toBe("--installer-process-group");
    expect(consumeTimingRecords(f.lines, authority)).toHaveLength(1);
  });

  it("honors a native per-caller 180-second bound while retaining the five-second grace", async () => {
    const f = fixture({ timeoutSeconds: 180 });
    await vi.advanceTimersByTimeAsync(179_999);
    expect(f.signalGroupImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.signalGroupImpl.mock.calls).toEqual([[4567, "TERM"]]);
    f.child.exitCode = 0;
    f.child.emit("close", 0);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.signalGroupImpl.mock.calls).toEqual([[4567, "TERM"]]);
    expect(f.lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.signalGroupImpl.mock.calls).toEqual([
      [4567, "TERM"],
      [4567, "KILL"],
    ]);
    const { record, status } = await f.result;
    expect(status).toBe(1);
    expect(record).toMatchObject({ terminalOutcome: "timeout", elapsedMs: 185_000 });
    expect(consumeTimingRecords(f.lines, authority)).toHaveLength(1);
  });

  it("keeps the existing 600-second default and rejects caller bounds above it", () => {
    expect(() => runInstaller({ identity, env, timeoutSeconds: 601 })).toThrow(/600/);
    expect(() => runInstaller({ identity, env, timeoutSeconds: 0 })).toThrow(/600/);
    expect(() => runInstaller({ identity, env, timeoutSeconds: 180.5 })).toThrow(/600/);
    expect(() => runInstaller({ identity, env, timeoutSeconds: "180" })).toThrow(/600/);
  });

  it.each([
    ["partial download fails closed", "partial download", "partial-download"],
    ["checksum failure fails closed", "checksum mismatch", "checksum-failure"],
    ["cache restore failure fails closed", "cache restore failed", "cache-restore-failure"],
    ["fallback browser path is refused", "fallback browser executablePath=/usr/bin/chromium", "refused"],
  ])("fail-closed installer failures: %s", async (_name, output, outcome) => {
    const f = fixture();
    f.child.stdout.write(stage("install-chromium"));
    f.child.stderr.write(`${output}\n`);
    // Even a mistaken zero exit and complete marker cannot turn a failure green.
    f.child.stdout.write(stage("complete"));
    f.child.emit("close", 0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await f.result).status).not.toBe(0);
    expect((await f.result).record.terminalOutcome).toBe(outcome);
    expect(f.spawnImpl).toHaveBeenCalledOnce();
    expect(f.lines).toHaveLength(1);
  });

  it("fail-closed installer failures: cleanup failure", async () => {
    const signalGroupImpl = vi.fn(() => {
      throw new Error("SYNTHETIC kill denied");
    });
    const f = fixture({ signalGroupImpl });
    await vi.advanceTimersByTimeAsync(605_000);
    expect((await f.result).status).toBe(1);
    expect((await f.result).record.terminalOutcome).toBe("cleanup-failure");
    expect(signalGroupImpl.mock.calls).toEqual([
      [4567, "TERM"],
      [4567, "KILL"],
    ]);
  });

  it("fail-closed installer failures: secret and raw provider response are never logged", async () => {
    const f = fixture();
    f.child.stdout.write(stage("install-chromium"));
    f.child.stdout.write("provider-boundary-PRIVATE_TOKEN\nRunner image: PRIVATE_PROVIDER\n");
    f.child.stderr.write("<html>PRIVATE_PROVIDER provider response</html>\n".repeat(10_000));
    f.child.emit("close", 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await f.result).status).toBe(1);
    expect(f.lines).toHaveLength(1);
    expect(f.lines.join("")).not.toMatch(/PRIVATE|<html>/);
    expect(f.spawnImpl.mock.calls[0][2].env).not.toHaveProperty("GH_TOKEN");
    expect(f.spawnImpl.mock.calls[0][2].env).not.toHaveProperty("PROVIDER_SECRET");
  });

  it("successful installation emits a live consumable cache miss record and permits controls", async () => {
    const f = fixture();
    for (const name of [
      "runner-identity",
      "install-chromium",
      "install-native-dependencies",
      "install-boundary",
      "complete",
    ])
      f.child.stdout.write(stage(name));
    f.child.emit("message", { installerStatus: 0 });
    f.child.emit("close", 0);
    const actual = await f.result;
    expect(actual.status).toBe(0);
    expect(actual.record).toMatchObject({
      ...identity,
      terminalOutcome: "success",
      phase: "terminal",
      source: "provider-download",
      cache: "miss",
      retryCount: 0,
    });
    expect(consumeTimingRecords(f.lines, authority)).toEqual([actual.record]);
    expect(f.signalGroupImpl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("records cache hit but reclassifies an observed download as a miss", async () => {
    for (const downloading of [false, true]) {
      const f = fixture({ cacheHit: true });
      f.child.stdout.write(stage("install-chromium"));
      if (downloading) f.child.stdout.write("Downloading Chromium 123\n");
      f.child.stdout.write(stage("complete"));
      f.child.emit("message", { installerStatus: 0 });
      f.child.emit("close", 0);
      expect((await f.result).record).toMatchObject({
        source: downloading ? "provider-download" : "cache",
        cache: downloading ? "miss" : "hit",
      });
    }
  });

  it("fail-closed installer failures: incomplete installs, nonzero status, spawn failure and changed allowance", async () => {
    const incomplete = fixture();
    incomplete.child.emit("close", 0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await incomplete.result).status).toBe(1);
    const nonzero = fixture();
    nonzero.child.stdout.write(stage("complete"));
    nonzero.child.emit("message", { installerStatus: 7 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await nonzero.result).status).toBe(1);
    expect(nonzero.spawnImpl).toHaveBeenCalledOnce();
    const failed = fixture();
    failed.child.emit("error", new Error("PRIVATE spawn failure"));
    expect((await failed.result).status).toBe(1);
    expect(failed.lines.join("")).not.toContain("PRIVATE");
    expect(() => runInstaller({ identity, env: { ...env, INSTALLER_TIMEOUT_SECONDS: "601" } })).toThrow(/600/);
  });

  it("marks only a refused start, never a started child's refusal, as start-refused", async () => {
    const preStart = [
      fixture({
        spawnImpl: () => {
          throw new Error("PRIVATE spawn refusal");
        },
      }),
      fixture({ spawnImpl: () => Object.assign(new EventEmitter(), { pid: undefined }) }),
      fixture({ spawnImpl: () => Object.assign(new EventEmitter(), { pid: 0 }) }),
    ];
    const spawnError = fixture();
    spawnError.child.emit("error", new Error("PRIVATE spawn failure"));
    preStart.push(spawnError);
    for (const f of preStart) {
      const result = await f.result;
      expect(result).toMatchObject({ status: 1, startRefused: true, record: { terminalOutcome: "refused" } });
      expect(f.lines).toHaveLength(1);
      expect(f.lines.join("")).not.toContain("PRIVATE");
      expect(f.signalGroupImpl).not.toHaveBeenCalled();
    }
    // A started child's error is not proof that its group is gone: it waits for KILL.
    const startedError = fixture();
    let startedErrorSettled = false;
    const startedErrorResult = startedError.result.then((result) => {
      startedErrorSettled = true;
      return result;
    });
    startedError.child.emit("spawn");
    startedError.child.emit("error", new Error("PRIVATE ipc failure"));
    expect(startedError.signalGroupImpl.mock.calls).toEqual([[4567, "TERM"]]);
    // Later errors and the leader's close cannot finish the attempt early.
    startedError.child.emit("error", new Error("PRIVATE late ipc failure"));
    startedError.child.emit("close", 1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(startedErrorSettled).toBe(false);
    expect(startedError.lines).toEqual([]);
    expect(startedError.signalGroupImpl.mock.calls).toEqual([[4567, "TERM"]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(startedError.signalGroupImpl.mock.calls).toEqual([
      [4567, "TERM"],
      [4567, "KILL"],
    ]);
    const started = await startedErrorResult;
    expect(started).toMatchObject({ status: 1, record: { terminalOutcome: "refused" } });
    expect(started).not.toHaveProperty("startRefused");
    expect(startedError.lines).toHaveLength(1);
    expect(startedError.lines.join("")).not.toContain("PRIVATE");
    const startedRefusal = fixture();
    startedRefusal.child.emit("spawn");
    startedRefusal.child.emit("message", { installerStatus: 7 });
    await vi.advanceTimersByTimeAsync(5_000);
    const refused = await startedRefusal.result;
    expect(refused).toMatchObject({ status: 1, record: { terminalOutcome: "refused" } });
    expect(refused).not.toHaveProperty("startRefused");
  });

  it("a started child's error while stopping keeps cancellation and cleanup failure through KILL", async () => {
    const controller = new AbortController();
    const cancelled = fixture({ cancelSignal: controller.signal });
    cancelled.child.emit("spawn");
    controller.abort();
    cancelled.child.emit("error", new Error("PRIVATE ipc failure"));
    expect(cancelled.signalGroupImpl.mock.calls).toEqual([[4567, "TERM"]]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(cancelled.lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(cancelled.signalGroupImpl.mock.calls).toEqual([
      [4567, "TERM"],
      [4567, "KILL"],
    ]);
    expect(await cancelled.result).toMatchObject({ status: 1, record: { terminalOutcome: "cancelled" } });
    // A refused TERM is a cleanup failure even when KILL is accepted.
    const signalGroupImpl = vi.fn((_pid, signal) => {
      if (signal === "TERM") throw new Error("SYNTHETIC TERM denied");
    });
    const termRefused = fixture({ signalGroupImpl });
    termRefused.child.emit("spawn");
    termRefused.child.emit("message", { installerStatus: 1 });
    termRefused.child.emit("error", new Error("PRIVATE ipc failure"));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(termRefused.lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(signalGroupImpl.mock.calls).toEqual([
      [4567, "TERM"],
      [4567, "KILL"],
    ]);
    expect(await termRefused.result).toMatchObject({ status: 1, record: { terminalOutcome: "cleanup-failure" } });
  });
});

describe("owning hosted job identity", () => {
  const authority = {
    ...env,
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REPOSITORY: "chase-sets/chase-sets",
    RUNNER_NAME: "runner-1",
  };
  const job = {
    id: 456,
    run_id: 123,
    run_attempt: 1,
    head_sha: identity.headSha,
    runner_name: "runner-1",
    name: "Static Checks",
    status: "in_progress",
  };
  it("uses the owning API job id, never a run-id fallback", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ total_count: 1, jobs: [job] }) }));
    expect(await resolveInstallerIdentity(authority, fetchImpl)).toEqual(identity);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toContain("/runs/123/attempts/1/jobs?per_page=100");
  });
  it.each([
    { ...job, runner_name: "sibling" },
    { ...job, head_sha: "b".repeat(40) },
    { ...job, run_id: 124 },
    { ...job, run_attempt: 2 },
    { ...job, status: "cancelled" },
    { ...job, status: "completed" },
    { ...job, status: "unknown-PRIVATE_PROVIDER" },
    { ...job, status: "queued", runner_name: "sibling" },
    { ...job, status: "queued", head_sha: "b".repeat(40), runner_name: null },
    { ...job, id: "456" },
    { ...job, id: 0 },
    { ...job, id: Number.MAX_SAFE_INTEGER + 1 },
  ])("refuses wrong authority without retry", async (wrong) => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ total_count: 1, jobs: [wrong] }) }));
    await expect(resolveInstallerIdentity(authority, fetchImpl)).rejects.toThrow(/owning job/);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const f = discovery([
      { total_count: 1, jobs: [wrong] },
      { total_count: 1, jobs: [job] },
    ]);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(await f.result).toEqual({ status: 1 });
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.spawnImpl).not.toHaveBeenCalled();
    expect(f.lines.join("\n")).not.toContain("PRIVATE_PROVIDER");
  });

  function discovery(payloads = [{ total_count: 1, jobs: [job] }], options = {}) {
    vi.useFakeTimers();
    const started = Date.now();
    const lines = [];
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => payloads[Math.min(fetchImpl.mock.calls.length - 1, payloads.length - 1)],
    }));
    const loadPlaywright = vi.fn(async () => ({ chromium: { executablePath: () => "synthetic-absent-browser" } }));
    const child = Object.assign(new EventEmitter(), {
      pid: 4567,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      send: vi.fn(),
    });
    const spawnImpl = vi.fn(() => child);
    const result = runHostedInstaller({
      env: authority,
      fetchImpl,
      now: () => Date.now() - started,
      write: (line) => lines.push(line),
      loadPlaywright,
      installerOptions: { spawnImpl },
      ...options,
    });
    return { fetchImpl, loadPlaywright, spawnImpl, child, lines, result };
  }

  it("observes absent then queued/null then in-progress/null before exactly one authoritative spawn", async () => {
    const f = discovery([
      { total_count: 0, jobs: [] },
      { total_count: 1, jobs: [{ ...job, status: "queued", runner_name: null }] },
      { total_count: 1, jobs: [{ ...job, runner_name: null }] },
      { total_count: 1, jobs: [job] },
    ]);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
    expect(f.spawnImpl).not.toHaveBeenCalled();
    expect(f.loadPlaywright).not.toHaveBeenCalled();
    expect(f.lines.filter((line) => line.startsWith("provider-browser-install-timing/v1 "))).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.fetchImpl).toHaveBeenCalledTimes(4);
    expect(f.spawnImpl).toHaveBeenCalledOnce();
    expect(f.loadPlaywright).toHaveBeenCalledOnce();
    const observations = f.lines
      .filter((line) => line.startsWith("provider-browser-install-authority-observation "))
      .map((line) => JSON.parse(line.slice(line.indexOf("{"))));
    expect(observations.map(({ reason }) => reason)).toEqual([
      "pending-visibility",
      "pending-visibility",
      "pending-visibility",
      "authority-resolved",
    ]);
    expect(observations[0]).toMatchObject({ observation: 1, elapsedMs: 0, jobCount: 0, candidateCount: 0 });
    expect(observations[1]).toMatchObject({ status: "queued", runnerPending: true, runnerMatch: false });
    expect(f.lines).toContain(
      `provider-browser-install-authority-resolved ${JSON.stringify({ ...identity, runId: 123, jobId: 456, elapsedMs: 15_000, observation: 4 })}`,
    );
    f.child.stdout.write(stage("install-chromium") + stage("complete"));
    f.child.emit("message", { installerStatus: 0 });
    f.child.emit("close", 0);
    expect((await f.result).status).toBe(0);
    expect(consumeTimingRecords(f.lines, authorityForTiming())).toHaveLength(1);
    expect(f.spawnImpl).toHaveBeenCalledOnce();
  });

  function authorityForTiming() {
    return {
      headSha: identity.headSha,
      owningJob: {
        ...job,
        steps: [
          {
            name: "Install provider browser boundary",
            status: "completed",
            conclusion: "success",
            started_at: "2026-01-01T00:00:00Z",
            completed_at: "2027-01-01T00:00:00Z",
          },
        ],
      },
    };
  }

  it.each([null, "runner-1"])(
    "never accepts queued authority with runner %s through the last observation",
    async (runner_name) => {
      const f = discovery([{ total_count: 1, jobs: [{ ...job, status: "queued", runner_name }] }]);
      await vi.advanceTimersByTimeAsync(175_000);
      expect(f.fetchImpl).toHaveBeenCalledTimes(36);
      expect(f.spawnImpl).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(f.loadPlaywright).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await f.result).toEqual({ status: 1 });
      expect(f.fetchImpl).toHaveBeenCalledTimes(36);
      expect(f.lines.at(-1)).toContain('"reason":"visibility-deadline"');
      expect(f.lines.at(-1)).toContain('"elapsedMs":180000');
      expect(f.lines.some((line) => line.startsWith("provider-browser-install-timing/v1 "))).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("never-visible identity exhausts the total bound without a spawn", async () => {
    const f = discovery([{ total_count: 0, jobs: [] }]);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(await f.result).toEqual({ status: 1 });
    expect(f.fetchImpl.mock.calls.length).toBeLessThanOrEqual(37);
    expect(f.spawnImpl).not.toHaveBeenCalled();
    expect(f.lines.at(-1)).toContain("visibility-deadline");
  });

  it("charges request and body reads to the same deadline and never overlaps observations", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      return {
        ok: true,
        json: async () => {
          await new Promise((resolve) => setTimeout(resolve, 7_000));
          return { total_count: 0, jobs: [] };
        },
      };
    });
    const f = discovery(undefined, { fetchImpl });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls).toBe(1);
    expect(f.spawnImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await f.result).toEqual({ status: 1 });
    expect(f.lines.at(-1)).toContain("body-timeout");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);
  });

  it("accepts an exact owner at the last observation, not its preceding pending state", async () => {
    const pending = { total_count: 1, jobs: [{ ...job, status: "queued", runner_name: null }] };
    const f = discovery([...Array(35).fill(pending), { total_count: 1, jobs: [job] }], {
      loadPlaywright: async () => {
        throw new Error("PRIVATE import");
      },
    });
    await vi.advanceTimersByTimeAsync(174_999);
    expect(f.spawnImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await f.result).toEqual({ status: 1 });
    expect(f.fetchImpl).toHaveBeenCalledTimes(36);
    expect(f.lines.some((line) => line.includes('"reason":"authority-resolved"'))).toBe(true);
    expect(f.lines.at(-1)).toBe("provider-browser-install-refused:playwright-import");
  });

  it.each(["request", "body"])(
    "bounds a stalled %s by 10 seconds and aborts without overlapping requests",
    async (phase) => {
      let signal;
      const f = discovery(undefined, {
        fetchImpl: vi.fn(async (_url, options) => {
          signal = options.signal;
          if (phase === "request") return await new Promise(() => {});
          return { ok: true, json: () => new Promise(() => {}) };
        }),
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(signal.aborted).toBe(false);
      expect(f.spawnImpl).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await f.result).toEqual({ status: 1 });
      expect(signal.aborted).toBe(true);
      expect(f.lines.at(-1)).toContain(`${phase}-timeout`);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["request", "body"])("clips the final %s timeout to the remaining total ceiling", async (phase) => {
    let count = 0;
    let signal;
    const fetchImpl = vi.fn(async (_url, options) => {
      count += 1;
      if (count < 36) return { ok: true, json: async () => ({ total_count: 0, jobs: [] }) };
      signal = options.signal;
      if (phase === "request") return await new Promise(() => {});
      return { ok: true, json: () => new Promise(() => {}) };
    });
    const f = discovery(undefined, { fetchImpl });
    await vi.advanceTimersByTimeAsync(179_999);
    expect(signal.aborted).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(36);
    await vi.advanceTimersByTimeAsync(1);
    expect(await f.result).toEqual({ status: 1 });
    expect(signal.aborted).toBe(true);
    expect(f.spawnImpl).not.toHaveBeenCalled();
    expect(f.lines.at(-1)).toContain("visibility-deadline");
  });

  it.each([
    null,
    {},
    { total_count: 0 },
    { total_count: 1, jobs: [] },
    { jobs: [job] },
    { total_count: "1", jobs: [job] },
    { total_count: -1, jobs: [] },
    { total_count: 101, jobs: Array(101).fill({ name: "synthetic sibling" }) },
    { total_count: 1, jobs: [null] },
    { total_count: 1, jobs: [{}] },
  ])("rejects malformed/incomplete/capped lists before spawn: %j", async (payload) => {
    const f = discovery([payload]);
    await vi.advanceTimersByTimeAsync(0);
    expect(await f.result).toEqual({ status: 1 });
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.spawnImpl).not.toHaveBeenCalled();
    expect(f.lines.at(-1)).toContain("malformed-incomplete-list");
  });

  it("does not hide duplicate canonical owners behind a runner filter", async () => {
    const f = discovery([{ total_count: 2, jobs: [job, { ...job, id: 457, runner_name: null, status: "queued" }] }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(await f.result).toEqual({ status: 1 });
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.spawnImpl).not.toHaveBeenCalled();
    expect(f.lines.at(-1)).toContain("duplicate-owner");
  });

  it.each(["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_REPOSITORY", "BOUNDARY_HEAD_SHA", "GH_TOKEN", "RUNNER_NAME"])(
    "rejects invalid %s before any request or spawn",
    async (key) => {
      const f = discovery(undefined, { env: { ...authority, [key]: "" } });
      expect(await f.result).toEqual({ status: 1 });
      expect(f.fetchImpl).not.toHaveBeenCalled();
      expect(f.spawnImpl).not.toHaveBeenCalled();
      expect(f.lines.at(-1)).toContain("invalid-environment");
    },
  );

  it.each(["http", "transport", "body", "payload", "import", "pre-spawn"])(
    "keeps %s failure output fixed and free of secrets, bodies and exception text",
    async (phase) => {
      const secret = "SENTINEL_PRIVATE_TOKEN_BODY_EXCEPTION";
      const f = discovery(undefined, {
        env: { ...authority, GH_TOKEN: secret },
        ...(phase === "http"
          ? { fetchImpl: async () => ({ ok: false, statusText: secret, json: async () => secret }) }
          : {}),
        ...(phase === "transport"
          ? {
              fetchImpl: async () => {
                throw new Error(secret);
              },
            }
          : {}),
        ...(phase === "body"
          ? {
              fetchImpl: async () => ({
                ok: true,
                json: async () => {
                  throw new Error(secret);
                },
              }),
            }
          : {}),
        ...(phase === "payload" ? { fetchImpl: async () => ({ ok: true, json: async () => secret }) } : {}),
        ...(phase === "import"
          ? {
              loadPlaywright: async () => {
                throw new Error(secret);
              },
            }
          : {}),
        ...(phase === "pre-spawn" ? { env: { ...authority, GH_TOKEN: secret, INSTALLER_TIMEOUT_SECONDS: "601" } } : {}),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(await f.result).toEqual({ status: 1 });
      expect(f.spawnImpl).not.toHaveBeenCalled();
      expect(f.lines.join("\n")).not.toContain(secret);
      expect(f.lines.join("\n")).not.toContain("PRIVATE");
      expect(f.lines.at(-1)).toContain(
        {
          http: "http-failure",
          transport: "transport-failure",
          body: "body-failure",
          payload: "malformed-incomplete-list",
          import: "playwright-import",
          "pre-spawn": "pre-spawn",
        }[phase],
      );
    },
  );

  it("shares the literal verifier owner reader without selecting a governing installer mode", async () => {
    const source = readFileSync("scripts/provider-browser-install-timeout-verifier.mjs", "utf8");
    expect(source).toContain(
      'resolveInstallerIdentity(env, fetch, { jobName: "Synthetic browser installer timeout" })',
    );
    expect(source).not.toContain("await fetch(");
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ total_count: 1, jobs: [{ ...job, name: "Synthetic browser installer timeout" }] }),
    }));
    expect(
      await resolveInstallerIdentity(authority, fetchImpl, {
        jobName: "Synthetic browser installer timeout",
        write: () => {},
      }),
    ).toEqual(identity);
  });
});
