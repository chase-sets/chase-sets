import { buildPackageManagerInvocation, runCommand } from "./lib/process.mjs";
import { acquireHeavySlot } from "./lib/heavy-slot.mjs";

function appendNodeOption(currentValue, option) {
  const values = (currentValue ?? "").split(/\s+/).filter(Boolean);
  return values.includes(option) ? values.join(" ") : [...values, option].join(" ");
}

const invocation = buildPackageManagerInvocation(["exec", "react-router", "build"]);

acquireHeavySlot("build");
await runCommand(invocation.command, invocation.args, {
  cwd: process.cwd(),
  env: {
    NODE_OPTIONS: appendNodeOption(process.env.NODE_OPTIONS, "--no-deprecation"),
  },
  stdio: "inherit",
});
