import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { repoRoot } from "./repo.mjs";

function activePackageManagerExecPath({ env = process.env, exists = existsSync } = {}) {
  const execPath = env.npm_execpath;
  if (!execPath || !/pnpm/i.test(execPath) || !exists(execPath)) {
    return null;
  }

  return execPath;
}

function buildInvocationFromPackageManagerPath(execPath, args) {
  const extension = path.extname(execPath).toLowerCase();

  if (extension === ".cjs" || extension === ".js") {
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
    activePackageManagerExecPath({ env, exists }),
    env.PNPM_HOME ? path.join(env.PNPM_HOME, "pnpm.cjs") : null,
    env.PNPM_HOME
      ? path.join(env.PNPM_HOME, "node_modules", "pnpm", "bin", "pnpm.cjs")
      : null,
    path.join(path.dirname(process.execPath), "node_modules", "pnpm", "bin", "pnpm.cjs"),
    env.APPDATA
      ? path.join(env.APPDATA, "npm", "node_modules", "pnpm", "bin", "pnpm.cjs")
      : null,
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

  const activeExecPath = activePackageManagerExecPath({ env, exists });
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
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: {
      ...process.env,
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

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, options);

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code ?? "unknown"}.`,
        ),
      );
    });
  });
}
