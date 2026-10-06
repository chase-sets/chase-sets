import { buildPackageManagerInvocation, spawnCommand, terminateProcessTree } from "./lib/process.mjs";
import { repoRoot } from "./lib/repo.mjs";

export function createDevSystemLauncher({
  children = [],
  onFailure = () => {
    process.exitCode = 1;
  },
  resolveInvocation = buildPackageManagerInvocation,
  spawn = spawnCommand,
  terminate = terminateProcessTree,
  logError = console.error,
} = {}) {
  let failed = false;
  return {
    launch(definition, options = {}) {
      if (failed) return null;
      const invocation = definition.command
        ? { command: definition.command, args: definition.args ?? [] }
        : resolveInvocation(["--filter", definition.workspace, "run", definition.script ?? "dev"]);
      try {
        return spawn(invocation.command, invocation.args, options);
      } catch (error) {
        failed = true;
        const redact = (value) => {
          let safe = String(value);
          for (const secret of Object.values(options.env ?? {})) {
            if (typeof secret === "string" && secret.length > 0) safe = safe.replaceAll(secret, "[redacted]");
          }
          return safe.replace(/[\r\n\t]/g, " ").slice(0, 256);
        };
        const code =
          typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code.slice(0, 64) : "unknown";
        const syscall =
          typeof error?.syscall === "string" && /^[a-zA-Z0-9_]+$/.test(error.syscall)
            ? error.syscall.slice(0, 64)
            : "unknown";
        logError(
          `[${redact(definition.name)}] Failed to start: ${JSON.stringify({
            command: redact(invocation.command),
            args: invocation.args.slice(0, 24).map(redact),
            cwd: redact(options.cwd ?? repoRoot),
            code,
            syscall,
          })}`,
        );
        for (const frame of String(error?.stack ?? "")
          .split("\n")
          .filter((line) => /^\s+at /.test(line))
          .slice(0, 6)) {
          logError(redact(frame));
        }
        for (const child of children) {
          try {
            terminate(child, "SIGTERM");
          } catch {
            logError("[dev] Failed to stop an owned child after startup failure.");
          }
        }
        onFailure();
        return null;
      }
    },
  };
}
