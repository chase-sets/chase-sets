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
    requiredEnv: ["DIGITALOCEAN_ACCESS_TOKEN"],
  },
  {
    tool: "aws",
    pattern: /(?:^|[\s;&|$(])aws(?=\s|$)/m,
    requiredEnv: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  },
];

function stepBlocks(source) {
  const lines = source.split(/\r?\n/);
  const starts = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (/^ {6}- /.test(lines[index])) {
      starts.push(index);
    }
  }

  return starts.map((start, index) => ({
    startLine: start + 1,
    source: lines.slice(start, starts[index + 1] ?? lines.length).join("\n"),
  }));
}

function stepName(stepSource) {
  return (
    stepSource.match(/^ {6}- name:\s*(.+)$/m)?.[1]?.trim() ??
    stepSource.match(/^ {6}- uses:\s*(.+)$/m)?.[1]?.trim() ??
    "unnamed step"
  );
}

function stepRunBlock(stepSource) {
  const lines = stepSource.split("\n");
  const runIndex = lines.findIndex((line) => /^(?: {6}- run:| {8}run:)/.test(line));
  if (runIndex < 0) return null;

  const inlineRun = lines[runIndex].replace(/^(?: {6}- run:| {8}run:)\s*/, "");
  if (inlineRun !== "|" && inlineRun !== ">" && inlineRun !== "") return inlineRun;

  return lines.slice(runIndex + 1).join("\n");
}

function stepEnvKeys(stepSource) {
  const lines = stepSource.split("\n");
  const envIndex = lines.findIndex((line) => /^ {8}env:\s*$/.test(line));
  if (envIndex < 0) return new Set();

  const keys = new Set();
  for (const line of lines.slice(envIndex + 1)) {
    if (line.trim() !== "" && !/^ {10}/.test(line)) break;
    const match = line.match(/^ {10}([A-Za-z_][A-Za-z0-9_]*):/);
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
    scripts.add(match[1].replace(/^["']|["']$/g, "").replace(/^\.\//, ""));
  }
  return [...scripts].sort();
}

function defaultReadScript(scriptPath) {
  const resolved = resolvePath(scriptPath);
  return existsSync(resolved) ? readFileSync(resolved, "utf8") : null;
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

  for (const step of stepBlocks(source)) {
    const run = stepRunBlock(step.source);
    if (run === null) continue;

    const requiredEnv = new Set(spacesCredentialEnvNames(run));
    const scripts = nodeScriptInvocations(run);
    for (const scriptPath of scripts) {
      const scriptSource = readScript(scriptPath);
      if (scriptSource === null) continue;
      for (const name of spacesCredentialEnvNames(scriptSource)) {
        requiredEnv.add(name);
      }
    }
    if (requiredEnv.size === 0) continue;

    const name = stepName(step.source);
    const envKeys = stepEnvKeys(step.source);
    const missingEnv = [...requiredEnv].sort().filter((key) => !envKeys.has(key));
    checkedSteps.push({ name, line: step.startLine, requiredEnv: [...requiredEnv].sort(), scripts });

    if (missingEnv.length > 0) {
      violations.push(
        `${workflowFile}:${step.startLine} step '${name}' uses dedicated Spaces evidence credentials but does not declare step env: ${missingEnv.join(", ")}`,
      );
    }
  }

  return { passed: violations.length === 0, checkedSteps, violations };
}

export function checkWorkflowProviderCredentials(source, { workflowFile = "workflow" } = {}) {
  const checkedSteps = [];
  const violations = [];

  for (const step of stepBlocks(source)) {
    const run = stepRunBlock(step.source);
    if (run === null) continue;

    const tools = providerToolRequirements.filter(({ pattern }) => pattern.test(run));
    if (tools.length === 0) continue;

    const name = stepName(step.source);
    const envKeys = stepEnvKeys(step.source);
    const requiredEnv = [...new Set(tools.flatMap((tool) => tool.requiredEnv))];
    const missingEnv = requiredEnv.filter((key) => !envKeys.has(key));
    checkedSteps.push({ name, line: step.startLine, tools: tools.map(({ tool }) => tool) });

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
