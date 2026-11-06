import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { SUBCOMMANDS } from "../ops.mjs";
import { evaluateProspectiveIssueReadiness } from "../issue-readiness.mjs";

const roots = [".github/workflows", ".github/actions", "scripts"];
const actionPath = ".github/actions/report-scheduled-workflow-alert/action.yml";
const scriptCreators = [
  ["scripts/release-health-delivery-health.mjs", "publishSliIssues"],
  ["scripts/release-health-merge-group-failure-signatures.mjs", "upsertCircuitIssue"],
  ["scripts/release-lock-monitor.mjs", "monitorReleaseLock"],
  ["scripts/release-health-db-duration-drift.mjs", "reconcileDbDurationIssues"],
];
const documents = [
  ".agents/skills/planning/SKILL.md",
  ".agents/skills/planning/references/issue-standard.md",
  ".agents/skills/delivery/SKILL.md",
  ".claude/skills/planning/SKILL.md",
  ".claude/skills/planning/references/issue-standard.md",
  ".claude/skills/delivery/SKILL.md",
  "docs/contributing/backlog-model.md",
];
const typedCommand = "gh api --method POST repos/chase-sets/chase-sets/issues -f type=<Slice|Bug|Decision|Probe>";
const read = (path) => readFileSync(path, "utf8");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const statusOwner = "scripts/pr-release-status.mjs";
const statusCaller = ".github/workflows/platform-pr.yml";
const beforeComposition = JSON.parse(read("scripts/fixtures/workflow-composition/platform-pr.json"));
const statusCommentStep = beforeComposition.workflow.jobs["release-status"].steps.find(
  (step) => step.name === "Update PR release status comment",
);

// Transfer the original three logical operations, not a reduced physical-file
// census. The original reviewed context digest still constrains the caller;
// the complete extracted declaration is constrained before projecting it.
const reviewedStatusOwner = execFileSync("git", ["show", `69ad1c9a1541471dd88a550c9e38c04fc97ed4d8:${statusOwner}`], {
  encoding: "utf8",
});

function statusCreationProjection(workflowSource, ownerSource) {
  const tree = ts.createSourceFile(statusOwner, ownerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = tree.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "commentPrReleaseStatus",
  );
  expect(declarations).toHaveLength(1);
  const printer = ts.createPrinter({ removeComments: true });
  const expected = ts.createSourceFile(
    statusOwner,
    reviewedStatusOwner,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const expectedDeclaration = expected.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "commentPrReleaseStatus",
  );
  expect(printer.printNode(ts.EmitHint.Unspecified, declarations[0], tree)).toBe(
    printer.printNode(ts.EmitHint.Unspecified, expectedDeclaration, expected),
  );
  expect(creationContext(statusOwner, ownerSource)).toBe(creationContext(statusOwner, reviewedStatusOwner));
  expect(creationSites(ownerSource)).toHaveLength(3);
  const imports = tree.statements.filter(ts.isImportDeclaration);
  for (const [moduleName, binding] of [
    ["node:child_process", "execFileSync"],
    ["node:fs/promises", "readFile"],
  ]) {
    expect(
      imports.some(
        (node) =>
          node.moduleSpecifier.text === moduleName &&
          node.importClause?.namedBindings?.elements?.some(
            (entry) => entry.name.text === binding && !entry.propertyName,
          ),
      ),
    ).toBe(true);
  }
  const workflow = parse(workflowSource);
  const steps = workflow.jobs["release-status"].steps;
  const index = steps.findIndex((step) => step.name === statusCommentStep.name);
  expect(steps[index]).toEqual({
    ...statusCommentStep,
    run: "node ./scripts/pr-release-status.mjs comment",
    env: { ...statusCommentStep.env, PR_NUMBER: "${{ github.event.pull_request.number }}" },
  });
  expect(steps.filter((step) => /pr-release-status\.mjs\s+comment/.test(step.run ?? ""))).toHaveLength(1);
  steps[index] = statusCommentStep;
  return workflow;
}
// Non-issue POSTs and read-only gh api calls are deliberately counted too.
// A new site, including one using a dynamic URL or argument array, requires
// reviewing this census rather than silently bypassing the typed creators.
const reviewedSites = {
  ".github/actions/report-scheduled-workflow-alert/action.yml": 1,
  ".github/workflows/platform-ephemeral-verification.yml": 3,
  ".github/workflows/platform-merge-gate-verification.yml": 2,
  ".github/workflows/platform-merge-qualification-observer.yml": 4,
  ".github/workflows/platform-merge-qualification.yml": 3,
  ".github/workflows/platform-pr.yml": 5,
  ".github/workflows/platform-preview-cleanup.yml": 3,
  ".github/workflows/platform-production-stale-helm-recovery.yml": 1,
  ".github/workflows/platform-production.yml": 10,
  ".github/workflows/platform-registry-cleanup.yml": 1,
  ".github/workflows/platform-seed-packs-apply.yml": 2,
  ".github/workflows/platform-staging-advisory-evidence.yml": 2,
  ".github/workflows/platform-staging-reset.yml": 1,
  ".github/workflows/platform-staging-route-matrix-evidence.yml": 3,
  "scripts/catalog-staging-count-lifecycle.mjs": 1,
  "scripts/catalog-staging-count-preparation.mjs": 1,
  "scripts/catalog-staging-scrydex-coordinate-preview.mjs": 1,
  "scripts/connector-pairing-drill-deploy-binding.mjs": 3,
  "scripts/dispatch-unlock-count.mjs": 2,
  "scripts/easypost-refund-event-replay.mjs": 1,
  "scripts/guest-buy-now-freshness-probe.mjs": 4,
  "scripts/issue-form-labels.mjs": 1,
  "scripts/issue-readiness.mjs": 2,
  "scripts/label-registry.mjs": 4,
  "scripts/lib/synthetic-account-invitations.mjs": 3,
  "scripts/marketplace-production-proof-topology-evidence.mjs": 18,
  "scripts/merge-qualification.mjs": 1,
  "scripts/next-work.mjs": 1,
  "scripts/platform-pr-scope.mjs": 1,
  "scripts/platform-risk-review.mjs": 1,
  "scripts/platform-smoke.mjs": 9,
  "scripts/project-status-sync.mjs": 1,
  "scripts/provider-object-disposition/browser-boundary/bootstrap.mjs": 1,
  "scripts/provider-webhook-lifecycle.mjs": 3,
  "scripts/release-health-db-duration-drift.mjs": 4,
  "scripts/release-health-delivery-health.mjs": 3,
  "scripts/release-health-flake-digest.mjs": 1,
  "scripts/release-health-merge-group-failure-signatures.mjs": 4,
  "scripts/release-lock-monitor.mjs": 2,
  "scripts/review-cadence-digest.mjs": 1,
  "scripts/roadmap-authority-probe.mjs": 2,
  "scripts/roadmap-status.mjs": 2,
  "scripts/staging-evidence-authority.mjs": 1,
  "scripts/staging-evidence-window.mjs": 3,
  "scripts/staging-projection-operations.mjs": 2,
  "scripts/staging-refresh-preflight.mjs": 1,
  "scripts/staging-wake-drills.mjs": 1,
  "scripts/stripe-money-smoke-test.mjs": 13,
  "scripts/stripe-webhook-endpoint.mjs": 2,
};
const reviewedSiteContexts = {
  ".github/actions/report-scheduled-workflow-alert/action.yml":
    "5595752c7d1460851b2dbc0fb881dbd62538bb35e4e3508eba1f1220574e0c6c",
  ".github/workflows/platform-ephemeral-verification.yml":
    "7f1144d23dcd3cf55046c2541219a6bfcfcca1cfa84d09814c496f710776c9a0",
  ".github/workflows/platform-merge-gate-verification.yml":
    "6fa344fe648338f5869c1b251a63634c4abd5ce96f206df921e87364b267090d",
  ".github/workflows/platform-merge-qualification-observer.yml":
    "4cc464eb0efccd4db0ad4b72a8d927522c0ead34f51ac484052c1aaa53195307",
  ".github/workflows/platform-merge-qualification.yml":
    "9cf77243f7f8d72afe23dfc74edc861c9cb0fb301065d90eca041212198a9884",
  ".github/workflows/platform-pr.yml": "3c0d9f0fe5b15cf8ff0b26d4d4b4828f74c9fe4ef8a64f45c75940da66472b33",
  ".github/workflows/platform-preview-cleanup.yml": "8799915ac4e6c8f687db7fb98a26d5fe0f4732b4daffeed799232a7510a5875f",
  ".github/workflows/platform-production-stale-helm-recovery.yml":
    "874cc16209c22390554079f4f5232158e578673c4d387afa04fadcac8d0c6e3d",
  ".github/workflows/platform-production.yml": "0a20e3f646d11cfaa8bb1bbbe66f08badfb4cb295649b54d5fc8b7055021136c",
  ".github/workflows/platform-registry-cleanup.yml": "490369cb5c0eaef5431059f8f7571b4dca0f65e9cf5a962e54894a4496c94d8e",
  ".github/workflows/platform-seed-packs-apply.yml": "c7d398976c70d96686f0197e193ca25328c6b2fb93efba73b189de5aa0b0c082",
  ".github/workflows/platform-staging-advisory-evidence.yml":
    "ca7b3b2b0c547dc6c86e8228f5d50199c3e74427b923fbbbe82773cc991e71ab",
  ".github/workflows/platform-staging-reset.yml": "faba2302a5172c8c9b901b226c759a64cc28c51f54fb9d429be81565e877d6fe",
  ".github/workflows/platform-staging-route-matrix-evidence.yml":
    "1fba522423d44818b04cbf723508822fdd9bc4dfca9324fa48f22f0b459cf58b",
  "scripts/catalog-staging-count-lifecycle.mjs": "743f308bf2b21cff783674ab9f69601a0ec04959d034253a3fe1d269257663bd",
  "scripts/catalog-staging-count-preparation.mjs": "441a612dbf19637932fb8436258593d7b521ab1da6c2606b557e3c240cd46f0a",
  "scripts/catalog-staging-scrydex-coordinate-preview.mjs":
    "9074c190b4a94e3e32314b3e4e4322075ffa9440cc637dd196c6c6242b7945b2",
  "scripts/connector-pairing-drill-deploy-binding.mjs":
    "ff425081924b7c5275737ef0a526a44a1daaeea94234d674a66ea7137137c618",
  "scripts/dispatch-unlock-count.mjs": "cdc5e770ee4b7f91eac40f91118bfad992a4a01dd15d85bd5dba574910d30872",
  "scripts/easypost-refund-event-replay.mjs": "0a1980a7006e3c58b1df5f799bb0092c322c9a41659314ebbd50679de83a6cfd",
  "scripts/guest-buy-now-freshness-probe.mjs": "2faa364ba0e4b78dee01b4002df76145288c0ff4441d70bdf8a5c4ce4733ea38",
  "scripts/issue-form-labels.mjs": "685730538343e74f740e9a91d792adc0bf59597da76d723371afc6650066f7c9",
  "scripts/issue-readiness.mjs": "e4fb71671a3abf36f950490ed03fa845a556cd27d45e449297bfe54110971472",
  "scripts/label-registry.mjs": "360cfce61b3c98e79c1c20e867d22b8aa1a758a311866a4afd348dd1ed183248",
  "scripts/lib/synthetic-account-invitations.mjs": "39497c2c3996892252430b8a4eafd95bb35a48cb7a172fc1247c06e7def35069",
  "scripts/marketplace-production-proof-topology-evidence.mjs":
    "d9afa69618c0fc844e2b6c82bd1ad7b74784eeea07b3a975b78721852ef879d6",
  "scripts/merge-qualification.mjs": "b04be2a584d6aa22fe04bc464f65a1bb317c9f62393c447d4e4a66daadfd1e3e",
  "scripts/next-work.mjs": "0e5faa744dfcfe74d72930ca37f06a1842072c6cf7a9c234f54870f45b2b2174",
  "scripts/platform-pr-scope.mjs": "9d3522578401d01f7bbb9f98b07a33c82620665aaa2e2a21913e7502a85be3b1",
  "scripts/platform-risk-review.mjs": "629eb54a9b60db5d97b3c3026c494cd1a9483cf6601fa73289eef97fa55577c2",
  "scripts/platform-smoke.mjs": "a4cb3bfbdc3f6c0d5625f913f145b44f5687ad992a06884db95d508c7c2ce659",
  "scripts/project-status-sync.mjs": "df628a68ae1d87a4c1def0a0e4525cf4ca5a980d2f2d574bfd3bb4e0aebacf66",
  "scripts/provider-object-disposition/browser-boundary/bootstrap.mjs":
    "f80e3e9f0740b6ad3dd65abd4390807146f896f57abae2edb2bcaff8b146d349",
  "scripts/provider-webhook-lifecycle.mjs": "60348f37a131d7b5e12d49396282334dd776a15bb4a75476efcb88cb774ea9f9",
  "scripts/release-health-db-duration-drift.mjs": "a524656ee72215a24e9ab85540488ebd1da93effa2fa90c0d5fe971772c8bd34",
  "scripts/release-health-delivery-health.mjs": "0380435da6de9517547f2d1b961b44084087d4943a567225c2ff2a7bade834c3",
  "scripts/release-health-flake-digest.mjs": "99235fd1ce76c30d53b29a54f5e5ee038fa8cf22ae60ff6907b06a7835dd51e8",
  "scripts/release-health-merge-group-failure-signatures.mjs":
    "70696279f5208a0682fd6f85dd2e4bd210b90dd970d2791f4c54db198ce1232d",
  "scripts/release-lock-monitor.mjs": "2b383c4870bdeba629901c995aa95cb7aabac8c3ff3b3a097a9157ae3b88a384",
  "scripts/review-cadence-digest.mjs": "078900adf917f1134e1145d7c7a1be86c96733de48db09e2942a6df362ad345d",
  "scripts/roadmap-authority-probe.mjs": "0788fe241a83e2fde60540d0d6727d95d3fcf9cf72cb125aba7083182844412c",
  "scripts/roadmap-status.mjs": "f70dd7c246a7b14c5887302b1a6d0718be522a7568f934951dcf89e940ecc3f8",
  "scripts/staging-evidence-authority.mjs": "21fac8a5bed15b704efe60f8c10326334354ab0376aee2906af0f72d70b3b20b",
  "scripts/staging-evidence-window.mjs": "7dce45794b45e8378c1b25e2f5165d061e0777f10fd7b3c11185e53d7a5df816",
  "scripts/staging-projection-operations.mjs": "ab2d69296083f225b19579adce4156c0155bbd77d8959222321fb77cc6074d74",
  "scripts/staging-refresh-preflight.mjs": "8327da03d2d0ea8d486d3f456f9daf2fd5301ba15068a034ddf30f28b41267e3",
  "scripts/staging-wake-drills.mjs": "3c5544f6031c2473f2e69b9bf20f4c2c64f55afb08bb0be1e93a481a51c50937",
  "scripts/stripe-money-smoke-test.mjs": "b7dd30be0469e9226d03894debd4aaadb468d40657c6f2e7ce58508d7ad4672d",
  "scripts/stripe-webhook-endpoint.mjs": "525b0a34268baf31eb5ce0695ea834c08ca56dca71e4683ccbe57f753ce0c052",
};
const sharedCallers = [
  "catalog-provider-refresh-watch.yml",
  "platform-ci-flake-digest.yml",
  "platform-coverage.yml",
  "platform-credential-health.yml",
  "platform-database-restore-drill.yml",
  "platform-db-duration-drift.yml",
  "platform-delivery-health.yml",
  "platform-dependency-audit.yml",
  "platform-digitalocean-drift-digest.yml",
  "platform-merge-group-failure-signatures.yml",
  "platform-merge-queue-posture.yml",
  "platform-postgres-growth-evidence.yml",
  "platform-postgres-slow-query-digest.yml",
  "platform-preview-cleanup-observer.yml",
  "platform-preview-cleanup.yml",
  "platform-production-restore-point-cleanup.yml",
  "platform-registry-cleanup.yml",
  "platform-staging-rollback-drill.yml",
  "platform-terraform-state-snapshot.yml",
  "public-docs-stale-review.yml",
  "review-cadence-digest.yml",
];
const shellCreators = [
  [".github/workflows/platform-production.yml", "Create or update advisory evidence incident"],
  [".github/workflows/platform-production.yml", "Create, update, or resolve incident issue"],
  [".github/workflows/platform-production.yml", "Create or update rollback incident issue"],
  [".github/workflows/platform-staging-advisory-evidence.yml", "Create, update, or resolve advisory evidence incident"],
];
const bash =
  process.platform === "win32"
    ? resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "../../../bin/bash.exe")
    : "bash";

function shellProbe(path, name, type, milestone, source = read(path)) {
  const workflow = parse(source);
  const step = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((candidate) => candidate.name === name);
  if (!step?.run) throw new Error(`Missing shell creator ${path}::${name}`);
  const root = mkdtempSync(join(tmpdir(), "issue-creation-type-contract-"));
  const stubs = `
    gh() {
      printf '%s\\n' "$@" >> trace
      if [[ "$1" == api && "$2" == --paginate ]]; then printf '%s' "$SYNTHETIC_MILESTONE";
      elif [[ "$1" == api ]]; then printf '%s' "$SYNTHETIC_RETURNED_TYPE"; fi
    }
    node() { printf '%s' 'synthetic incident body'; }
  `;
  try {
    const result = spawnSync(bash, ["-c", `${stubs}\n${step.run}`], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ...Object.fromEntries(Object.keys(step.env ?? {}).map((key) => [key, ""])),
        GITHUB_REPOSITORY: "synthetic/synthetic",
        RELEASE_COMMIT: "a".repeat(40),
        ADVISORY_RESULT: "failure",
        DEPLOY_INCIDENT_ACTION: "create",
        ROOT_CAUSE_SIGNATURE: "synthetic",
        SYNTHETIC_RETURNED_TYPE: type?.is_enabled === true ? type.name : "",
        SYNTHETIC_MILESTONE: milestone,
      },
    });
    if (result.error) throw result.error;
    return { ...result, trace: read(join(root, "trace")) };
  } finally {
    if (!root.startsWith(join(tmpdir(), "issue-creation-type-contract-")))
      throw new Error("Unexpected fixture cleanup root");
    rmSync(root, { recursive: true, force: true });
  }
}

function filesUnder(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) return filesUnder(path);
    return /\.(?:mjs|[cm]?js|[cm]?tsx?|ya?ml|ps1|sh|py)$/.test(path) && !/\.(?:test|spec)\./.test(path) ? [path] : [];
  });
}

function sourceInventory(root = ".") {
  const inventory = {};
  for (const [path, count] of roots
    .flatMap((path) => filesUnder(join(root, path)))
    .sort()
    .flatMap((path) => {
      const sites = creationSites(read(path));
      return sites.length ? [[relative(root, path).replaceAll("\\", "/"), sites.length]] : [];
    })) {
    const logicalPath = path === statusOwner ? statusCaller : path;
    inventory[logicalPath] = (inventory[logicalPath] ?? 0) + count;
  }
  return inventory;
}

function creationContext(path, source, ownerSource) {
  source = source.replaceAll("\r\n", "\n");
  if (/\.ya?ml$/.test(path)) {
    const fragments = [];
    function visit(value, environments = []) {
      if (!value || typeof value !== "object") return;
      const scopes = value.env ? [...environments, value.env] : environments;
      for (const [key, child] of Object.entries(value)) {
        if (["run", "script"].includes(key) && typeof child === "string" && creationSites(child).length) {
          fragments.push({ key, source: child, environments: scopes });
        } else if (child && typeof child === "object") visit(child, scopes);
      }
    }
    visit(path === statusCaller && ownerSource ? statusCreationProjection(source, ownerSource) : parse(source));
    return hash(JSON.stringify(fragments.length ? fragments : source));
  }
  if (!/\.[cm]?[jt]sx?$/.test(path)) return hash(source);
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const sites = creationSites(source);
  // Keep the enclosing declaration, not just the POST token: its target,
  // payload, local argument arrays and module configuration are review input.
  const statements = tree.statements.filter(
    (node) => ts.isVariableStatement(node) || sites.some((site) => site.offset >= node.pos && site.offset < node.end),
  );
  return hash(JSON.stringify(statements.map((node) => node.getText(tree))));
}

function contextInventory(root = ".") {
  const ownerSource = existsSync(join(root, statusOwner)) ? read(join(root, statusOwner)) : null;
  return Object.fromEntries(
    roots
      .flatMap((path) => filesUnder(join(root, path)))
      .sort()
      .flatMap((path) => {
        const source = read(path);
        const relativePath = relative(root, path).replaceAll("\\", "/");
        if (relativePath === statusOwner) {
          statusCreationProjection(read(join(root, statusCaller)), source);
          return [];
        }
        return creationSites(source).length ? [[relativePath, creationContext(relativePath, source, ownerSource)]] : [];
      }),
  );
}

function assertCreatorCallers(workflow, path, readSource = read) {
  const aliases = Object.entries(SUBCOMMANDS)
    .filter(([, command]) => scriptCreators.some(([file]) => file === `scripts/${command.script}`))
    .map(([alias]) => alias);
  const creatorFiles = scriptCreators.map(([file]) => file);
  function unresolved(location) {
    throw new Error(`Unresolved or ambiguous creator forwarding: ${location}`);
  }
  function workspacePath(value, directory, location) {
    if (typeof value !== "string" || typeof directory !== "string") unresolved(location);
    const rooted = /^(?:\$\{\{\s*github\.workspace\s*\}\}|\$\{GITHUB_WORKSPACE\}|\$GITHUB_WORKSPACE)(?:\/|$)/.test(
      value,
    );
    const expanded = value.replace(/\$\{\{\s*github\.workspace\s*\}\}|\$\{GITHUB_WORKSPACE\}|\$GITHUB_WORKSPACE/g, ".");
    if (/[$`]|^[\\/]|^[A-Za-z]:/.test(expanded) || /[$`]/.test(directory)) unresolved(location);
    const result = posix.normalize(posix.join(rooted ? "." : directory, expanded));
    if (result === ".." || result.startsWith("../")) unresolved(location);
    return result;
  }
  function callsScript(run, directory, location) {
    const candidates = (run.match(/"[^"\n]*"|'[^'\n]*'|[^\s;&|()<>]+/g) ?? [])
      .map((token) => token.replace(/^["']|["']$/g, ""))
      .filter((token) => creatorFiles.some((file) => token.endsWith(file.split("/").at(-1))));
    const aliasCall = aliases.some((alias) => run.includes(alias));
    if (!candidates.length && !aliasCall) return false;
    // Shell directory changes and computed paths need explicit review rather
    // than guessing which creator a command will invoke.
    if (/(?:^|[;\n&|])\s*(?:cd|pushd|popd)\b/.test(run)) unresolved(location);
    for (const token of candidates) {
      const effectiveDirectory = workspacePath(directory, ".", location);
      if (!creatorFiles.includes(workspacePath(token, effectiveDirectory, location))) unresolved(location);
    }
    return true;
  }
  function actionCallsCreator(reference, location, chain) {
    const directory = workspacePath(reference, ".", location);
    if (chain.includes(directory)) unresolved(`${location} (composite cycle)`);
    const manifests = ["action.yml", "action.yaml"].flatMap((name) => {
      try {
        const source = readSource(`${directory}/${name}`);
        return typeof source === "string" ? [source] : [];
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    });
    if (manifests.length !== 1) unresolved(location);
    const action = parse(manifests[0]);
    if (action?.runs?.using !== "composite" || !Array.isArray(action.runs.steps)) unresolved(location);
    // Composite run steps default to the workspace, not the action directory.
    return inspectSteps(action.runs.steps, {}, ".", `${location} -> ${directory}`, [...chain, directory]) > 0;
  }
  function inspectSteps(steps, job, defaultDirectory, location, chain = []) {
    let count = 0;
    for (const [index, step] of steps.entries()) {
      const boundary = `${location} step ${index + 1}`;
      const run = step.run ?? "";
      const directory = step["working-directory"] ?? defaultDirectory;
      const scriptCall = callsScript(run, directory, boundary);
      const shellCreate = creationSites(run).some((site) => site.kind === "issue-target");
      const inlineCreate = creationSites(step.with?.script ?? "").some((site) =>
        ["cli", "graphql", "octokit", "issue-target"].includes(site.kind),
      );
      const actionCall =
        typeof step.uses === "string" && step.uses.startsWith("./")
          ? actionCallsCreator(step.uses, boundary, chain)
          : false;
      if (!scriptCall && !shellCreate && !inlineCreate && !actionCall) continue;
      count += 1;
      expect(job["continue-on-error"], boundary).toBeUndefined();
      expect(step["continue-on-error"], boundary).toBeUndefined();
      // Shell creators' close-only branches may return 0 before creation; the
      // actual create probes above exercise the other branch. Command callers
      // have no such branch and may not normalize the command's error.
      if (scriptCall) expect(run, boundary).not.toMatch(/\|\|\s*(?:true|:|exit\s+0)|set\s+\+e|exit\s+0/);
    }
    return count;
  }
  let count = 0;
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    const directory = job.defaults?.run?.["working-directory"] ?? workflow.defaults?.run?.["working-directory"] ?? ".";
    count += inspectSteps(job.steps ?? [], job, directory, `${path} ${jobId}`);
  }
  return count;
}

function functionBody(path, name, source = read(path)) {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = tree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration?.body) throw new Error(`Missing function ${path}::${name}`);
  return declaration.body.getText(tree).slice(1, -1);
}

function executeFunction(path, name, dependencies, args, source) {
  const body = functionBody(path, name, source);
  return new AsyncFunction(...Object.keys(dependencies), `return async function(${args}) {${body}}`)(
    ...Object.values(dependencies),
  );
}

function creationSites(source) {
  const sites = [];
  for (const match of source.matchAll(/\bgh\s+issue\s+create\b|\bcreateIssue\b|\bissues\s*\.\s*create\s*\(/g)) {
    sites.push({
      kind: match[0].startsWith("gh") ? "cli" : match[0] === "createIssue" ? "graphql" : "octokit",
      offset: match.index,
    });
  }
  // Inventory every REST POST, not only literal /issues URLs: wrappers and
  // dynamic argument arrays must not make a future creator invisible.
  for (const match of source.matchAll(/\bmethod\s*:\s*(?:[^\n,]*?)["']POST["']|\bgh\s+api\b[^\n]*(?:\\\n[^\n]*)*/g)) {
    sites.push({ kind: "rest", offset: match.index });
  }
  const tree = /["']gh["']/.test(source)
    ? ts.createSourceFile("operations.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    : null;
  function apiCall(node) {
    return (
      ts.isCallExpression(node) &&
      node.arguments[0]?.text === "gh" &&
      node.arguments[1] &&
      ts.isArrayLiteralExpression(node.arguments[1]) &&
      node.arguments[1].elements[0]?.text === "api"
    );
  }
  function visit(node) {
    if (!ts.isFunctionDeclaration(node) && !ts.isFunctionExpression(node) && !ts.isArrowFunction(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    const calls = [];
    function collect(child) {
      if (apiCall(child)) calls.push(child);
      ts.forEachChild(child, collect);
    }
    collect(node);
    // The relocated shell if/else is one argument-array call with two logical
    // methods. Include its read and both write branches as one operation family;
    // unrelated pre-existing GET wrappers retain their original census.
    if (!calls.some((call) => call.arguments[1].elements.some(ts.isConditionalExpression))) return;
    for (const node of calls) {
      const args = node.arguments[1];
      if (args && ts.isArrayLiteralExpression(args) && args.elements[0]?.text === "api") {
        const methodIndex = args.elements.findIndex((entry) => entry.text === "--method");
        const method = args.elements[methodIndex + 1];
        const count = methodIndex >= 0 && method && ts.isConditionalExpression(method) ? 2 : 1;
        for (let index = 0; index < count; index++) sites.push({ kind: "rest", offset: node.pos });
      }
    }
  }
  if (tree) visit(tree);
  // Index create targets independently of POST counts. Retargeting a reviewed
  // comment/label POST to /issues must not inherit that site's review.
  for (const match of source.matchAll(/["'`](?:[^"'`\n]*\/)?issues["'`]/g)) {
    sites.push({ kind: "issue-target", offset: match.index });
  }
  return sites;
}

function docErrors(source) {
  return [
    source.includes(`${typedCommand} ... --jq .type.name`) ? null : "typed-command",
    source.includes("`gh issue create` cannot set type") ? null : "unsupported-cli",
    source.includes("Machine alerts use native `Bug`") ? null : "machine-policy",
    source.includes("scripts/check-structure/issue-creation-type-contract.test.mjs") ? null : "guard-pointer",
    /\bgh issue create\s+(?:--repo|--title|--body)/.test(source) ? "bare-create" : null,
  ].filter(Boolean);
}

async function scriptProbe(path, name, type, source, requestError) {
  const requests = [];
  const receipt = { number: 123, id: 456, html_url: "https://synthetic.invalid/issues/123", state: "open", type };
  const request = async (...args) => {
    requests.push(args);
    if (requestError) throw requestError;
    return receipt;
  };
  let invoke;
  if (name === "publishSliIssues") {
    const fn = await executeFunction(
      path,
      name,
      {
        API_BASE_URL: "https://synthetic.invalid",
        DELIVERY_HEALTH_SLI_MARKER_VERSION: "synthetic",
        parseSliMarker: () => null,
        renderSliIssue: () => "synthetic body",
      },
      "{ client, repository, record }",
      source,
    );
    invoke = () =>
      fn({
        client: { paginate: async () => [], json: request },
        repository: "synthetic/synthetic",
        record: { slis: [{ id: "synthetic", status: "breaching", severity: "p1" }] },
      });
  } else if (name === "upsertCircuitIssue") {
    const fn = await executeFunction(
      path,
      name,
      {
        githubJson: async (_options, ...args) => request(...args),
        circuitTitle: () => "synthetic title",
        renderCircuitSummary: () => "synthetic body",
        updateCircuitIssue: () => {
          throw new Error("unexpected update");
        },
      },
      "options, issue, record",
      source,
    );
    invoke = () => fn({ mutate: true }, null, {});
  } else if (name === "monitorReleaseLock") {
    const fn = await executeFunction(
      path,
      name,
      {
        isNonEmptyString: Boolean,
        evaluateLockMonitorDecision: () => ({ shouldNotify: true, identity: "synthetic" }),
        buildRunUrl: () => "https://synthetic.invalid/run",
        createGitHubClient: () => ({ request }),
        listMatchingIssues: async () => [],
        RELEASE_LOCK_MONITOR_IDENTITY_MARKER: "synthetic",
        RELEASE_LOCK_MONITOR_ISSUE_TITLE: "synthetic title",
        buildIncidentBody: () => "synthetic body",
      },
      "options, dependencies = {}",
      source,
    );
    invoke = () => fn({ repository: "chase-sets/chase-sets", token: "synthetic-token" });
  } else {
    const fn = await executeFunction(
      path,
      name,
      {
        apiClient:
          () =>
          async (...args) => ({ payload: await request(...args) }),
        collectPages: async () => [],
        WORKFLOW: "synthetic.yml",
      },
      "digest, options",
      source,
    );
    invoke = () =>
      fn(
        {
          state: "ratified",
          collection: { status: "complete" },
          verdicts: [{ key: "synthetic", state: "breach" }],
          includedJobIds: [],
        },
        {
          repository: "synthetic/synthetic",
          env: {
            GITHUB_ACTIONS: "true",
            GITHUB_EVENT_NAME: "schedule",
            GITHUB_WORKFLOW_REF: "synthetic/synthetic/.github/workflows/synthetic.yml@refs/heads/main",
          },
        },
      );
  }
  let error;
  try {
    await invoke();
  } catch (caught) {
    error = caught;
  }
  const [, options] = requests[0] ?? [];
  const payload = typeof options?.body === "string" ? JSON.parse(options.body) : options?.body;
  return { error, payload };
}

async function scriptFailureExit(path, name, error) {
  const fail = async () => {
    throw error;
  };
  const console = { error: () => {}, log: () => {} };
  if (name === "publishSliIssues") {
    const main = await executeFunction(
      path,
      "runDeliveryHealthCommand",
      {
        parseDeliveryHealthArgs: () => ({}),
        collectDeliveryHealth: fail,
        writeOutputs: async () => {},
        console,
      },
      "argv, env = {}, dependencies = {}",
    );
    return main([]);
  }
  if (name === "monitorReleaseLock") {
    const main = await executeFunction(
      path,
      "main",
      {
        parseReleaseLockMonitorArgs: () => ({}),
        monitorReleaseLock: fail,
        console,
      },
      "argv, env = {}",
    );
    return main([]);
  }
  if (name === "upsertCircuitIssue") {
    const main = await executeFunction(
      path,
      "main",
      {
        parseMergeGroupFailureSignaturesArgs: () => ({ enforcement: false }),
        collectMergeGroupFailureSignatures: fail,
        writeOutputs: async () => {},
        console,
        appendFile: async () => {},
      },
      "argv, env = {}",
    );
    return main([]);
  }
}

describe("issue creation type contract", () => {
  it("retains the dispatch-time readiness fallback for missing, disabled and non-dispatchable types", () => {
    const fixture = JSON.parse(read("scripts/fixtures/issue-readiness-v1.json"));
    for (const issueType of [
      { nodeId: "synthetic-type", name: "Slice", isEnabled: true },
      null,
      { nodeId: "synthetic-type", name: "Slice", isEnabled: false },
      { nodeId: "synthetic-type", name: "Task", isEnabled: true },
      { nodeId: "synthetic-type", name: "Unknown", isEnabled: true },
    ]) {
      const result = evaluateProspectiveIssueReadiness({
        body: fixture.readyBody,
        metadata: {
          repository: "synthetic/synthetic",
          number: 1,
          state: "open",
          issueType,
          milestone: {
            number: 1,
            title: "Synthetic outcome",
            description: '<!-- outcome: {"version":1,"track":"wave","order":1,"status":"committed"} -->',
            state: "open",
          },
          labels: ["priority:p1", "area:ops", "kind:tech-debt"],
          parentNumber: null,
          dependencies: [],
        },
        checkedAt: "2026-11-05T00:00:00Z",
        checkerSha: "a".repeat(40),
      });
      expect(result.reasonCodes.includes("ISSUE_TYPE_NOT_DISPATCHABLE")).toBe(
        issueType === null || issueType.isEnabled !== true || issueType.name === "Unknown",
      );
      if (issueType?.name === "Task") expect(result.reasonCodes).toContain("ISSUE_NOT_CLASSIFIED");
      expect(result.status).toBe(issueType?.name === "Slice" && issueType.isEnabled ? "ready" : "not-ready");
    }
  });
  it("fails the merge-signature command when the authority rejects the typed create request", async () => {
    const [path, name] = scriptCreators[1];
    const result = await scriptProbe(path, name, null, undefined, new Error("synthetic GitHub 422: rejected type"));
    expect(result.error?.code).toBe("ISSUE_CREATION_FAILED");
    expect(result.error?.cause?.message).toContain("422");
    expect(await scriptFailureExit(path, name, result.error)).toBe(2);
  });
  it.each(shellCreators)(
    "executes typed %s::%s with and without a milestone and rejects bad receipts",
    (path, name) => {
      for (const milestone of ["", "146"]) {
        for (const type of [
          { name: "Bug", is_enabled: true },
          null,
          { name: "Slice", is_enabled: true },
          { name: "Bug", is_enabled: false },
        ]) {
          const result = shellProbe(path, name, type, milestone);
          expect(result.trace).toContain("type=Bug\n");
          expect(result.trace).toContain(".type | select(.is_enabled == true) | .name\n");
          if (type?.name === "Bug" && type.is_enabled === true) expect(result.status, result.stderr).toBe(0);
          else {
            expect(result.status).toBe(1);
            expect(result.stderr).toContain("ISSUE_CREATION_TYPE_MISMATCH");
          }
          if (name.includes("rollback") || name === "Create, update, or resolve incident issue") {
            expect(result.trace.includes("milestone=146\n")).toBe(Boolean(milestone));
          }
        }
      }
      const original = read(path);
      const before = hash(original);
      const mutant = original.replaceAll("-f type=Bug", "-f omitted=Bug");
      expect(
        shellProbe(path, name, { name: "Bug", is_enabled: true }, "", mutant).trace,
        "REMOVE_SHELL_TYPE mutant is red",
      ).not.toContain("type=Bug\n");
      expect(hash(read(path))).toBe(before);
    },
  );

  it.each(scriptCreators)(
    "types the real %s::%s create function and fails every invalid response",
    async (path, name) => {
      for (const type of [
        { name: "Bug", is_enabled: true },
        null,
        undefined,
        { name: "Slice", is_enabled: true },
        { name: "Bug", is_enabled: false },
        { name: "Bug" },
      ]) {
        const result = await scriptProbe(path, name, type);
        expect(result.payload?.type).toBe("Bug");
        if (type?.name === "Bug" && type.is_enabled === true) expect(result.error).toBeUndefined();
        else {
          expect(result.error?.message).toContain("ISSUE_CREATION_TYPE_MISMATCH");
          if (name !== "reconcileDbDurationIssues")
            expect(await scriptFailureExit(path, name, result.error)).toBeGreaterThan(0);
        }
      }
      const original = read(path);
      const before = hash(original);
      const mutant = original.replace('type: "Bug"', 'omitted: "Bug"');
      expect(mutant).not.toBe(original);
      expect(
        (await scriptProbe(path, name, { name: "Bug", is_enabled: true }, mutant)).payload?.type,
        "REMOVE_CREATE_TYPE mutant is red",
      ).not.toBe("Bug");
      expect(hash(read(path)), "restored source hash after named in-memory mutant").toBe(before);
    },
  );

  it("never converts a merge-group create type failure to advisory success", async () => {
    const path = scriptCreators[1][0];
    const fn = await executeFunction(
      path,
      "main",
      {
        parseMergeGroupFailureSignaturesArgs: () => ({ enforcement: false }),
        collectMergeGroupFailureSignatures: async () => {
          const error = new Error("synthetic type mismatch");
          error.code = "ISSUE_CREATION_TYPE_MISMATCH";
          throw error;
        },
        writeOutputs: async () => {},
        console: { error: () => {}, log: () => {} },
        appendFile: async () => {},
      },
      "argv, env = {} ",
    );
    expect(await fn([])).toBe(2);
  });

  it("inventories every creation-sensitive site under workflows, actions and scripts", () => {
    expect(sourceInventory()).toEqual(reviewedSites);
  });

  it("pins the inspected creation contexts so unchanged counts cannot authorize a different target", () => {
    expect(contextInventory()).toEqual(reviewedSiteContexts);
  });

  it("transfers all three release-comment operations plus both remaining sites without resetting the reviewed census or digest", () => {
    expect(creationSites(read(statusCaller))).toHaveLength(2);
    expect(creationSites(read(statusOwner))).toHaveLength(3);
    expect(sourceInventory()[statusCaller]).toBe(5);
    expect(creationContext(statusCaller, read(statusCaller), read(statusOwner))).toBe(
      reviewedSiteContexts[statusCaller],
    );
    const baseline = parse(
      execFileSync("git", ["show", `${beforeComposition.sourceHead}:${statusCaller}`], { encoding: "utf8" }),
    );
    expect(baseline.jobs["release-status"].steps.find((step) => step.name === statusCommentStep.name)).toEqual(
      statusCommentStep,
    );
  });

  it.each([
    ["target", (source) => source.replace("/issues/${env.PR_NUMBER}/comments", "/pulls/${env.PR_NUMBER}/comments")],
    ["method", (source) => source.replace('commentId ? "PATCH" : "POST"', 'commentId ? "POST" : "PATCH"')],
    ["payload", (source) => source.replace("`body=${body.replace", "`title=${body.replace")],
    ["enclosing arguments", (source) => source.replace('encoding: "utf8"', 'encoding: "ascii"')],
    ["credential binding", (source) => source.replace("{ stdio:", "{ env: {}, stdio:")],
    ["import binding", (source) => source.replace('from "node:child_process"', 'from "./synthetic-executor.mjs"')],
  ])("rejects same-count extracted-owner %s drift", (_name, edit) => {
    const source = read(statusOwner);
    const mutant = edit(source);
    expect(mutant).not.toBe(source);
    expect(creationSites(mutant)).toHaveLength(creationSites(source).length);
    expect(() => statusCreationProjection(read(statusCaller), mutant)).toThrow();
  });

  it("rejects same-count non-issue-to-issue retargeting inside the extracted argument arrays", () => {
    const source = `const issueTarget = \`repos/\${env.GITHUB_REPOSITORY}/issues\`;\n${read(statusOwner)}`;
    const mutant = source.replace("`repos/${env.GITHUB_REPOSITORY}/issues/${env.PR_NUMBER}/comments`", "issueTarget");
    expect(mutant).not.toBe(source);
    expect(creationSites(mutant)).toHaveLength(creationSites(source).length);
    expect(creationContext(statusOwner, mutant)).not.toBe(creationContext(statusOwner, source));
    expect(() => statusCreationProjection(read(statusCaller), mutant)).toThrow();
  });

  it.each(["GH_TOKEN", "PR_NUMBER"])("rejects loss of the caller's step-local %s forwarding", (field) => {
    const workflow = parse(read(statusCaller));
    delete workflow.jobs["release-status"].steps.find((step) => step.name === statusCommentStep.name).env[field];
    expect(() => statusCreationProjection(stringify(workflow), read(statusOwner))).toThrow();
  });

  it.each(["", "11\n22\n"])(
    "executes the extracted GET and conditional write with prior comments %j",
    async (comments) => {
      const calls = [];
      const invoke = await executeFunction(
        statusOwner,
        "commentPrReleaseStatus",
        {
          readFile: async (path, encoding) => {
            expect(path).toBe("artifacts/pr-release-status.md");
            expect(encoding).toBe("utf8");
            return "synthetic body\n";
          },
        },
        "env, execute, source = 'artifacts/pr-release-status.md'",
      );
      await invoke({ GITHUB_REPOSITORY: "synthetic/repository", PR_NUMBER: "42" }, (...args) => {
        calls.push(args);
        return comments;
      });
      expect(calls).toEqual([
        [
          "gh",
          [
            "api",
            "repos/synthetic/repository/issues/42/comments",
            "--jq",
            '.[] | select(.user.login == "github-actions[bot]" and (.body | contains("<!-- chase-sets-pr-release-status -->"))) | .id',
          ],
          { encoding: "utf8" },
        ],
        [
          "gh",
          [
            "api",
            "--method",
            comments ? "PATCH" : "POST",
            comments
              ? "repos/synthetic/repository/issues/comments/22"
              : "repos/synthetic/repository/issues/42/comments",
            "-f",
            "body=synthetic body",
          ],
          { stdio: ["ignore", "ignore", "inherit"] },
        ],
      ]);
    },
  );

  it.each(roots)("rejects retargeting an existing non-issue POST under %s without adding a POST", (root) => {
    const source = 'await client.request(`/repos/${repo}/issues/${number}/comments`, { method: "POST", body });';
    const mutant = source.replace("/issues/${number}/comments", "/issues");
    expect(creationSites(source).filter((site) => site.kind === "rest")).toHaveLength(1);
    expect(creationSites(mutant).filter((site) => site.kind === "rest")).toHaveLength(1);
    expect(creationSites(source)).toHaveLength(1);
    expect(creationSites(mutant)).toHaveLength(2);
    const fixture = mkdtempSync(join(tmpdir(), "issue-creation-retarget-"));
    try {
      const path = join(fixture, root, "synthetic.mjs");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source);
      const before = sourceInventory(fixture);
      writeFileSync(path, mutant);
      expect(sourceInventory(fixture)).not.toEqual(before);
      const existingTarget = 'const issueUrl = "/issues"; await client.request(commentUrl, { method: "POST", body });';
      writeFileSync(path, existingTarget);
      const sameCount = sourceInventory(fixture);
      const contexts = contextInventory(fixture);
      writeFileSync(path, existingTarget.replace("request(commentUrl", "request(issueUrl"));
      expect(sourceInventory(fixture)).toEqual(sameCount);
      expect(contextInventory(fixture)).not.toEqual(contexts);
    } finally {
      if (!fixture.startsWith(join(tmpdir(), "issue-creation-retarget-")))
        throw new Error("Unexpected fixture cleanup root");
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("enumerates all shared-action callers and preserves their failure propagation", () => {
    const callers = [];
    let count = 0;
    for (const path of filesUnder(".github/workflows")) {
      const workflow = parse(read(path));
      for (const job of Object.values(workflow.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (step.uses !== "./.github/actions/report-scheduled-workflow-alert") continue;
          callers.push(path.split("/").at(-1));
          count += 1;
          expect(step["continue-on-error"], path).not.toBe(true);
          expect(job["continue-on-error"], path).not.toBe(true);
        }
      }
    }
    expect([...new Set(callers)].sort()).toEqual(sharedCallers);
    expect(count).toBe(39);
  });

  it("discovers creator callers by action, direct script, ops alias and create target, rejecting suppression at each node", () => {
    let count = 0;
    for (const path of filesUnder(".github/workflows")) {
      const workflow = parse(read(path));
      count += assertCreatorCallers(workflow, path);
      for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
        for (const [stepIndex, step] of (job.steps ?? []).entries()) {
          const isolated = { ...workflow, jobs: { [jobId]: { ...job, steps: [step] } } };
          if (!assertCreatorCallers(isolated, path)) continue;
          for (const boundary of ["job", "step"]) {
            const mutant = structuredClone(workflow);
            const target = boundary === "job" ? mutant.jobs[jobId] : mutant.jobs[jobId].steps[stepIndex];
            target["continue-on-error"] = true;
            expect(() => assertCreatorCallers(mutant, path), `${path} ${jobId} ${boundary}`).toThrow();
          }
        }
      }
    }
    expect(count).toBeGreaterThanOrEqual(47);
  });

  it.each(["step", "job-default", "workflow-default", "step-overrides-job", "job-overrides-workflow"])(
    "resolves relative creator scripts through the effective %s working directory",
    (scope) => {
      const workflow = { jobs: { reporter: { steps: [{ run: "node release-lock-monitor.mjs" }] } } };
      const job = workflow.jobs.reporter;
      const step = job.steps[0];
      if (scope === "workflow-default" || scope === "job-overrides-workflow")
        workflow.defaults = { run: { "working-directory": scope === "workflow-default" ? "scripts" : "wrong" } };
      if (["job-default", "step-overrides-job", "job-overrides-workflow"].includes(scope))
        job.defaults = { run: { "working-directory": scope === "step-overrides-job" ? "wrong" : "scripts" } };
      if (["step", "step-overrides-job"].includes(scope)) step["working-directory"] = "scripts";
      const before = hash(JSON.stringify(workflow));
      expect(assertCreatorCallers(workflow, "synthetic-relative.yml")).toBe(1);
      for (const boundary of ["job", "step", "shell"]) {
        const mutant = structuredClone(workflow);
        if (boundary === "shell") mutant.jobs.reporter.steps[0].run += " || true";
        else (boundary === "job" ? mutant.jobs.reporter : mutant.jobs.reporter.steps[0])["continue-on-error"] = true;
        expect(
          () => assertCreatorCallers(mutant, "synthetic-relative.yml"),
          `RELATIVE_${boundary}_SUPPRESSION`,
        ).toThrow();
      }
      expect(hash(JSON.stringify(workflow)), "restored relative fixture hash").toBe(before);
    },
  );

  it.each(["shared-action", "relative-script"])(
    "follows nested local composites to the %s boundary and rejects every suppressed forwarding node",
    (target) => {
      const wrapper = ".github/actions/synthetic-wrapper/action.yml";
      const nested = ".github/actions/synthetic-nested/action.yml";
      const leaf =
        target === "shared-action"
          ? { uses: "./.github/actions/report-scheduled-workflow-alert" }
          : { shell: "bash", "working-directory": "scripts", run: "node release-lock-monitor.mjs" };
      const sources = new Map([
        [wrapper, { runs: { using: "composite", steps: [{ uses: "./.github/actions/synthetic-nested" }] } }],
        [nested, { runs: { using: "composite", steps: [leaf] } }],
      ]);
      const reader = (path) => (sources.has(path) ? JSON.stringify(sources.get(path)) : read(path));
      const workflow = { jobs: { reporter: { steps: [{ uses: "./.github/actions/synthetic-wrapper" }] } } };
      const before = hash(JSON.stringify([...sources]));
      expect(assertCreatorCallers(workflow, "synthetic-wrapper.yml", reader)).toBe(1);
      for (const boundary of ["job", "caller", wrapper, nested]) {
        const mutant = structuredClone(workflow);
        let step;
        if (boundary === "job") step = mutant.jobs.reporter;
        else if (boundary === "caller") step = mutant.jobs.reporter.steps[0];
        else step = sources.get(boundary).runs.steps[0];
        step["continue-on-error"] = true;
        try {
          expect(
            () => assertCreatorCallers(mutant, "synthetic-wrapper.yml", reader),
            `COMPOSITE_SUPPRESSION ${boundary}`,
          ).toThrow();
        } finally {
          delete step["continue-on-error"];
        }
      }
      if (target === "relative-script") {
        leaf.run += " || true";
        try {
          expect(
            () => assertCreatorCallers(workflow, "synthetic-wrapper.yml", reader),
            "COMPOSITE_SHELL_SUPPRESSION",
          ).toThrow();
        } finally {
          leaf.run = "node release-lock-monitor.mjs";
        }
      }
      expect(hash(JSON.stringify([...sources])), "restored composite fixture hash").toBe(before);
      expect(assertCreatorCallers(workflow, "synthetic-wrapper.yml", reader)).toBe(1);
    },
  );

  it("fails closed on unresolved or ambiguous creator forwarding", () => {
    for (const step of [
      { uses: "./.github/actions/synthetic-missing" },
      { uses: "./.github/actions/${{ inputs.wrapper }}" },
      { run: "node release-lock-monitor.mjs", "working-directory": "${{ inputs.directory }}" },
      { run: "node scripts/other/release-lock-monitor.mjs" },
      { run: "cd scripts\nnode release-lock-monitor.mjs" },
      { run: "node $CREATOR/release-lock-monitor.mjs" },
    ]) {
      expect(() => assertCreatorCallers({ jobs: { reporter: { steps: [step] } } }, "synthetic-unresolved.yml")).toThrow(
        "Unresolved or ambiguous creator forwarding",
      );
    }
    const workflow = { jobs: { reporter: { steps: [{ uses: "./.github/actions/synthetic-cycle" }] } } };
    const cycle = JSON.stringify({
      runs: { using: "composite", steps: [{ uses: "./.github/actions/synthetic-cycle" }] },
    });
    expect(() =>
      assertCreatorCallers(workflow, "synthetic-cycle.yml", (path) =>
        path.endsWith("action.yml") ? cycle : undefined,
      ),
    ).toThrow("composite cycle");
    const ambiguous = JSON.stringify({
      runs: { using: "composite", steps: [{ run: "node scripts/release-lock-monitor.mjs" }] },
    });
    expect(() => assertCreatorCallers(workflow, "synthetic-ambiguous.yml", () => ambiguous)).toThrow(
      "Unresolved or ambiguous creator forwarding",
    );
  });
  it("sets Bug at the shared action create boundary and rejects missing, disabled and wrong native types", async () => {
    const script = parse(read(actionPath)).runs.steps[0].with.script;
    for (const type of [
      { name: "Bug", is_enabled: true },
      undefined,
      null,
      { name: "Slice" },
      { name: "Bug", is_enabled: false },
      { name: "Bug" },
    ]) {
      const failures = [];
      const creates = [];
      const successes = [];
      const github = {
        rest: {
          search: { issuesAndPullRequests: async () => ({ data: { items: [] } }) },
          issues: {
            create: async (request) => {
              creates.push(request);
              return { data: { number: 123, type } };
            },
          },
        },
      };
      await new AsyncFunction("github", "context", "core", "process", script)(
        github,
        {
          repo: { owner: "synthetic", repo: "synthetic" },
          serverUrl: "https://synthetic.invalid",
          runId: 123,
          eventName: "schedule",
          ref: "refs/heads/main",
        },
        { info: (message) => successes.push(message), setFailed: (message) => failures.push(message) },
        {
          env: {
            ALERT_WORKFLOW_NAME: "synthetic",
            ALERT_STATUS: "failure",
            ALERT_DRY_RUN: "false",
            ALERT_RUN_ATTEMPT: "1",
            ALERT_LABELS: "kind:ops",
          },
        },
      );
      expect(creates).toHaveLength(1);
      expect(creates[0].type).toBe("Bug");
      expect(failures.length).toBe(type?.name === "Bug" && type.is_enabled === true ? 0 : 1);
      if (failures.length) expect(successes.some((message) => message.startsWith("Created"))).toBe(false);
    }
  });

  it.each(documents)("pins typed headless registration and rejects documentation mutants: %s", (path) => {
    const source = read(path);
    const before = hash(source);
    expect(docErrors(source)).toEqual([]);
    expect(docErrors(source.replace("-f type=", "-f omitted="))).toContain("typed-command");
    expect(docErrors(`${source}\ngh issue create --repo chase-sets/chase-sets`)).toContain("bare-create");
    expect(hash(read(path)), "documentation mutants never modify the checkout").toBe(before);
  });

  it.each([
    ["cli", "gh issue create --title synthetic"],
    ["rest", "gh api --method POST repos/synthetic/synthetic/issues -f title=synthetic"],
    ["octokit", "await github.rest.issues.create({ title: 'synthetic' });"],
    ["rest", 'await fetch(url, { method: "POST", body: JSON.stringify({ title: "synthetic" }) });'],
    ["graphql", 'await graphql("mutation { createIssue(input: $input) { issue { id } } }");'],
  ])("discovers a newly added untyped %s creator in every source root", (kind, source) => {
    const fixture = mkdtempSync(join(tmpdir(), "issue-creation-new-site-"));
    try {
      for (const root of roots) {
        const path = `${root}/synthetic-new-creator.${root === "scripts" ? "mjs" : "yml"}`;
        const target = join(fixture, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, source);
        expect(creationSites(source).some((site) => site.kind === kind)).toBe(true);
        const inventory = sourceInventory(fixture);
        expect(inventory[path]).toBeGreaterThan(0);
        expect({ ...reviewedSites, ...inventory }, "new creator cannot match the reviewed source census").not.toEqual(
          reviewedSites,
        );
      }
    } finally {
      if (!fixture.startsWith(join(tmpdir(), "issue-creation-new-site-")))
        throw new Error("Unexpected fixture cleanup root");
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
