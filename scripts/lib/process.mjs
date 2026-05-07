import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { repoRoot } from "./repo.mjs";

function resolveWindowsNpmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm", "node_modules", "npm", "bin", "npm-cli.js")
      : null,
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function buildNpmInvocation(args) {
  if (process.platform === "win32") {
    const npmCliPath = resolveWindowsNpmCliPath();
    if (npmCliPath) {
      return {
        command: process.execPath,
        args: [npmCliPath, ...args],
      };
    }
  }

  return {
    command: "npm",
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
