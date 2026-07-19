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
