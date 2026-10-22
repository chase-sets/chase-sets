import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { consumeTimingRecords } from "./provider-browser-install-timing.mjs";
import {
  INSTALLER_TIMEOUT_SECONDS,
  resolveInstallerIdentity,
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
    const install = job.steps.find((step) => step.name === "Install provider browser boundary");
    expect(INSTALLER_TIMEOUT_SECONDS).toBe(600);
    expect(job["timeout-minutes"]).toBe(20);
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
    expect(consumeTimingRecords(f.lines, { headSha: identity.headSha, stepExecuted: true })).toHaveLength(1);
  });

  it.each([
    ["partial download fails closed", "partial download", "partial-download"],
    ["checksum failure fails closed", "checksum mismatch", "checksum-failure"],
    ["cache restore failure fails closed", "cache restore failed", "cache-restore-failure"],
    ["fallback browser path is refused", "fallback browser executablePath=/usr/bin/chromium", "refused"],
  ])("%s", async (_name, output, outcome) => {
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

  it("cleanup failure fails closed", async () => {
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

  it("secret and raw provider response are never logged", async () => {
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
    expect(consumeTimingRecords(f.lines, { headSha: identity.headSha, stepExecuted: true })).toEqual([actual.record]);
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

  it("refuses incomplete installs, spawn failure, and changed allowance without retries", async () => {
    const incomplete = fixture();
    incomplete.child.emit("close", 0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await incomplete.result).status).toBe(1);
    const failed = fixture();
    failed.child.emit("error", new Error("PRIVATE spawn failure"));
    expect((await failed.result).status).toBe(1);
    expect(failed.lines.join("")).not.toContain("PRIVATE");
    expect(() => runInstaller({ identity, env: { ...env, INSTALLER_TIMEOUT_SECONDS: "601" } })).toThrow(/600/);
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
    { ...job, run_attempt: 2 },
    { ...job, status: "cancelled" },
  ])("refuses wrong authority without retry", async (wrong) => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ total_count: 1, jobs: [wrong] }) }));
    await expect(resolveInstallerIdentity(authority, fetchImpl)).rejects.toThrow(/owning job/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
