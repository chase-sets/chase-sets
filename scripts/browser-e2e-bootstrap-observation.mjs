import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { runCommand } from "./lib/process.mjs";

const execFileAsync = promisify(execFile);
const processTreeQueryTimeoutMs = 4_000;
const processTreeQuery = [
  "Get-CimInstance Win32_Process |",
  "Select-Object ProcessId,ParentProcessId,Name,@{Name='Created';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} |",
  "ConvertTo-Json -Compress",
].join(" ");

export async function sampleWindowsProcessTree(rootPid, { platform = process.platform } = {}) {
  if (platform !== "win32") return [];
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", processTreeQuery], {
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
    timeout: processTreeQueryTimeoutMs,
  });
  const records = [JSON.parse(stdout)].flat();
  const descendants = new Set([rootPid]);
  for (let pass = 0; pass < 16; pass += 1) {
    let added = false;
    for (const record of records) {
      if (!descendants.has(record.ParentProcessId) || descendants.has(record.ProcessId)) continue;
      descendants.add(record.ProcessId);
      added = true;
    }
    if (!added) break;
  }
  return records
    .filter((record) => descendants.has(record.ProcessId))
    .map((record) => ({
      pid: record.ProcessId,
      parentPid: record.ParentProcessId,
      name: record.Name,
      createdAt: record.Created,
    }));
}

export async function runObservedBrowserE2eBootstrap(
  command,
  args,
  {
    name,
    prefix = name,
    recorder,
    environment,
    run = runCommand,
    sampleProcessTree = sampleWindowsProcessTree,
    pollMs = 2_000,
    sampleGraceMs = pollMs * 2,
    stderrToStderr = !process.env.CI,
  },
) {
  let child;
  let interval;
  let sampling;
  const sample = () => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null || sampling) return;
    sampling = (async () => {
      try {
        recorder.recordProcessTree(name, await sampleProcessTree(child.pid));
      } catch (error) {
        recorder.recordProcessTreeError(name, error?.code ?? error?.name ?? "unknown");
      }
    })()
      .catch(() => {})
      .finally(() => {
        sampling = undefined;
      });
  };
  try {
    await run(command, args, {
      env: environment,
      inheritEnv: false,
      prefix,
      stderrToStderr,
      onSpawn(spawned) {
        child = spawned;
        recorder.observe(name, child, {
          command,
          args,
          parentPid: process.pid,
          innerNodePid: null,
          processTree: [],
        });
        sample();
        interval = setInterval(sample, pollMs);
      },
    });
  } finally {
    clearInterval(interval);
    if (sampling) {
      let graceTimer;
      try {
        await Promise.race([
          sampling.catch(() => {}),
          new Promise((resolve) => {
            graceTimer = setTimeout(resolve, sampleGraceMs);
          }),
        ]);
      } finally {
        clearTimeout(graceTimer);
      }
    }
  }
}
