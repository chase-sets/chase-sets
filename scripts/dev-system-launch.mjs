import { buildPackageManagerInvocation, spawnCommand, terminateProcessTree } from "./lib/process.mjs";

export function createDevSystemLauncher({
  children,
  onFailure,
  resolveInvocation = buildPackageManagerInvocation,
  spawn = spawnCommand,
  terminate = terminateProcessTree,
  logError = console.error,
} = {}) {
  return {
    launch(definition, options) {
      const invocation = definition.command
        ? { command: definition.command, args: definition.args ?? [] }
        : resolveInvocation(["--filter", definition.workspace, "run", definition.script ?? "dev"]);
      return spawn(invocation.command, invocation.args, options);
    },
  };
}
