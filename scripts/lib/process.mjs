import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { repoRoot } from "./repo.mjs";

const minimalProcessEnvironmentNames = new Set(
  [
    "APPDATA",
    "CHASE_SETS_HEAVY_SLOT_ID",
    "CI",
    "COMSPEC",
    "FORCE_COLOR",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "PNPM_HOME",
    "SYSTEMROOT",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WINDIR",
  ].map((name) => name.toLowerCase()),
);

export function buildMinimalProcessEnvironment(env = process.env, explicit = {}) {
  const minimal = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && minimalProcessEnvironmentNames.has(name.toLowerCase())) {
      minimal[name] = value;
    }
  }
  for (const [name, value] of Object.entries(explicit)) {
    if (value !== undefined) {
      minimal[name] = value;
    }
  }
  return minimal;
}

function activePackageManagerExecPath({ env = process.env, exists = existsSync, platform = process.platform } = {}) {
  const execPath = env.npm_execpath;
  if (!execPath || !/pnpm/i.test(execPath) || !exists(execPath)) {
    return null;
  }
  if (platform === "win32" && isWindowsCommandShim(execPath)) {
    return null;
  }

  return execPath;
}

function isWindowsCommandShim(execPath) {
  const extension = path.extname(execPath).toLowerCase();
  return extension === ".cmd" || extension === ".bat" || extension === ".ps1";
}

function buildInvocationFromPackageManagerPath(execPath, args) {
  const extension = path.extname(execPath).toLowerCase();

  if (extension === ".cjs" || extension === ".js" || extension === ".mjs") {
    return {
      command: process.execPath,
      args: [execPath, ...args],
    };
  }

  return {
    command: execPath,
    args,
  };
}

function resolveWindowsPnpmCliPath({ env = process.env, exists = existsSync } = {}) {
  const candidates = [
    activePackageManagerExecPath({ env, exists, platform: "win32" }),
    env.PNPM_HOME ? path.join(env.PNPM_HOME, "pnpm.cjs") : null,
    env.PNPM_HOME ? path.join(env.PNPM_HOME, "node_modules", "pnpm", "bin", "pnpm.cjs") : null,
    path.join(path.dirname(process.execPath), "node_modules", "pnpm", "bin", "pnpm.cjs"),
    env.APPDATA ? path.join(env.APPDATA, "npm", "node_modules", "pnpm", "bin", "pnpm.cjs") : null,
  ].filter(Boolean);

  return candidates.find((candidate) => exists(candidate)) ?? null;
}

export function buildPackageManagerInvocation(args, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;

  if (platform === "win32") {
    const pnpmCliPath = resolveWindowsPnpmCliPath({ env, exists });
    if (pnpmCliPath) {
      return buildInvocationFromPackageManagerPath(pnpmCliPath, args);
    }
  }

  const activeExecPath = activePackageManagerExecPath({ env, exists, platform });
  if (activeExecPath) {
    return buildInvocationFromPackageManagerPath(activeExecPath, args);
  }

  return {
    command: "pnpm",
    args,
  };
}

function wirePrefixedStream(stream, prefix) {
  let buffer = "";

  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      if (part.length > 0) {
        console.log(`[${prefix}] ${part}`);
      }
    }
  });

  stream.on("end", () => {
    if (buffer.length > 0) {
      console.log(`[${prefix}] ${buffer}`);
    }
  });
}

export function spawnCommand(command, args, options = {}) {
  const inheritedEnvironment = options.inheritEnv === false ? {} : process.env;
  const platform = options.platform ?? process.platform;
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(command, args, {
    cwd: options.cwd ?? repoRoot,
    ...(options.timeoutMs !== undefined && platform !== "win32" ? { detached: true } : {}),
    env: {
      ...inheritedEnvironment,
      FORCE_COLOR: process.env.FORCE_COLOR ?? "1",
      ...options.env,
    },
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  if (options.prefix && child.stdout && child.stderr) {
    wirePrefixedStream(child.stdout, options.prefix);
    wirePrefixedStream(child.stderr, options.prefix);
  }

  return child;
}

export function terminateProcessTree(
  child,
  signal = "SIGTERM",
  { killImpl = process.kill, platform = process.platform, processGroup = false, spawnSyncImpl = spawnSync } = {},
) {
  if (!child) {
    return false;
  }

  if (platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
      return false;
    }
    const result = spawnSyncImpl("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.error && result.error.code !== "ENOENT") {
      throw result.error;
    }
    return result.status === 0;
  }

  if (processGroup && child.pid) {
    try {
      killImpl(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") {
        return false;
      }
      throw error;
    }
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    return false;
  }
  return child.kill(signal);
}

function formatTimeout(timeoutMs) {
  return timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
}

function parseTimeoutMs(value) {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Command timeout must be a positive integer number of milliseconds.");
  }

  return value;
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = parseTimeoutMs(options.timeoutMs);
    const timeoutKillGraceMs = parseTimeoutMs(options.timeoutKillGraceMs) ?? 1_000;
    const child = spawnCommand(command, args, options);
    const timeoutUsesProcessGroup = timeoutMs !== undefined && process.platform !== "win32";
    let settled = false;
    let timedOut = false;
    let timeoutId;
    let forceKillId;

    function clearTimers({ preserveForceKill = false } = {}) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      if (forceKillId && !preserveForceKill) {
        clearTimeout(forceKillId);
        forceKillId = undefined;
      }
    }

    function timeoutError() {
      return new Error(`${command} ${args.join(" ")} timed out after ${formatTimeout(timeoutMs)}.`);
    }

    if (timeoutMs) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        const killed = terminateProcessTree(child, "SIGTERM", {
          processGroup: timeoutUsesProcessGroup,
        });
        if (!killed && !settled) {
          settled = true;
          clearTimers();
          reject(timeoutError());
          return;
        }

        if (timeoutUsesProcessGroup) {
          forceKillId = setTimeout(() => {
            forceKillId = undefined;
            terminateProcessTree(child, "SIGKILL", {
              processGroup: true,
            });
          }, timeoutKillGraceMs);
        }
      }, timeoutMs);
    }

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timedOut) {
        clearTimers({ preserveForceKill: timeoutUsesProcessGroup });
        reject(timeoutError());
        return;
      }

      clearTimers();
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}.`));
    });
  });
}
