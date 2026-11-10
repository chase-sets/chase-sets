// Pure source/event/planner fixtures only. Never execute the diagnostic or provider tools.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "@chase-sets/typescript-compiler-api";
import { inventoryRefusalCodes, bootstrapComparisonCodes } from "./test-support/10678-ingress-nosend/inventory.mjs";
import { sha256 } from "./test-support/10678-ingress-nosend/helpers.mjs";
import { parse } from "yaml";
import { classifyChanges } from "./change-scope.mjs";
import { createCiGatePlan } from "./ci-gate-plan.mjs";
import { listWorkspacePackages } from "./lib/repo.mjs";
import { checkWorkflowCanonicalArtifacts } from "./workflow-canonical-artifacts.mjs";
import { checkWorkflowProviderCredentials } from "./workflow-provider-credentials.mjs";
import {
  classifyReleaseQualificationScope,
  releaseQualificationScopeRegistry,
} from "./release-qualification-scope.mjs";
const main = "d507b7dd58bad88c929e10133443eb62ac39a3bf";
const h1 = "cbd4068778b1fed220e6d43d2138d41b55839da6";
const h1Main = "bc7d68fc5ce488996a5651a1bf678bd581d7eda2";
const branch = "host/10678-ingress-nosend-diagnostic";
const diagnosticPath = ".github/workflows/ingress-nosend-diagnostic.yml";
const git = (...args) => execFileSync("git", args, { encoding: "utf8", windowsHide: true });
const paths = (value) => value.split(/\r?\n/).filter(Boolean);
const workspaces = listWorkspacePackages();
const scope = (changedFiles) => classifyChanges({ changedFiles, workspaces });
const plan = (changedFiles, extra = {}) =>
  createCiGatePlan({
    mode: "pull-request",
    labels: [],
    provenance: "same-repository",
    scope: scope(changedFiles),
    ...extra,
  });
const preview = (p) => p.gates.find((g) => g.id === "preview-deploy-smoke");
const source = readFileSync(diagnosticPath, "utf8");
const workflow = parse(source);
const job = workflow.jobs["ingress-nosend-diagnostic"];
const nodeBody = job.steps[1].run.split("<<'NODE'\n")[1].split("\nNODE")[0];
const nodeTree = ts.createSourceFile("bootstrap.mjs", nodeBody, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const descendants = (node, predicate) => {
  const result = [];
  const visit = (n) => {
    if (predicate(n)) result.push(n);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return result;
};
const declaration = (name) =>
  descendants(nodeTree, (node) => ts.isVariableDeclaration(node) && node.name.getText(nodeTree) === name)[0];
const stages = new Function(`return ${declaration("stages").initializer.getText(nodeTree)}`)();
const calls = descendants(nodeTree, ts.isCallExpression);
const stageCalls = calls.filter((call) => call.expression.getText(nodeTree) === "at");
const privateMarker = "SYNTHETIC_PRIVATE_cookie_token_value";
const syntaxShape = (node) => {
  const children = [];
  ts.forEachChild(node, (child) => {
    children.push(syntaxShape(child));
  });
  return [node.kind, node.text ?? null, children];
};
const stageBinding = (nodes) =>
  sha256(
    JSON.stringify(
      nodes.map((call) => ({ stage: call.arguments[0].text, expression: syntaxShape(call.arguments[1]) })),
    ),
  );
function controlCategory(error) {
  const api = { inventoryRefusalCodes, bootstrapComparisonCodes };
  return new Function("api", `return ${declaration("category").initializer.getText(nodeTree)}`)(api)(error);
}
async function bootstrapControl(
  failStage,
  error = new Error(privateMarker),
  comparisonCode = "OTHER",
  comparisonContext = "component=OTHER predicate=OTHER",
) {
  const output = [],
    operations = [];
  const config = { head: "a".repeat(40), phase: "inventory", publicInputs: Object.freeze({ SYNTHETIC: true }) };
  const tools = { git: { path: "/synthetic/git" } };
  const api = {
    inventoryRefusalCodes,
    bootstrapComparisonCodes,
    maximumEnvelopeBytes: 48000,
    bootstrapComparisonCategory: () => comparisonCode,
    createBootstrapComparison: () => Object.freeze({}),
    hostedContext: () => ({ head: config.head }),
    decodeAuthority: (_raw, _hash, options) => {
      expect(options.phase).toBe("inventory");
      return { config };
    },
    readAuthority: (_file, _hash, options) => {
      expect(options.phase).toBe("inventory");
      return { config };
    },
    measurementConfig: (payload) => {
      expect(payload).toBe(config);
      return config;
    },
    bootstrapTools: (payload) => {
      expect(payload).toBe(config);
      return tools;
    },
    stockTools: Object.freeze(["SYNTHETIC_STOCK"]),
    enforceExecutables: (actualTools, names, verifyPathNode, handle) => {
      expect(actualTools).toBe(tools);
      expect(names).toBe(api.stockTools);
      expect(verifyPathNode).toBe(false);
      expect(handle).toEqual({});
      operations.push("executables");
    },
    observeIdentity: () => {
      operations.push("observe");
      return Object.freeze({ SYNTHETIC: true });
    },
    enforceIdentityPins: (payload, _actual, bootstrap) => {
      expect(payload).toBe(config);
      expect(bootstrap).toBe(true);
      operations.push("identity");
    },
    bootstrapComparisonResult: () => comparisonContext,
  };
  const replacements = [
    ...nodeTree.statements.filter(ts.isImportDeclaration).map((node) => [node.getStart(nodeTree), node.end, ""]),
    ...calls
      .filter((node) => node.expression.kind === ts.SyntaxKind.ImportKeyword)
      .map((node) => [node.getStart(nodeTree), node.end, "loadApi()"]),
  ];
  let text = nodeBody;
  for (const [start, end, value] of replacements.sort((a, b) => b[0] - a[0]))
    text = text.slice(0, start) + value + text.slice(end);
  // Faults are injected into the pure control-flow clone, never the actual bootstrap.
  text = text.replace("return operation();", "fault(id); return operation();");
  const process = {
    env: { DIAGNOSTIC_FREEZE_JSON: "SYNTHETIC", DIAGNOSTIC_FREEZE_SHA256: "SYNTHETIC", RUNNER_TEMP: "/synthetic-temp" },
    exitCode: 0,
  };
  const bindings = {
    assert: (condition, message) => {
      if (!condition) throw new Error(message);
    },
    Buffer,
    path: { join: (...parts) => parts.join("/") },
    process,
    loadApi: async () => api,
    readFileSync: () => "{}",
    realpathSync: (file) => (file === "." ? "/synthetic-root" : file),
    mkdirSync: () => {
      operations.push("mkdir");
    },
    writeFileSync: () => {
      operations.push("write-authority");
    },
    spawnSync: (file, args, options) => {
      expect(file).toBe(tools.git.path);
      expect(args).toEqual(["rev-parse", "HEAD"]);
      expect(options).toEqual({
        env: { PATH: "/usr/bin:/bin", HOME: "/synthetic-temp/10678-authority" },
        encoding: "utf8",
        shell: false,
      });
      operations.push("disk-head");
      return { status: 0, stdout: config.head };
    },
    console: { log: (line) => output.push(line), error: (line) => output.push(line) },
    fault: (stage) => {
      if (stage === failStage) throw error;
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction(...Object.keys(bindings), text)(...Object.values(bindings));
  return { output, operations, exitCode: process.exitCode };
}

describe("10678 bootstrap-only production-source controls", () => {
  it("has a closed stage/call partition and no hidden measurement or publication capability", () => {
    expect(nodeTree.parseDiagnostics).toEqual([]);
    expect(stageCalls.map((call) => call.arguments[0].text)).toEqual(stages);
    expect(new Set(stages).size).toBe(stages.length);
    expect(stageBinding(stageCalls)).toBe("7d75c3748423cc610ee44b290056d211d763fbc20c4d78a35e27bd493679a200");
    for (let i = 1; i < stageCalls.length; i++) {
      const mutant = [...stageCalls];
      [mutant[i - 1], mutant[i]] = [mutant[i], mutant[i - 1]];
      expect(stageBinding(mutant)).not.toBe(stageBinding(stageCalls));
    }
    const allowed = new Set([
      "Object.freeze",
      "stages.includes",
      "operation",
      "Object.getOwnPropertyDescriptor",
      "codes.find",
      "at",
      "import",
      "api.createBootstrapComparison",
      "readFileSync",
      "JSON.parse",
      "api.hostedContext",
      "Buffer.from",
      "assert",
      "api.decodeAuthority",
      "realpathSync",
      "temp.startsWith",
      "path.join",
      "mkdirSync",
      "writeFileSync",
      "api.readAuthority",
      "api.measurementConfig",
      "api.bootstrapTools",
      "api.enforceExecutables",
      "api.observeIdentity",
      "api.enforceIdentityPins",
      "spawnSync",
      "head.stdout.trim",
      "console.log",
      "api.bootstrapComparisonResult",
      "api?.bootstrapComparisonCodes.includes",
      "api.bootstrapComparisonCategory",
      "category",
    ]);
    for (const call of calls)
      expect(allowed.has(call.expression.getText(nodeTree)), call.expression.getText(nodeTree)).toBe(true);
    expect(
      calls
        .filter((call) => call.expression.kind === ts.SyntaxKind.ImportKeyword)
        .map((call) => call.arguments[0].text),
    ).toEqual(["./scripts/test-support/10678-ingress-nosend/inventory.mjs"]);
    for (const call of stageCalls) {
      expect(ts.isArrowFunction(call.arguments[1])).toBe(true);
      expect(call.arguments[1].parameters).toHaveLength(0);
    }
    for (const forbidden of [
      "prepare",
      "measure",
      "seal",
      "collect",
      "inventoryReceipt",
      "upload",
      "rows",
      "install",
      "fetch",
    ])
      expect(calls.some((call) => call.expression.getText(nodeTree) === `api.${forbidden}`)).toBe(false);
    expect(job.steps).toHaveLength(2);
    expect(job.steps.filter((step) => step.uses)).toHaveLength(1);
    expect(job.steps[1].run).toContain("--input-type=module 2>/dev/null");
    expect(job.steps[1].run).toContain("BOOTSTRAP_ONLY_PROCESS_FAILED stage=SHELL_EXEC category=OTHER");
    expect(job.steps[1].run).toContain("BOOTSTRAP_ONLY_REFUSED stage=SHELL_NODE category=OTHER");
  });
  it("fails at every production stage with OTHER, no raw message/getter/serialization escape and nonzero", async () => {
    const hostile = Object.defineProperty(new Error(), "message", {
      get() {
        throw new Error(privateMarker);
      },
    });
    const proxy = new Proxy(new Error(), {
      getOwnPropertyDescriptor() {
        throw new Error(privateMarker);
      },
    });
    for (const stage of stages)
      for (const error of [
        new Error(privateMarker),
        hostile,
        proxy,
        { message: "REVIEWED_RUNNER_IDENTITY_DRIFT" },
        new Error("REVIEWED_RUNNER_IDENTITY_DRIFT"),
      ]) {
        const result = await bootstrapControl(stage, error);
        expect(result.exitCode).toBe(1);
        expect(result.output).toEqual([
          `BOOTSTRAP_ONLY_REFUSED stage=${stage} category=OTHER component=OTHER predicate=OTHER MEASUREMENT_NOT_EXECUTED rows=0`,
        ]);
        expect(result.output.join()).not.toContain(privateMarker);
        expect(result.operations).not.toContain("upload");
      }
  });
  it("returns only source-owned recognized codes and closes forged/private messages to OTHER", () => {
    for (const code of [...inventoryRefusalCodes, ...bootstrapComparisonCodes])
      expect(controlCategory(new Error(code))).toBe(code);
    for (const error of [
      null,
      undefined,
      privateMarker,
      new Error(`REVIEWED_RUNNER_IDENTITY_DRIFT ${privateMarker}`),
      { message: "REVIEWED_RUNNER_IDENTITY_DRIFT" },
      Object.defineProperty(new Error(), "message", {
        get() {
          throw new Error(privateMarker);
        },
      }),
    ])
      expect(controlCategory(error)).toBe("OTHER");
  });
  it("proves success is only bootstrap completion with zero rows and no path to preparation or upload", async () => {
    const result = await bootstrapControl();
    expect(result).toEqual({
      exitCode: 0,
      output: ["BOOTSTRAP_ONLY_COMPLETE MEASUREMENT_NOT_EXECUTED rows=0"],
      operations: ["mkdir", "write-authority", "executables", "observe", "identity", "disk-head"],
    });
  });
  it("preserves authenticated comparison attribution without giving raw messages drift authority", async () => {
    const context = "component=FINGERPRINT predicate=FINGERPRINT_EQUAL mismatches=FINGERPRINT_KERNEL";
    const code = "RUNNER_OS_DAEMON_OR_TOOL_DRIFT";
    const result = await bootstrapControl("IDENTITY_COMPARE", new Error(code), code, context);
    expect(result.output).toEqual([
      `BOOTSTRAP_ONLY_REFUSED stage=IDENTITY_COMPARE category=${code} ${context} MEASUREMENT_NOT_EXECUTED rows=0`,
    ]);
    expect(result.exitCode).toBe(1);
    const forged = await bootstrapControl("IDENTITY_COMPARE", new Error(code));
    expect(forged.output[0]).toContain("category=OTHER component=OTHER predicate=OTHER");
  });
  it("keeps the exact H2 coarse catch as a frozen RED attribution control", () => {
    const old = parse(git("show", `7400687eb03a26212b17998145ede703340a971f:${diagnosticPath}`));
    const text = old.jobs["ingress-nosend-diagnostic"].steps[1].run.split("<<'NODE'\n")[1].split("\nNODE")[0];
    const tree = ts.createSourceFile("h2.mjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const body = descendants(tree, ts.isCatchClause)[0].block.getText(tree);
    expect(body).toContain("console.error('AUTHORITY_BOOTSTRAP_REFUSED')");
    const output = [],
      process = {};
    new Function("console", "process", body)({ error: (line) => output.push(line) }, process);
    expect(process.exitCode).toBe(1);
    expect(() => expect(output[0]).toContain("stage=IDENTITY_COMPARE")).toThrow();
    expect(output).toEqual(["AUTHORITY_BOOTSTRAP_REFUSED"]);
  });
});

describe("10678 D4 publication and unchanged shared contracts", () => {
  it("passes the named canonical-artifact and provider-credential source guards for the exact diagnostic", () => {
    expect(checkWorkflowCanonicalArtifacts(source, { workflowFile: diagnosticPath }).passed).toBe(true);
    expect(checkWorkflowProviderCredentials(source, { workflowFile: diagnosticPath })).toMatchObject({
      passed: true,
      checkedSteps: [],
      violations: [],
    });
  });
  it("retains the original actual H1 diff as the F1 REQUIRED-preview failing control", () => {
    const changed = paths(git("diff", "--name-only", h1Main, h1));
    expect(changed).toContain(".github/workflows/platform-pr.yml");
    expect(preview(plan(changed))).toMatchObject({ selection: "REQUIRED", reason: "scope" });
  });
  it("classifies the actual repaired diagnostic delta as workflow lint without cluster or credential gates", () => {
    const changed = [
      ...new Set([
        ...paths(git("diff", "--name-only", main)),
        ...paths(
          git(
            "ls-files",
            "--others",
            "--exclude-standard",
            "--",
            diagnosticPath,
            "scripts/test-support/10678-ingress-nosend",
            "scripts/ingress-nosend-publication.test.mjs",
          ),
        ),
      ]),
    ];
    expect(changed).toContain(diagnosticPath);
    expect(changed).not.toContain(".github/workflows/platform-pr.yml");
    const s = scope(changed);
    expect(s.workflowLintRequired).toBe(true);
    expect(s.clusterPreviewRequired).toBe(false);
    expect(preview(plan(changed))).toMatchObject({ selection: "NOT_REQUIRED", reason: "not-affected" });
    for (const gate of plan(changed).gates.filter((g) =>
      /^(?:terraform-|docker-image|compose-preview-smoke)/.test(g.id),
    ))
      expect(gate.selection, gate.id).toBe("NOT_REQUIRED");
    // Hypothetical PR planning is a regression control, NOT publication authority. Actual publication has no PR.
  });
  it("preserves ordinary deployment, preview labels, fork, missing provenance and merge-group selection", () => {
    const deployment = ["infrastructure/helm/platform/templates/ingress.yaml"];
    expect(preview(plan(deployment))).toMatchObject({ selection: "REQUIRED", reason: "scope" });
    expect(preview(plan(["docs/README.md"], { labels: ["preview"] }))).toMatchObject({
      selection: "REQUIRED",
      reason: "preview-label",
    });
    expect(preview(plan(deployment, { provenance: "fork" }))).toMatchObject({
      selection: "NOT_REQUIRED",
      reason: "fork",
    });
    expect(preview(plan(deployment, { provenance: undefined }))).toMatchObject({
      selection: "UNDECIDABLE",
      reason: "missing-provenance",
    });
    expect(preview(plan(deployment, { mode: "merge-group" }))).toMatchObject({
      selection: "NOT_REQUIRED",
      reason: "merge-group",
    });
  });
  it("registers only the exact disposable workflow as ci and keeps unknown workflows fail-closed", () => {
    const before = git("show", `${main}:scripts/release-qualification-scope.mjs`);
    expect(readFileSync("scripts/release-qualification-scope.mjs", "utf8")).toBe(
      before.replace(
        '    "ci-image-mirrors.yml": "release",',
        '    "ci-image-mirrors.yml": "release",\n    "ingress-nosend-diagnostic.yml": "ci",',
      ),
    );
    expect(releaseQualificationScopeRegistry.workflows["ingress-nosend-diagnostic.yml"]).toBe("ci");
    const classify = (file) =>
      classifyReleaseQualificationScope({
        base: { sha: "a".repeat(40), treeSha: "b".repeat(40) },
        candidate: { sha: "c".repeat(40), treeSha: "d".repeat(40) },
        changedFiles: [{ path: file, status: "added" }],
        readFileAt: () => source,
        releaseWorkflowScriptReferences: new Set(),
        workspaces: [],
        now: () => 1,
      });
    expect(classify(diagnosticPath)).toMatchObject({ class: "not_applicable", reasonCodes: ["ci_only_workflow"] });
    expect(classify(".github/workflows/SYNTHETIC-unknown.yml")).toMatchObject({
      class: "persistent_required",
      reasonCodes: ["unregistered_workflow"],
    });
  });
  it("keeps every existing workflow and shared classifier/planner byte-identical to admitted main", () => {
    const ordinary = paths(git("ls-tree", "-r", "--name-only", main, "--", ".github/workflows"));
    for (const file of [...ordinary, "scripts/change-scope.mjs", "scripts/ci-gate-plan.mjs"])
      expect(readFileSync(file), file).toEqual(execFileSync("git", ["show", `${main}:${file}`], { windowsHide: true }));
    expect(
      parse(readFileSync(".github/workflows/platform-preview-cleanup.yml", "utf8")).on.pull_request_target.types,
    ).toContain("closed");
  });
  it("admits exactly one diagnostic push job and no existing push or completion listener", () => {
    expect(workflow.name).toBe("Ingress No-Send Diagnostic");
    expect(workflow.on).toEqual({ push: { branches: [branch] } });
    expect(Object.keys(workflow.jobs)).toEqual(["ingress-nosend-diagnostic"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "ingress-nosend-diagnostic-${{ github.ref }}",
      "cancel-in-progress": false,
    });
    expect(job.if).toContain("github.event_name == 'push'");
    expect(job.if).toContain("github.repository == 'chase-sets/chase-sets'");
    expect(job.if).toContain(`github.ref == 'refs/heads/${branch}'`);
    expect(job.if).toContain("github.event.deleted == false");
    const names = readdirSync(".github/workflows").filter((name) => /\.ya?ml$/.test(name));
    let matched = 0;
    for (const name of names) {
      const w = parse(readFileSync(`.github/workflows/${name}`, "utf8"));
      if (name === "ingress-nosend-diagnostic.yml") {
        matched++;
        continue;
      }
      expect(w.name, name).not.toBe(workflow.name);
      if (w.on?.push) {
        expect(w.on.push.branches, name).toBeInstanceOf(Array);
        for (const pattern of w.on.push.branches) expect(["main", "pilot/corten"], name).toContain(pattern);
        expect(w.on.push.tags, name).toBeUndefined();
      }
      expect(w.on?.create, name).toBeUndefined();
      expect(w.on?.delete, name).toBeUndefined();
      if (w.on?.workflow_run) {
        expect(w.on.workflow_run.workflows, name).toBeInstanceOf(Array);
        for (const subscription of w.on.workflow_run.workflows) {
          const regex = new RegExp(`^${subscription.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);
          expect(regex.test(workflow.name), name).toBe(false);
        }
      }
    }
    expect(matched).toBe(1);
  });
  it("preserves immutable checkout and least authority with physically no measurement-capable step", () => {
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job["timeout-minutes"]).toBe(30);
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBeUndefined();
    expect(job.secrets).toBeUndefined();
    expect(source).not.toMatch(/secrets\.|id-token|pull_request|workflow_dispatch/);
    const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout.uses).toBe("actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10");
    expect(checkout.with).toEqual({ ref: "${{ github.sha }}", "fetch-depth": 0, "persist-credentials": false });
    expect(job.steps).toHaveLength(2);
    expect(job.steps[1].id).toBe("authority");
    expect(job.steps[1].if).toBeUndefined();
    expect(job.steps[1].env).toBeUndefined();
    expect(source).not.toMatch(/runner\.mjs|upload-artifact|GITHUB_OUTPUT|BOOTSTRAP_NODE|outputs\.|DIAGNOSTIC_JOB_ID/);
    const eventConsumers = job.steps.filter((s) => s.run?.includes("GITHUB_EVENT_PATH="));
    expect(eventConsumers).toHaveLength(1);
    for (const step of eventConsumers) {
      expect(step.run).toContain('GITHUB_EVENT_NAME="$GITHUB_EVENT_NAME"');
      expect(step.run).toContain('GITHUB_REF="$GITHUB_REF"');
      expect(step.run).not.toContain("GITHUB_EVENT_NAME=push");
    }
    expect(source).toContain("BOOTSTRAP_ONLY_COMPLETE MEASUREMENT_NOT_EXECUTED rows=0");
  });
});
