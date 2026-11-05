import { readFileSync } from "node:fs";
import { requiredJobs } from "../../pr-checks/required-jobs.mjs";

export function requiredJobCalls(step) {
  if (step.run !== "node scripts/pr-checks/required-jobs.mjs" || step.env.PR_REQUIRED_NEEDS_JSON !== "${{ toJSON(needs) }}") {
    throw new Error("Required-job caller is not bound to the real needs input");
  }
  return requiredJobs.map(([id, name, requirement]) => {
    const result = ["static", "typecheck", "build"].includes(id) ? `needs.${id}.result` : `needs['${id}'].result`;
    const resultArgument = `\${{ ${result} }}`;
    const requiredArgument = requirement === null ? "$capture_required" : `\${{ needs['change-scope'].outputs.${requirement} }}`;
    return { name, helper: "require_job", resultArgument, requiredArgument, line: `require_job "${name}" "${resultArgument}" "${requiredArgument}"` };
  });
}

export function stageOperation(file, operation) {
  const source = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  if (!operation) return source.replace(/^#![^\n]*\n/, "");
  const start = source.indexOf(`  ${operation})\n`);
  if (start < 0) throw new Error(`Missing stage operation: ${file} ${operation}`);
  const bodyStart = source.indexOf("\n", start) + 1;
  const end = source.indexOf("    ;;\n", bodyStart);
  if (end < 0) throw new Error(`Unterminated stage operation: ${file} ${operation}`);
  return source.slice(bodyStart, end).replace(/^ {4}/gm, "");
}

export function stageRun(step) {
  const call = step.run?.match(/^bash (scripts\/pr-checks\/[a-z0-9-]+\.sh)(?: ([a-z-]+))?$/);
  return call ? stageOperation(call[1], call[2]) : step.run;
}
