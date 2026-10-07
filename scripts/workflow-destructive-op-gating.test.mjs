import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  DESTRUCTIVE_GRAMMAR,
  DESTRUCTIVE_OPERATION_EXEMPTIONS,
  NAMED_RESET_WORKFLOW_TRIPWIRES,
  benignAdmissionInventory,
  checkDiscoveredWorkflows,
  checkNamedResetWorkflowTripwires,
  checkWorkflowDestructiveOperationGating,
  classifyShellCommands,
  deriveAuthoritativeGrammar,
  discoverWorkflowFiles,
  validateGrammarPartition,
} from "./workflow-destructive-op-gating.mjs";

const root = resolve(import.meta.dirname, "..");
const corpusSha = "926050f88aae70a631c117c1e0f002a3160a9278";
const registryFile = ".github/workflows/platform-registry-cleanup.yml";
const restoreFile = ".github/workflows/platform-production-restore-point-cleanup.yml";
const productionFile = ".github/workflows/platform-production.yml";
const driftFile = ".github/workflows/platform-db-duration-drift.yml";
const [stagingFile, catalogFile] = NAMED_RESET_WORKFLOW_TRIPWIRES;
const readWorkflow = (file) => readFileSync(join(root, file), "utf8");
const operations = (run) => classifyShellCommands(run).operations;
// Counted without the detector's discovery code.
const independentWorkflowTotal = () =>
  readdirSync(join(root, ".github/workflows"), { recursive: true }).filter((file) => /\.ya?ml$/.test(file)).length;

const fixtureDirectories = [];
afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureRoot() {
  const directory = mkdtempSync(join(tmpdir(), "workflow-destructive-op-gating-"));
  fixtureDirectories.push(directory);
  for (const file of discoverWorkflowFiles(root)) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    copyFileSync(join(root, file), join(directory, file));
  }
  return directory;
}

function changeWorkflow(file, change) {
  const workflow = parse(readWorkflow(file));
  change(workflow);
  return stringify(workflow);
}

function pushWorkflow(run = "terraform destroy", jobId = "anonymous", stepName = "ordinary task") {
  return stringify({
    name: "Synthetic 8709 fixture",
    on: "push",
    jobs: { [jobId]: { "runs-on": "ubuntu-latest", steps: [{ name: stepName, run }] } },
  });
}

// Word helpers for synthetic, re-hashed benign entries.
const W = (value) => ({ value, dynamic: false, quoted: false });
const Q = (value) => ({ value, dynamic: false, quoted: true });
const D = (value) => ({ value, dynamic: true, quoted: true });
const U = (value) => ({ value, dynamic: true, quoted: false });
const word = (item) => (typeof item === "string" ? W(item) : item);
const render = (words) =>
  words
    .map(({ value, dynamic, quoted }) => {
      if (dynamic) return quoted ? `"${value}"` : value;
      return quoted ? `'${value}'` : value;
    })
    .join(" ");

function syntheticEntry(items, input) {
  const words = items.map(word);
  const selector = words[0].value;
  const shape = { selector, words, ...(input?.length ? { input } : {}) };
  const heredoc = input?.length ? ` <<'SYNTHETIC_8709'\n${input[0]}SYNTHETIC_8709` : "";
  return {
    id: createHash("sha256").update(JSON.stringify(shape)).digest("hex"),
    ...shape,
    example: render(words) + heredoc,
    origin: { sha: "0".repeat(40), path: ".github/workflows/synthetic-8709.yml", job: "synthetic", step: 1 },
    proof: { selector: "synthetic review control", operands: "synthetic review control" },
  };
}

const withEntry = (entry) => ({
  ...DESTRUCTIVE_GRAMMAR,
  benignForms: [...DESTRUCTIVE_GRAMMAR.benignForms.filter((candidate) => candidate.id !== entry.id), entry],
});
// Admission proves each entry on its own, so single-entry grammars suffice
// wherever no corpus workflow is classified.
const alone = (entry) => ({ ...DESTRUCTIVE_GRAMMAR, benignForms: [entry] });
const covered = (entry) => `${entry.id}: benign payload contains a covered invocation.`;
const unpinned = (entry) => `${entry.id}: benign payload admits an unpinned program.`;
const at = (words, index, replacement) => words.map((item, position) => (position === index ? replacement : item));
const insert = (words, index, item) => [...words.slice(0, index), item, ...words.slice(index)];
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
// The two corpus entries whose pnpm --filter package is "$workspace".
const originIds = [
  "127ddb007aa5c3e3f7d55a4a3ed6e695a113f4137c52190c94d69b15ba26f28b",
  "8e090b6e1c15a22d9267ab80b3fa67c822df751b26d523e1d8a89f83acd535a2",
];

// Validator caller and classifier caller both report the named admission
// violation, and nothing else.
function expectRejected(entry, violation) {
  const grammar = alone(entry);
  expect(validateGrammarPartition(grammar).violations, entry.example).toEqual([violation]);
  const classified = classifyShellCommands(entry.example, { grammar });
  expect(classified.operations).toEqual([]);
  expect(classified.indeterminate).toEqual([expect.objectContaining({ tool: "grammar", reason: violation })]);
}

function expectAdmitted(entry) {
  const grammar = withEntry(entry);
  expect(validateGrammarPartition(grammar).violations, entry.example).toEqual([]);
  expect(classifyShellCommands(entry.example, { grammar }).indeterminate, entry.example).toEqual([]);
}

// Both callers over a batch: one validation reports exactly each rejected
// entry's named violation, the classifier caller refuses with those same
// violations, and the admitted entries validate and classify clean together.
function expectBatch(admitted, rejected) {
  const refusals = [...new Map(rejected.map((pair) => [pair[0].id, pair])).values()];
  const negative = { ...DESTRUCTIVE_GRAMMAR, benignForms: refusals.map(([entry]) => entry) };
  const { violations } = validateGrammarPartition(negative);
  const reported = (entry) => violations.filter((violation) => violation.startsWith(`${entry.id}:`));
  expect(refusals.map(([entry]) => [entry.example, reported(entry)])).toEqual(
    refusals.map(([entry, violation]) => [entry.example, [violation]]),
  );
  expect(violations).toHaveLength(refusals.length);
  expect(classifyShellCommands("true", { grammar: negative }).indeterminate).toEqual([
    expect.objectContaining({ tool: "grammar", reason: violations.join("; ") }),
  ]);
  const accepted = [...new Map(admitted.map((entry) => [entry.id, entry])).values()];
  // The classifier unwraps env/exec/command itself, so wrapped inner forms
  // need the corpus that admits them.
  const ids = new Set(accepted.map(({ id }) => id));
  const positive = {
    ...DESTRUCTIVE_GRAMMAR,
    benignForms: [...DESTRUCTIVE_GRAMMAR.benignForms.filter(({ id }) => !ids.has(id)), ...accepted],
  };
  expect(validateGrammarPartition(positive).violations).toEqual([]);
  expect(
    classifyShellCommands(accepted.map(({ example }) => example).join("\n"), { grammar: positive }).indeterminate,
  ).toEqual([]);
}

describe("derived destructive command positions", () => {
  it("detects continued destructive commands", () => {
    expect(
      operations(
        "terraform \\\n  destroy -auto-approve\ndoctl registry \\\n  repository delete-tag app old\ndoctl reg \\\n gc start",
      ),
    ).toEqual(["terraform:destroy", "doctl:registry-repository-delete-tag", "doctl:registry-garbage-collection-start"]);
    expect(operations("terr\\\naform des\\\ntroy\ndoc\\\ntl registry repository delete-tag app old")).toEqual([
      "terraform:destroy",
      "doctl:registry-repository-delete-tag",
    ]);
    expect(operations('"terraform" "des\\\ntroy"')).toEqual(["terraform:destroy"]);
    expect(operations("terraform 'des\\\ntroy'")).toEqual([]);
  });

  it("detects doctl global options", () => {
    expect(operations('doctl -t "$TOKEN" registry repository delete-tag app old')).toEqual([
      "doctl:registry-repository-delete-tag",
    ]);
    expect(operations("doctl --output=json registry --context fixture repo -tTOKEN dt app old")).toEqual([
      "doctl:registry-repository-delete-tag",
    ]);
    expect(operations('doctl --trace=false reg gc --api-url "https://example.invalid" s')).toEqual([
      "doctl:registry-garbage-collection-start",
    ]);
    const globals = DESTRUCTIVE_GRAMMAR.partition.filter(
      (member) => member.surface === "doctl-option" && member.disposition === "HANDLED",
    );
    expect(globals.length).toBeGreaterThan(0);
    for (const { form } of globals)
      for (const name of form.names) {
        const option = form.arity === 1 ? `${name} "terraform destroy"` : name;
        expect(operations(`doctl ${option} registry repository delete-tag app old`), name).toEqual([
          "doctl:registry-repository-delete-tag",
        ]);
      }
  });

  it("detects Terraform's equals-only chdir and Node script options", () => {
    expect(operations('terraform -chdir="a directory" destroy')).toEqual(["terraform:destroy"]);
    expect(classifyShellCommands("terraform -chdir fixture destroy").indeterminate).toEqual([
      expect.objectContaining({ reason: "-chdir requires =value" }),
    ]);
    expect(classifyShellCommands("terraform -synthetic-8709-option destroy").indeterminate).toHaveLength(1);
    for (const [run, operation] of [
      [
        "node --no-warnings ./scripts/digitalocean-registry-cleanup.mjs cleanup",
        "script:digitalocean-registry-cleanup",
      ],
      [
        "node \\\n  ../../../scripts/production-db-restore-point-cleanup.mjs --apply",
        "script:production-db-restore-point-cleanup",
      ],
      [
        "node --title t --require x.mjs -- ./scripts/disable-terraform-prevent-destroy.mjs main.tf",
        "script:disable-terraform-prevent-destroy",
      ],
      [
        'node "$GITHUB_WORKSPACE/scripts/production-db-restore-point-cleanup.mjs" --apply',
        "script:production-db-restore-point-cleanup",
      ],
    ])
      expect(operations(run), run).toEqual([operation]);
  });

  it("does not classify command names in data operands", () => {
    const run = `echo terraform destroy
printf '%s\\n' 'doctl registry repository delete-tag app old'
# terraform destroy
echo ./scripts/production-db-restore-point-cleanup.mjs
node --title ./scripts/production-db-restore-point-cleanup.mjs harmless.mjs
node -e 'terraform destroy'
node -p 'digitalocean-registry-cleanup.mjs'
node --check ./scripts/production-db-restore-point-cleanup.mjs
terraform -chdir="destroy" plan
doctl --context 'registry repository delete-tag' registry repository list-tags app
cat <<'SYNTHETIC_8709_DATA'
terraform destroy
SYNTHETIC_8709_DATA
for label in terraform destroy; do echo "$label"; done
case "$label" in terraform|destroy) echo data ;; esac
labels=("terraform destroy" "doctl registry")
tools=(terraform destroy)
tools+=(terraform destroy)
echo "$((terraform + destroy))"
((terraform + destroy))
command -v terraform
`;
    expect(classifyShellCommands(run)).toMatchObject({ operations: [], indeterminate: [] });
  });

  it.each([
    "echo data; terraform destroy",
    "true && terraform destroy",
    "false || terraform destroy",
    "terraform destroy | cat",
    "(terraform destroy)",
    "{ terraform destroy; }",
    ">result MODE=fixture terraform destroy 2>/dev/null",
    "PATH+=:/opt/bin terraform destroy",
    "a[0]=x terraform destroy",
    "((terraform destroy) )",
    "((terraform destroy);)",
    'echo "$((terraform destroy) )"',
    "{output}>result terraform destroy",
    "env MODE=x terraform destroy",
    "exec terraform destroy",
    "command -p -- terraform destroy",
    'echo "$(echo "$(terraform destroy)")"',
    'echo "${OPTIONAL:-$(terraform destroy)}"',
    "cat <(terraform destroy)",
    "echo `terraform destroy`",
    "if true; then terraform destroy; fi",
    "for label in x; do terraform destroy; done",
    "case x in x) terraform destroy ;; esac",
    "cleanup() { terraform destroy; }",
    "cat <<SYNTHETIC_8709\n$(terraform destroy)\nSYNTHETIC_8709\n",
  ])("detects executable position across shell grammar: %s", (run) => {
    expect(operations(run)).toEqual(["terraform:destroy"]);
  });

  it("detects doctl after an appending assignment prefix", () => {
    expect(operations("MODE+=x doctl registry repository delete-tag r t")).toEqual([
      "doctl:registry-repository-delete-tag",
    ]);
  });
});

describe("closed executable admission", () => {
  it("benign forms have closed admission", () => {
    const corpus = DESTRUCTIVE_GRAMMAR.benignForms.filter((entry) => entry.origin.sha === corpusSha);
    const appended = DESTRUCTIVE_GRAMMAR.benignForms.filter((entry) => entry.origin.sha !== corpusSha);
    expect(corpus).toHaveLength(674);
    expect(appended.map(({ origin }) => [origin.path, origin.job, origin.step])).toEqual([[driftFile, "digest", 3]]);
    expect(validateGrammarPartition().violations).toEqual([]);
    // The two origin-bound entries are admitted only inside their full block
    // (see "origin-proved dynamic package selection").
    for (const entry of DESTRUCTIVE_GRAMMAR.benignForms.filter(({ id }) => !originIds.includes(id)))
      expect(classifyShellCommands(entry.example).indeterminate, entry.id).toEqual([]);

    const admitted = DESTRUCTIVE_GRAMMAR.benignForms.find((entry) => entry.selector === "timeout");
    for (const mutation of ["proof", "origin", "selector", "hole", "missing"]) {
      const grammar = structuredClone(DESTRUCTIVE_GRAMMAR);
      const entry = grammar.benignForms.find((candidate) => candidate.id === admitted.id);
      if (mutation === "proof") delete entry.proof.operands;
      if (mutation === "origin") delete entry.origin.sha;
      if (mutation === "selector") entry.selector = "synthetic-unlisted";
      if (mutation === "hole") entry.dataOperands = true;
      if (mutation === "missing") grammar.benignForms = grammar.benignForms.filter((candidate) => candidate !== entry);
      expect(classifyShellCommands(admitted.example, { grammar }).indeterminate.length, mutation).toBeGreaterThan(0);
      if (mutation !== "missing") expect(validateGrammarPartition(grammar).violations, mutation).toHaveLength(1);
    }
  });

  it.each([
    [["bash", "-c", Q("terraform destroy")]],
    [["sh", "-c", Q("doctl registry garbage-collection start r")]],
    [["timeout", "5m", D("$RUNNER_TEMP/doctl"), "registry", "repository", "delete-tag", "r", "t"]],
    [["timeout", "8m", D("$GITHUB_WORKSPACE/scripts/production-db-restore-point-cleanup.mjs"), "--apply"]],
    [["bash", "-c", Q("terr''aform destroy")]],
    [["bash"], ["terraform destroy -auto-approve\n"]],
    [["timeout", "8m", "/usr/bin/node", "--synthetic-8709-option", "harmless.mjs"]],
    [["timeout", "8m", "node", D("${SYNTHETIC_8709_SCRIPT}")]],
  ])("covered payloads cannot be admitted: %j", (items, input) => {
    expectRejected(syntheticEntry(items, input), covered(syntheticEntry(items, input)));
  });

  const c3Rows = {
    absolute: ["/usr/bin/timeout", "5m", D("$TOOL"), "destroy", "-auto-approve"],
    nestedAbsolute: ["nohup", "/usr/bin/timeout", "5m", D("$TOOL"), "destroy", "-auto-approve"],
    fixedDynamicWrapper: ["nohup", D("$BIN/timeout"), "5m", D("$TOOL"), "destroy", "-auto-approve"],
    fixedDynamicShell: ["timeout", "5m", D("$BIN/bash"), "-c", Q('"$@"'), "_", D("$TOOL"), "destroy"],
    pnpmOption: ["pnpm", "--dir", ".", "exec", D("$TOOL"), "destroy", "-auto-approve"],
    pnpmDynamicSubcommand: ["pnpm", D("$MODE"), D("$TOOL"), "destroy", "-auto-approve"],
    findDynamicAction: ["find", ".", D("$ACTION"), D("$TOOL"), "destroy", ";"],
  };
  // S4 review r1 reproductions (#8970): additional program operands (F2),
  // unquoted wildcard scripts (F3), terminal fallbacks (F4) and a context-free
  // dynamic package (F7).
  const reviewRows = {
    "F2 perl": ["perl", "-e", Q("print 1"), "-e", D("$SYNTHETIC_8970_PROGRAM")],
    "F2 ruby": ["ruby", "-e", Q("puts 1"), "-e", D("$SYNTHETIC_8970_PROGRAM")],
    "F2 pwsh": ["pwsh", "-c", Q("Write-Output ok"), D("$SYNTHETIC_8970_PROGRAM")],
    "F2 sed": ["sed", Q("s/x/y/"), "-e", D("$SYNTHETIC_8970_PROGRAM"), "synthetic.txt"],
    "F2 awk": ["awk", Q("{print 1}"), "-f", D("$SYNTHETIC_8970_PROGRAM")],
    "F3 python wildcard": ["python", "*.py"],
    "F3 pnpm run wildcard": ["pnpm", "run", "synthetic-8970-*"],
    "F4 playwright dynamic action": ["playwright", D("$SYNTHETIC_8970_ACTION")],
    "F4 playwright unsupported action": ["playwright", "synthetic-8970-unsupported-action"],
    "F4 git fetch --format": ["git", "fetch", "--format"],
    "F4 curl --output": ["curl", "--output"],
    "F4 kubectl create dynamic": ["kubectl", "create", D("$SYNTHETIC_8970_ACTION")],
    "F7 context-free dynamic package": ["pnpm", "--filter", D("$workspace"), "run", "start"],
  };
  const unpinnedForms = {
    ...c3Rows,
    ...reviewRows,
    bareShell: ["bash"],
    shellStdin: ["sh", "-s"],
    dynamicShellProgram: ["bash", "-c", D("$CMD")],
    dynamicEval: ["eval", D("$CMD")],
    E1: ["timeout", "5m", D("$TOOL"), "destroy", "-auto-approve"],
    E2: ["sudo", D("$TOOL")],
    E3: ["xargs", "-I{}", "{}", "destroy"],
    E4: ["bash", "-c", Q('"$@"'), "_", D("$TOOL"), "destroy"],
    E5: ["timeout", "5m", "env", D("$TOOL")],
    E6bare: ["python"],
    E6wrapped: ["timeout", "5m", "python"],
    E6stdinWithoutInput: ["python", "-"],
    findExec: ["find", ".", "-exec", D("$TOOL"), "destroy", ";"],
  };
  it.each(Object.entries(unpinnedForms))("unpinned programs cannot be admitted: %s", (_label, items) => {
    const entry = syntheticEntry(items);
    expectRejected(entry, unpinned(entry));
  });

  it.each([
    ["wildcard", ["python", "*.py"]],
    ["question mark", ["pnpm", "run", "synthetic-8970-?"]],
    ["bracket", ["pnpm", "run", "synthetic-8970-[ab]"]],
    ["brace list", ["python", "{a,b}.py"]],
    ["brace sequence", ["tsx", "probe-{1..3}.ts"]],
    ["bare selector", ["pyth*n", "-c", Q("print(1)")]],
    ["path selector", ["/usr/bin/pyth?n", "-c", Q("print(1)")]],
    ["wrapped selector", ["timeout", "5m", "pyth*n", "-c", Q("print(1)")]],
    ["fixed-dynamic selector", ["timeout", "5m", D("$BIN/pyth*n"), "-c", Q("print(1)")]],
    ["program text", ["bash", "-c", "*"]],
    ["single-argument slot", ["docker", "exec", "*", "pg_isready"]],
    ["terminal data", ["jq", "-r", Q(".x"), "*.json"]],
  ])("filename expansion cannot select a program or fill a single-argument slot: %s", (_label, items) => {
    const entry = syntheticEntry(items);
    expectRejected(entry, unpinned(entry));
  });

  it("quoted literal patterns stay data", () => {
    expectAdmitted(syntheticEntry(["python", Q("*.py")]));
    expectAdmitted(syntheticEntry(["find", "artifacts", "-type", "f", "-name", Q("*.json")]));
    expectAdmitted(syntheticEntry(["grep", "-E", Q("^[0-9]+$"), D("$FILE")]));
  });

  // Inventory-bound matrix: every program mode below and every terminal shape
  // (generated) comes from benignAdmissionInventory, and the two key sets must
  // match exactly. Each row checks the bare control, literal path and nested
  // fixed-dynamic spellings, prefix variants, dynamic role-selecting slots, an
  // unsupported option and a proved dynamic data slot.
  const python = (name) => ({
    [`${name} -c`]: { words: [name, "-c", Q("print(1)"), "argv"], roles: [1, 2], data: 3, option: 1 },
    [`${name} -`]: { words: [name, "-", "argv"], input: ["print(1)\n"], roles: [1], data: 2, option: 1 },
    [`${name} script`]: { words: [name, "tool.py", "argv"], roles: [1], data: 2, option: 1 },
  });
  // Program flags that keep parsing options must end the command.
  const programFlag = (name, flag, text) => ({
    words: [name, flag, Q(text)],
    roles: [1, 2],
    option: 1,
    negatives: [
      [name, flag, Q(text), "argv"],
      [name, flag, Q(text), flag, Q(text)],
    ],
  });
  const programRows = {
    "timeout duration": { words: ["timeout", "5m", "jq", "-r", Q(".x")], roles: [1, 2], data: 4, option: 1 },
    "nohup forward": {
      words: ["nohup", "node", "./scripts/platform-compose-ingress.mjs", "--port", "1"],
      roles: [1, 2],
      nodeSuffix: [2],
      data: 4,
      option: 1,
    },
    "npx forward": { words: ["npx", "playwright", "--version"], roles: [1], option: 1 },
    // The classifier unwraps env/exec/command itself, so their inner form is one
    // the corpus already admits.
    "env assignments": {
      words: ["env", "MODE=x", "jq", "-r", Q(".number")],
      roles: [2],
      data: 1,
      dataWord: D("MODE=$X"),
      option: 1,
      negatives: [["env", U("MODE=$X"), "jq", "-r", Q(".number")]],
    },
    "exec forward": { words: ["exec", "jq", "-r", Q(".number")], roles: [1], option: 1 },
    "command forward": { words: ["command", "-p", "--", "jq", "-r", Q(".number")], roles: [3], option: 1 },
    "command -v": { words: ["command", "-v", "jq"], roles: [2], option: 1 },
    "pnpm exec": { words: ["pnpm", "exec", "tsx", "infra/probe.ts", "final"], roles: [1, 2, 3], data: 4, option: 1 },
    "pnpm dlx": { words: ["pnpm", "dlx", "playwright", "--version"], roles: [1, 2], option: 1 },
    "pnpm run": { words: ["pnpm", "run", "verify:static", "--", "--flag"], roles: [1, 2], data: 4, option: 1 },
    "pnpm install": { words: ["pnpm", "install", "--frozen-lockfile"], roles: [1, 2], option: 2 },
    "pnpm --filter run": {
      words: ["pnpm", "--filter", "@chase-sets/app-platform-api", "run", "synthetic-8709:script"],
      roles: [2, 3, 4],
      option: 1,
      negatives: [["pnpm", "--filter", U("$PACKAGE"), "run", "start"]],
    },
    "pnpm --filter test": {
      words: ["pnpm", "--filter", "@chase-sets/easypost-postage", "test", "--", "a.test.ts"],
      roles: [2, 3],
      data: 5,
      option: 1,
    },
    // Exercised by its own context controls below; no entry alone admits it.
    "pnpm --filter origin": { origin: true },
    "docker exec": {
      words: ["docker", "exec", D("$C"), "pg_isready", "-U", "postgres"],
      roles: [1, 3],
      data: 5,
      option: 2,
      negatives: [["docker", "exec", D("${containers[@]}"), "pg_isready"]],
    },
    "docker run": {
      words: ["docker", "run", "--rm", D("$IMAGE"), "pnpm", "run", "start"],
      roles: [1, 4, 5, 6],
      data: 3,
      option: 2,
    },
    "docker run alpine/helm:3.15.4": {
      words: ["docker", "run", "--rm", "alpine/helm:3.15.4", "lint", "charts/x"],
      roles: [1, 4],
      data: 5,
      option: 5,
    },
    "docker run ghcr.io/yannh/kubeconform:v0.6.7": {
      words: ["docker", "run", "--rm", "ghcr.io/yannh/kubeconform:v0.6.7", "-strict", "manifest.yaml"],
      roles: [1, 3],
      data: 5,
      option: 4,
    },
    "kubectl exec": {
      words: ["kubectl", "exec", D("$POD"), "--", "rm", "-f", D("$P")],
      roles: [1, 3, 4],
      data: 6,
      option: 2,
      negatives: [
        ["kubectl", "exec", D("$POD"), "--", D("$TOOL")],
        ["kubectl", "exec", "--namespace", D("${namespaces[@]}"), D("$POD"), "--", "rm", "-f", "x"],
      ],
    },
    "kubectl create job": {
      words: ["kubectl", "create", "job", "proof", "--", "node", "--version"],
      roles: [2, 5, 6],
      nodeSuffix: [6],
      option: 4,
    },
    "find -type f -name": {
      words: ["find", "artifacts", "-type", "f", "-name", Q("*.json")],
      roles: [1, 2, 3, 4, 5],
      option: 2,
      negatives: [["find", "artifacts", "-type", "f", "-name", "*.json"]],
    },
    "eval program": { words: ["eval", Q("echo ok")], roles: [1], option: 1 },
    ...Object.fromEntries(
      ["bash", "sh", "dash", "zsh", "ksh"].map((name) => [
        `${name} -c`,
        { words: [name, "-c", Q("echo ok")], roles: [1, 2], option: 1, negatives: [[name, "-c", Q("echo ok"), "_"]] },
      ]),
    ),
    ...python("python"),
    ...python("python3"),
    "perl -e": programFlag("perl", "-e", "print 1"),
    "perl -": { words: ["perl", "-", "argv"], input: ["print 1;\n"], roles: [1], data: 2, option: 1 },
    "perl script": { words: ["perl", "tool.pl", "argv"], roles: [1], data: 2, option: 1 },
    "ruby -e": programFlag("ruby", "-e", "puts 1"),
    "ruby -": { words: ["ruby", "-", "argv"], input: ["puts 1\n"], roles: [1], data: 2, option: 1 },
    "ruby script": { words: ["ruby", "tool.rb", "argv"], roles: [1], data: 2, option: 1 },
    "pwsh -c": programFlag("pwsh", "-c", "Write-Output ok"),
    "pwsh script": {
      words: ["pwsh", "tool.ps1", "argv"],
      roles: [1],
      data: 2,
      option: 1,
      negatives: [["pwsh", "-"]],
    },
    "node -e": { ...programFlag("node", "-e", "1"), nodeSuffix: [1], optionCovered: true },
    "node -": { words: ["node", "-", "argv"], input: ["1\n"], roles: [1], nodeSuffix: [1], data: 2 },
    "node --version": {
      words: ["node", "--version"],
      roles: [1],
      nodeSuffix: [1],
      option: 2,
      optionCovered: true,
    },
    "node script": {
      words: ["node", "./scripts/platform-compose-ingress.mjs", "--port", "1"],
      roles: [1],
      nodeSuffix: [1],
      data: 3,
      option: 1,
      optionCovered: true,
    },
    "tsx script": { words: ["tsx", "infra/probe.ts", "a"], roles: [1], data: 2, option: 1 },
    "psql options": {
      words: ["psql", "-U", "postgres", "-c", Q("SELECT 1")],
      roles: [3, 4],
      data: 2,
      option: 1,
      negatives: [
        ["psql", "-c", D("$SQL")],
        ["psql", "-c", Q("\\! sh")],
      ],
    },
    "trap action": { words: ["trap", "cleanup", "EXIT"], roles: [1, 2] },
    "awk program": { words: ["awk", "-F", Q("="), Q("{print $3}"), "file"], roles: [3], data: 4, option: 1 },
    "sed program": {
      words: ["sed", "-i", Q("/x/d"), "file"],
      roles: [2],
      data: 3,
      option: 1,
      negatives: [
        ["sed", "-i", Q("/x/d"), "file", "--expression=p"],
        ["sed", "-i.bak", Q("/x/d"), "file"],
      ],
    },
    "local declarations": { words: ["local", "MODE=x"], data: 1, dataWord: D("MODE=$X") },
    "export declarations": { words: ["export", "MODE=x"], data: 1, dataWord: D("MODE=$X") },
  };
  const inventory = benignAdmissionInventory();
  const terminalRows = inventory.filter((row) => row.kind === "terminal");

  it("the matrix covers exactly the closed admission inventory", () => {
    const modes = inventory.filter((row) => row.kind === "program").map((row) => `${row.selector} ${row.mode}`);
    expect(Object.keys(programRows).sort()).toEqual([...modes].sort());
    expect(new Set(modes).size).toBe(modes.length);
    expect(terminalRows.length).toBeGreaterThan(100);
    // Generated path negatives assume no selector mixes command paths with a
    // shape that would take the replaced word as data.
    for (const row of terminalRows.filter(({ path }) => !path)) {
      const named = terminalRows.filter(({ selector, path }) => selector === row.selector && path);
      if (named.length) expect(row.operands, row.selector).toBe(0);
    }
  });

  const pathSpelling = (words) => [W(`/usr/bin/${word(words[0]).value}`), ...words.slice(1)];
  const prefixNegatives = (words) => [
    ["timeout", "5m"],
    ["timeout", "5m", D("$TOOL"), ...words.slice(1)],
    ["timeout", "-k", "5", "5m", ...words],
    ["timeout", D("$DURATION"), ...words],
    ["nice", ...words],
    ["sudo", ...words],
    ["env", "-i", ...words],
    ["exec", "-a", "x", ...words],
  ];

  // Node-suffix positions are refused by the earlier covered-invocation step
  // (first failure wins); every other refusal is the unpinned-program one.
  it.each(Object.entries(programRows).filter(([, row]) => !row.origin))(
    "rule matrix: %s",
    (_key, { words, input, roles = [], nodeSuffix = [], data, dataWord, option, optionCovered, negatives = [] }) => {
      const entry = (items) => syntheticEntry(items, input);
      const admitted = [
        words,
        pathSpelling(words),
        ["timeout", "5m", D(`$BIN/${word(words[0]).value}`), ...words.slice(1)],
        ["nohup", "timeout", "5m", ...words],
        ...(data === undefined ? [] : [at(words, data, dataWord ?? D("$SYNTHETIC_8709_DATA"))]),
      ].map(entry);
      const rejected = [
        ...prefixNegatives(words).map((items) => [entry(items), unpinned]),
        ...roles.map((index) => [
          entry(at(words, index, D("$SYNTHETIC_8709_ROLE"))),
          nodeSuffix.includes(index) ? covered : unpinned,
        ]),
        ...(option === undefined
          ? []
          : [[entry(insert(words, option, "--synthetic-8709-option")), optionCovered ? covered : unpinned]]),
        ...negatives.map((items) => [entry(items), unpinned]),
      ].map(([candidate, violation]) => [candidate, violation(candidate)]);
      expectBatch(admitted, rejected);
    },
  );

  // Terminal shapes, generated from their option tables: every spelling of
  // every option is admitted; missing, extra or variadic values, the wrong
  // spelling, unknown and dynamic option names, dynamic or unknown command path
  // words and operands beyond the shape's bound are refused.
  const value = D("$SYNTHETIC_8709_VALUE");
  const spellings = (name, { flag, inline, values }) => [
    ...(flag ? [[name]] : []),
    ...(inline ? [[D(`${name}=$SYNTHETIC_8709_VALUE`)]] : []),
    ...(values ? [[name, ...Array(values).fill(value)]] : []),
  ];
  it.each(terminalRows.map((row) => [`${row.selector}${row.path ? ` ${row.path}` : ""}`, row]))(
    "terminal shape: %s",
    (_label, { selector, path, global, options, operands, variadic }) => {
      const head = selector.split(" ");
      const command = path ? path.split(" ") : [];
      const base = [...head, ...command];
      const admitted = [
        base,
        [`/usr/bin/${head[0]}`, ...base.slice(1)],
        // A fixed-dynamic spelling exists only for path-safe basenames.
        ...(/^[\w./-]+$/.test(head[0]) ? [["timeout", "5m", D(`$BIN/${head[0]}`), ...base.slice(1)]] : []),
        ...Object.entries(global).flatMap(([name, spec]) =>
          spellings(name, spec).map((spelling) => [...head, ...spelling, ...command]),
        ),
        ...Object.entries(options).flatMap(([name, spec]) =>
          spellings(name, spec).map((spelling) => [...base, ...spelling]),
        ),
        ...(operands > 0 ? [[...base, D("$SYNTHETIC_8709_DATA")]] : []),
        ...(variadic ? [[...base, U("$SYNTHETIC_8709_LIST")]] : []),
        ...(options["--"] ? [[...base, "--", U("$SYNTHETIC_8709_LIST")]] : []),
      ];
      const rejected = [
        [...base, "--synthetic-8709-option"],
        [...base, D("--synthetic-8709-$OPTION")],
        ...Object.entries(options)
          .filter(([name]) => name !== "--")
          .flatMap(([name, { flag, inline, values }]) => [
            ...(inline ? [] : [[...base, `${name}=synthetic`]]),
            ...(flag ? [] : [[...base, name]]),
            ...(values ? [[...base, name, ...Array(values - 1).fill(value), U("$SYNTHETIC_8709_LIST")]] : []),
          ]),
        ...command.flatMap((_part, index) => [
          [...head, ...at(command, index, D("$SYNTHETIC_8709_ACTION"))],
          [...head, ...at(command, index, "synthetic-8709-action")],
        ]),
        ...(Number.isFinite(operands) ? [[...base, ...Array(operands + 1).fill("synthetic-8709-data")]] : []),
        ...(variadic ? [] : [[...base, U("$SYNTHETIC_8709_LIST")]]),
      ];
      expectBatch(
        admitted.map((items) => syntheticEntry(items)),
        rejected.map((items) => {
          const entry = syntheticEntry(items);
          return [entry, unpinned(entry)];
        }),
      );
    },
  );

  it("rejects unknown utilities and multi-argument expansions in single-argument slots", () => {
    for (const items of [
      ["synthetic-8709-tool", "x"],
      ["git", "fetch", U("$REFS")],
      ["pnpm", "--filter", U("$PACKAGE"), "run", "start"],
      ["docker", "exec", D("${containers[@]}"), "pg_isready"],
      ["env", U("MODE=$X"), "jq", Q(".x")],
      ["psql", "-c", D("$SQL")],
      ["psql", "-c", Q("\\! sh")],
      ["kubectl", "exec", D("$POD"), "--", D("$TOOL")],
      ["kubectl", "synthetic-plugin", "x"],
      ["kubectl", "-n", D("${namespaces[@]}"), "get", "pods"],
      ["kubectl", "exec", "--namespace", D("${namespaces[@]}"), D("$POD"), "--", "rm", "-f", "x"],
      ["docker", "compose", "-f", U("$FILES"), "ps"],
      ["git", "-c", "core.sshCommand=x", "fetch"],
      ["git", "config", "core.sshCommand", D("$X")],
      ["docker", "compose", "-f", "compose.yml", "exec", "app", "sh"],
    ]) {
      const entry = syntheticEntry(items);
      expectRejected(entry, unpinned(entry));
    }
  });

  // F1: a committed entry stays admitted only for the actual spelling it
  // proves; partial quoting re-runs admission on the lexed tokens and refuses
  // with that entry's named diagnostic.
  const postgresProbe = 'docker exec "$POSTGRES_CONTAINER_ID" pg_isready -U postgres -d postgres';
  const timeoutPsql = DESTRUCTIVE_GRAMMAR.benignForms.find((entry) =>
    entry.example.startsWith('timeout 15s docker exec "$POSTGRES_CONTAINER_ID" psql'),
  );
  const fixedJq = syntheticEntry(["timeout", "5m", D("$BIN/jq"), "-r", Q(".x")]);
  const fixedTimeout = syntheticEntry(["nohup", D("$BIN/timeout"), "5m", "jq", "-r", Q(".x")]);
  const quotedPattern = syntheticEntry(["python", Q("x*.py")]);
  const partialQuoting = {
    "empty quotes after": [
      postgresProbe,
      postgresProbe.replace('"$POSTGRES_CONTAINER_ID"', '$POSTGRES_CONTAINER_ID""'),
    ],
    "empty quotes before": [
      postgresProbe,
      postgresProbe.replace('"$POSTGRES_CONTAINER_ID"', '""$POSTGRES_CONTAINER_ID'),
    ],
    "single quotes after": [
      postgresProbe,
      postgresProbe.replace('"$POSTGRES_CONTAINER_ID"', "$POSTGRES_CONTAINER_ID''"),
    ],
    "nested timeout docker": [
      timeoutPsql.example,
      timeoutPsql.example.replace('"$POSTGRES_CONTAINER_ID"', '$POSTGRES_CONTAINER_ID""'),
    ],
    "fixed-basename selector": [fixedJq.example, `timeout 5m $BIN"/jq" -r '.x'`, fixedJq],
    "fixed-basename prefix": [fixedTimeout.example, `nohup $BIN"/timeout" 5m jq -r '.x'`, fixedTimeout],
    "partially quoted pattern": [quotedPattern.example, 'python "x"*.py', quotedPattern],
  };
  it.each(Object.entries(partialQuoting))(
    "partial quoting cannot reuse a proved entry: %s",
    (_label, [proved, run, synthetic]) => {
      const grammar = synthetic ? withEntry(synthetic) : DESTRUCTIVE_GRAMMAR;
      expect(classifyShellCommands(proved, { grammar }).indeterminate).toEqual([]);
      const entry = synthetic ?? DESTRUCTIVE_GRAMMAR.benignForms.find(({ example }) => example === proved);
      const [refusal, ...others] = classifyShellCommands(run, { grammar }).indeterminate;
      expect([refusal.reason, others]).toEqual([unpinned(entry), []]);
      const ungated = checkWorkflowDestructiveOperationGating(pushWorkflow(run), { grammar });
      expect(ungated.passed).toBe(false);
      expect(ungated.checkedSteps).toEqual([expect.objectContaining({ disposition: "INDETERMINATE" })]);
      expect(ungated.violations).toContainEqual(expect.stringContaining(refusal.reason));
      const source = changeWorkflow(productionFile, (workflow) => {
        workflow.jobs["deploy-production"].steps.push({ name: "Synthetic 8709 payload", run });
      });
      const exempt = checkWorkflowDestructiveOperationGating(source, { workflowFile: productionFile, grammar });
      expect(exempt.passed).toBe(false);
      expect(exempt.violations).toContainEqual(expect.stringContaining(refusal.reason));
    },
  );

  const suppressionNegatives = {
    "AC2 shell payload": ["bash", "-c", Q("terraform destroy")],
    E1: ["timeout", "5m", D("$TOOL"), "destroy", "-auto-approve"],
    ...c3Rows,
    ...reviewRows,
  };
  it.each(Object.entries(suppressionNegatives))(
    "benign payload cannot suppress exempt inventory or ungated workflows: %s",
    (_label, items) => {
      const entry = syntheticEntry(items);
      const grammar = withEntry(entry);
      const [violation] = validateGrammarPartition(grammar).violations;
      expect(violation).toMatch(/: benign payload (?:contains a covered invocation|admits an unpinned program)\.$/);
      const ungated = checkWorkflowDestructiveOperationGating(pushWorkflow(entry.example), { grammar });
      expect(ungated.passed).toBe(false);
      expect(ungated.checkedSteps).toEqual([expect.objectContaining({ disposition: "INDETERMINATE" })]);
      expect(ungated.violations).toContainEqual(expect.stringContaining(violation));
      const source = changeWorkflow(productionFile, (workflow) => {
        workflow.jobs["deploy-production"].steps.push({ name: "Synthetic 8709 payload", run: entry.example });
      });
      const exempt = checkWorkflowDestructiveOperationGating(source, { workflowFile: productionFile, grammar });
      expect(exempt.passed).toBe(false);
      expect(exempt.checkedSteps.length).toBeGreaterThan(0);
      expect(exempt.checkedSteps).toContainEqual(
        expect.objectContaining({ name: "Synthetic 8709 payload", disposition: "INDETERMINATE" }),
      );
      expect(exempt.violations).toContainEqual(expect.stringContaining(violation));
      expect(exempt.violations).toContainEqual(expect.stringContaining("exact invocation multiset required"));
    },
  );

  it("the suppression harness passes a corpus-shaped positive", () => {
    // Same harness as above: the named rejection is the governing difference,
    // not the fixture.
    const positive = syntheticEntry(["timeout", "5m", "jq", "-r", Q(".x")]);
    const grammar = withEntry(positive);
    expect(checkWorkflowDestructiveOperationGating(pushWorkflow(positive.example), { grammar })).toEqual({
      passed: true,
      checkedSteps: [],
      violations: [],
    });
    const source = changeWorkflow(productionFile, (workflow) => {
      workflow.jobs["deploy-production"].steps.push({ name: "Synthetic 8709 payload", run: positive.example });
    });
    expect(checkWorkflowDestructiveOperationGating(source, { workflowFile: productionFile, grammar })).toMatchObject({
      passed: true,
      violations: [],
    });
  });

  it("the classifier caller enforces admission even after a proved grammar is mutated", () => {
    const negative = syntheticEntry(["timeout", "5m", D("$TOOL"), "destroy", "-auto-approve"]);
    const positive = syntheticEntry(["timeout", "5m", "jq", "-r", Q(".x")]);
    DESTRUCTIVE_GRAMMAR.benignForms.push(negative, positive);
    try {
      expect(classifyShellCommands(negative.example).indeterminate).toEqual([
        expect.objectContaining({ reason: unpinned(negative) }),
      ]);
      expect(classifyShellCommands(positive.example).indeterminate).toEqual([]);
    } finally {
      DESTRUCTIVE_GRAMMAR.benignForms.splice(-2, 2);
    }
    expect(classifyShellCommands(positive.example).indeterminate).toHaveLength(1);
  });

  it("preserves the corpus forwarding, interpreter and data controls", () => {
    const corpusExample = (pattern) => {
      const entry = DESTRUCTIVE_GRAMMAR.benignForms.find((candidate) => pattern.test(candidate.example));
      expect(entry, String(pattern)).toBeDefined();
      return entry;
    };
    for (const pattern of [
      /^timeout 15s docker exec "\$POSTGRES_CONTAINER_ID" psql/,
      /^nohup node \.\/scripts\/platform-compose-ingress\.mjs/,
      /^pnpm exec tsx /,
      /^python - <</,
      /^docker exec "\$POSTGRES_CONTAINER_ID" sh -c/,
      /^kubectl create job platform-image-pull-proof .* -- node --version$/,
      /^pnpm --filter @chase-sets\/app-platform-api run admin-qa-actor-fixtures:production$/,
      /^pnpm --filter @chase-sets\/app-platform-api run representative-commerce-state:production$/,
      /^pnpm --filter @chase-sets\/easypost-postage test -- easypost-smoke\.test\.ts$/,
      /^pnpm --filter @chase-sets\/easypost-postage run test tests\/combined-parcel-probe\.test\.ts$/,
      /^find "\$EVIDENCE_DIR" -type f -name 'staging-wake-drill-\*\.json' ! -name/,
      /^find "\$EVIDENCE_DIR" -type f -name 'staging-wake-drill-load-evaluation\.json'/,
    ])
      expect(classifyShellCommands(corpusExample(pattern).example).indeterminate, String(pattern)).toEqual([]);
    for (const run of [
      "tee artifacts/release-health/staging-terraform-diagnostics.txt",
      "rm -rf .terraform",
      "jq -r '.x' tfplan.json",
      "../../../scripts/terraform-init-with-retry.sh -reconfigure",
    ])
      expect(classifyShellCommands(run).operations, run).toEqual([]);
    for (const items of [
      ["tee", "artifacts/release-health/staging-terraform-diagnostics.txt"],
      ["rm", "-rf", ".terraform"],
      ["jq", "-r", Q(".x"), "tfplan.json"],
      ["../../../scripts/terraform-init-with-retry.sh", "-reconfigure"],
    ])
      expectAdmitted(syntheticEntry(items));
    for (const items of [
      ["tee", "terraform"],
      ["jq", "-r", Q(".x"), "./terraform"],
    ]) {
      const entry = syntheticEntry(items);
      expectRejected(entry, covered(entry));
    }
  });

  it("Bash word whitespace terminates and unknown forms fail closed", () => {
    for (const run of ["echo hello world", "echo hello world", "echo a\vb", "echo a\fb"])
      expect(classifyShellCommands(run), JSON.stringify(run)).toMatchObject({ operations: [], indeterminate: [] });
    for (const run of ["﻿echo a", "terraform destroy", "terraform\vdestroy", "terraform\fdestroy"])
      expect(classifyShellCommands(run).indeterminate, JSON.stringify(run)).toContainEqual(
        expect.objectContaining({ disposition: "INDETERMINATE", reason: "unlisted executable form" }),
      );
    for (const run of ["\\", "'", '"$(', "`", "${", "$((", "((", "<(", "\u0000\u0001 ", "a\\\r", "<<", "cat <<"])
      expect(Array.isArray(classifyShellCommands(run).invocations), JSON.stringify(run)).toBe(true);
  });

  it("benign forwarding and fixed selectors stay green", () => {
    for (const selector of ["timeout", "nohup"]) {
      for (const entry of DESTRUCTIVE_GRAMMAR.benignForms.filter((form) => form.selector === selector)) {
        expect(classifyShellCommands(entry.example).indeterminate).toEqual([]);
        const mutant = entry.example.replace(
          /\.\/scripts\/[^\s]+|docker/,
          "./scripts/production-db-restore-point-cleanup.mjs",
        );
        expect(mutant).not.toBe(entry.example);
        expect(classifyShellCommands(mutant).indeterminate.length).toBeGreaterThan(0);
        expect(classifyShellCommands(`${entry.example} "$(terraform destroy)"`).operations).toContain(
          "terraform:destroy",
        );
      }
    }
    expect(operations('"$RUNNER_TEMP/doctl" registry repository delete-tag r t')).toEqual([
      "doctl:registry-repository-delete-tag",
    ]);
    expect(
      classifyShellCommands('binary="${RUNNER_TEMP}/kubectl-argo-rollouts"\n"$binary" version').indeterminate,
    ).toEqual([]);
    expect(operations('binary="${RUNNER_TEMP}/kubectl-argo-rollouts"\nbinary=terraform\n"$binary" destroy')).toEqual([
      "terraform:destroy",
    ]);
    for (const run of [
      'binary="${RUNNER_TEMP}/kubectl-argo-rollouts"\nbinary+=terraform\n"$binary" version',
      'if true; then binary=terraform; fi\n"$binary" destroy',
      'binary=terraform\nread binary\n"$binary" destroy',
      'false && binary="${RUNNER_TEMP}/kubectl-argo-rollouts"\n"$binary" version',
      '(binary="${RUNNER_TEMP}/kubectl-argo-rollouts")\n"$binary" version',
      '"$(echo terraform)" destroy',
    ])
      expect(classifyShellCommands(run).indeterminate.length, run).toBeGreaterThan(0);
    for (const run of [
      "mkdir -p doctl",
      "cp doctl other",
      "chmod +x doctl",
      "install -m 0755 doctl target",
      "command -v doctl",
    ])
      expect(classifyShellCommands(run), run).toMatchObject({ operations: [], indeterminate: [] });
  });

  it("shell dispositions constrain executable and data positions", () => {
    expect(operations('echo "$(( $(terraform destroy) + 1 ))"')).toEqual(["terraform:destroy"]);
    for (const run of [
      "select item in data; do echo data; done",
      "for ((i=0;i<1;i++)); do echo data; done",
      "coproc echo data",
      "time echo data",
      "((terraform destroy))",
      "(echo data",
      "echo >",
      "if true; then echo data",
      "echo ${missing",
      "echo ${ echo data; }",
      "echo data &&",
      "|| echo data",
      "install --strip-program=terraform -s source target",
      "printf -v 'a[$(terraform destroy)]' data",
      "tools=(echo data; terraform destroy)",
      "if true; fi",
      "while true; done",
      "case data esac",
    ])
      expect(classifyShellCommands(run).indeterminate.length, run).toBeGreaterThan(0);
    const grammar = structuredClone(DESTRUCTIVE_GRAMMAR);
    for (const member of grammar.partition.filter((item) => item.form.production === "arith_command"))
      member.disposition = "INDETERMINATE";
    expect(classifyShellCommands('echo "$((terraform + destroy))"', { grammar }).indeterminate.length).toBeGreaterThan(
      0,
    );
    const nonBash = parse(pushWorkflow("Write-Output safe"));
    nonBash.jobs.anonymous.steps[0].shell = "pwsh";
    expect(checkWorkflowDestructiveOperationGating(stringify(nonBash)).violations).toContainEqual(
      expect.stringContaining("unproved non-Bash"),
    );
  });

  it.each(["PATH+=:/opt/bin terraform destroy -auto-approve", "((terraform destroy) )"])(
    "reviewer ungated push reproduction refuses: %s",
    (run) => {
      expect(operations(run)).toEqual(["terraform:destroy"]);
      const result = checkWorkflowDestructiveOperationGating(pushWorkflow(run));
      expect(result.passed).toBe(false);
      expect(result.checkedSteps).toHaveLength(1);
    },
  );

  it.each([
    'env -i doctl -t "$T" registry repository delete-tag r t',
    "timeout 8m node ./scripts/production-db-restore-point-cleanup.mjs --apply",
    "env -i terraform destroy",
    "env -u HOME terraform destroy",
    "env -- terraform destroy",
    "exec -a tf terraform destroy",
    "exec -c terraform destroy",
    "bash -c 'terraform destroy'",
    "sh -c 'doctl registry repository delete-tag r t'",
    "bash <<EOF\nterraform destroy\nEOF",
    "bash <<< 'terraform destroy'",
    "eval 'terraform destroy'",
    "builtin eval 'terraform destroy'",
    "source fixture.sh",
    ". fixture.sh",
    "sudo terraform destroy",
    "xargs terraform destroy",
    "pnpm exec terraform destroy",
    "npx terraform destroy",
    "$TF destroy",
    '"${TERRAFORM_BIN}" destroy',
    '"$(command -v terraform)" destroy',
    "${{ inputs.tool }} destroy",
    "terraform${EMPTY} destroy",
    "nohup node ./scripts/digitalocean-registry-cleanup.mjs --dry-run=false &",
    "synthetic-8709-selector harmless",
    "echo 'unterminated",
  ])("unresolved executable forms fail closed: %s", (run) => {
    expect(classifyShellCommands(run).indeterminate.length).toBeGreaterThan(0);
    const result = checkWorkflowDestructiveOperationGating(pushWorkflow(run));
    expect(result.passed).toBe(false);
    expect(result.checkedSteps).toHaveLength(1);
  });

  it("uncertainty cannot disappear from cleanup or exemption inventory", () => {
    const wrapped = readWorkflow(registryFile).replace(
      "node ./scripts/digitalocean-registry-cleanup.mjs",
      "timeout 30m node ./scripts/digitalocean-registry-cleanup.mjs",
    );
    expect(wrapped).not.toBe(readWorkflow(registryFile));
    const result = checkWorkflowDestructiveOperationGating(wrapped, { workflowFile: registryFile });
    expect(result.passed).toBe(false);
    expect(result.checkedSteps).toHaveLength(1);
    expect(result.violations).toContainEqual(expect.stringContaining("INDETERMINATE"));
    const production = changeWorkflow(productionFile, (workflow) => {
      workflow.jobs["deploy-production"].steps.push({
        run: "timeout 30m node ./scripts/digitalocean-registry-cleanup.mjs --apply",
      });
    });
    expect(
      checkWorkflowDestructiveOperationGating(production, { workflowFile: productionFile }).violations,
    ).toContainEqual(expect.stringContaining("exact invocation multiset required"));
  });
});

// #8709 F7 decision: "$workspace" is admitted only inside the two complete
// boot_smoke blocks at 926050f8, at their proved substitution occurrence.
describe("origin-proved dynamic package selection", () => {
  const originBlocks = [
    {
      id: originIds[0],
      file: ".github/workflows/platform-pr.yml",
      job: "docker-image",
      bytes: 1681,
      sha256: "e48422407d8d8524fc51f1174991009aa0a794b09ffcb183d360b83116be3c15",
    },
    {
      id: originIds[1],
      file: productionFile,
      job: "build-image",
      bytes: 1638,
      sha256: "fb2ed0ee188f938991ce89b677bbe174cfdee0845a6d09468c7fe0e8b6ecb898",
    },
  ];
  // YAML-decoded, as the detector receives a step's run text.
  const blockRun = ({ file, job }) => parse(readWorkflow(file)).jobs[job].steps[6].run;
  const entryOf = ({ id }) => DESTRUCTIVE_GRAMMAR.benignForms.find((entry) => entry.id === id);
  const change = (run, from, to) => {
    expect(run).toContain(from);
    return run.replace(from, to);
  };
  const marketplaceCall = 'boot_smoke marketplace "@chase-sets/app-marketplace-web" /health/ready 18080';
  const publicCall = 'boot_smoke public-web "@chase-sets/app-public-web" / 18081';
  const command = 'pnpm --filter "$workspace" run start';
  // Changed callers, bindings and surrounding text; the command and entry
  // spelling stay unchanged.
  const contextChanges = (run) => ({
    "marketplace package dynamic": change(run, marketplaceCall, marketplaceCall.replace(/"[^"]+"/, '"$OTHER"')),
    "public package dynamic": change(run, publicCall, publicCall.replace(/"[^"]+"/, '"$OTHER"')),
    "marketplace package changed": change(
      run,
      marketplaceCall,
      marketplaceCall.replace("marketplace-web", "other-web"),
    ),
    "public package changed": change(run, publicCall, publicCall.replace('public-web"', 'other-web"')),
    "option-shaped package": change(run, marketplaceCall, marketplaceCall.replace(/"[^"]+"/, "--dir=elsewhere")),
    "third caller": `${run}boot_smoke admin "@chase-sets/app-admin-web" / 18082\n`,
    "callers removed": change(change(run, `${marketplaceCall}\n`, ""), `${publicCall}\n`, ""),
    "binding changed": change(run, 'workspace="$2"', 'workspace="$3"'),
    "binding reassigned": change(run, 'workspace="$2"\n', 'workspace="$2"\n  workspace="$OTHER"\n'),
    "positional parameters reset": change(
      run,
      `${marketplaceCall}\n`,
      `set -- marketplace "$OTHER"\n${marketplaceCall}\n`,
    ),
    "text appended": `${run}echo appended\n`,
    "text prepended": `echo prepended\n${run}`,
  });
  // Changed command spellings inside the otherwise complete block.
  const commandChanges = {
    unquoted: "pnpm --filter $workspace run start",
    "empty quotes": 'pnpm --filter $workspace"" run start',
    suffix: 'pnpm --filter "$workspace"suffix run start',
    braced: 'pnpm --filter "${workspace}" run start',
    "other variable": 'pnpm --filter "$OTHER" run start',
    "all arguments": 'pnpm --filter "$@" run start',
    "array expansion": 'pnpm --filter "${args[@]}" run start',
    "command substitution": 'pnpm --filter "$(printf x)" run start',
    "dynamic script": 'pnpm --filter "$workspace" run "$SCRIPT"',
    "second filter": 'pnpm --filter "$workspace" --filter other run start',
    "unknown option": 'pnpm --filter "$workspace" --synthetic-8709-option run start',
  };
  const expectWorkflowRefused = (run) => {
    const ungated = checkWorkflowDestructiveOperationGating(pushWorkflow(run));
    expect(ungated.passed).toBe(false);
    expect(ungated.checkedSteps).toEqual([expect.objectContaining({ disposition: "INDETERMINATE" })]);
  };

  it.each(originBlocks.map((block) => [block.file, block]))(
    "C1 the complete origin block admits its preserved entry: %s",
    (_file, block) => {
      const entry = entryOf(block);
      expect(entry.origin).toEqual({ sha: corpusSha, path: block.file, job: block.job, step: 7 });
      expect(entry.id).toBe(sha256(JSON.stringify({ selector: entry.selector, words: entry.words })));
      const run = blockRun(block);
      expect([Buffer.byteLength(run), sha256(run)]).toEqual([block.bytes, block.sha256]);
      expect(classifyShellCommands(run)).toMatchObject({ operations: [], indeterminate: [] });
      expect(classifyShellCommands(run.replaceAll("\n", "\r\n")).indeterminate).toEqual([]);
      expect(checkWorkflowDestructiveOperationGating(pushWorkflow(run))).toEqual({
        passed: true,
        checkedSteps: [],
        violations: [],
      });
      const source = changeWorkflow(productionFile, (workflow) => {
        workflow.jobs["deploy-production"].steps.push({ name: "Synthetic 8709 origin block", run });
      });
      expect(checkWorkflowDestructiveOperationGating(source, { workflowFile: productionFile })).toMatchObject({
        passed: true,
        violations: [],
      });
    },
  );

  it("C2 every corpus --filter entry stays admitted", () => {
    const filters = DESTRUCTIVE_GRAMMAR.benignForms.filter((entry) =>
      entry.words?.some(({ value }) => value === "--filter"),
    );
    expect(filters).toHaveLength(8);
    expect(filters.filter(({ id }) => originIds.includes(id))).toHaveLength(2);
    for (const entry of filters.filter(({ id }) => !originIds.includes(id)))
      expect(classifyShellCommands(entry.example).indeterminate, entry.example).toEqual([]);
    expect(filters.map(({ example }) => example)).toContainEqual(
      expect.stringMatching(/--filter @chase-sets\/easypost-postage test -- /),
    );
  });

  it.each(originBlocks.map((block) => [block.file, block]))(
    "C3/C7 changed callers, bindings or block text refuse the unchanged command: %s",
    (_file, block) => {
      // The stored entry still validates; only the runtime context changed.
      expect(validateGrammarPartition().passed).toBe(true);
      for (const [label, run] of Object.entries(contextChanges(blockRun(block)))) {
        expect(classifyShellCommands(run).indeterminate, label).toContainEqual(
          expect.objectContaining({ reason: unpinned(entryOf(block)) }),
        );
        expectWorkflowRefused(run);
      }
    },
  );

  it.each(originBlocks.map((block) => [block.file, block]))(
    "C4 the command outside its proved block or occurrence refuses: %s",
    (_file, block) => {
      const entry = entryOf(block);
      const run = blockRun(block);
      const refusals = {
        "docker command alone": entry.example,
        "pnpm command alone": command,
        "function alone": run.slice(0, run.indexOf(marketplaceCall)),
        "other occurrence": `probe="$(${entry.example})"`,
      };
      // Valid and invalid contexts in both orders: no proof leaks between runs.
      const sequence = [run, ...Object.values(refusals), run];
      for (const order of [sequence, [...sequence].reverse()])
        for (const candidate of order) {
          const { indeterminate } = classifyShellCommands(candidate);
          if (candidate === run) expect(indeterminate).toEqual([]);
          else expect(indeterminate.length, candidate).toBeGreaterThan(0);
        }
      expect(classifyShellCommands(entry.example).indeterminate).toEqual([
        expect.objectContaining({ reason: unpinned(entry) }),
      ]);
      for (const candidate of Object.values(refusals)) expectWorkflowRefused(candidate);
    },
  );

  it.each(Object.entries(commandChanges))(
    "C5 a changed command spelling refuses inside the block: %s",
    (_label, spelling) => {
      for (const block of originBlocks) {
        const run = change(blockRun(block), command, spelling);
        expect(classifyShellCommands(run).indeterminate.length, block.file).toBeGreaterThan(0);
        expectWorkflowRefused(run);
      }
    },
  );

  it("C5/C6/C7 mutated, forged or covered origin entries are refused by both callers", () => {
    const entry = entryOf(originBlocks[0]);
    const workspace = entry.words.findIndex(({ value }) => value === "$workspace");
    const rehashed = (words) => ({ ...syntheticEntry(words), origin: entry.origin, proof: entry.proof });
    const mutated = [
      at(entry.words, workspace, U("$workspace")),
      at(entry.words, workspace, D("$workspacesuffix")),
      at(entry.words, workspace, D("${workspace}")),
      at(entry.words, workspace, D("$OTHER")),
      at(entry.words, workspace, D("$@")),
      at(entry.words, workspace, D("${args[@]}")),
      at(entry.words, workspace, D("$(printf x)")),
      at(entry.words, entry.words.length - 1, D("$SCRIPT")),
      insert(entry.words, workspace + 1, W("--synthetic-8709-option")),
      [W("pnpm"), ...entry.words.slice(workspace - 1)],
    ].map(rehashed);
    for (const candidate of mutated) expectRejected(candidate, unpinned(candidate));
    // The exact words under any other origin.
    for (const origin of [
      { ...entry.origin, step: 8 },
      { ...entry.origin, job: "build-image" },
      { ...entry.origin, path: ".github/workflows/synthetic-8709.yml" },
      { ...entry.origin, sha: "f".repeat(40) },
    ]) {
      const forged = { ...entry, origin };
      expectRejected(forged, unpinned(forged));
    }
    // A copied identity over changed words, and a covered insertion.
    const copied = { ...entry, words: at(entry.words, workspace, D("$OTHER")) };
    expectRejected(copied, `${entry.id}: changed benign form identity.`);
    const coveredEntry = rehashed([...entry.words, W("terraform")]);
    expectRejected(coveredEntry, covered(coveredEntry));
    const run = change(blockRun(originBlocks[0]), '  host_port="$4"\n', '  host_port="$4"\n  terraform destroy\n');
    expect(operations(run)).toEqual(["terraform:destroy"]);
    expect(checkWorkflowDestructiveOperationGating(pushWorkflow(run)).passed).toBe(false);
  });

  // A mutant of the detector, written inside the repository so it resolves the
  // same dependencies; each replacement must occur exactly once.
  async function importMutant(replacements) {
    let source = readFileSync(join(root, "scripts/workflow-destructive-op-gating.mjs"), "utf8");
    for (const [from, to] of replacements) {
      expect(source.split(from)).toHaveLength(2);
      source = source.replace(from, to);
    }
    const cache = join(root, "node_modules", ".cache");
    mkdirSync(cache, { recursive: true });
    const directory = mkdtempSync(join(cache, "workflow-destructive-op-gating-mutant-"));
    fixtureDirectories.push(directory);
    copyFileSync(
      join(root, "scripts/workflow-destructive-op-gating-grammar.json"),
      join(directory, "workflow-destructive-op-gating-grammar.json"),
    );
    writeFileSync(join(directory, "workflow-destructive-op-gating.mjs"), source);
    return import(pathToFileURL(join(directory, "workflow-destructive-op-gating.mjs")).href);
  }

  it("C8 the origin context check is load-bearing", async () => {
    const bypass = await importMutant([["context.origin !== null &&", "true &&"]]);
    for (const block of originBlocks) {
      const run = blockRun(block);
      expect(bypass.classifyShellCommands(run).indeterminate).toEqual([]);
      // Without the context check no changed-context control refuses the
      // command, so that check alone refuses them.
      const entry = entryOf(block);
      const refusal = expect.objectContaining({ reason: unpinned(entry) });
      for (const [label, changed] of Object.entries(contextChanges(run))) {
        expect(bypass.classifyShellCommands(changed).indeterminate, label).not.toContainEqual(refusal);
        expect(classifyShellCommands(changed).indeterminate, label).toContainEqual(refusal);
      }
      expect(bypass.classifyShellCommands(entry.example).indeterminate).toEqual([]);
      const forged = { ...entry, origin: { ...entry.origin, step: 8 } };
      expect(bypass.validateGrammarPartition(alone(forged)).violations).toEqual([]);
      expect(validateGrammarPartition(alone(forged)).violations).toEqual([unpinned(forged)]);
    }
  });

  it("C3 the stored witness text carries authority only through its binding proof", async () => {
    // Editing the stored platform-pr witness and the run alike keeps them equal;
    // a changed comment still proves, a changed binding does not.
    const [block] = originBlocks;
    const entry = entryOf(block);
    const run = blockRun(block);
    const comment = "# queue accepts a Docker image change.";
    const commented = await importMutant([[`"${comment}"`, '"# synthetic 8709 comment"']]);
    expect(commented.classifyShellCommands(change(run, comment, "# synthetic 8709 comment")).indeterminate).toEqual([]);
    const binding = `"${comment}",\n      "boot_smoke() {",\n      '  component="$1"',\n      '  workspace="$2"',`;
    const rebound = await importMutant([[binding, binding.replace('"$2"', '"$3"')]]);
    expect(rebound.classifyShellCommands(change(run, 'workspace="$2"', 'workspace="$3"')).indeterminate).toEqual([
      expect.objectContaining({ reason: unpinned(entry) }),
    ]);
    expect(rebound.validateGrammarPartition().violations).toEqual([unpinned(entry)]);
  });
});

describe("authoritative grammar partition", () => {
  it("partition equals authoritative derivation", () => {
    expect(validateGrammarPartition()).toEqual({ passed: true, members: 503, violations: [] });
    expect(DESTRUCTIVE_GRAMMAR.partition).toEqual(deriveAuthoritativeGrammar());
    expect(DESTRUCTIVE_GRAMMAR.partition.filter((member) => member.disposition === "HANDLED")).toHaveLength(442);
    expect(DESTRUCTIVE_GRAMMAR.partition.filter((member) => member.disposition === "INDETERMINATE")).toHaveLength(61);
    expect(DESTRUCTIVE_GRAMMAR.sources.map(({ id, excerptSha256 }) => [id, excerptSha256])).toEqual([
      ["bash", "79b2d71b111231a093f390e82181428b15523ffe66fb7cc8a893f81da5a0e1b8"],
      ["doctl-global", "138e78ea8ccce848f3f5c1115ae5477934311629769f59e3e51aa79651d7d8ab"],
      ["doctl-constants", "93e07da01e5c478b7a98bd87d12a903a3155b3de99a65f3a1f16cab451dea16b"],
      ["doctl-registry", "819cb62a61b3c34aaa18dad5f32fd279c8c9ba7e77cabd8f592ba813532688b5"],
      ["terraform-global", "2e8c741c11cb1f85a89d6de228be0d1cbaa9c6715c54fa5d000f90fded141205"],
      ["terraform-commands", "d465182221c8d4407eb111236f544e2d944709339a1ecb14dfcbaea1b241fb59"],
      ["node-options", "6b07ab3887f29d4f18195cb5475469f4b8c5cf0e92ad9e9bf9286fcd9d103665"],
      ["node-types", "c60a28f67e10267daf25a73c20baf2e29ddba044047e758c87f32e26fe0e3545"],
    ]);
    for (const source of DESTRUCTIVE_GRAMMAR.sources) expect(source.citation).toMatch(/^https:\/\//);
    expect(DESTRUCTIVE_GRAMMAR.partition).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "bash:list1:list1 ';' newline_list list1", disposition: "HANDLED" }),
        expect.objectContaining({
          id: "doctl:option:access-token",
          form: { names: ["--access-token", "-t"], arity: 1 },
        }),
        expect.objectContaining({ id: "node:option:--title", form: expect.objectContaining({ arity: 1 }) }),
      ]),
    );
  });

  it.each(["missing", "duplicate", "unsourced", "altered disposition", "altered source"])(
    "rejects %s grammar mutation",
    (mutation) => {
      const grammar = structuredClone(DESTRUCTIVE_GRAMMAR);
      if (mutation === "missing") grammar.partition.pop();
      if (mutation === "duplicate") grammar.partition.push(grammar.partition[0]);
      if (mutation === "unsourced")
        grammar.partition.push({
          id: "synthetic-8709",
          source: "bash",
          surface: "shell",
          form: {},
          disposition: "HANDLED",
        });
      if (mutation === "altered disposition")
        grammar.partition[0].disposition = grammar.partition[0].disposition === "HANDLED" ? "INDETERMINATE" : "HANDLED";
      if (mutation === "altered source") grammar.sources[0].lines.push("synthetic-8709-not-authoritative");
      expect(validateGrammarPartition(grammar).passed).toBe(false);
      expect(classifyShellCommands("true", { grammar }).indeterminate).toEqual([
        expect.objectContaining({ tool: "grammar" }),
      ]);
    },
  );

  it("unknown derived command form fails closed", () => {
    const unknown = "doctl registry repository synthetic-8709-unlisted-command app";
    expect(classifyShellCommands(unknown).indeterminate).toEqual([
      expect.objectContaining({ disposition: "INDETERMINATE", reason: "unlisted registry subcommand" }),
    ]);
    const result = checkWorkflowDestructiveOperationGating(pushWorkflow(unknown), {
      workflowFile: ".github/workflows/synthetic-8709-unknown.yml",
    });
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(
      expect.stringContaining("synthetic-8709-unknown.yml: job 'anonymous' step #1: INDETERMINATE"),
    );
    expect(
      checkWorkflowDestructiveOperationGating(pushWorkflow("doctl registry repository list-tags app")).passed,
    ).toBe(true);
  });

  it.each(["jobs:\n  broken: [\n", "jobs: {}\njobs: {}\n", "a label, not a workflow"])(
    "malformed YAML fails closed: %s",
    (source) => {
      expect(checkWorkflowDestructiveOperationGating(source).violations).toContainEqual(
        expect.stringContaining("workflow could not be parsed; failing closed"),
      );
    },
  );
});

describe("semantic cleanup shape contracts and real discovery", () => {
  it("all discovered workflows satisfy shape contract", () => {
    const result = checkDiscoveredWorkflows({ root });
    expect(result.violations).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.total).toBe(independentWorkflowTotal());
    expect(result.scanned).toBe(result.total);
    expect(
      Object.fromEntries(
        result.results
          .filter((entry) => entry.checkedSteps.length)
          .map((entry) => [entry.workflowFile, entry.checkedSteps.length]),
      ),
    ).toEqual({
      ".github/workflows/platform-preview-cleanup.yml": 2,
      [restoreFile]: 1,
      [productionFile]: 1,
      [registryFile]: 1,
      [stagingFile]: 2,
    });
    expect(result.tripwires.checkedWorkflows).toEqual(NAMED_RESET_WORKFLOW_TRIPWIRES);
  });

  it("the fresh-base append is load-bearing for its workflow", () => {
    const grammar = {
      ...DESTRUCTIVE_GRAMMAR,
      benignForms: DESTRUCTIVE_GRAMMAR.benignForms.filter((entry) => entry.origin.sha === corpusSha),
    };
    const result = checkWorkflowDestructiveOperationGating(readWorkflow(driftFile), {
      workflowFile: driftFile,
      grammar,
    });
    expect(result.passed).toBe(false);
    expect(result.checkedSteps).toEqual([
      expect.objectContaining({ jobId: "digest", stepIndex: 3, disposition: "INDETERMINATE" }),
    ]);
    expect(checkWorkflowDestructiveOperationGating(readWorkflow(driftFile), { workflowFile: driftFile })).toEqual({
      passed: true,
      checkedSteps: [],
      violations: [],
    });
  });

  it.each([registryFile, restoreFile])("#6127 cleanup shapes pass: %s", (workflowFile) => {
    expect(checkWorkflowDestructiveOperationGating(readWorkflow(workflowFile), { workflowFile })).toMatchObject({
      passed: true,
      violations: [],
      checkedSteps: [expect.objectContaining({ disposition: "provable-gate" })],
    });
  });

  it("accepts env renaming and expression wrappers, not obsolete literal names", () => {
    const renamed = readWorkflow(registryFile)
      .replaceAll("MODE", "REQUESTED_MODE")
      .replaceAll("CONFIRM", "EXACT_CONFIRMATION")
      .replaceAll("DIGITALOCEAN_REGISTRY_CLEANUP_RESOLVED_DRY_RUN", "SYNTHETIC_8709_RESOLVED_MODE");
    expect(checkWorkflowDestructiveOperationGating(renamed).passed).toBe(true);
    const workflow = parse(renamed);
    workflow.jobs.cleanup.if = workflow.jobs.cleanup.if.replace(/^\$\{\{ | \}\}$/g, "");
    expect(checkWorkflowDestructiveOperationGating(stringify(workflow)).passed).toBe(true);
  });

  const refusalStep = (workflow) => workflow.jobs["refuse-unconfirmed-apply"].steps[0];
  it.each([
    ["trigger set", (workflow) => (workflow.on.push = {}), "triggered only"],
    ["dry-run default", (workflow) => (workflow.on.workflow_dispatch.inputs.dry_run.default = "false"), "defaults to"],
    ["typed confirm", (workflow) => (workflow.on.workflow_dispatch.inputs.confirm.type = "boolean"), "typed string"],
    ["confirm default", (workflow) => (workflow.on.workflow_dispatch.inputs.confirm.default = ""), "without a default"],
    ["missing refusal", (workflow) => delete workflow.jobs["refuse-unconfirmed-apply"], "shell-validate"],
    [
      "manual refusal condition",
      (workflow) => (workflow.jobs["refuse-unconfirmed-apply"].if = "inputs.confirm"),
      "shell-validate",
    ],
    [
      "nonzero unknown refusal",
      (workflow) => (refusalStep(workflow).run = refusalStep(workflow).run.replaceAll("exit 1", "echo accepted")),
      "nonzero exit",
    ],
    [
      "case-sensitive confirmation",
      (workflow) => (refusalStep(workflow).run = refusalStep(workflow).run.replace('"$CONFIRM"', '"${CONFIRM,,}"')),
      "case-sensitively",
    ],
    [
      "invalid mode accepted",
      (workflow) => (refusalStep(workflow).run = refusalStep(workflow).run.replace('"true")', '"true" | "" | "TRUE")')),
      "shell-validate",
    ],
    ["dependency", (workflow) => delete workflow.jobs.cleanup.needs, "cancellation-safe"],
    [
      "cancellation",
      (workflow) => (workflow.jobs.cleanup.if = workflow.jobs.cleanup.if.replace("!cancelled()", "always()")),
      "cancellation-safe",
    ],
    [
      "failure admission",
      (workflow) => (workflow.jobs.cleanup.if = workflow.jobs.cleanup.if.replace("'success'", "'failure'")),
      "cancellation-safe",
    ],
    [
      "resolver uniqueness",
      (workflow) => workflow.jobs.cleanup.steps.push(workflow.jobs.cleanup.steps[0]),
      "single fail-closed",
    ],
    [
      "resolver default refusal",
      (workflow) =>
        (workflow.jobs.cleanup.steps[0].run = workflow.jobs.cleanup.steps[0].run.replace("exit 1", "echo accepted")),
      "single fail-closed",
    ],
    [
      "resolver inversion",
      (workflow) =>
        (workflow.jobs.cleanup.env.DIGITALOCEAN_REGISTRY_CLEANUP_REQUESTED_DRY_RUN =
          "${{ github.event_name == 'schedule' && 'true' || github.event.inputs.dry_run }}"),
      "single fail-closed",
    ],
    [
      "resolved publication under requested name",
      (workflow) =>
        (workflow.jobs.cleanup.steps[0].run = workflow.jobs.cleanup.steps[0].run.replaceAll(
          "RESOLVED_DRY_RUN",
          "REQUESTED_DRY_RUN",
        )),
      "distinct resolved name",
    ],
    [
      "script dry-run wiring",
      (workflow) => {
        const step = workflow.jobs.cleanup.steps.find((candidate) => candidate.name === "Cleanup registry tags");
        step.run = step.run.replace('--dry-run="${DIGITALOCEAN_REGISTRY_CLEANUP_RESOLVED_DRY_RUN}"', "--dry-run=false");
      },
      "cannot associate",
    ],
  ])("rejects preserved shape mutant: %s", (_label, change, violation) => {
    const source = changeWorkflow(registryFile, change);
    expect(source).not.toBe(stringify(parse(readWorkflow(registryFile))));
    const result = checkWorkflowDestructiveOperationGating(source);
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining(violation));
  });

  it("rejects restore resolver inversion and unconditional apply wiring", () => {
    const restore = readWorkflow(restoreFile);
    for (const [from, to, violation] of [
      ['resolved_apply="true"', "echo resolved_apply=true", "single fail-closed"],
      ['apply_args=("--apply")', "echo apply_args= '(' --apply ')'", "cannot associate"],
      ['"true") resolved_apply="false"', '"true") resolved_apply="true"', "single fail-closed"],
      ['"${apply_args[@]}"', '--apply "${apply_args[@]}"', "cannot associate"],
    ]) {
      const mutant = restore.replace(from, to);
      expect(mutant, from).not.toBe(restore);
      expect(checkWorkflowDestructiveOperationGating(mutant).violations, from).toContainEqual(
        expect.stringContaining(violation),
      );
    }
    const competing = changeWorkflow(restoreFile, (workflow) => {
      workflow.jobs.cleanup.env.PRODUCTION_DB_RESTORE_POINT_CLEANUP_APPLY = "true";
    });
    expect(checkWorkflowDestructiveOperationGating(competing).violations).toContainEqual(
      expect.stringContaining("cannot associate"),
    );
  });

  it("exemption extra invocation rejected", () => {
    const file = DESTRUCTIVE_OPERATION_EXEMPTIONS[0].workflowFile;
    const source = changeWorkflow(file, (workflow) =>
      workflow.jobs["destroy-preview"].steps.push({ run: "terraform destroy" }),
    );
    expect(checkWorkflowDestructiveOperationGating(source, { workflowFile: file }).violations).toContainEqual(
      expect.stringContaining("exact invocation multiset required"),
    );
    const sameStep = readWorkflow(file).replace(
      "run: terraform destroy -auto-approve",
      "run: |\n          terraform destroy -auto-approve\n          terraform destroy -auto-approve",
    );
    expect(sameStep).not.toBe(readWorkflow(file));
    expect(checkWorkflowDestructiveOperationGating(sameStep, { workflowFile: file }).violations).toContainEqual(
      expect.stringContaining("exact invocation multiset required"),
    );
  });

  it("exemption missing invocation rejected", () => {
    const file = DESTRUCTIVE_OPERATION_EXEMPTIONS[0].workflowFile;
    const source = readWorkflow(file).replace("run: terraform destroy -auto-approve", "run: terraform plan");
    expect(source).not.toBe(readWorkflow(file));
    expect(checkWorkflowDestructiveOperationGating(source, { workflowFile: file }).violations).toContainEqual(
      expect.stringContaining("exact invocation multiset required"),
    );
    const directory = fixtureRoot();
    rmSync(join(directory, file));
    expect(checkDiscoveredWorkflows({ root: directory }).violations).toContain(
      `${file}: bounded exemption workflow is missing.`,
    );
  });

  it("unknown forms cannot borrow exempt paths or jobs", () => {
    const file = DESTRUCTIVE_OPERATION_EXEMPTIONS[0].workflowFile;
    const source = changeWorkflow(file, (workflow) =>
      workflow.jobs["destroy-preview"].steps.push({ run: "terraform synthetic-8709-command" }),
    );
    const result = checkWorkflowDestructiveOperationGating(source, { workflowFile: file });
    expect(result.violations).toContainEqual(expect.stringContaining("INDETERMINATE"));
    expect(result.violations).toContainEqual(expect.stringContaining("exact invocation multiset required"));
  });

  it("new destructive workflow requires gate", () => {
    const directory = fixtureRoot();
    const file = ".github/workflows/synthetic-8709-extra.yaml";
    writeFileSync(join(directory, file), pushWorkflow());
    const result = checkDiscoveredWorkflows({ root: directory });
    expect(result.total).toBe(independentWorkflowTotal() + 1);
    expect(result.scanned).toBe(result.total);
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining(`${file}: refuse-unconfirmed-apply`));
  });

  const siblingFile = ".github/workflows/nested/synthetic-8709-ordinary-task.yaml";
  function siblingRoot(source) {
    const directory = fixtureRoot();
    mkdirSync(dirname(join(directory, siblingFile)), { recursive: true });
    writeFileSync(join(directory, siblingFile), source);
    return directory;
  }

  it("arbitrary workflow sibling discovered", () => {
    const file = siblingFile;
    const directory = siblingRoot(
      pushWorkflow('MODE=fixture >output doctl -t "$TOKEN" reg repo dt app old', "ordinary-job", "ordinary step"),
    );
    const result = checkDiscoveredWorkflows({ root: directory });
    expect(result).toMatchObject({
      passed: false,
      scanned: independentWorkflowTotal() + 1,
      total: independentWorkflowTotal() + 1,
    });
    expect(result.results.find((entry) => entry.workflowFile === file).checkedSteps).toEqual([
      expect.objectContaining({
        jobId: "ordinary-job",
        name: "ordinary step",
        operations: ["doctl:registry-repository-delete-tag"],
      }),
    ]);
    expect(result.violations).toContainEqual(expect.stringContaining(`${file}: destructive job 'ordinary-job'`));
  });

  it.each([
    "terraform \\\n destroy",
    "timeout 8m node ./scripts/production-db-restore-point-cleanup.mjs --apply",
    "$TF destroy",
    'timeout 5m "$TOOL" destroy -auto-approve',
  ])("arbitrary sibling refuses continued, wrapped and dynamic forms despite ambient input: %s", (run) => {
    const directory = siblingRoot(pushWorkflow(run, "arbitrary", "arbitrary"));
    const previousChangedFiles = process.env.CHANGED_FILES;
    process.env.CHANGED_FILES = "README.md";
    try {
      const discovered = checkDiscoveredWorkflows({ root: directory });
      expect(discovered.passed).toBe(false);
      expect(discovered.scanned).toBe(independentWorkflowTotal() + 1);
      expect(discovered.violations).toContainEqual(expect.stringContaining(`${siblingFile}:`));
      expect(discovered.results.find((entry) => entry.workflowFile === siblingFile).checkedSteps).toHaveLength(1);
    } finally {
      if (previousChangedFiles === undefined) delete process.env.CHANGED_FILES;
      else process.env.CHANGED_FILES = previousChangedFiles;
    }
  });

  it("arbitrary sibling with a repaired supported gate passes", () => {
    const repaired = parse(readWorkflow(restoreFile));
    repaired.jobs["ordinary-job"] = repaired.jobs.cleanup;
    delete repaired.jobs.cleanup;
    expect(checkDiscoveredWorkflows({ root: siblingRoot(stringify(repaired)) })).toMatchObject({
      passed: true,
      scanned: independentWorkflowTotal() + 1,
      total: independentWorkflowTotal() + 1,
      violations: [],
    });
  });
});

describe("both named reset tripwires", () => {
  const sources = Object.fromEntries(NAMED_RESET_WORKFLOW_TRIPWIRES.map((file) => [file, readWorkflow(file)]));

  it("catalog always mutant rejected", () => {
    expect(checkNamedResetWorkflowTripwires(sources)).toMatchObject({ passed: true, violations: [] });
    const mutant = sources[catalogFile].replace("!cancelled() &&", "always() &&");
    expect(mutant).not.toBe(sources[catalogFile]);
    expect(checkNamedResetWorkflowTripwires({ ...sources, [catalogFile]: mutant }).violations).toEqual([
      expect.stringContaining(`${catalogFile}: named reset tripwire`),
    ]);
  });

  it.each([
    [catalogFile, (source) => source.replaceAll("exit 1", "echo accepted")],
    [catalogFile, (source) => source.replace("needs.refuse-unconfirmed-apply.result == 'skipped'", "true")],
    [
      catalogFile,
      (source) => source.replace("inputs.confirm != 'reset staging catalog integration data'", "inputs.confirm"),
    ],
    [stagingFile, (source) => source.replace('if [ "$RESET_CONFIRM" != "reset staging" ]; then', "if false; then")],
    [
      stagingFile,
      (source) => source.replace('if [ "$RESET_CONFIRM" != "resume staging recreate" ]; then', "if false; then"),
    ],
    [stagingFile, (source) => source.replaceAll("exit 1", "echo accepted")],
  ])("retains actual refusal/result control for %s", (file, mutate) => {
    const mutant = mutate(sources[file]);
    expect(mutant).not.toBe(sources[file]);
    expect(checkNamedResetWorkflowTripwires({ ...sources, [file]: mutant }).passed).toBe(false);
  });

  it("fails closed if either named tripwire source is absent", () => {
    for (const file of NAMED_RESET_WORKFLOW_TRIPWIRES)
      expect(checkNamedResetWorkflowTripwires({ ...sources, [file]: undefined }).violations).toContainEqual(
        expect.stringContaining(`${file}: named reset workflow source is missing`),
      );
  });
});
