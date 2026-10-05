import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  DESTRUCTIVE_GRAMMAR,
  DESTRUCTIVE_OPERATION_EXEMPTIONS,
  NAMED_RESET_WORKFLOW_TRIPWIRES,
  checkDiscoveredWorkflows,
  checkNamedResetWorkflowTripwires,
  checkWorkflowDestructiveOperationGating,
  classifyShellCommands,
  deriveAuthoritativeGrammar,
  discoverWorkflowFiles,
  validateGrammarPartition,
} from "./workflow-destructive-op-gating.mjs";

const root = resolve(import.meta.dirname, "..");
const registryFile = ".github/workflows/platform-registry-cleanup.yml";
const restoreFile = ".github/workflows/platform-production-restore-point-cleanup.yml";
const catalogFile = NAMED_RESET_WORKFLOW_TRIPWIRES[1];
const stagingFile = NAMED_RESET_WORKFLOW_TRIPWIRES[0];
const readWorkflow = (file) => readFileSync(join(root, file), "utf8");
const operations = (run) => classifyShellCommands(run).operations;
const independentWorkflowTotal = () =>
  readdirSync(join(root, ".github/workflows")).filter((file) => /\.ya?ml$/.test(file)).length;
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (!directory.startsWith(join(root, ".tmp") + "/") && !directory.startsWith(join(root, ".tmp") + "\\"))
      throw new Error("Fixture deletion escaped seat scratch.");
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureRoot() {
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const directory = mkdtempSync(join(root, ".tmp", "workflow-grammar-"));
  directories.push(directory);
  mkdirSync(join(directory, ".github/workflows"), { recursive: true });
  for (const file of discoverWorkflowFiles(root)) copyFileSync(join(root, file), join(directory, file));
  return directory;
}

function changeWorkflow(file, change) {
  const workflow = parse(readWorkflow(file));
  change(workflow);
  return stringify(workflow);
}

function violatingWorkflow(run = "terraform destroy", jobId = "anonymous", stepName = "ordinary task") {
  return stringify({
    name: "Synthetic grammar fixture",
    on: "push",
    jobs: { [jobId]: { "runs-on": "ubuntu-latest", steps: [{ name: stepName, run }] } },
  });
}

describe("derived destructive command positions", () => {
  it("detects continued destructive commands", () => {
    expect(
      operations(
        "terraform \\\n  destroy -auto-approve\ndoctl registry \\\n  repository delete-tag example old\ndoctl registry garbage-collection \\\n  start",
      ),
    ).toEqual(["terraform:destroy", "doctl:registry-repository-delete-tag", "doctl:registry-garbage-collection-start"]);
    expect(operations("terra\\\nform dest\\\nroy\ndoctl reg\\\nistry repository delete-tag example old")).toEqual([
      "terraform:destroy",
      "doctl:registry-repository-delete-tag",
    ]);
    expect(operations('"terraform" "dest\\\nroy"')).toEqual(["terraform:destroy"]);
    expect(operations("terraform 'dest\\\nroy'")).toEqual([]);
  });

  it("detects doctl global options", () => {
    expect(operations('doctl -t "$TOKEN" registry repository delete-tag example old')).toEqual([
      "doctl:registry-repository-delete-tag",
    ]);
    expect(operations("doctl --output=json registry --context fixture repo -tTOKEN dt example old")).toEqual([
      "doctl:registry-repository-delete-tag",
    ]);
    expect(operations('doctl --trace=false reg gc --api-url "https://example.invalid" s')).toEqual([
      "doctl:registry-garbage-collection-start",
    ]);
  });

  it.each(
    DESTRUCTIVE_GRAMMAR.partition.filter(
      (member) => member.surface === "doctl-option" && member.disposition === "HANDLED",
    ),
  )("handles derived global option $id", ({ form }) => {
    for (const name of form.names) {
      const option = form.arity === 1 ? `${name} "terraform destroy"` : name;
      expect(operations(`doctl ${option} registry repository delete-tag example old`)).toEqual([
        "doctl:registry-repository-delete-tag",
      ]);
    }
  });

  it("detects Terraform's equals-only pre-command chdir", () => {
    expect(operations('terraform -chdir="a directory" destroy')).toEqual(["terraform:destroy"]);
    expect(classifyShellCommands("terraform -chdir fixture destroy").indeterminate).toEqual([
      expect.objectContaining({ reason: "-chdir requires =value" }),
    ]);
    expect(classifyShellCommands("terraform -synthetic-6129-option fixture destroy").indeterminate).toHaveLength(1);
  });

  it.each([
    ["node --no-warnings ./scripts/digitalocean-registry-cleanup.mjs cleanup", "script:digitalocean-registry-cleanup"],
    [
      "node \\\n  ../../../scripts/production-db-restore-point-cleanup.mjs --apply",
      "script:production-db-restore-point-cleanup",
    ],
    [
      "node --title 'destructive-looking data' --require harmless.mjs -- ./scripts/disable-terraform-prevent-destroy.mjs main.tf",
      "script:disable-terraform-prevent-destroy",
    ],
    [
      "node --title --eval ./scripts/production-db-restore-point-cleanup.mjs --apply",
      "script:production-db-restore-point-cleanup",
    ],
    [
      'node "$GITHUB_WORKSPACE/scripts/production-db-restore-point-cleanup.mjs" --apply',
      "script:production-db-restore-point-cleanup",
    ],
  ])("retains script options and continuations: %s", (run, operation) => expect(operations(run)).toEqual([operation]));

  it("does not classify command names in data operands", () => {
    const run = `echo terraform destroy
printf '%s\\n' 'doctl registry repository delete-tag example old'
# terraform destroy
echo ./scripts/production-db-restore-point-cleanup.mjs
node --title ./scripts/production-db-restore-point-cleanup.mjs harmless.mjs
node -e 'terraform destroy'
node --eval 'doctl registry repository delete-tag example old'
node -p 'digitalocean-registry-cleanup.mjs'
node --check ./scripts/production-db-restore-point-cleanup.mjs
terraform -chdir="destroy" plan
doctl --context 'registry repository delete-tag' registry repository list-tags example
cat <<'SYNTHETIC_6129_DATA'
terraform destroy
node ./scripts/production-db-restore-point-cleanup.mjs
SYNTHETIC_6129_DATA
for label in terraform destroy doctl; do echo "$label"; done
case "$label" in terraform|destroy) echo data ;; esac
labels=("terraform destroy" "doctl registry repository delete-tag")
tools=(terraform destroy doctl registry repository delete-tag)
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
    "MODE=fixture terraform destroy",
    "PATH+=:/opt/bin terraform destroy",
    "a[0]=x terraform destroy",
    "((terraform destroy) )",
    "((terraform destroy);)",
    'echo "$((terraform destroy) )"',
    'MODE="$VALUE" terraform destroy',
    "{output}>result terraform destroy",
    "env MODE=fixture terraform destroy",
    "command -- terraform destroy",
    "exec terraform destroy",
    "command -p -- terraform destroy",
    'echo "$(terraform destroy)"',
    'echo "$(echo "$(terraform destroy)")"',
    'echo "${OPTIONAL:-$(terraform destroy)}"',
    "cat <(terraform destroy)",
    "echo `terraform destroy`",
    "OUTPUT=$(terraform destroy)",
    "if true; then terraform destroy; fi",
    "for label in example; do terraform destroy; done",
    "case fixture in fixture) terraform destroy ;; esac",
    "cleanup() { terraform destroy; }",
    "cat <<SYNTHETIC_6129_EXPANSION\n$(terraform destroy)\nSYNTHETIC_6129_EXPANSION\n",
  ])("detects executable position across shell grammar: %s", (run) =>
    expect(operations(run)).toEqual(["terraform:destroy"]),
  );

  it("fails closed on an ambiguous covered command without selecting unrelated labels", () => {
    expect(
      classifyShellCommands("node --synthetic-6129-option scripts/production-db-restore-point-cleanup.mjs")
        .indeterminate,
    ).toHaveLength(1);
    expect(classifyShellCommands('terraform "destroy').indeterminate).toHaveLength(1);
    expect(classifyShellCommands('echo "terraform destroy').indeterminate.length).toBeGreaterThan(0);
    expect(classifyShellCommands('node "$SYNTHETIC_6129_SCRIPT"').indeterminate).toHaveLength(1);
    expect(classifyShellCommands("time -p terraform destroy").indeterminate).toHaveLength(1);
    expect(classifyShellCommands("coproc terraform destroy").indeterminate).toHaveLength(1);
    expect(operations("./scripts/production-db-restore-point-cleanup.mjs --apply")).toEqual([
      "script:production-db-restore-point-cleanup",
    ]);
  });
});

describe("closed executable admission", () => {
  it("benign forms have closed admission", () => {
    expect(DESTRUCTIVE_GRAMMAR.benignForms).toHaveLength(674);
    expect(validateGrammarPartition().violations).toEqual([]);
    for (const entry of DESTRUCTIVE_GRAMMAR.benignForms) {
      expect(entry.origin.sha).toBe("926050f88aae70a631c117c1e0f002a3160a9278");
      expect(entry.proof.selector.length).toBeGreaterThan(0);
      expect(entry.proof.operands.length).toBeGreaterThan(0);
      expect(classifyShellCommands(entry.example).indeterminate, entry.id).toEqual([]);
    }
    const admitted = DESTRUCTIVE_GRAMMAR.benignForms.find((entry) => entry.selector === "timeout");
    for (const mutation of ["proof", "origin", "selector", "payload", "hole", "missing"]) {
      const grammar = structuredClone(DESTRUCTIVE_GRAMMAR);
      const entry = grammar.benignForms.find((candidate) => candidate.id === admitted.id);
      if (mutation === "proof") delete entry.proof.operands;
      if (mutation === "origin") delete entry.origin.sha;
      if (mutation === "selector") entry.selector = "synthetic-unlisted";
      if (mutation === "payload") entry.words[3].value = "./scripts/production-db-restore-point-cleanup.mjs";
      if (mutation === "hole") entry.dataOperands = true;
      if (mutation === "missing") grammar.benignForms = grammar.benignForms.filter((candidate) => candidate !== entry);
      expect(classifyShellCommands(admitted.example, { grammar }).indeterminate.length, mutation).toBeGreaterThan(0);
      if (mutation !== "missing") expect(validateGrammarPartition(grammar).passed, mutation).toBe(false);
    }
    const grammar = structuredClone(DESTRUCTIVE_GRAMMAR);
    const entry = grammar.benignForms.find((candidate) => candidate.id === admitted.id);
    entry.words[3].value = "./scripts/production-db-restore-point-cleanup.mjs";
    entry.example = entry.words.map((word) => word.value).join(" ");
    entry.id = createHash("sha256")
      .update(JSON.stringify({ selector: entry.selector, words: entry.words }))
      .digest("hex");
    expect(validateGrammarPartition(grammar)).toMatchObject({
      passed: false,
      violations: expect.arrayContaining([`${entry.id}: benign payload contains a covered invocation.`]),
    });
    expect(classifyShellCommands(entry.example, { grammar }).indeterminate.length).toBeGreaterThan(0);
  });

  it("benign payload cannot suppress exempt inventory", () => {
    const grammar = structuredClone(DESTRUCTIVE_GRAMMAR);
    const entry = structuredClone(grammar.benignForms.find((candidate) => candidate.selector === "timeout"));
    entry.words = "timeout 30m node ./scripts/digitalocean-registry-cleanup.mjs --apply"
      .split(" ")
      .map((value) => ({ value, dynamic: false, quoted: false }));
    entry.example = entry.words.map((word) => word.value).join(" ");
    entry.id = createHash("sha256")
      .update(JSON.stringify({ selector: entry.selector, words: entry.words }))
      .digest("hex");
    grammar.benignForms.push(entry);
    const workflowFile = ".github/workflows/platform-production.yml";
    const source = changeWorkflow(workflowFile, (workflow) => {
      workflow.jobs["deploy-production"].steps.push({ name: "Synthetic covered payload", run: entry.example });
    });
    const result = checkWorkflowDestructiveOperationGating(source, { workflowFile, grammar });
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining("benign payload contains a covered invocation"));
  });

  it.each([
    ["/usr/bin/terraform", "destroy"],
    ["/usr/bin/doctl", "registry", "repository", "delete-tag", "r", "t"],
    ["/usr/bin/node", "--synthetic-6129-unknown-option", "harmless.mjs"],
    ["/usr/bin/node", "${SYNTHETIC_6129_SCRIPT}"],
  ])("rejects re-hashed forwarded payload: %s", (...payload) => {
    const grammar = structuredClone(DESTRUCTIVE_GRAMMAR);
    const entry = grammar.benignForms.find((candidate) => candidate.selector === "timeout");
    entry.words = ["timeout", "8m", ...payload].map((value) => ({
      value,
      dynamic: value.includes("$"),
      quoted: value.includes("$"),
    }));
    entry.example = entry.words.map((word) => word.value).join(" ");
    entry.id = createHash("sha256")
      .update(JSON.stringify({ selector: entry.selector, words: entry.words }))
      .digest("hex");
    expect(validateGrammarPartition(grammar).violations).toContain(
      `${entry.id}: benign payload contains a covered invocation.`,
    );
    expect(classifyShellCommands(entry.example, { grammar }).indeterminate.length).toBeGreaterThan(0);
  });

  it("Bash word whitespace terminates and unknown forms fail closed", () => {
    for (const run of ["echo hello world", "echo hello\u00a0world", "echo a\vb", "echo a\fb"]) {
      expect(classifyShellCommands(run), JSON.stringify(run)).toMatchObject({ operations: [], indeterminate: [] });
    }
    for (const run of ["\uFEFFecho a", "terraform\u00a0destroy", "terraform\vdestroy", "terraform\fdestroy"]) {
      expect(classifyShellCommands(run).indeterminate, JSON.stringify(run)).toContainEqual(
        expect.objectContaining({ disposition: "INDETERMINATE", reason: "unlisted executable form" }),
      );
    }
  });

  it("benign forwarding and fixed selectors stay green", () => {
    for (const selector of ["timeout", "nohup"]) {
      for (const entry of DESTRUCTIVE_GRAMMAR.benignForms.filter((form) => form.selector === selector)) {
        expect(classifyShellCommands(entry.example).indeterminate).toEqual([]);
        const mutant = entry.example.replace(
          /(?:\.\/scripts\/[^\s]+|docker)/,
          "./scripts/production-db-restore-point-cleanup.mjs",
        );
        expect(mutant).not.toBe(entry.example);
        expect(classifyShellCommands(mutant).indeterminate.length).toBeGreaterThan(0);
        expect(classifyShellCommands(entry.example + ' "$(terraform destroy)"').operations).toContain(
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
      'binary="${RUNNER_TEMP}/kubectl-argo-rollouts" echo data\n"$binary" version',
      'false && binary="${RUNNER_TEMP}/kubectl-argo-rollouts"\n"$binary" version',
      '(binary="${RUNNER_TEMP}/kubectl-argo-rollouts")\n"$binary" version',
      '"$(echo terraform)" destroy',
    ])
      expect(classifyShellCommands(run).indeterminate.length).toBeGreaterThan(0);
    for (const run of [
      "mkdir -p doctl",
      "cp doctl other",
      "chmod +x doctl",
      "install -m 0755 doctl target",
      "command -v doctl",
    ])
      expect(classifyShellCommands(run)).toMatchObject({ operations: [], indeterminate: [] });
  });

  it("shell dispositions constrain executable and data positions", () => {
    for (const run of ["((terraform + destroy))", 'echo "$((terraform + destroy))"', "echo terraform destroy"])
      expect(classifyShellCommands(run)).toMatchObject({ operations: [], indeterminate: [] });
    for (const run of [
      'echo "$(( $(terraform destroy) + 1 ))"',
      "if true; then terraform destroy; elif true; then echo data; fi",
    ])
      expect(operations(run)).toEqual(["terraform:destroy"]);
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
    for (const member of grammar.partition.filter(
      (member) => member.surface === "shell" && member.form.production === "arith_command",
    ))
      member.disposition = "INDETERMINATE";
    expect(classifyShellCommands('echo "$((terraform + destroy))"', { grammar }).indeterminate.length).toBeGreaterThan(
      0,
    );
    const nonBash = parse(violatingWorkflow("Write-Output safe"));
    nonBash.jobs.anonymous.steps[0].shell = "pwsh";
    expect(checkWorkflowDestructiveOperationGating(stringify(nonBash)).violations).toContainEqual(
      expect.stringContaining("unproved non-Bash"),
    );
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
    const production = changeWorkflow(".github/workflows/platform-production.yml", (workflow) => {
      workflow.jobs["deploy-production"].steps.push({
        run: "timeout 30m node ./scripts/digitalocean-registry-cleanup.mjs --apply",
      });
    });
    expect(
      checkWorkflowDestructiveOperationGating(production, { workflowFile: ".github/workflows/platform-production.yml" })
        .violations,
    ).toContainEqual(expect.stringContaining("exact invocation multiset required"));
  });
  it.each([
    "PATH+=:/opt/bin terraform destroy -auto-approve",
    "MODE+=x doctl registry repository delete-tag r t",
    "a[0]=x terraform destroy",
    "((terraform destroy) )",
    'env -i doctl -t "$T" registry repository delete-tag r t',
    "timeout 8m node ./scripts/production-db-restore-point-cleanup.mjs --apply",
  ])("reviewer ungated push reproduction refuses: %s", (run) => {
    const result = checkWorkflowDestructiveOperationGating(violatingWorkflow(run));
    expect(result.passed).toBe(false);
    expect(result.checkedSteps).toHaveLength(1);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it.each([
    "env -i terraform destroy",
    "env -u HOME terraform destroy",
    "env -- terraform destroy",
    "env -i PATH=/usr/bin terraform destroy",
    "exec -a tf terraform destroy",
    "exec -c terraform destroy",
    "timeout 600 terraform destroy",
    "nohup terraform destroy",
    "nice terraform destroy",
    "stdbuf -oL terraform destroy",
    "sudo terraform destroy",
    "xargs terraform destroy",
    "eval 'terraform destroy'",
    "bash -c 'terraform destroy'",
    "sh -c 'terraform destroy'",
    "bash <<EOF\nterraform destroy\nEOF",
    "bash <<< 'terraform destroy'",
    "builtin eval 'terraform destroy'",
    "source fixture.sh",
    ". fixture.sh",
    "pnpm exec terraform destroy",
    "npx terraform destroy",
    "$TF destroy",
    '"${TERRAFORM_BIN}" destroy',
    '"$(command -v terraform)" destroy',
    "${{ inputs.tool }} destroy",
    "terraform${EMPTY} destroy",
    "nohup node ./scripts/digitalocean-registry-cleanup.mjs --dry-run=false &",
    "synthetic-unlisted-selector harmless",
    "echo 'unterminated",
  ])("unresolved executable forms fail closed: %s", (run) => {
    expect(classifyShellCommands(run).indeterminate.length).toBeGreaterThan(0);
    expect(checkWorkflowDestructiveOperationGating(violatingWorkflow(run)).passed).toBe(false);
  });
});

describe("authoritative grammar partition", () => {
  it("partition equals authoritative derivation", () => {
    expect(validateGrammarPartition()).toEqual({ passed: true, members: 503, violations: [] });
    expect(DESTRUCTIVE_GRAMMAR.partition).toEqual(deriveAuthoritativeGrammar());
    expect(new Set(DESTRUCTIVE_GRAMMAR.partition.map((member) => member.id)).size).toBe(503);
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
          id: "synthetic-6129-unsourced",
          source: "bash",
          surface: "shell",
          form: {},
          disposition: "HANDLED",
        });
      if (mutation === "altered disposition")
        grammar.partition[0].disposition = grammar.partition[0].disposition === "HANDLED" ? "INDETERMINATE" : "HANDLED";
      if (mutation === "altered source") grammar.sources[0].lines.push("synthetic-6129-not-authoritative");
      expect(validateGrammarPartition(grammar).passed).toBe(false);
    },
  );

  it("unknown derived command form fails closed", () => {
    const unknown = "doctl registry repository synthetic-6129-unlisted-command example";
    expect(classifyShellCommands(unknown).indeterminate).toEqual([
      expect.objectContaining({ disposition: "INDETERMINATE", reason: "unlisted registry subcommand" }),
    ]);
    const result = checkWorkflowDestructiveOperationGating(violatingWorkflow(unknown), {
      workflowFile: ".github/workflows/synthetic-6129-unknown.yml",
    });
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(
      expect.stringContaining("synthetic-6129-unknown.yml: job 'anonymous' step #1: INDETERMINATE"),
    );
    expect(
      checkWorkflowDestructiveOperationGating(violatingWorkflow("doctl registry repository list-tags example")).passed,
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
      ".github/workflows/platform-production.yml": 1,
      [registryFile]: 1,
      [stagingFile]: 2,
    });
    expect(result.tripwires.checkedWorkflows).toEqual(NAMED_RESET_WORKFLOW_TRIPWIRES);
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
      .replaceAll("DIGITALOCEAN_REGISTRY_CLEANUP_RESOLVED_DRY_RUN", "SYNTHETIC_6129_RESOLVED_MODE");
    expect(checkWorkflowDestructiveOperationGating(renamed).passed).toBe(true);
    const workflow = parse(renamed);
    workflow.jobs.cleanup.if = workflow.jobs.cleanup.if.replace(/^\$\{\{ | \}\}$/g, "");
    expect(checkWorkflowDestructiveOperationGating(stringify(workflow)).passed).toBe(true);
  });

  it.each([
    [
      "trigger set",
      (workflow) => {
        workflow.on.push = {};
      },
      "triggered only",
    ],
    [
      "dry-run default",
      (workflow) => {
        workflow.on.workflow_dispatch.inputs.dry_run.default = "false";
      },
      "defaults to",
    ],
    [
      "typed confirm",
      (workflow) => {
        workflow.on.workflow_dispatch.inputs.confirm.type = "boolean";
      },
      "typed string",
    ],
    [
      "confirm default",
      (workflow) => {
        workflow.on.workflow_dispatch.inputs.confirm.default = "";
      },
      "without a default",
    ],
    [
      "missing refusal",
      (workflow) => {
        delete workflow.jobs["refuse-unconfirmed-apply"];
      },
      "shell-validate",
    ],
    [
      "manual refusal condition",
      (workflow) => {
        workflow.jobs["refuse-unconfirmed-apply"].if = "inputs.confirm";
      },
      "shell-validate",
    ],
    [
      "nonzero unknown refusal",
      (workflow) => {
        const step = workflow.jobs["refuse-unconfirmed-apply"].steps[0];
        step.run = step.run.replaceAll("exit 1", "echo accepted");
      },
      "nonzero exit",
    ],
    [
      "case-sensitive confirmation",
      (workflow) => {
        const step = workflow.jobs["refuse-unconfirmed-apply"].steps[0];
        step.run = step.run.replace('"$CONFIRM"', '"${CONFIRM,,}"');
      },
      "case-sensitively",
    ],
    [
      "invalid mode accepted",
      (workflow) => {
        const step = workflow.jobs["refuse-unconfirmed-apply"].steps[0];
        step.run = step.run.replace('"true")', '"true" | "" | "TRUE")');
      },
      "shell-validate",
    ],
    [
      "dependency",
      (workflow) => {
        delete workflow.jobs.cleanup.needs;
      },
      "cancellation-safe",
    ],
    [
      "cancellation",
      (workflow) => {
        workflow.jobs.cleanup.if = workflow.jobs.cleanup.if.replace("!cancelled()", "always()");
      },
      "cancellation-safe",
    ],
    [
      "failure admission",
      (workflow) => {
        workflow.jobs.cleanup.if = workflow.jobs.cleanup.if.replace("'success'", "'failure'");
      },
      "cancellation-safe",
    ],
    [
      "resolver uniqueness",
      (workflow) => {
        workflow.jobs.cleanup.steps.push(workflow.jobs.cleanup.steps[0]);
      },
      "single fail-closed",
    ],
    [
      "resolver default refusal",
      (workflow) => {
        const step = workflow.jobs.cleanup.steps[0];
        step.run = step.run.replace("exit 1", "echo accepted");
      },
      "single fail-closed",
    ],
    [
      "resolver inversion",
      (workflow) => {
        workflow.jobs.cleanup.env.DIGITALOCEAN_REGISTRY_CLEANUP_REQUESTED_DRY_RUN =
          "${{ github.event_name == 'schedule' && 'true' || github.event.inputs.dry_run }}";
      },
      "single fail-closed",
    ],
    [
      "resolved publication under requested name",
      (workflow) => {
        workflow.jobs.cleanup.steps[0].run = workflow.jobs.cleanup.steps[0].run.replaceAll(
          "RESOLVED_DRY_RUN",
          "REQUESTED_DRY_RUN",
        );
      },
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
    const result = checkWorkflowDestructiveOperationGating(changeWorkflow(registryFile, change));
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining(violation));
  });

  it("rejects restore resolver inversion and unconditional apply wiring", () => {
    const echoed = readWorkflow(restoreFile).replace('resolved_apply="true"', "echo resolved_apply=true");
    expect(checkWorkflowDestructiveOperationGating(echoed).violations).toContainEqual(
      expect.stringContaining("single fail-closed"),
    );
    const echoedArray = readWorkflow(restoreFile).replace('apply_args=("--apply")', "echo apply_args= '(' --apply ')'");
    expect(checkWorkflowDestructiveOperationGating(echoedArray).violations).toContainEqual(
      expect.stringContaining("cannot associate"),
    );
    const inverted = readWorkflow(restoreFile).replace(
      '"true") resolved_apply="false"',
      '"true") resolved_apply="true"',
    );
    expect(checkWorkflowDestructiveOperationGating(inverted).violations).toContainEqual(
      expect.stringContaining("single fail-closed"),
    );
    const unconditional = readWorkflow(restoreFile).replace('"${apply_args[@]}"', '--apply "${apply_args[@]}"');
    expect(checkWorkflowDestructiveOperationGating(unconditional).violations).toContainEqual(
      expect.stringContaining("cannot associate"),
    );
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
    expect(checkWorkflowDestructiveOperationGating(sameStep, { workflowFile: file }).violations).toContainEqual(
      expect.stringContaining("exact invocation multiset required"),
    );
  });

  it("exemption missing invocation rejected", () => {
    const file = DESTRUCTIVE_OPERATION_EXEMPTIONS[0].workflowFile;
    const source = readWorkflow(file).replace("run: terraform destroy -auto-approve", "run: terraform plan");
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
      workflow.jobs["destroy-preview"].steps.push({ run: "terraform synthetic-6129-command" }),
    );
    const result = checkWorkflowDestructiveOperationGating(source, { workflowFile: file });
    expect(result.violations).toContainEqual(expect.stringContaining("INDETERMINATE"));
    expect(result.violations).toContainEqual(expect.stringContaining("exact invocation multiset required"));
  });

  it("new destructive workflow requires gate", () => {
    const directory = fixtureRoot();
    const file = ".github/workflows/synthetic-6129-extra.yaml";
    writeFileSync(join(directory, file), violatingWorkflow());
    const result = checkDiscoveredWorkflows({ root: directory });
    expect(result.total).toBe(independentWorkflowTotal() + 1);
    expect(result.scanned).toBe(result.total);
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining(`${file}: refuse-unconfirmed-apply`));
  });

  it("arbitrary workflow sibling discovered", () => {
    const directory = fixtureRoot();
    const file = ".github/workflows/synthetic-6129-ordinary-task.yaml";
    writeFileSync(
      join(directory, file),
      violatingWorkflow(
        'MODE=fixture >output doctl -t "$TOKEN" reg repo dt example old',
        "ordinary-job",
        "ordinary step",
      ),
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
    writeFileSync(
      join(directory, file),
      violatingWorkflow(
        'MODE=fixture >output node --no-warnings "./scripts/production-db-restore-point-cleanup.mjs" --apply',
        "another-job",
        "another step",
      ),
    );
    expect(checkDiscoveredWorkflows({ root: directory }).violations).toContainEqual(
      expect.stringContaining(`${file}: destructive job 'another-job'`),
    );
    const previousChangedFiles = process.env.CHANGED_FILES;
    process.env.CHANGED_FILES = "README.md";
    try {
      for (const run of [
        "terraform \\\n destroy",
        "timeout 8m node ./scripts/production-db-restore-point-cleanup.mjs --apply",
        "$TF destroy",
      ]) {
        writeFileSync(join(directory, file), violatingWorkflow(run, "arbitrary", "arbitrary"));
        const discovered = checkDiscoveredWorkflows({ root: directory });
        expect(discovered.passed).toBe(false);
        expect(discovered.scanned).toBe(independentWorkflowTotal() + 1);
        expect(discovered.violations).toContainEqual(expect.stringContaining(`${file}:`));
        expect(discovered.results.find((entry) => entry.workflowFile === file).checkedSteps).toHaveLength(1);
      }
    } finally {
      if (previousChangedFiles === undefined) delete process.env.CHANGED_FILES;
      else process.env.CHANGED_FILES = previousChangedFiles;
    }
    const repaired = parse(readWorkflow(restoreFile));
    repaired.jobs["ordinary-job"] = repaired.jobs.cleanup;
    delete repaired.jobs.cleanup;
    repaired.jobs["ordinary-job"].steps.find((step) => step.name === "Cleanup restore-point forks").name =
      "ordinary step";
    writeFileSync(join(directory, file), stringify(repaired));
    expect(checkDiscoveredWorkflows({ root: directory })).toMatchObject({
      passed: true,
      scanned: independentWorkflowTotal() + 1,
      total: independentWorkflowTotal() + 1,
      violations: [],
    });
  });
});

describe("both named reset tripwires", () => {
  const sources = Object.fromEntries(NAMED_RESET_WORKFLOW_TRIPWIRES.map((file) => [file, readWorkflow(file)]));

  it("catalog always() mutant red and head green", () => {
    expect(checkNamedResetWorkflowTripwires(sources)).toMatchObject({ passed: true, violations: [] });
    const mutant = sources[catalogFile].replace("!cancelled() &&", "always() &&");
    expect(mutant).not.toBe(sources[catalogFile]);
    expect(checkNamedResetWorkflowTripwires({ ...sources, [catalogFile]: mutant }).violations).toEqual([
      expect.stringContaining(`${catalogFile}: named reset tripwire`),
    ]);
  });

  it.each([
    [catalogFile, (source) => source.replace("exit 1", "echo accepted").replaceAll("exit 1", "echo accepted")],
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
