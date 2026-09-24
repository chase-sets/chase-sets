import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./browser-e2e-evidence.mjs";
import { buildMinimalProcessEnvironment, spawnCommand, terminateProcessTree } from "./lib/process.mjs";

const execFileAsync = promisify(execFile);
const childLimitMs = 5_000;
const eventWindowMs = 60_000;
const eventQuery = [
  "$events = @(Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Error'; Id=1000; StartTime=[datetime]::Parse($args[0])} -ErrorAction SilentlyContinue);",
  "@($events | ForEach-Object { $xml = [xml]$_.ToXml(); $data = @($xml.Event.EventData.Data);",
  "[pscustomobject]@{ time = $_.TimeCreated.ToUniversalTime().ToString('o'); pid = [string]$data[8].'#text' } }) | ConvertTo-Json -Compress",
].join(" ");

function matchesPid(value, pid) {
  if (!value) return false;
  const text = value.trim();
  if (/^0x[\da-f]+$/i.test(text)) return Number.parseInt(text.slice(2), 16) === pid;
  return /^\d+$/.test(text) && Number(text) === pid;
}

export async function runWerVisibilityControl({
  outputDirectory,
  spawn = spawnCommand,
  terminate = terminateProcessTree,
  query = queryApplicationErrors,
  now = Date.now,
} = {}) {
  if (!outputDirectory) throw new Error("WER control requires an output directory.");
  mkdirSync(outputDirectory, { recursive: true });
  const startedAt = new Date(now()).toISOString();
  const child = spawn("node", ["-e", "process.abort()"], {
    inheritEnv: false,
    env: buildMinimalProcessEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let limit;
  const exit = await Promise.race([
    new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal, timedOut: false }));
      child.once("error", (error) =>
        resolve({ code: null, signal: null, timedOut: false, error: error?.code ?? error?.name ?? "unknown" }),
      );
    }),
    new Promise((resolve) => {
      limit = setTimeout(() => {
        terminate(child, "SIGKILL");
        resolve({ code: child.exitCode, signal: child.signalCode, timedOut: true });
      }, childLimitMs);
    }),
  ]);
  clearTimeout(limit);
  const exitedAt = new Date(now()).toISOString();
  const deadline = Date.parse(exitedAt) + eventWindowMs;
  let matchedEventAt = null;
  let queryError = null;
  do {
    try {
      const events = await query(startedAt);
      matchedEventAt =
        events.find(
          (event) =>
            matchesPid(event.pid, child.pid) &&
            Math.abs(Date.parse(event.time) - Date.parse(exitedAt)) <= eventWindowMs,
        )?.time ?? null;
      if (matchedEventAt) break;
      queryError = null;
    } catch (error) {
      queryError = error?.code ?? error?.name ?? "unknown";
    }
    if (now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, deadline - now())));
  } while (now() <= deadline);
  const packet = {
    kind: "browser-e2e-wer-visibility-control",
    startedAt,
    exitedAt,
    pid: child.pid ?? null,
    exitCode: exit.code,
    signal: exit.signal,
    timedOut: exit.timedOut,
    spawnError: exit.error ?? null,
    applicationError1000Seen: matchedEventAt !== null,
    matchedEventAt,
    queryError,
  };
  writeJsonAtomic(path.join(outputDirectory, "wer-control.json"), packet);
  return packet;
}

async function queryApplicationErrors(startedAt) {
  const command = eventQuery.replace("$args[0]", `'${startedAt}'`);
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], {
    windowsHide: true,
    timeout: 4_000,
    maxBuffer: 1024 * 1024,
  });
  if (!stdout.trim()) return [];
  return [JSON.parse(stdout)].flat();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packet = await runWerVisibilityControl({ outputDirectory: path.resolve(process.argv[2]) });
  console.log(JSON.stringify(packet));
}
