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
  storedOccurrenceProofs,
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

function pushWorkflow(run = "terraform destroy", jobId = "anonymous", stepName = "ordinary task", env = undefined) {
  return stringify({
    name: "Synthetic 8709 fixture",
    on: "push",
    jobs: { [jobId]: { "runs-on": "ubuntu-latest", steps: [{ name: stepName, ...(env ? { env } : {}), run }] } },
  });
}

// A live step's run and its workflow/job/step env declarations.
function liveStep(file, job, step) {
  const workflow = parse(readWorkflow(file));
  const definition = workflow.jobs[job];
  const item = definition.steps[step - 1];
  return { run: item.run, env: { workflow: workflow.env ?? {}, job: definition.env ?? {}, step: item.env ?? {} } };
}
// All three scopes flattened into one step env map (the innermost wins, as in
// the detector's own lookup order).
const stepEnv = (env) => ({ ...env.workflow, ...env.job, ...env.step });
const emptyEnv = { workflow: {}, job: {}, step: {} };
const originEnvOf = (entry) =>
  DESTRUCTIVE_GRAMMAR.origins.find(
    ({ sha, path, job, step }) =>
      [sha, path, job, step].join("|") ===
      [entry.origin.sha, entry.origin.path, entry.origin.job, entry.origin.step].join("|"),
  )?.env;

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
// The two corpus sed entries whose file operand is an origin-bound directory.
const directoryIds = [
  "6f8e2d3b0a8074a8e387c00b81a30b36ac26d7e2fda2f792e1d577974eb71f89",
  "2560701ccadcee87c93a85e5a552d60d79dc0c4840ab18434c4857db505f626d",
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

// #9031 site fixtures: a stored origin record (LF run + three env maps) and
// synthetic entries for every command of a candidate run that no entry admits
// by shape, all stored at that synthetic origin.
const syntheticOrigin = {
  sha: "0".repeat(40),
  path: ".github/workflows/synthetic-9031.yml",
  job: "synthetic",
  step: 1,
};
function storedOrigin(origin, run, env = emptyEnv) {
  const scopes = { workflow: env.workflow ?? {}, job: env.job ?? {}, step: env.step ?? {} };
  return { ...origin, run, env: scopes, runSha256: sha256(run), envSha256: sha256(JSON.stringify(scopes)) };
}
// Shapes only a bypass spells (`extras`) are stored at their own synthetic
// origins, each recorded as that bypass run, so they validate and the
// target's refusal stays the first one.
function siteFixture(candidate, env = emptyEnv, extras = []) {
  const entries = new Map();
  const records = [];
  [candidate, ...extras].forEach((run, position) => {
    const origin = { ...syntheticOrigin, step: position + 1 };
    if (position) records.push(storedOrigin(origin, run, env));
    for (const unknown of classifyShellCommands(run, { env }).indeterminate) {
      if (!new Set(["unlisted executable form", "unlisted Terraform command"]).has(unknown.reason) || !unknown.command)
        continue;
      const words = unknown.command.words.map(({ value, dynamic, quoted }) => ({ value, dynamic, quoted }));
      const input = unknown.command.redirects
        .filter(({ target }) => target?.body !== undefined)
        .map(({ target }) => target.body);
      const entry = { ...syntheticEntry(words, input.length ? input : undefined), origin };
      if (!entries.has(entry.id)) entries.set(entry.id, entry);
    }
  });
  const grammarFor = (run, storedEnv = env) => ({
    ...DESTRUCTIVE_GRAMMAR,
    benignForms: [...DESTRUCTIVE_GRAMMAR.benignForms, ...entries.values()],
    origins: [...DESTRUCTIVE_GRAMMAR.origins, storedOrigin(syntheticOrigin, run, storedEnv), ...records],
  });
  return {
    grammar: grammarFor(candidate),
    grammarFor,
    // The entry whose words spell `text` (values joined by spaces): a
    // synthetic one, or the corpus entry that already admits that shape.
    target: (text) =>
      [...entries.values(), ...DESTRUCTIVE_GRAMMAR.benignForms].find(
        ({ words }) => words?.map(({ value }) => value).join(" ") === text,
      ),
  };
}

// The candidate validates at its stored origin and classifies clean.
function expectSiteAdmitted(fixture, run, env = emptyEnv) {
  expect(validateGrammarPartition(fixture.grammar).violations).toEqual([]);
  expect(classifyShellCommands(run, { grammar: fixture.grammar, env }).indeterminate, run).toEqual([]);
}

// A bypass refuses with the target's named violation first through the
// classifier, an ungated push workflow and the exempt deploy-production job
// (passed=false, checked > 0), and the validator refuses the same bypass as
// the stored origin. Unrelated inputs stay frozen: the fixture's entries and
// the corpus are unchanged.
function expectSiteRefused(fixture, target, bypass, env = emptyEnv) {
  const violation = unpinned(target);
  const [refusal] = classifyShellCommands(bypass, { grammar: fixture.grammar, env }).indeterminate;
  expect(refusal?.reason, bypass).toBe(violation);
  const ungated = checkWorkflowDestructiveOperationGating(
    pushWorkflow(bypass, "anonymous", "ordinary task", stepEnv(env)),
    {
      grammar: fixture.grammar,
    },
  );
  expect(ungated.passed).toBe(false);
  expect(ungated.checkedSteps.length).toBeGreaterThan(0);
  expect(ungated.violations[0]).toContain(violation);
  const source = changeWorkflow(productionFile, (workflow) => {
    workflow.jobs["deploy-production"].steps.push({ name: "Synthetic 9031 bypass", env: stepEnv(env), run: bypass });
  });
  const exempt = checkWorkflowDestructiveOperationGating(source, {
    workflowFile: productionFile,
    grammar: fixture.grammar,
  });
  expect(exempt.passed).toBe(false);
  expect(exempt.checkedSteps.length).toBeGreaterThan(0);
  expect(exempt.violations).toContainEqual(expect.stringContaining(violation));
  // A corpus target keeps its own stored origin; a synthetic one is stored at
  // the fixture origin, so the validator caller sees the bypass too.
  if (target.origin.sha === syntheticOrigin.sha)
    expect(validateGrammarPartition(fixture.grammarFor(bypass, env)).violations).toContain(violation);
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
    expect(DESTRUCTIVE_GRAMMAR.benignForms.find(({ origin }) => origin.path === driftFile)?.origin).toEqual({
      sha: "268a0899e8463007bb41a641ebe1b8153ecae70d",
      path: driftFile,
      job: "digest",
      step: 3,
    });
    expect(validateGrammarPartition().violations).toEqual([]);
    // The origin-bound entries are admitted only inside their full block or
    // after their directory bindings (see "origin-proved dynamic package
    // selection" and "origin-bound sed directories"). An entry whose operands
    // need a site is proved at every occurrence in its stored origin record
    // instead of standalone.
    const contextBound = [...originIds, ...directoryIds];
    for (const entry of DESTRUCTIVE_GRAMMAR.benignForms.filter(({ id }) => !contextBound.includes(id))) {
      const occurrences = storedOccurrenceProofs(entry);
      if (occurrences.length)
        expect(
          occurrences.map(({ violations }) => violations),
          entry.id,
        ).toEqual(occurrences.map(() => []));
      else expect(classifyShellCommands(entry.example).indeterminate, entry.id).toEqual([]);
    }
    for (const id of directoryIds) {
      const entry = DESTRUCTIVE_GRAMMAR.benignForms.find((candidate) => candidate.id === id);
      expect(classifyShellCommands(entry.example).indeterminate).toEqual([
        expect.objectContaining({ tool: "sed", reason: unpinned(entry) }),
      ]);
    }

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
    // S4 delta review r2 (#8970): a dynamic awk/sed tail word may begin with
    // `-`, and GNU sed permutes it into another program; a directory operand
    // outside its origin step is not origin-bound.
    "F2 sed dynamic option tail": ["sed", Q("p"), D("$SYNTHETIC_OPTION"), D("$SYNTHETIC_PROGRAM")],
    "F2 sed dynamic file": ["sed", "-i", Q("/x/d"), D("$SYNTHETIC_8970_FILE")],
    "F2 awk dynamic option tail": ["awk", Q("{print}"), D("$SYNTHETIC_OPTION"), D("$SYNTHETIC_PROGRAM")],
    "F2 sed directory outside its origin": ["sed", "-i", Q('/backend "s3" {}/d'), D("$tmp/versions.tf")],
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
    expectAdmitted(syntheticEntry(["grep", "-E", Q("^[0-9]+$"), D("./$FILE")]));
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
      words: ["docker", "exec", D("synthetic-$C"), "pg_isready", "-U", "postgres"],
      roles: [1, 3],
      data: 5,
      option: 2,
      negatives: [["docker", "exec", D("${containers[@]}"), "pg_isready"]],
    },
    "docker run": {
      words: ["docker", "run", "--rm", D("registry.example/$IMAGE"), "pnpm", "run", "start"],
      roles: [1, 4, 5, 6],
      data: 3,
      dataWord: D("registry.example/$SYNTHETIC_8709_DATA"),
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
      words: ["kubectl", "exec", D("pod/$POD"), "--", "rm", "-f", D("./$P")],
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
    // One pinned .sh script and nothing after it.
    ...Object.fromEntries(
      ["bash", "sh", "dash", "zsh", "ksh"].map((name) => [
        `${name} script`,
        {
          words: [name, "scripts/synthetic-9031.sh"],
          roles: [1],
          option: 1,
          negatives: [
            [name, "scripts/synthetic-9031.sh", "argv"],
            [name, "scripts/synthetic-9031.py"],
            [name, D("$SYNTHETIC_SCRIPT/x.sh")],
          ],
        },
      ]),
    ),
    "xvfb-run --auto-servernum": {
      words: ["xvfb-run", "--auto-servernum", "jq", "-r", Q(".x")],
      roles: [1, 2],
      data: 4,
      option: 1,
      negatives: [["xvfb-run", "jq", "-r", Q(".x")]],
    },
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
    // awk/sed file operands are data only behind a fixed non-option lead.
    "awk program": {
      words: ["awk", "-F", Q("="), Q("{print $3}"), "file"],
      roles: [3],
      data: 4,
      dataWord: D("./$SYNTHETIC_8709_DATA"),
      option: 1,
      negatives: [["awk", "-F", Q("="), Q("{print $3}"), D("$SYNTHETIC_8709_DATA")]],
    },
    "sed program": {
      words: ["sed", "-i", Q("/x/d"), "file"],
      roles: [2],
      data: 3,
      dataWord: D("./$SYNTHETIC_8709_DATA"),
      option: 1,
      negatives: [
        ["sed", "-i", Q("/x/d"), "file", "--expression=p"],
        ["sed", "-i.bak", Q("/x/d"), "file"],
        ["sed", "-i", Q("/x/d"), D("$SYNTHETIC_8709_DATA")],
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
        ...(data === undefined ? [] : [at(words, data, dataWord ?? D("./$SYNTHETIC_8709_DATA"))]),
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
    (_label, { selector, path, global, options, operands, variadic, values }) => {
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
        ...(operands > 0 ? [[...base, D("synthetic-8709/$SYNTHETIC_8709_DATA")]] : []),
        // L2 value shapes take any single word; F4 operands need a proved lead.
        ...(operands > 0 && values ? [[...base, D("$SYNTHETIC_8709_DATA")]] : []),
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
        ...(operands > 0 && !values
          ? [
              [...base, D("$SYNTHETIC_8709_DATA")],
              [...base, D("-$SYNTHETIC_8709_DATA")],
            ]
          : []),
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

  // L2: a closed workflow-function name is admitted only as a call of the one
  // same-run definition; its arguments are data values for that body.
  // One row per (function, bypass) keeps each test inside the strict budget.
  const functionRows = inventory.filter((row) => row.kind === "function");
  const functionCase = (selector) => {
    const entry = { ...syntheticEntry([selector, D("$SYNTHETIC_ARG")]), origin: syntheticOrigin };
    const run = `${selector}() {\n  :\n}\n${selector} "$SYNTHETIC_ARG"\n`;
    const stored = (text) => ({
      ...DESTRUCTIVE_GRAMMAR,
      benignForms: [...DESTRUCTIVE_GRAMMAR.benignForms, entry],
      origins: [...DESTRUCTIVE_GRAMMAR.origins, storedOrigin(syntheticOrigin, text)],
    });
    const bypasses = {
      "call without a definition": `${selector} "$SYNTHETIC_ARG"\n`,
      "second definition": `${run}${selector}() {\n  :\n}\n`,
    };
    return { entry, run, stored, bypasses };
  };
  it("workflow function calls need exactly one same-run definition", () => {
    expect(functionRows.length).toBeGreaterThan(10);
  });
  it.each(functionRows.map(({ selector }) => selector))(
    "workflow function %s: its one definition admits the call",
    (selector) => {
      const { run, stored } = functionCase(selector);
      expect(validateGrammarPartition(stored(run)).violations, selector).toEqual([]);
      expect(classifyShellCommands(run, { grammar: stored(run) }).indeterminate, selector).toEqual([]);
    },
  );
  it.each(
    functionRows.flatMap(({ selector }) =>
      Object.keys(functionCase(selector).bypasses).map((label) => [selector, label]),
    ),
  )("workflow function %s: %s refuses", (selector, label) => {
    const { entry, run, stored, bypasses } = functionCase(selector);
    const bypass = bypasses[label];
    expect(validateGrammarPartition(stored(bypass)).violations, bypass).toEqual([unpinned(entry)]);
    expect(classifyShellCommands(bypass, { grammar: stored(run) }).indeterminate[0]?.reason, bypass).toBe(
      unpinned(entry),
    );
  });
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

  // F2: a word after the awk/sed program is a file only when it cannot begin
  // with `-` or follows a literal `--`.
  it("awk and sed tails admit only proved non-option files", () => {
    const file = D("$SYNTHETIC_8970_FILE");
    expectBatch(
      [
        ["sed", "-i", Q("/x/d"), D("./$SYNTHETIC_8970_FILE")],
        ["sed", "-i", Q("/x/d"), "--", file, D("$SYNTHETIC_OPTION")],
        ["sed", "-i", "--", Q("/x/d"), file],
        ["awk", Q("{print}"), D("/tmp/$SYNTHETIC_8970_FILE"), "-"],
        ["awk", "-F", Q("="), "--", Q("{print}"), file],
      ].map((items) => syntheticEntry(items)),
      [
        ["sed", "-i", Q("/x/d"), file],
        ["sed", "-i", Q("/x/d"), file, "--"],
        ["sed", "-i", Q("/x/d"), D("${SYNTHETIC_8970_FILE}/x")],
        ["sed", "-i", Q("/x/d"), D("$(printf ./x)")],
        ["sed", "-i", Q("/x/d"), "--", U("$SYNTHETIC_8970_FILES")],
        ["awk", Q("{print}"), file],
      ].map((items) => {
        const entry = syntheticEntry(items);
        return [entry, unpinned(entry)];
      }),
    );
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
      // The corpus probes run under their origin step's job services env.
      const env = synthetic ? emptyEnv : originEnvOf(timeoutPsql);
      expect(classifyShellCommands(proved, { grammar, env }).indeterminate).toEqual([]);
      const entry = synthetic ?? DESTRUCTIVE_GRAMMAR.benignForms.find(({ example }) => example === proved);
      const [refusal, ...others] = classifyShellCommands(run, { grammar, env }).indeterminate;
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
    ]) {
      const entry = corpusExample(pattern);
      expect(classifyShellCommands(entry.example, { env: originEnvOf(entry) }).indeterminate, String(pattern)).toEqual(
        [],
      );
    }
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
        expect(classifyShellCommands(entry.example, { env: originEnvOf(entry) }).indeterminate).toEqual([]);
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
      bytes: 1744,
      sha256: "ae27f4e536a6d784443e1a88e648e596fb1c1ac46deb390c7be98c3fcf97ed3d",
      originSha: "991a1d8586da9405dcdec26e4f02e40ee93ba420",
    },
  ];
  // YAML-decoded, as the detector receives a step's run text.
  const blockRun = ({ file, job }) => parse(readWorkflow(file)).jobs[job].steps[6].run;
  // The block's own env declarations prove its other operands (the image).
  const blockEnv = ({ file, job }) => liveStep(file, job, 7).env;
  const entryOf = ({ id }) => DESTRUCTIVE_GRAMMAR.benignForms.find((entry) => entry.id === id);
  // Entries in a block proved through container_id's admitted substitution.
  const dependentsOf = (block) =>
    DESTRUCTIVE_GRAMMAR.benignForms
      .filter(
        ({ origin, words }) =>
          origin.path === block.file &&
          origin.job === block.job &&
          words?.some(({ value }) => value === "$container_id"),
      )
      .map(({ id }) => id);
  const change = (run, from, to) => {
    expect(run).toContain(from);
    return run.replace(from, to);
  };
  const marketplaceCall = 'boot_smoke marketplace "@chase-sets/app-marketplace-web" /health/ready 18080';
  const publicCall = 'boot_smoke public-web "@chase-sets/app-public-web" / 18081';
  const command = 'pnpm --filter "$workspace" run start';
  // The start of the substitution that holds the command, and that start with
  // a statement inserted before docker run.
  const nestedAt = 'container_id="$(docker run -d';
  const nested = (statement) => `container_id="$(${statement}docker run -d`;
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
    "binding reassigned in the substitution": change(run, nestedAt, nested('workspace="$OTHER"; ')),
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
  const expectWorkflowRefused = (run, env) => {
    const ungated = checkWorkflowDestructiveOperationGating(
      pushWorkflow(run, "anonymous", "ordinary task", env && stepEnv(env)),
    );
    expect(ungated.passed).toBe(false);
    expect(ungated.checkedSteps).toEqual([expect.objectContaining({ disposition: "INDETERMINATE" })]);
  };

  it.each(originBlocks.map((block) => [block.file, block]))(
    "C1 the complete origin block admits its preserved entry: %s",
    (_file, block) => {
      const entry = entryOf(block);
      expect(entry.origin).toEqual({
        sha: block.originSha ?? corpusSha,
        path: block.file,
        job: block.job,
        step: 7,
      });
      expect(entry.id).toBe(sha256(JSON.stringify({ selector: entry.selector, words: entry.words })));
      const run = blockRun(block);
      const env = blockEnv(block);
      expect([Buffer.byteLength(run), sha256(run)]).toEqual([block.bytes, block.sha256]);
      expect(classifyShellCommands(run, { env })).toMatchObject({ operations: [], indeterminate: [] });
      expect(classifyShellCommands(run.replaceAll("\n", "\r\n"), { env }).indeterminate).toEqual([]);
      expect(
        checkWorkflowDestructiveOperationGating(pushWorkflow(run, "anonymous", "ordinary task", stepEnv(env))),
      ).toEqual({
        passed: true,
        checkedSteps: [],
        violations: [],
      });
      const source = changeWorkflow(productionFile, (workflow) => {
        workflow.jobs["deploy-production"].steps.push({ name: "Synthetic 8709 origin block", env: stepEnv(env), run });
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
    // Eight historical entries plus the fresh-base xvfb-run forwarding one.
    expect(filters).toHaveLength(9);
    expect(filters.filter(({ id }) => originIds.includes(id))).toHaveLength(2);
    for (const entry of filters.filter(({ id }) => !originIds.includes(id))) {
      const occurrences = storedOccurrenceProofs(entry);
      if (occurrences.length)
        expect(
          occurrences.map(({ violations }) => violations),
          entry.example,
        ).toEqual(occurrences.map(() => []));
      else expect(classifyShellCommands(entry.example).indeterminate, entry.example).toEqual([]);
    }
    expect(filters.map(({ example }) => example)).toContainEqual(
      expect.stringMatching(/--filter @chase-sets\/easypost-postage test -- /),
    );
  });

  it.each(originBlocks.map((block) => [block.file, block]))(
    "C3/C7 changed callers, bindings or block text refuse the unchanged command: %s",
    (_file, block) => {
      // The stored entry still validates; only the runtime context changed.
      expect(validateGrammarPartition().passed).toBe(true);
      const env = blockEnv(block);
      for (const [label, run] of Object.entries(contextChanges(blockRun(block)))) {
        expect(classifyShellCommands(run, { env }).indeterminate, label).toContainEqual(
          expect.objectContaining({ reason: unpinned(entryOf(block)) }),
        );
        expectWorkflowRefused(run, env);
      }
    },
  );

  it.each(originBlocks.map((block) => [block.file, block]))(
    "C4 the command outside its proved block or occurrence refuses: %s",
    (_file, block) => {
      const entry = entryOf(block);
      const run = blockRun(block);
      const env = blockEnv(block);
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
          const { indeterminate } = classifyShellCommands(candidate, { env });
          if (candidate === run) expect(indeterminate).toEqual([]);
          else expect(indeterminate.length, candidate).toBeGreaterThan(0);
        }
      expect(classifyShellCommands(entry.example, { env }).indeterminate).toEqual([
        expect.objectContaining({ reason: unpinned(entry) }),
      ]);
      for (const candidate of Object.values(refusals)) expectWorkflowRefused(candidate, env);
    },
  );

  it.each(Object.entries(commandChanges))(
    "C5 a changed command spelling refuses inside the block: %s",
    (_label, spelling) => {
      for (const block of originBlocks) {
        const run = change(blockRun(block), command, spelling);
        expect(classifyShellCommands(run, { env: blockEnv(block) }).indeterminate.length, block.file).toBeGreaterThan(
          0,
        );
        expectWorkflowRefused(run, blockEnv(block));
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
  // `recordChange` edits the copied grammar's stored origin runs the same way
  // (re-hashed), since a witness block and its origin record are one text.
  async function importMutant(replacements, recordChange = (run) => run) {
    let source = readFileSync(join(root, "scripts/workflow-destructive-op-gating.mjs"), "utf8");
    for (const [from, to] of replacements) {
      expect(source.split(from)).toHaveLength(2);
      source = source.replace(from, to);
    }
    const cache = join(root, "node_modules", ".cache");
    mkdirSync(cache, { recursive: true });
    const directory = mkdtempSync(join(cache, "workflow-destructive-op-gating-mutant-"));
    fixtureDirectories.push(directory);
    const grammar = JSON.parse(readFileSync(join(root, "scripts/workflow-destructive-op-gating-grammar.json"), "utf8"));
    grammar.origins = grammar.origins.map((record) => {
      const run = recordChange(record.run);
      return run === record.run ? record : { ...record, run, runSha256: sha256(run) };
    });
    writeFileSync(join(directory, "workflow-destructive-op-gating-grammar.json"), JSON.stringify(grammar));
    writeFileSync(join(directory, "workflow-destructive-op-gating.mjs"), source);
    return import(pathToFileURL(join(directory, "workflow-destructive-op-gating.mjs")).href);
  }

  it("C8 the origin context check is load-bearing", async () => {
    const bypass = await importMutant([["context.origin !== null &&", "true &&"]]);
    for (const block of originBlocks) {
      const run = blockRun(block);
      const env = blockEnv(block);
      expect(bypass.classifyShellCommands(run, { env }).indeterminate).toEqual([]);
      // Without the context check no changed-context control refuses the
      // command, so that check alone refuses them.
      const entry = entryOf(block);
      const refusal = expect.objectContaining({ reason: unpinned(entry) });
      for (const [label, changed] of Object.entries(contextChanges(run))) {
        expect(bypass.classifyShellCommands(changed, { env }).indeterminate, label).not.toContainEqual(refusal);
        expect(classifyShellCommands(changed, { env }).indeterminate, label).toContainEqual(refusal);
      }
      expect(bypass.classifyShellCommands(entry.example, { env }).indeterminate).toEqual([]);
      // A forged origin with its own record: only the context check refuses it.
      const forged = { ...entry, origin: { ...entry.origin, step: 70 } };
      expect(DESTRUCTIVE_GRAMMAR.origins.some(({ path, step }) => path === block.file && step === 70)).toBe(false);
      const forgedGrammar = {
        ...alone(forged),
        origins: [...DESTRUCTIVE_GRAMMAR.origins, storedOrigin(forged.origin, run, env)],
      };
      expect(bypass.validateGrammarPartition(forgedGrammar).violations).toEqual([]);
      expect(validateGrammarPartition(forgedGrammar).violations).toEqual([unpinned(forged)]);
    }
  });

  it("C3 the stored witness text carries authority only through its binding proof", async () => {
    // Editing the stored platform-pr witness and the run alike keeps them equal;
    // a changed comment still proves, a changed binding does not.
    const [block] = originBlocks;
    const entry = entryOf(block);
    const run = blockRun(block);
    const comment = "# queue accepts a Docker image change.";
    const commented = await importMutant([[`"${comment}"`, '"# synthetic 8709 comment"']], (text) =>
      text.replace(comment, "# synthetic 8709 comment"),
    );
    const env = blockEnv(block);
    expect(
      commented.classifyShellCommands(change(run, comment, "# synthetic 8709 comment"), { env }).indeterminate,
    ).toEqual([]);
    const binding = `"${comment}",\n      "boot_smoke() {",\n      '  component="$1"',\n      '  workspace="$2"',`;
    const rebound = await importMutant([[binding, binding.replace('"$2"', '"$3"')]]);
    expect(
      rebound.classifyShellCommands(change(run, 'workspace="$2"', 'workspace="$3"'), { env }).indeterminate,
    ).toEqual([expect.objectContaining({ tool: "grammar", reason: expect.stringContaining(unpinned(entry)) })]);
    // The F7 entry and every entry proved through its container_id substitution.
    expect([...rebound.validateGrammarPartition().violations].sort()).toEqual(
      [entry.id, ...dependentsOf(block)].map((id) => `${id}: benign payload admits an unpinned program.`).sort(),
    );
  });

  it("C3 rebinding inside the bound substitution voids the stored witness", async () => {
    // Each stored witness and its run gain the same statement inside the
    // substitution, before docker run: the load-time proof must refuse it.
    const statements = {
      assignment: 'workspace="$SYNTHETIC_8970_PACKAGE"; ',
      "positional reset": 'set -- "$SYNTHETIC_8970_PACKAGE"; ',
      unset: "unset workspace; ",
      arithmetic: "(( workspace = 1 )); ",
    };
    const comments = ["# queue accepts a Docker image change.", "# never reaches the deploy lane."];
    // The stored text from each block's unique comment to the substitution.
    const header = (comment, statement = "") =>
      [
        `"${comment}",`,
        '"boot_smoke() {",',
        `'  component="$1"',`,
        `'  workspace="$2"',`,
        `'  health_path="$3"',`,
        `'  host_port="$4"',`,
        '"",',
        `'  ${nested(statement)}`,
      ].join("\n      ");
    // Two mutants, each covering both blocks with a different statement.
    const labels = Object.keys(statements);
    for (const pair of [labels.slice(0, 2), labels.slice(2)]) {
      const mutant = await importMutant(
        pair.map((label, index) => [header(comments[index]), header(comments[index], statements[label])]),
      );
      expect([...mutant.validateGrammarPartition().violations].sort(), pair.join(", ")).toEqual(
        originBlocks
          .flatMap((block) => [block.id, ...dependentsOf(block)])
          .map((id) => `${id}: benign payload admits an unpinned program.`)
          .sort(),
      );
      originBlocks.forEach((block, index) => {
        const run = change(blockRun(block), nestedAt, nested(statements[pair[index]]));
        expect(mutant.classifyShellCommands(run).indeterminate, pair[index]).toContainEqual(
          expect.objectContaining({ reason: expect.stringContaining(unpinned(entryOf(block))) }),
        );
        expect(mutant.checkWorkflowDestructiveOperationGating(pushWorkflow(run)).passed, pair[index]).toBe(false);
      });
    }
  });
});

describe("origin-bound sed directories", () => {
  const sedCommand = (operand) => `sed -i '/backend "s3" {}/d' "${operand}"`;
  const directories = [
    {
      file: ".github/workflows/platform-pr.yml",
      job: "terraform-preview-plan",
      step: 6,
      operand: "$tmp/versions.tf",
      changes: (run, change) => ({
        "binding removed": change('tmp="$(mktemp -d)"\n', ""),
        "binding changed": change('tmp="$(mktemp -d)"', 'tmp="$SYNTHETIC_8970_DIR"'),
        "binding repeated": change('tmp="$(mktemp -d)"\n', 'tmp="$(mktemp -d)"\ntmp="$SYNTHETIC_8970_DIR"\n'),
        "TMPDIR assignment": 'TMPDIR="-e"\n' + run,
        "TMPDIR export": 'export TMPDIR="-e"\n' + run,
        "quoted export TMPDIR": '"export" TMPDIR="-e"\n' + run,
        "PATH export": 'export PATH="-e"\n' + run,
        "read rebinding": change(sedCommand("$tmp/versions.tf"), `read -r tmp\n${sedCommand("$tmp/versions.tf")}`),
        "conditional binding": change('tmp="$(mktemp -d)"', 'if true; then tmp="$(mktemp -d)"; fi'),
        "piped binding": change('tmp="$(mktemp -d)"', 'true | tmp="$(mktemp -d)"'),
        "binding after the command": `${sedCommand("$tmp/versions.tf")}\n${run}`,
        "mktemp redefined": `mktemp() { echo -e; }\n${run}`,
      }),
    },
    {
      file: ".github/workflows/platform-observability-state-migration.yml",
      job: "migrate",
      step: 8,
      operand: "$local_module/versions.tf",
      changes: (run, change) => ({
        "chain link changed": change('local_root="${migration_root}/local"', 'local_root="$SYNTHETIC_8970_DIR"'),
        "binding removed": change('local_module="${local_root}/infrastructure/digitalocean/observability"\n', ""),
        "runner root assigned": `RUNNER_TEMP="$SYNTHETIC_8970_DIR"\n${run}`,
        "PATH assigned": `PATH="$SYNTHETIC_8970_DIR"\n${run}`,
      }),
    },
  ];
  const stepRun = ({ file, job, step }) => liveStep(file, job, step).run;
  const stepEnvOf = ({ file, job, step }) => liveStep(file, job, step).env;
  const entryOf = ({ operand }) =>
    DESTRUCTIVE_GRAMMAR.benignForms.find((entry) => entry.selector === "sed" && entry.words.at(-1).value === operand);

  it.each(directories.map((directory) => [directory.file, directory]))(
    "the origin step admits its preserved sed entry: %s",
    (_file, directory) => {
      const entry = entryOf(directory);
      expect(entry.origin).toEqual({ sha: corpusSha, path: directory.file, job: directory.job, step: directory.step });
      expect(directoryIds).toContain(entry.id);
      const run = stepRun(directory);
      expect(run).toContain(sedCommand(directory.operand));
      expect(classifyShellCommands(run, { env: stepEnvOf(directory) }).indeterminate).toEqual([]);
      // CRLF leaves the bindings' tokens unchanged; other multi-line words in
      // the step need not match their stored LF spelling.
      const crlf = classifyShellCommands(run.replaceAll("\n", "\r\n"), { env: stepEnvOf(directory) }).indeterminate;
      expect(crlf.filter(({ tool }) => tool === "sed")).toEqual([]);
    },
  );

  it.each(directories.map((directory) => [directory.file, directory]))(
    "a changed binding, root or read refuses the unchanged sed command: %s",
    (_file, directory) => {
      const entry = entryOf(directory);
      const run = stepRun(directory);
      const change = (from, to) => {
        expect(run.split(from), from).toHaveLength(2);
        return run.replace(from, to);
      };
      const refusal = expect.objectContaining({ tool: "sed", reason: unpinned(entry) });
      for (const [label, changed] of Object.entries({
        ...directory.changes(run, change),
        "command alone": sedCommand(directory.operand),
      })) {
        expect(classifyShellCommands(changed).indeterminate, label).toContainEqual(refusal);
        const ungated = checkWorkflowDestructiveOperationGating(pushWorkflow(changed));
        expect(ungated.passed, label).toBe(false);
        expect(ungated.violations, label).toContainEqual(expect.stringContaining(unpinned(entry)));
      }
    },
  );

  it("a stored directory operand is bound to its origin step", () => {
    for (const directory of directories) {
      const entry = entryOf(directory);
      for (const origin of [
        { ...entry.origin, step: entry.origin.step + 1 },
        { ...entry.origin, job: "synthetic-8970" },
        { ...entry.origin, path: ".github/workflows/synthetic-8970.yml" },
        { ...entry.origin, sha: "f".repeat(40) },
      ]) {
        const forged = { ...entry, origin };
        expectRejected(forged, unpinned(forged));
      }
    }
  });
});

// #9031: every dynamic F4 operand (terminal operand, forwarding resource, find
// start path) is admitted only with a lead proved at its own site, from the
// actual run and env, and every stored entry is proved at every occurrence in
// its stored origin record.
describe("site-proved F4 operand leads", () => {
  const curl = "curl --fail $url";
  const literalUrl = 'url="https://example.invalid/synthetic-9031"';
  const premiseCases = {
    "L3 top-level binding": {
      candidate: `${literalUrl}\ncurl --fail "$url"\n`,
      target: curl,
      bypasses: {
        "option literal": 'url="-Ksynthetic"\ncurl --fail "$url"\n',
        "input expression": 'url="${{ inputs.synthetic_url }}"\ncurl --fail "$url"\n',
        "secret expression": 'url="${{ secrets.SYNTHETIC_URL }}"\ncurl --fail "$url"\n',
        "pull request title": 'url="${{ github.event.pull_request.title }}"\ncurl --fail "$url"\n',
        "top-level positional": 'url="$1"\ncurl --fail "$url"\n',
        "unproved default": 'url="${SYNTHETIC_URL:-https://example.invalid}"\ncurl --fail "$url"\n',
        "use before binding": `curl --fail "$url"\n${literalUrl}\n`,
        "second writer": `${literalUrl}\nurl="$1"\ncurl --fail "$url"\n`,
        "conditional binding": `if [ -n "$SYNTHETIC_MODE" ]; then\n  ${literalUrl}\nfi\ncurl --fail "$url"\n`,
        "subshell binding": `(${literalUrl})\ncurl --fail "$url"\n`,
        "piped binding": `true | ${literalUrl}\ncurl --fail "$url"\n`,
        "read rebinding": `${literalUrl}\nread -r url\ncurl --fail "$url"\n`,
        "quoted builtin rebinding": `${literalUrl}\n"export" url="-K"\ncurl --fail "$url"\n`,
        "nested function rebinding": `${literalUrl}\nfail() {\n  url="-K"\n}\nfail\ncurl --fail "$url"\n`,
        "trap rebinding": `${literalUrl}\ntrap 'url=-K' EXIT\ncurl --fail "$url"\n`,
      },
    },
    "L4-L env literal": {
      candidate: 'curl --fail "$SYNTHETIC_URL"\n',
      env: { ...emptyEnv, step: { SYNTHETIC_URL: "https://example.invalid/synthetic-9031" } },
      target: "curl --fail $SYNTHETIC_URL",
      envBypasses: {
        "bare undeclared": emptyEnv,
        "option literal": { ...emptyEnv, job: { SYNTHETIC_URL: "-Ksynthetic" } },
        "empty literal": { ...emptyEnv, workflow: { SYNTHETIC_URL: "" } },
        "unguarded input": { ...emptyEnv, step: { SYNTHETIC_URL: "${{ inputs.synthetic_url }}" } },
        "input alias": { ...emptyEnv, step: { SYNTHETIC_URL: "${{ github.event.inputs.synthetic_url }}" } },
        secret: { ...emptyEnv, step: { SYNTHETIC_URL: "${{ secrets.SYNTHETIC_URL }}" } },
        "unknown event field": { ...emptyEnv, step: { SYNTHETIC_URL: "${{ github.event.issue.title }}" } },
        "expression function": { ...emptyEnv, step: { SYNTHETIC_URL: "${{ format('-{0}', github.sha) }}" } },
      },
    },
    "L3-G whole-language guard": {
      candidate:
        '[[ "$SYNTHETIC_RUN_ID" =~ ^[0-9]+$ ]] || {\n  echo "synthetic run id must be digits" >&2\n  exit 1\n}\ngh run view "$SYNTHETIC_RUN_ID" --json status\n',
      env: { ...emptyEnv, step: { SYNTHETIC_RUN_ID: "${{ inputs.synthetic_run_id }}" } },
      target: "gh run view $SYNTHETIC_RUN_ID --json status",
      bypasses: {
        "guard removed": 'gh run view "$SYNTHETIC_RUN_ID" --json status\n',
        "guard after use":
          'gh run view "$SYNTHETIC_RUN_ID" --json status\n[[ "$SYNTHETIC_RUN_ID" =~ ^[0-9]+$ ]] || {\n  echo "synthetic run id must be digits" >&2\n  exit 1\n}\n',
        "first atom only":
          '[[ "$SYNTHETIC_RUN_ID" =~ ^[0-9]*-e$ ]] || {\n  echo "synthetic run id must be digits" >&2\n  exit 1\n}\ngh run view "$SYNTHETIC_RUN_ID" --json status\n',
        "top-level alternation":
          '[[ "$SYNTHETIC_RUN_ID" =~ ^a|-e$ ]] || {\n  echo "synthetic run id must be digits" >&2\n  exit 1\n}\ngh run view "$SYNTHETIC_RUN_ID" --json status\n',
        unanchored:
          '[[ "$SYNTHETIC_RUN_ID" =~ [0-9]+ ]] || {\n  echo "synthetic run id must be digits" >&2\n  exit 1\n}\ngh run view "$SYNTHETIC_RUN_ID" --json status\n',
        "any character":
          '[[ "$SYNTHETIC_RUN_ID" =~ ^.+$ ]] || {\n  echo "synthetic run id must be digits" >&2\n  exit 1\n}\ngh run view "$SYNTHETIC_RUN_ID" --json status\n',
        "nonterminating handler":
          '[[ "$SYNTHETIC_RUN_ID" =~ ^[0-9]+$ ]] || {\n  echo "synthetic run id must be digits" >&2\n}\ngh run view "$SYNTHETIC_RUN_ID" --json status\n',
        "rebound after guard":
          '[[ "$SYNTHETIC_RUN_ID" =~ ^[0-9]+$ ]] || {\n  echo "synthetic run id must be digits" >&2\n  exit 1\n}\nSYNTHETIC_RUN_ID="-e"\ngh run view "$SYNTHETIC_RUN_ID" --json status\n',
        "nullable without nonempty use":
          '[[ "$SYNTHETIC_RUN_ID" =~ ^([0-9]+)?$ ]] || {\n  echo "synthetic run id must be digits" >&2\n  exit 1\n}\ngh run view "$SYNTHETIC_RUN_ID" --json status\n',
      },
    },
    "L3-G nullable guard with nonempty use": {
      candidate:
        '[[ "$SYNTHETIC_RUN_ID" =~ ^([0-9]+)?$ ]] || {\n  echo "synthetic run id must be empty or digits" >&2\n  exit 1\n}\nif [ -n "$SYNTHETIC_RUN_ID" ]; then\n  gh run view "$SYNTHETIC_RUN_ID" --json status\nfi\n',
      env: { ...emptyEnv, step: { SYNTHETIC_RUN_ID: "${{ inputs.synthetic_run_id }}" } },
      target: "gh run view $SYNTHETIC_RUN_ID --json status",
      bypasses: {
        "use outside the nonempty arm":
          '[[ "$SYNTHETIC_RUN_ID" =~ ^([0-9]+)?$ ]] || {\n  echo "synthetic run id must be empty or digits" >&2\n  exit 1\n}\nif [ -n "$SYNTHETIC_RUN_ID" ]; then\n  :\nfi\ngh run view "$SYNTHETIC_RUN_ID" --json status\n',
      },
    },
    "LB finite literal loop": {
      candidate:
        'for environment in staging production; do\n  synthetic_root="${RUNNER_TEMP}/${environment}"\n  cd "$synthetic_root"\ndone\n',
      target: "cd $synthetic_root",
      bypasses: {
        "provenance-only binding":
          'for environment in staging production; do\n  synthetic_root="$(mktemp -d)"\n  cd "$synthetic_root"\ndone\n',
        "unproved iterator list":
          'for environment in $(cat environments); do\n  synthetic_root="${RUNNER_TEMP}/${environment}"\n  cd "$synthetic_root"\ndone\n',
        "late binding":
          'for environment in staging production; do\n  cd "$synthetic_root"\n  synthetic_root="${RUNNER_TEMP}/${environment}"\ndone\n',
        "use after the loop":
          'for environment in staging production; do\n  synthetic_root="${RUNNER_TEMP}/${environment}"\ndone\ncd "$synthetic_root"\n',
        "nested loop writer":
          'for environment in staging production; do\n  synthetic_root="${RUNNER_TEMP}/${environment}"\n  for other in x; do\n    synthetic_root="-e"\n  done\n  cd "$synthetic_root"\ndone\n',
      },
    },
    "LB literal iterator lead": {
      candidate: 'for directory in staging production; do\n  cd "$directory"\ndone\n',
      target: "cd $directory",
      bypasses: {
        "option-shaped element": 'for directory in staging -e; do\n  cd "$directory"\ndone\n',
        "iterator rebinding": 'for directory in staging production; do\n  directory="$1"\n  cd "$directory"\ndone\n',
      },
    },
    "LE finite array iterator": {
      candidate:
        'canary_urls=("https://example.invalid/a" "https://example.invalid/b")\nfor url in "${canary_urls[@]}"; do\n  curl --fail "$url"\ndone\n',
      target: curl,
      bypasses: {
        "option-shaped element":
          'canary_urls=("https://example.invalid/a" "-K")\nfor url in "${canary_urls[@]}"; do\n  curl --fail "$url"\ndone\n',
        "unconditional unproved append":
          'canary_urls=("https://example.invalid/a" "https://example.invalid/b")\ncanary_urls+=("$1")\nfor url in "${canary_urls[@]}"; do\n  curl --fail "$url"\ndone\n',
        "mapfile rebinding":
          'canary_urls=("https://example.invalid/a" "https://example.invalid/b")\nmapfile -t canary_urls < synthetic-urls.txt\nfor url in "${canary_urls[@]}"; do\n  curl --fail "$url"\ndone\n',
      },
    },
    "LS function invocation": {
      candidate:
        'probe_key() {\n  response="${RUNNER_TEMP}/synthetic-9031.xml"\n  grep -qi "AccessDenied" "$response"\n}\nprobe_key\n',
      target: "grep -qi AccessDenied $response",
      bypasses: {
        "use before binding":
          'probe_key() {\n  grep -qi "AccessDenied" "$response"\n  response="${RUNNER_TEMP}/synthetic-9031.xml"\n}\nprobe_key\n',
        "redefined function":
          'probe_key() {\n  response="${RUNNER_TEMP}/synthetic-9031.xml"\n  grep -qi "AccessDenied" "$response"\n}\nprobe_key() {\n  :\n}\nprobe_key\n',
        "recursive function":
          'probe_key() {\n  response="${RUNNER_TEMP}/synthetic-9031.xml"\n  grep -qi "AccessDenied" "$response"\n  probe_key\n}\nprobe_key\n',
        "helper writer":
          'fail() {\n  response="-e"\n}\nprobe_key() {\n  response="${RUNNER_TEMP}/synthetic-9031.xml"\n  grep -qi "AccessDenied" "$response"\n}\nprobe_key\n',
      },
    },
    "LS conditional arm and group": {
      candidate:
        'if [ -n "$SYNTHETIC_MODE" ]; then\n  out="${RUNNER_TEMP}/synthetic-9031"\n  {\n    grep -qi "AccessDenied" "$out"\n  }\nfi\n',
      target: "grep -qi AccessDenied $out",
      bypasses: {
        "sibling arm":
          'if [ -n "$SYNTHETIC_MODE" ]; then\n  out="${RUNNER_TEMP}/synthetic-9031"\nelse\n  grep -qi "AccessDenied" "$out"\nfi\n',
        "after the arm":
          'if [ -n "$SYNTHETIC_MODE" ]; then\n  out="${RUNNER_TEMP}/synthetic-9031"\nfi\ngrep -qi "AccessDenied" "$out"\n',
      },
    },
    "LL local binding": {
      candidate: 'read_field() {\n  local url="https://${1}"\n  curl --fail "$url"\n}\nread_field example.invalid\n',
      target: curl,
      bypasses: {
        "provenance-only local":
          'read_field() {\n  local url="$(cat synthetic-url)"\n  curl --fail "$url"\n}\nread_field example.invalid\n',
        "option-shaped local":
          'read_field() {\n  local url="-K"\n  curl --fail "$url"\n}\nread_field example.invalid\n',
      },
    },
    "LP positional local": {
      candidate: 'read_field() {\n  local url="$1"\n  curl --fail "$url"\n}\nread_field "https://example.invalid/a"\n',
      target: curl,
      bypasses: {
        "unproved actual":
          'read_field() {\n  local url="$1"\n  curl --fail "$url"\n}\nread_field "https://example.invalid/a"\nread_field "$SYNTHETIC_OPTION"\n',
        "no direct call": 'read_field() {\n  local url="$1"\n  curl --fail "$url"\n}\n',
      },
    },
    "LC exhaustive conditional": {
      candidate:
        'if [ -n "$SYNTHETIC_MODE" ]; then\n  url="https://example.invalid/a"\nelse\n  url="https://example.invalid/b"\nfi\ncurl --fail "$url"\n',
      target: curl,
      bypasses: {
        "missing else":
          'if [ -n "$SYNTHETIC_MODE" ]; then\n  url="https://example.invalid/a"\nfi\ncurl --fail "$url"\n',
        "unproved arm":
          'if [ -n "$SYNTHETIC_MODE" ]; then\n  url="https://example.invalid/a"\nelse\n  url="$1"\nfi\ncurl --fail "$url"\n',
      },
    },
    "LC initial binding with replacement": {
      candidate:
        'url="https://example.invalid/a"\nif [ -n "$SYNTHETIC_MODE" ]; then\n  url="https://example.invalid/b"\nfi\ncurl --fail "$url"\n',
      target: curl,
      bypasses: {
        "option replacement":
          'url="https://example.invalid/a"\nif [ -n "$SYNTHETIC_MODE" ]; then\n  url="-K"\nfi\ncurl --fail "$url"\n',
        "straight-line repeat":
          'url="https://example.invalid/a"\nurl="https://example.invalid/b"\ncurl --fail "$url"\n',
      },
    },
    "LC-B loop replacement": {
      candidate:
        'for name in api web; do\n  resource="deployment/${name}"\n  if ! kubectl get "$resource" --namespace synthetic >/dev/null 2>&1; then\n    resource="rollout.argoproj.io/${name}"\n  fi\n  kubectl get "$resource" --namespace synthetic\ndone\n',
      target: "kubectl get $resource --namespace synthetic",
      bypasses: {
        "initial binding removed":
          'for name in api web; do\n  if ! kubectl get "$resource" --namespace synthetic >/dev/null 2>&1; then\n    resource="rollout.argoproj.io/${name}"\n  fi\n  kubectl get "$resource" --namespace synthetic\ndone\n',
        "option replacement":
          'for name in api web; do\n  resource="deployment/${name}"\n  if ! kubectl get "$resource" --namespace synthetic >/dev/null 2>&1; then\n    resource="-e"\n  fi\n  kubectl get "$resource" --namespace synthetic\ndone\n',
        "provenance-only replacement":
          'for name in api web; do\n  resource="deployment/${name}"\n  if ! kubectl get "$resource" --namespace synthetic >/dev/null 2>&1; then\n    resource="$(cat synthetic-resource)"\n  fi\n  kubectl get "$resource" --namespace synthetic\ndone\n',
      },
    },
    "LI read-loop output binding": {
      candidate:
        'while IFS= read -r encoded; do\n  number="$(jq -r \'.number\' <<< "${encoded}")"\n  gh issue close "$number" --comment synthetic\ndone < synthetic-issues.txt\n',
      target: "gh issue close $number --comment synthetic",
      bypasses: {
        "direct read target":
          'while IFS= read -r number; do\n  gh issue close "$number" --comment synthetic\ndone < synthetic-issues.txt\n',
        "use after the loop":
          'while IFS= read -r encoded; do\n  number="$(jq -r \'.number\' <<< "${encoded}")"\ndone < synthetic-issues.txt\ngh issue close "$number" --comment synthetic\n',
        "header without IFS":
          'while read -r encoded; do\n  number="$(jq -r \'.number\' <<< "${encoded}")"\n  gh issue close "$number" --comment synthetic\ndone < synthetic-issues.txt\n',
      },
    },
    "find start path": {
      candidate: "find \"$SYNTHETIC_DIR\" -type f -name '*.json'\n",
      env: { ...emptyEnv, step: { SYNTHETIC_DIR: "artifacts/synthetic-9031" } },
      target: "find $SYNTHETIC_DIR -type f -name *.json",
      envBypasses: {
        undeclared: emptyEnv,
        "option literal": { ...emptyEnv, step: { SYNTHETIC_DIR: "-exec" } },
      },
    },
    "forwarding resource": {
      candidate: 'docker exec "$SYNTHETIC_CONTAINER" pg_isready -U postgres\n',
      env: { ...emptyEnv, job: { SYNTHETIC_CONTAINER: "${{ job.services.postgres.id }}" } },
      target: "docker exec $SYNTHETIC_CONTAINER pg_isready -U postgres",
      envBypasses: {
        undeclared: emptyEnv,
        "unguarded input": { ...emptyEnv, job: { SYNTHETIC_CONTAINER: "${{ inputs.synthetic_container }}" } },
      },
    },
  };

  // One row per (premise, bypass) and (premise, envBypass) keeps each test
  // inside the strict budget. Every row of a premise uses the one fixture that
  // spells all of its bypasses, built on first use.
  const premiseFixtures = new Map();
  const premiseFixture = (label) => {
    if (!premiseFixtures.has(label)) {
      const item = premiseCases[label];
      const env = item.env ?? emptyEnv;
      const fixture = siteFixture(item.candidate, env, Object.values(item.bypasses ?? {}));
      premiseFixtures.set(label, { item, env, fixture, target: fixture.target(item.target) });
    }
    return premiseFixtures.get(label);
  };
  const premiseRows = (field) =>
    Object.entries(premiseCases).flatMap(([label, item]) =>
      Object.keys(item[field] ?? {}).map((bypass) => [label, bypass]),
    );

  it.each(Object.keys(premiseCases))("%s: candidate proves its lead", (label) => {
    const { item, env, fixture, target } = premiseFixture(label);
    expect(target, item.target).toBeDefined();
    expectSiteAdmitted(fixture, item.candidate, env);
  });
  it.each(premiseRows("bypasses"))("%s: bypass %s refuses", (label, bypass) => {
    const { item, env, fixture, target } = premiseFixture(label);
    const run = item.bypasses[bypass];
    expect(target, item.target).toBeDefined();
    expect(run, bypass).not.toBe(item.candidate);
    expectSiteRefused(fixture, target, run, env);
  });
  it.each(premiseRows("envBypasses"))("%s: env bypass %s refuses", (label, bypass) => {
    const { item, fixture, target } = premiseFixture(label);
    expect(target, item.target).toBeDefined();
    expectSiteRefused(fixture, target, item.candidate, item.envBypasses[bypass]);
  });

  // AC2 RED: every dynamic action/option negative must refuse through the
  // validator, classifier, ungated push caller and bounded deploy-production
  // exemption. These are provider-free synthetic controls.
  const f4RedRows = [
    ["curl unbound option", 'curl --fail "$SYNTHETIC_OPTION"', emptyEnv],
    ["curl env option", 'curl --fail "$SYNTHETIC_OPTION"', { ...emptyEnv, step: { SYNTHETIC_OPTION: "-Ksynthetic" } }],
    [
      "curl needs output provenance",
      'curl --fail "$SYNTHETIC_OPTION"',
      { ...emptyEnv, step: { SYNTHETIC_OPTION: "\${{ needs.synthetic.outputs.value }}" } },
    ],
    ["playwright dynamic action", 'playwright "$SYNTHETIC_ACTION"', emptyEnv],
    ["kubectl dynamic action", 'kubectl create "$SYNTHETIC_ACTION"', emptyEnv],
    ["git dynamic option", 'git fetch "$SYNTHETIC_OPTION"', emptyEnv],
    ["jq output as terraform action", 'terraform "$SYNTHETIC_ACTION"', emptyEnv],
    [
      "guard rebound",
      '[[ "$SYNTHETIC_ID" =~ ^[^-].*$ ]] || { exit 1; }\nSYNTHETIC_ID="-e"\ngh run view "$SYNTHETIC_ID" --json status',
      emptyEnv,
    ],
  ];
  it.each(f4RedRows)("F4 RED %s", (_label, run, env) => {
    const fixture = siteFixture(run, env);
    // `siteFixture.target` compares the parser's normalized word values,
    // while these controls intentionally keep their quoted shell spelling.
    // Resolve the same command by removing only those protecting quotes;
    // dynamic values and their identities remain unchanged.
    const target = fixture.target(run.split("\n").at(-1).replaceAll('"', ""));
    expect(target).toBeDefined();
    expectSiteRefused(fixture, target, run, env);
  });

  // AC3 GREEN: the three finite closures selected by #9852 remain explicit
  // controls rather than relying only on the live corpus transitions.
  const f4GreenRows = [
    [
      "T1 service id",
      'docker exec "$SYNTHETIC_CONTAINER" pg_isready -U postgres\n',
      { ...emptyEnv, job: { SYNTHETIC_CONTAINER: "\${{ job.services.postgres.id }}" } },
      "docker exec $SYNTHETIC_CONTAINER pg_isready -U postgres",
    ],
    ["T2 mktemp root", 'tmp="$(mktemp -d)"\ncurl --fail "$tmp/health"\n', emptyEnv, "curl --fail $tmp/health"],
    [
      "T3 whole-language guard",
      '[[ "$SYNTHETIC_ID" =~ ^[0-9]+$ ]] || { exit 1; }\ngh run view "$SYNTHETIC_ID" --json status\n',
      { ...emptyEnv, step: { SYNTHETIC_ID: "\${{ inputs.synthetic_id }}" } },
      "gh run view $SYNTHETIC_ID --json status",
    ],
  ];
  it.each(f4GreenRows)("F4 GREEN %s", (_label, run, env, targetText) => {
    const fixture = siteFixture(run, env);
    expect(fixture.target(targetText)).toBeDefined();
    expectSiteAdmitted(fixture, run, env);
  });

  it("LX: a leading trusted expression proves provenance; input, secret and unknown roots refuse", () => {
    const run = (root) => `for source_path in a.txt b.txt; do\n  git show "\${{ ${root} }}:\${source_path}"\ndone\n`;
    const candidate = run("needs.synthetic.outputs.commit");
    const fixture = siteFixture(candidate);
    expectSiteAdmitted(fixture, candidate);
    for (const root of [
      "inputs.synthetic_commit",
      "secrets.SYNTHETIC_COMMIT",
      "github.event.pull_request.title",
      "github.ref_name",
      "format('{0}', github.sha)",
    ]) {
      const entry = {
        ...syntheticEntry(["git", "show", D(`\${{ ${root} }}:\${source_path}`)]),
        origin: syntheticOrigin,
      };
      const grammar = {
        ...DESTRUCTIVE_GRAMMAR,
        benignForms: [...DESTRUCTIVE_GRAMMAR.benignForms, entry],
        origins: [...DESTRUCTIVE_GRAMMAR.origins, storedOrigin(syntheticOrigin, run(root))],
      };
      expect(validateGrammarPartition(grammar).violations, root).toEqual([unpinned(entry)]);
      expect(classifyShellCommands(run(root), { grammar: withEntry(entry) }).indeterminate[0].reason).toContain(
        unpinned(entry),
      );
    }
    // The suffix is separately proved: an unproved suffix name refuses.
    const unproved = 'git show "${{ needs.synthetic.outputs.commit }}:${source_path}"\n';
    const entry = fixture.target("git show ${{ needs.synthetic.outputs.commit }}:${source_path}");
    expect(classifyShellCommands(unproved, { grammar: fixture.grammar }).indeterminate[0].reason).toBe(unpinned(entry));
  });

  // AC1: each occurrence owns its proof. One stored ID, two live bindings:
  // only the invalid site refuses, in either position and alongside valid hits.
  it("same-ID two-binding fixture: only the invalid occurrence refuses", () => {
    const valid =
      'probe_key() {\n  local url="https://example.invalid/one"\n  curl --fail "$url"\n}\nread_field() {\n  local url="$1"\n  curl --fail "$url"\n}\nprobe_key\nread_field "https://example.invalid/two"\nread_field "$SYNTHETIC_PROBE"\n';
    const env = { ...emptyEnv, step: { SYNTHETIC_PROBE: "https://example.invalid/three" } };
    const second = valid.replace('read_field "$SYNTHETIC_PROBE"', 'read_field "$SYNTHETIC_OPTION"');
    const first = valid.replace('local url="https://example.invalid/one"', 'local url="$SYNTHETIC_OPTION"');
    const fixture = siteFixture(valid, env, [second, first]);
    const target = fixture.target(curl);
    expect(target.origin).toEqual(syntheticOrigin);
    expectSiteAdmitted(fixture, valid, env);
    const refusals = classifyShellCommands(second, { grammar: fixture.grammar, env }).indeterminate;
    // The first site still proves; only the second curl (index after it) refuses.
    expect(refusals).toEqual([expect.objectContaining({ tool: "curl", reason: unpinned(target) })]);
    expect(refusals[0].index).toBeGreaterThan(second.indexOf('curl --fail "$url"'));
    const firstRefusals = classifyShellCommands(first, { grammar: fixture.grammar, env }).indeterminate;
    expect(firstRefusals).toEqual([expect.objectContaining({ tool: "curl", reason: unpinned(target) })]);
    expect(firstRefusals[0].index).toBeLessThan(first.lastIndexOf('curl --fail "$url"'));
    // Moved and renamed copies: each copy is proved where it stands.
    const renamed = `${valid}probe_key\n`.replace(/probe_key/g, "verify_plan");
    expectSiteAdmitted(siteFixture(renamed, env), renamed, env);
    // The validator proves every stored occurrence: a stored second site that
    // fails refuses the entry even though the first proves.
    expect(validateGrammarPartition(fixture.grammarFor(second, env)).violations).toContain(unpinned(target));
    expect(storedOccurrenceProofs(target, fixture.grammar).map(({ violations }) => violations)).toEqual([[], []]);
  });

  it("stored origins: omission, duplicate and wrong-context records refuse", () => {
    const entry = DESTRUCTIVE_GRAMMAR.benignForms.find(({ example }) =>
      example.startsWith('grep -qi "AccessDenied" "$root_response"'),
    );
    expect(storedOccurrenceProofs(entry).map(({ violations }) => violations)).toEqual([[]]);
    const without = {
      ...DESTRUCTIVE_GRAMMAR,
      origins: DESTRUCTIVE_GRAMMAR.origins.filter(
        (record) => record.step !== entry.origin.step || record.path !== entry.origin.path,
      ),
    };
    expect(validateGrammarPartition(without).violations).toContain(unpinned(entry));
    const record = DESTRUCTIVE_GRAMMAR.origins.find(
      (item) => item.path === entry.origin.path && item.step === entry.origin.step,
    );
    const duplicate = { ...DESTRUCTIVE_GRAMMAR, origins: [...DESTRUCTIVE_GRAMMAR.origins, record] };
    expect(validateGrammarPartition(duplicate).violations).toEqual([
      `${[record.sha, record.path, record.job, record.step].join(":")}: duplicate origin record.`,
    ]);
    const other = DESTRUCTIVE_GRAMMAR.origins.find((item) => item !== record && !item.run.includes("root_response"));
    const wrong = {
      ...DESTRUCTIVE_GRAMMAR,
      origins: DESTRUCTIVE_GRAMMAR.origins.map((item) =>
        item === record ? storedOrigin(record, other.run, other.env) : item,
      ),
    };
    expect(validateGrammarPartition(wrong).violations).toContain(unpinned(entry));
    const tampered = {
      ...DESTRUCTIVE_GRAMMAR,
      origins: DESTRUCTIVE_GRAMMAR.origins.map((item) => (item === record ? { ...item, run: `${item.run}\n` } : item)),
    };
    expect(validateGrammarPartition(tampered).violations).toContain(unpinned(entry));
  });

  // AC1: the stored-to-live relation, measured at this base. Every live F4
  // proof names its stored entry; every stored entry whose proof needs a site
  // is proved at each stored occurrence; each live site is proved on its own.
  it("the stored-to-live occurrence relation is complete in both directions", () => {
    const discovered = checkDiscoveredWorkflows();
    expect(discovered.passed).toBe(true);
    const live = discovered.results.flatMap(({ workflowFile, proofs }) =>
      proofs.map((proof) => ({ workflowFile, ...proof })),
    );
    expect(live.length).toBeGreaterThan(200);
    expect(live.filter(({ proved }) => !proved)).toEqual([]);
    const ids = new Set(DESTRUCTIVE_GRAMMAR.benignForms.map(({ id }) => id));
    expect(live.filter(({ entry }) => !ids.has(entry))).toEqual([]);
    const sites = new Set(
      live.map(({ workflowFile, jobId, stepIndex, index, word }) =>
        [workflowFile, jobId, stepIndex, index, word].join("|"),
      ),
    );
    expect(sites.size).toBeLessThanOrEqual(live.length);
    const stored = DESTRUCTIVE_GRAMMAR.benignForms
      .map((entry) => [entry, storedOccurrenceProofs(entry)])
      .filter(([, occurrences]) => occurrences.length);
    expect(stored.length).toBeGreaterThan(200);
    for (const [entry, occurrences] of stored)
      expect(
        occurrences.map(({ violations }) => violations),
        entry.id,
      ).toEqual(occurrences.map(() => []));
    const premises = new Set(live.map(({ premise }) => premise));
    for (const premise of [
      "L1",
      "L3",
      "L3-G",
      "L4",
      "L4-L",
      "L4-T",
      "LB",
      "LE",
      "LS",
      "LL",
      "LP",
      "LC",
      "LC-B",
      "LI",
      "LR",
      "LX",
      "BS",
    ])
      expect(premises, premise).toContain(premise);
  });

  // D1: one stored ID, two live production sites, both upgraded by their
  // dominating non-option guards.
  it("D1 proves both live sites by the guarded lead envelope", () => {
    const d1 = DESTRUCTIVE_GRAMMAR.benignForms.find(
      ({ id }) => id === "9d359a5da3985b4bdf1051e39cf585a54fb5e01a57b6f9a219cdf040e647155c",
    );
    expect(d1).toBeDefined();
    const live = checkDiscoveredWorkflows().results.find(({ workflowFile }) => workflowFile === productionFile).proofs;
    const sites = live.filter(({ entry }) => entry === d1.id);
    expect(sites.map(({ jobId, premise, lead }) => [jobId, premise, lead])).toEqual([
      ["notify-production-deploy-incident", "L3-G", true],
      ["close-resolved-deploy-incidents", "L3-G", true],
    ]);
    expect(sites.at(-1).residual).toEqual([]);
    expect(sites.at(-1).dependencies).toEqual(expect.arrayContaining([".number", ".title"]));
  });

  // LR premises, each mutated in the live close-resolved block with every
  // other shape frozen.
  it("LR refuses every producer, header, field, target, input, writer and escape change", () => {
    const { run, env } = liveStep(productionFile, "close-resolved-deploy-incidents", 1);
    const d1 = DESTRUCTIVE_GRAMMAR.benignForms.find(
      ({ id }) => id === "9d359a5da3985b4bdf1051e39cf585a54fb5e01a57b6f9a219cdf040e647155c",
    );
    const change = (from, to) => {
      expect(run.split(from), from).toHaveLength(2);
      return run.replace(from, to);
    };
    const close =
      'gh issue close "${issue_number}" \\\n    --repo "${GITHUB_REPOSITORY}" \\\n    --comment "${close_comment}"';
    const mutants = {
      "header IFS": change("while IFS=$'\\t' read -r", "while IFS=, read -r"),
      "extra read target": change("read -r issue_number issue_title;", "read -r issue_number issue_title extra;"),
      "read builtin shadowed": `read() {\n  :\n}\n${run}`,
      "producer json fields": change("--json number,title \\", "--json number,title,body \\"),
      "producer projection": change(' | select(.title | startswith("Incident: Platform Deploy "))', ""),
      "producer field order": change("[.number, .title]", "[.title, .number]"),
      "producer piped": change("| @tsv'\n)", "| @tsv' | head -n 5\n)"),
      "producer second writer": change(
        'if [ -z "${open_incidents}" ]; then',
        'open_incidents="${SYNTHETIC_TSV}"\nif [ -z "${open_incidents}" ]; then',
      ),
      "input changed": change('done <<< "${open_incidents}"', 'done < "${SYNTHETIC_TSV_FILE}"'),
      "target rebound": change("  gh issue close", '  issue_number="-e"\n  gh issue close'),
      "use after the loop": `${run}${close}\n`,
    };
    const fixture = siteFixture(run, env, Object.values(mutants));
    expectSiteAdmitted(fixture, run, env);
    for (const [label, mutant] of Object.entries(mutants)) {
      const refusals = classifyShellCommands(mutant, { grammar: fixture.grammar, env }).indeterminate;
      expect(refusals[0]?.reason, label).toBe(unpinned(d1));
    }
  });

  it("AV refuses unproved appends, dynamic options, missing values and loop appends", () => {
    const { run, env } = liveStep(productionFile, "notify-production-deploy-incident", 3);
    const create = DESTRUCTIVE_GRAMMAR.benignForms.find(
      ({ id }) => id === "0d9650845498cfad724adaf87273779a05e4e6c21af8da031858b8fcd1d943c8",
    );
    const change = (from, to) => {
      expect(run.split(from), from).toHaveLength(2);
      return run.replace(from, to);
    };
    const use = '  gh issue create "${issue_create_args[@]}"';
    const mutants = {
      "unconditional unproved append": change(use, `  issue_create_args+=(--label "$SYNTHETIC_LABEL")\n${use}`),
      "dynamic option element": change(
        '  issue_create_args=(\n    --repo "${GITHUB_REPOSITORY}" \\',
        '  issue_create_args=(\n    "$SYNTHETIC_OPTION" "${GITHUB_REPOSITORY}" \\',
      ),
      "unknown option": change('    --label "kind:ops" \\', '    --assignee "synthetic" \\'),
      "missing value": change('    --label "area:infrastructure"\n  )', "    --label\n  )"),
      "loop append": change(use, `  for label in a b; do\n    issue_create_args+=(--label "$label")\n  done\n${use}`),
      "constructor removed": change("  issue_create_args=(", "  synthetic_args=("),
    };
    const fixture = siteFixture(run, env, Object.values(mutants));
    expectSiteAdmitted(fixture, run, env);
    for (const [label, mutant] of Object.entries(mutants)) {
      const refusals = classifyShellCommands(mutant, { grammar: fixture.grammar, env }).indeterminate;
      expect(
        refusals.map(({ reason }) => reason),
        label,
      ).toContain(unpinned(create));
    }
  });

  // AC6: provenance-only rows remain available to R outside the
  // option-capable envelope; no live option-capable row is provenance-only.
  it("R handoff inventory keeps every provenance residual and dependency", () => {
    const live = checkDiscoveredWorkflows().results.flatMap(({ workflowFile, proofs }) =>
      proofs.map((proof) => ({ workflowFile, ...proof })),
    );
    const handoff = live.filter(({ lead }) => !lead);
    expect(handoff.length).toBeGreaterThan(0);
    for (const item of handoff) {
      expect(item.residual.length, `${item.workflowFile} ${item.word}`).toBeGreaterThan(0);
      expect(item.dependencies.length + item.residual.length).toBeGreaterThan(0);
    }
    const counts = {};
    for (const { premise } of handoff) counts[premise] = (counts[premise] ?? 0) + 1;
    // Only provenance premises (and joins carrying one) reach the handoff.
    expect(Object.keys(counts).sort()).toEqual(expect.arrayContaining(["L4-T", "LX"]));
    for (const premise of Object.keys(counts))
      expect(["L3", "L3-T", "L4-T", "LC", "LI", "LR", "LS", "LX"]).toContain(premise);
    const optionTransitions = DESTRUCTIVE_GRAMMAR.benignForms.filter(({ transition }) => transition?.issue === 9862);
    expect(optionTransitions).toHaveLength(38);
    const transitionProofs = optionTransitions.flatMap((entry) =>
      storedOccurrenceProofs(entry).flatMap(({ proofs }) => proofs),
    );
    expect(transitionProofs).not.toEqual(expect.arrayContaining([expect.objectContaining({ lead: false })]));
  });
});

describe("#9862 F4 guard transitions", () => {
  const marker = "991a1d8586da9405dcdec26e4f02e40ee93ba420";
  const allowedFiles = new Set([
    ".github/workflows/platform-catalog-assets-apply.yml",
    ".github/workflows/platform-digitalocean-token-rotation-reminder.yml",
    ".github/workflows/platform-ephemeral-verification.yml",
    ".github/workflows/platform-merge-gate-verification.yml",
    ".github/workflows/platform-pr.yml",
    ".github/workflows/platform-production.yml",
    ".github/workflows/platform-staging-advisory-evidence.yml",
    ".github/workflows/platform-staging-route-matrix-evidence.yml",
    ".github/workflows/platform-staging-wake-drills.yml",
  ]);

  it("lands exactly 38 same-ID transitions with immutable before/after witnesses", () => {
    const transitions = DESTRUCTIVE_GRAMMAR.benignForms.filter(({ transition }) => transition?.issue === 9862);
    expect(transitions).toHaveLength(38);
    expect(new Set(transitions.map(({ id }) => id)).size).toBe(38);
    const records = new Map(
      DESTRUCTIVE_GRAMMAR.origins.map((origin) => [
        [origin.sha, origin.path, origin.job, origin.step].join("|"),
        origin,
      ]),
    );
    for (const entry of transitions) {
      expect(entry.origin.sha).toBe(marker);
      expect(allowedFiles).toContain(entry.origin.path);
      const before = entry.transition.from;
      expect(before.sha).toBe(corpusSha);
      expect([before.sha, before.path, before.job, before.step].join("|")).not.toBe(
        [entry.origin.sha, entry.origin.path, entry.origin.job, entry.origin.step].join("|"),
      );
      expect(entry.transition.beforeRunSha256).toBe(
        records.get([before.sha, before.path, before.job, before.step].join("|"))?.runSha256,
      );
      expect(entry.transition.afterRunSha256).toBe(
        records.get([entry.origin.sha, entry.origin.path, entry.origin.job, entry.origin.step].join("|"))?.runSha256,
      );
      expect(
        storedOccurrenceProofs({ ...entry, origin: before, transition: undefined }).map(({ violations }) => violations),
      ).toEqual(expect.arrayContaining([[]]));
      expect(storedOccurrenceProofs(entry).map(({ violations }) => violations)).toEqual(expect.arrayContaining([[]]));
    }
  });

  it("keeps the 711-entry baseline and 36 appended identities intact", () => {
    expect(DESTRUCTIVE_GRAMMAR.benignForms).toHaveLength(711);
    expect(validateGrammarPartition()).toEqual({ passed: true, members: 503, violations: [] });
    expect(
      DESTRUCTIVE_GRAMMAR.benignForms.filter(({ origin }) => origin.sha === "a460b410398b01d386b7919ef364e63d3d271b88"),
    ).toHaveLength(36);
  });
});

// #8993's published fourteen-ID handoff, applied at the landed H merge.
describe("#8993 origin transitions at landed H", () => {
  const landed = "ebe363d09fb1cd5084cb69a05277590750062a51";
  const freshBase = "a460b410398b01d386b7919ef364e63d3d271b88";
  const priorBase = "268a0899e8463007bb41a641ebe1b8153ecae70d";
  const transitions = [
    "9c19b252802fa93be3ab2af9dc5464f4458341b5b4fdd67f7efac1a9f646367e",
    "63c5fac1fd6fcd76408d51a81f3acf09b8445dd15446c66c4a5d283547e541bd",
    "68e4c8bc5fb4e8ca1699f692dcd9b0cf030ddf580b343c303d9cf22eaeb1217a",
    "60bf4549c3894a835f6d70875b6da4a89c576aef51c868eaa028c48980fd6c5a",
    "7a3ed764ac9994289e76b58af53fb5347d69c4d8fca26bb60383925634a4ba97",
    "930e7e07df96e4ec78a0415c4bf05045e8d42e0934f035ba3a864ee4450abdfd",
    "279c00822e5046894a7c702952d3a545d820c9f789dc71ffe1280eb7d1264e96",
    "f62b51bf13b67dd0041fd38fd2f807af9d1b18d530664ca5a5e8f43a0baef5fc",
    "353418aa54ad6a98da0d5956fe46019d90e7a1403ba3038416098d86c9b83667",
    "16c8677abe43b1d56b949a054db2c3c53f926458cfe10aaeee59c1d6f29d84c3",
    "d233dec2d2cf757d7f6eda546275ae8b4952957a5ade77066fc6bccaaec3a694",
  ];
  // Removed pre-H shapes (re-hashed here) and their published replacements;
  // the fourth is H's derived advisory summary replacement.
  const removals = [
    [
      [
        "gh",
        "run",
        "view",
        D("${{ inputs.platform_deploy_run_id }}"),
        "--repo",
        D("$GITHUB_REPOSITORY"),
        "--json",
        "databaseId,status,conclusion,url,headSha,createdAt,updatedAt,jobs",
      ],
      "d21e2189da53488bf42770c5918f535c5d5902e3ffbd7c784953f62c1ac3271f",
      "86d013e4d092485fd6965ec9ed24452d9de160f271defc5fa9e7362b6383dfe4",
    ],
    [
      [
        "gh",
        "run",
        "download",
        D("${{ inputs.wake_drill_run_id }}"),
        "--repo",
        D("$GITHUB_REPOSITORY"),
        "--dir",
        D("$EVIDENCE_DIR/wake-primary"),
      ],
      "6b0e486519035fba362ed362adac5f16672b1f6b74ff62346a2729243d96c2b6",
      "b6e18c4e58306dbc23c1647608437af4aaddcbab4325b55f0637ce38619593a4",
    ],
    [
      [
        "gh",
        "run",
        "download",
        D("${{ inputs.secondary_wake_drill_run_id }}"),
        "--repo",
        D("$GITHUB_REPOSITORY"),
        "--dir",
        D("$EVIDENCE_DIR/wake-secondary"),
      ],
      "2f7f93df74eede25e64bad5cb61e58af20c0f91edb6d938908f7908a961a1367",
      "283947dc6603546bfda2a97754221d6b489a1c1a3ccf930fddcca0d020706d42",
    ],
    [
      [
        "jq",
        "-n",
        "--arg",
        "checkedAt",
        D("$checked_at"),
        "--arg",
        "releaseCommit",
        D("${{ inputs.release_commit }}"),
        "--arg",
        "platformImage",
        D("${{ inputs.platform_image }}"),
        "--arg",
        "platformImageDigest",
        D("${{ inputs.platform_image_digest }}"),
        "--arg",
        "scenarioSeed",
        D("$SCENARIO_SEED_OUTCOME"),
        "--arg",
        "marketplaceE2e",
        D("$MARKETPLACE_E2E_OUTCOME"),
        "--argjson",
        "failedPhases",
        D("$failed_phases"),
        Q(
          '{schemaVersion:"staging-advisory-evidence/v2",checkedAt:$checkedAt,releaseCommit:$releaseCommit,platformImage:$platformImage,platformImageDigest:$platformImageDigest,scenarioSeed:{outcome:$scenarioSeed},marketplaceE2e:{outcome:$marketplaceE2e},failedPhases:$failedPhases}',
        ),
      ],
      "08d2c94924bf1d88ceea54fafaa97be1bda8ddad2c71c8f42df1d108548711af",
      "2c21f70f9d337dfc641377d919b9ce10c756f09cb35c1ce8f2d69d75a45c722d",
    ],
  ];
  const byId = new Map(DESTRUCTIVE_GRAMMAR.benignForms.map((entry) => [entry.id, entry]));
  const recordOf = (origin) =>
    DESTRUCTIVE_GRAMMAR.origins.find(
      ({ sha, path, job, step }) =>
        [sha, path, job, step].join("|") === [origin.sha, origin.path, origin.job, origin.step].join("|"),
    );

  it("applies eleven same-ID transitions and four removal+append pairs; N reconciles", () => {
    for (const id of transitions) {
      const entry = byId.get(id);
      expect(entry.origin.sha, id).toBe(landed);
      expect(entry.transition).toMatchObject({ from: { sha: corpusSha }, issue: 8993 });
      expect(entry.transition.from.path).toBe(entry.origin.path);
      expect(entry.transition.beforeRunSha256).toBe(recordOf(entry.transition.from).runSha256);
      expect(entry.transition.afterRunSha256).toBe(recordOf(entry.origin).runSha256);
      // Same shape bytes and ID in both records; proved at landed H.
      expect(
        storedOccurrenceProofs({ ...entry, origin: entry.transition.from, transition: undefined }).length,
        id,
      ).toBeGreaterThan(0);
      expect(
        storedOccurrenceProofs(entry).map(({ violations }) => violations),
        id,
      ).toEqual([[]]);
    }
    for (const [words, removed, appended] of removals) {
      expect(syntheticEntry(words).id).toBe(removed);
      expect(byId.has(removed)).toBe(false);
      expect(byId.get(appended)?.origin.sha).toBe(landed);
    }
    const bySha = {};
    for (const { origin } of DESTRUCTIVE_GRAMMAR.benignForms) bySha[origin.sha] = (bySha[origin.sha] ?? 0) + 1;
    // The landed H transitions retain fifteen identities, this head adds the
    // thirty-eight #9862 same-ID guards, and the two fresh-base append sets
    // remain intact.
    expect(bySha).toEqual({
      [corpusSha]: 621,
      "991a1d8586da9405dcdec26e4f02e40ee93ba420": 38,
      [landed]: 15,
      [priorBase]: 1,
      [freshBase]: 36,
    });
    expect(DESTRUCTIVE_GRAMMAR.benignForms).toHaveLength(711);
  });

  it("every removed pre-H shape is absent from every live workflow", () => {
    for (const file of discoverWorkflowFiles(root)) {
      const workflow = parse(readWorkflow(file));
      for (const [job, definition] of Object.entries(workflow.jobs ?? {}))
        for (const [index, step] of (definition.steps ?? []).entries()) {
          if (typeof step.run !== "string") continue;
          const origin = { sha: "1".repeat(40), path: file, job, step: index + 1 };
          const grammar = { ...DESTRUCTIVE_GRAMMAR, origins: [storedOrigin(origin, step.run)] };
          for (const [words] of removals)
            expect(
              storedOccurrenceProofs({ ...syntheticEntry(words), origin }, grammar),
              `${file} ${job} #${index + 1}`,
            ).toEqual([]);
        }
    }
  });

  it("stale, wrong-step, unguarded, transport-removed, changed-shape and label-only transitions refuse", () => {
    const entry = byId.get(transitions[0]);
    const record = recordOf(entry.origin);
    const replaced = (changes) => ({
      ...DESTRUCTIVE_GRAMMAR,
      benignForms: DESTRUCTIVE_GRAMMAR.benignForms.map((item) =>
        item.id === entry.id ? { ...item, ...changes.entry } : item,
      ),
      origins: DESTRUCTIVE_GRAMMAR.origins.map((item) => (item === record && changes.record ? changes.record : item)),
    });
    const guard = '[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] ||';
    expect(record.run).toContain(guard);
    const otherStep = DESTRUCTIVE_GRAMMAR.origins.find(
      (item) => item.sha === landed && item.path !== entry.origin.path,
    );
    const mutants = {
      stale: { entry: { origin: entry.transition.from, transition: undefined } },
      "wrong step": {
        entry: { origin: { ...otherStep, run: undefined, env: undefined, runSha256: undefined, envSha256: undefined } },
      },
      unguarded: { record: storedOrigin(record, record.run.replace(guard, "true ||"), record.env) },
      "transport removed": {
        record: storedOrigin(record, record.run, {
          ...record.env,
          step: Object.fromEntries(Object.entries(record.env.step).filter(([name]) => name !== "TARGET_SHA")),
        }),
      },
    };
    for (const [label, changes] of Object.entries(mutants)) {
      const { violations } = validateGrammarPartition(replaced(changes));
      expect(
        violations.some((violation) => violation.startsWith(entry.id)),
        label,
      ).toBe(true);
    }
    const shaped = { ...entry, words: at(entry.words, entry.words.length - 1, D("$EXPECTED_BASE_SHA")) };
    expect(validateGrammarPartition(replaced({ entry: shaped })).violations).toContain(
      `${entry.id}: changed benign form identity.`,
    );
    const labelOnly = { ...entry, origin: entry.transition.from };
    expect(validateGrammarPartition(replaced({ entry: labelOnly })).violations).toContain(
      `${entry.id}: incomplete benign form proof or corpus identity.`,
    );
    const rehashed = { ...entry, transition: { ...entry.transition, beforeRunSha256: "0".repeat(64) } };
    expect(validateGrammarPartition(replaced({ entry: rehashed })).violations).toContain(
      `${entry.id}: incomplete benign form proof or corpus identity.`,
    );
  });

  it("live H workflows prove every transitioned operand through its whole-language guard", () => {
    const results = checkDiscoveredWorkflows().results;
    const ids = new Set([...transitions, ...removals.map(([, , appended]) => appended)]);
    const proofs = results.flatMap(({ proofs: items }) => items).filter(({ entry }) => ids.has(entry));
    expect(proofs.length).toBeGreaterThan(0);
    expect(proofs.every(({ proved }) => proved)).toBe(true);
    const inputRooted = proofs.filter(({ word }) =>
      /TARGET_SHA|EXPECTED_BASE_SHA|RELEASE_COMMIT|target_commit|release_tag|image_ref|RUN_ID/.test(word),
    );
    expect(inputRooted.length).toBeGreaterThanOrEqual(transitions.length);
    expect(inputRooted.filter(({ premise }) => premise !== "L3-G")).toEqual([]);
  });
});

// AC4: the two sed directory chains keep exactly `mktemp -d` / RUNNER_TEMP
// roots; every root dependency (TMPDIR, PATH, RUNNER_TEMP) and chain name is
// protected from run writes and from step, job and workflow env declarations.
describe("F2 directory root closure", () => {
  const preview = liveStep(".github/workflows/platform-pr.yml", "terraform-preview-plan", 6);
  const migration = liveStep(".github/workflows/platform-observability-state-migration.yml", "migrate", 8);
  const sedEntry = (operand) =>
    DESTRUCTIVE_GRAMMAR.benignForms.find((entry) => entry.selector === "sed" && entry.words.at(-1).value === operand);
  const sedRefused = (run, env, operand) =>
    classifyShellCommands(run, { env }).indeterminate.some(
      ({ tool, reason }) => tool === "sed" && reason === unpinned(sedEntry(operand)),
    );

  it("both live chains prove their directories", () => {
    expect(sedRefused(preview.run, preview.env, "$tmp/versions.tf")).toBe(false);
    expect(sedRefused(migration.run, migration.env, "$local_module/versions.tf")).toBe(false);
  });

  it.each([
    ["TMPDIR assigned", (run) => `TMPDIR=-e\n${run}`],
    ["TMPDIR exported", (run) => `export TMPDIR=-e\n${run}`],
    ["TMPDIR quoted builtin", (run) => `"export" TMPDIR=-e\n${run}`],
    ["TMPDIR nested write", (run) => `reset() { TMPDIR=-e; }\n${run}`],
    ["PATH assigned", (run) => `PATH="$SYNTHETIC_9031_DIR"\n${run}`],
    ["mktemp redefined", (run) => `mktemp() { echo -e; }\n${run}`],
  ])("a root dependency write refuses the mktemp chain: %s", (_label, change) => {
    expect(sedRefused(change(preview.run), preview.env, "$tmp/versions.tf")).toBe(true);
  });

  it.each(["step", "job", "workflow"])("a %s env declaration of a root dependency refuses", (scope) => {
    for (const name of ["TMPDIR", "PATH"]) {
      const env = { ...preview.env, [scope]: { ...preview.env[scope], [name]: "/synthetic-9031" } };
      expect(sedRefused(preview.run, env, "$tmp/versions.tf"), name).toBe(true);
    }
    for (const name of ["RUNNER_TEMP", "PATH", "migration_root"]) {
      const env = { ...migration.env, [scope]: { ...migration.env[scope], [name]: "/synthetic-9031" } };
      expect(sedRefused(migration.run, env, "$local_module/versions.tf"), name).toBe(true);
    }
  });

  it("a lexical class is not a directory proof: an L3-proved name outside the chain refuses", () => {
    const run =
      'synthetic_dir="${RUNNER_TEMP}/synthetic-9031"\nsed -i \'/backend "s3" {}/d\' "$synthetic_dir/versions.tf"\n';
    const entry = {
      ...syntheticEntry(["sed", "-i", Q('/backend "s3" {}/d'), D("$synthetic_dir/versions.tf")]),
      example: run,
    };
    expectRejected(entry, unpinned(entry));
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
