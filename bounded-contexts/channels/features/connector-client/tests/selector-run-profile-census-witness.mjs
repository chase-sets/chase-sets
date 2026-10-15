import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { chromeArguments } from "./selector-human-route-rehearsal.mjs";

// The fixed #9628 witness driver. Only Start-SelectorRunOwned launches it, inside the run job, and
// it acts only after the owner's grant line on stdin. EOF or any other input before the grant is a
// normal refusal with no browser. After the grant it launches the pinned Chromium headless with the
// run profile, reports the browser PID, and on the owner's release (EOF) closes it normally.
export const CHROMIUM_REVISION = "chromium-1223";
export const CHROMIUM_SHA256 = "290fa7018fda22c52ada5eddb0113baf3ebc41fd0fde6085eddb19793606c635";
const driver = fileURLToPath(import.meta.url);
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

export function parseGrant(line, pid) {
  try {
    const grant = JSON.parse(line);
    const keys = Object.keys(grant ?? {})
      .sort()
      .join(",");
    const payload = grant?.payload;
    if (keys !== "format,payload,pid" || grant.format !== "selector-run-grant/v1" || grant.pid !== pid) return null;
    if (Object.keys(payload ?? {}).join(",") !== "profile" || typeof payload.profile !== "string") return null;
    if (!path.isAbsolute(payload.profile) || path.resolve(payload.profile) !== payload.profile) return null;
    return payload.profile;
  } catch {
    return null;
  }
}

// Playwright supplies the run profile as --user-data-dir and opens about:blank itself.
export function witnessArguments(profile, proxyPort) {
  const args = chromeArguments(profile, proxyPort);
  const managed = [`--user-data-dir=${profile}`, "about:blank"];
  const rest = args.filter((arg) => !managed.includes(arg));
  if (rest.length !== args.length - managed.length) throw new Error("chrome_arguments_changed");
  return rest;
}

function pinnedChromium(executable) {
  const digest = createHash("sha256").update(readFileSync(executable)).digest("hex");
  if (!executable.split(path.sep).includes(CHROMIUM_REVISION) || digest !== CHROMIUM_SHA256) {
    throw new Error("chromium_pin_refused");
  }
  return digest;
}

async function main() {
  const lines = createInterface({ input: process.stdin });
  const next = lines[Symbol.asyncIterator]();
  const first = await next.next();
  const profile = first.done ? null : parseGrant(first.value, process.pid);
  if (!profile) {
    emit({ event: "refused" });
    process.exitCode = 3;
    lines.close();
    return;
  }
  const deny = createServer((socket) => socket.destroy());
  let context;
  try {
    await new Promise((resolve, reject) => {
      deny.once("error", reject);
      deny.listen(0, "127.0.0.1", resolve);
    });
    const { chromium } = await import("@playwright/test");
    const executablePath = chromium.executablePath();
    const digest = pinnedChromium(executablePath);
    context = await chromium.launchPersistentContext(profile, {
      executablePath,
      headless: true,
      args: witnessArguments(profile, deny.address().port),
    });
    const session = await context.browser().newBrowserCDPSession();
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    const browsers = processInfo.filter((entry) => entry.type === "browser");
    await session.detach();
    if (browsers.length !== 1 || !Number.isInteger(browsers[0].id)) throw new Error("browser_identity_refused");
    emit({ event: "browser", pid: browsers[0].id, chromium: digest });
    // Hold the run until the owner's census is done: its release is EOF (or any line) on stdin.
    await next.next();
  } catch {
    emit({ event: "failed" });
    process.exitCode = 5;
  } finally {
    try {
      await context?.close();
    } catch {
      process.exitCode = 5;
    }
    deny.close();
    lines.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === driver) await main();
