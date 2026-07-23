import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const providerToolRequirements = [
  {
    tool: "terraform",
    pattern: /(?:^|[\s;&|$(])terraform(?=\s|$)/m,
    requiredEnv: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  },
  {
    tool: "doctl",
    pattern: /(?:^|[\s;&|$(])doctl(?=\s|$)/m,
    scriptPattern:
      /(?:execFile|execFileSync|spawn|spawnSync|commandOutput|commandJson|output|json)\s*\(\s*["']doctl["']/m,
    requiredEnv: ["DIGITALOCEAN_ACCESS_TOKEN"],
  },
  {
    tool: "aws",
    pattern: /(?:^|[\s;&|$(])aws(?=\s|$)/m,
    requiredEnv: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  },
  {
    tool: "reviewed-plan",
    pattern: /(?:^|[\s;&|$(])node\s+scripts\/terraform-reviewed-plan\.mjs\s+(?:seal|open)(?=\s|$)/m,
    requiredEnv: ["PLAN_ENCRYPTION_SECRET"],
  },
];

const terraformProviderOperationPattern = /(?:^|[\s;&|$(])terraform\s+(?:-[^\s]+\s+)*(?:plan|apply)(?=\s|$)/m;
const terraformDigitalOceanProviderEnv = [
  "TF_VAR_digitalocean_token",
  "TF_VAR_spaces_access_id",
  "TF_VAR_spaces_secret_key",
];

// Workflow job steps sit at a 6-space list indent; composite-action steps
// (`.github/actions/*/action.yml`) sit shallower because `steps:` nests
// directly under `runs:`. Derive the item indent from the `steps:` line so
// both surfaces parse with the same helpers.
function stepItemIndent(source) {
  const match = source.match(/^([ ]*)steps:[ ]*$/m);
  return match ? match[1].length + 2 : 6;
}

function stepBlocks(source, indent = 6) {
  const lines = source.split(/\r?\n/);
  const starts = [];
  const itemStart = new RegExp(`^ {${indent}}- `);

  for (let index = 0; index < lines.length; index += 1) {
    if (itemStart.test(lines[index])) {
      starts.push(index);
    }
  }

  return starts.map((start, index) => ({
    startLine: start + 1,
    source: lines.slice(start, starts[index + 1] ?? lines.length).join("\n"),
  }));
}

function stepName(stepSource, indent = 6) {
  return (
    stepSource.match(new RegExp(`^ {${indent}}- name:\\s*(.+)$`, "m"))?.[1]?.trim() ??
    stepSource.match(new RegExp(`^ {${indent}}- uses:\\s*(.+)$`, "m"))?.[1]?.trim() ??
    "unnamed step"
  );
}

function stepRunBlock(stepSource, indent = 6) {
  const lines = stepSource.split("\n");
  const runLine = new RegExp(`^(?: {${indent}}- run:| {${indent + 2}}run:)`);
  const runIndex = lines.findIndex((line) => runLine.test(line));
  if (runIndex < 0) return null;

  const inlineRun = lines[runIndex].replace(new RegExp(`^(?: {${indent}}- run:| {${indent + 2}}run:)\\s*`), "");
  if (inlineRun !== "|" && inlineRun !== ">" && inlineRun !== "") return inlineRun;

  return lines.slice(runIndex + 1).join("\n");
}

function stepEnvKeys(stepSource, indent = 6) {
  const lines = stepSource.split("\n");
  const envLine = new RegExp(`^ {${indent + 2}}env:\\s*$`);
  const envIndex = lines.findIndex((line) => envLine.test(line));
  if (envIndex < 0) return new Set();

  const keyIndent = new RegExp(`^ {${indent + 4}}`);
  const keyPattern = new RegExp(`^ {${indent + 4}}([A-Za-z_][A-Za-z0-9_]*):`);
  const keys = new Set();
  for (const line of lines.slice(envIndex + 1)) {
    if (line.trim() !== "" && !keyIndent.test(line)) break;
    const match = line.match(keyPattern);
    if (match) keys.add(match[1]);
  }
  return keys;
}

// Dedicated Spaces evidence credentials (release qualification): any env name shaped
// like <PREFIX>_SPACES_ACCESS_ID / <PREFIX>_SPACES_SECRET_KEY is a bucket-scoped
// Spaces credential pair. The guard selects its surface by code shape — a
// workflow step whose run block invokes a node script (or references the
// credential directly) — never by workflow path or step-name vocabulary.
const spacesCredentialEnvPattern = /\b[A-Z][A-Z0-9_]*_SPACES_(?:ACCESS_ID|SECRET_KEY)\b/g;
const nodeScriptInvocationPattern = /(?:^|[\s;&|($])node\s+("[^"]+\.mjs"|'[^']+\.mjs'|[^\s;&|)'"]+\.mjs)/gm;

export function spacesCredentialEnvNames(source) {
  return [...new Set(source.match(spacesCredentialEnvPattern) ?? [])].sort();
}

export function nodeScriptInvocations(run) {
  const scripts = new Set();
  for (const match of run.matchAll(nodeScriptInvocationPattern)) {
    scripts.add(
      match[1]
        .replace(/^["']|["']$/g, "")
        // Steps checked out at the repo root routinely address scripts via the
        // workspace variable; normalize so the guard inspects the real source.
        .replace(/^\$\{?GITHUB_WORKSPACE\}?\//, "")
        .replace(/^\.\//, ""),
    );
  }
  return [...scripts].sort();
}

function defaultReadScript(scriptPath) {
  const resolved = resolvePath(scriptPath);
  return existsSync(resolved) ? readFileSync(resolved, "utf8") : null;
}

// Steps that run with a `working-directory` deep in the tree invoke scripts
// through `../` chains; those still live at the repo root, so retry with the
// leading parent segments stripped before declaring the path unresolvable.
function resolveInvokedScript(scriptPath, readScript) {
  for (const candidate of new Set([scriptPath, scriptPath.replace(/^(?:\.\.\/)+/, "")])) {
    const source = readScript(candidate);
    if (source !== null) return source;
  }
  return null;
}

// Every workflow step that touches the dedicated Spaces evidence credentials —
// by invoking a node script whose source reads them, or by referencing them
// inline — must declare each credential in its step-local env so the secret is
// threaded explicitly and the step fails before a provider call when one is
// withheld.
export function checkWorkflowSpacesEvidenceCredentials(
  source,
  { workflowFile = "workflow", readScript = defaultReadScript } = {},
) {
  const checkedSteps = [];
  const violations = [];
  const indent = stepItemIndent(source);

  for (const step of stepBlocks(source, indent)) {
    const run = stepRunBlock(step.source, indent);
    if (run === null) continue;

    const requiredEnv = new Set(spacesCredentialEnvNames(run));
    const scripts = nodeScriptInvocations(run);
    const unresolvable = [];
    for (const scriptPath of scripts) {
      const scriptSource = resolveInvokedScript(scriptPath, readScript);
      if (scriptSource === null) {
        unresolvable.push(scriptPath);
        continue;
      }
      for (const name of spacesCredentialEnvNames(scriptSource)) {
        requiredEnv.add(name);
      }
    }

    const name = stepName(step.source, indent);
    // Fail closed: a script the guard cannot read is a script it cannot clear
    // of touching the dedicated Spaces evidence credentials.
    for (const scriptPath of unresolvable) {
      violations.push(
        `${workflowFile}:${step.startLine} step '${name}' invokes node script '${scriptPath}' that does not resolve in the repository, so it cannot be inspected for dedicated Spaces evidence credential use; failing closed.`,
      );
    }

    if (requiredEnv.size === 0 && unresolvable.length === 0) continue;

    const envKeys = stepEnvKeys(step.source, indent);
    const missingEnv = [...requiredEnv].sort().filter((key) => !envKeys.has(key));
    checkedSteps.push({ name, line: step.startLine, requiredEnv: [...requiredEnv].sort(), scripts, unresolvable });

    if (missingEnv.length > 0) {
      violations.push(
        `${workflowFile}:${step.startLine} step '${name}' uses dedicated Spaces evidence credentials but does not declare step env: ${missingEnv.join(", ")}`,
      );
    }
  }

  return { passed: violations.length === 0, checkedSteps, violations };
}

export function checkWorkflowProviderCredentials(
  source,
  { workflowFile = "workflow", readScript = defaultReadScript } = {},
) {
  const checkedSteps = [];
  const violations = [];
  const indent = stepItemIndent(source);

  for (const step of stepBlocks(source, indent)) {
    const run = stepRunBlock(step.source, indent);
    if (run === null) continue;

    const scripts = nodeScriptInvocations(run);
    const invokedScriptSources = scripts
      .map((scriptPath) => resolveInvokedScript(scriptPath, readScript))
      .filter((scriptSource) => scriptSource !== null);
    const tools = providerToolRequirements.filter(
      ({ pattern, scriptPattern }) =>
        pattern.test(run) ||
        (scriptPattern && invokedScriptSources.some((scriptSource) => scriptPattern.test(scriptSource))),
    );
    if (tools.length === 0) continue;

    const name = stepName(step.source, indent);
    const envKeys = stepEnvKeys(step.source, indent);
    const requiredEnv = [
      ...new Set([
        ...tools.flatMap((tool) => tool.requiredEnv),
        ...(terraformProviderOperationPattern.test(run) ? terraformDigitalOceanProviderEnv : []),
      ]),
    ];
    const missingEnv = requiredEnv.filter((key) => !envKeys.has(key));
    checkedSteps.push({
      name,
      line: step.startLine,
      tools: tools.map(({ tool }) => tool),
      requiredEnv,
      scripts,
    });

    if (missingEnv.length > 0) {
      violations.push(
        `${workflowFile}:${step.startLine} provider-touching step '${name}' invokes ${tools
          .map(({ tool }) => tool)
          .join("/")} but does not declare step env: ${missingEnv.join(", ")}`,
      );
    }
  }

  return { passed: violations.length === 0, checkedSteps, violations };
}
