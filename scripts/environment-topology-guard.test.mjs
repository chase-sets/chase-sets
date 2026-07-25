import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadEnvironmentTopology,
  reconcileEnvironmentDnsTerraform,
  scanEnvironmentTopology,
  validateEnvironmentTopologyManifest,
} from "./environment-topology-guard.mjs";

const repositoryRoot = resolve(".");
const guardEntrypoint = resolve("scripts/environment-topology-guard.mjs");
const manifestPath = resolve("scripts/environment-topology-manifest.json");
const schemaPath = resolve("scripts/environment-topology-manifest.schema.json");
const docsPath = resolve("docs/architecture/environment-domain-names.md");
const fixtureRoots = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("environment topology guard (#6088)", () => {
  it("parses a closed-schema manifest and keeps the documented application host set exact", () => {
    const manifest = loadEnvironmentTopology(repositoryRoot);
    expect(validateEnvironmentTopologyManifest(manifest)).toEqual([]);
    expect(readFileSync(schemaPath, "utf8")).toContain('"additionalProperties": false');

    const expectedTable = applicationHostTable(manifest);
    const document = readFileSync(docsPath, "utf8");
    const documentedTable = document.match(
      /<!-- environment-topology-hosts:start -->\r?\n([\s\S]*?)\r?\n<!-- environment-topology-hosts:end -->/,
    )?.[1];
    expect(documentedTable).toBe(expectedTable);

    expect(validateEnvironmentTopologyManifest({ ...manifest, unexpected: true })).toContain(
      "manifest has unknown property 'unexpected'.",
    );
  });

  it("derives full workflow/action/script discovery and reports scanned/total without silent narrowing", () => {
    const result = scanEnvironmentTopology();

    expect(result.discovery.scannedFiles).toBe(result.discovery.totalFiles);
    expect(result.discovery.primaryFiles).toBe(result.discovery.totalFiles);
    expect(result.discovery.primaryFiles).toBeGreaterThan(400);
    expect(result.discovery.recognizedShapes).toEqual(
      expect.arrayContaining(["run-block", "input-default", "environment-value", "script-assertion"]),
    );
  });

  it("detects a DNS assertion against the parent zone for a record owned by a delegated child zone", () => {
    const root = createFixture({
      ".github/workflows/staging-reset.yml": workflowWithRun(`
custom_domain="assets.staging.chasesets.com"
record_name="\${custom_domain%.chasesets.com}"
doctl compute domain records list chasesets.com --output json | jq -e \\
  --arg record_name "$record_name" '.[] | select(.name == $record_name)'
`),
    });

    const result = runGuard(root);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[topology-zone-shape-contradiction]");
    expect(result.stderr).toContain("owned by delegated child zone 'staging.chasesets.com'");
  });

  it.each([
    {
      bite: "#5566 ingress-wait legacy host",
      file: ".github/workflows/ingress.yml",
      planted: workflowWithRun("node ./scripts/platform-ingress-wait.mjs --url https://landing-staging.chasesets.com/"),
      repaired: workflowWithRun("node ./scripts/platform-ingress-wait.mjs --url https://www.staging.chasesets.com/"),
      code: "topology-assertion-undeclared",
      message: "landing-staging.chasesets.com",
    },
    {
      bite: "#5569/#5570 staging apex ALIAS",
      file: ".github/workflows/staging-reset.yml",
      planted: workflowWithRun(
        'zone="staging.chasesets.com"; record_name="@"; record_type="ALIAS"; echo "$record_type $record_name $zone"',
      ),
      repaired: workflowWithRun(
        'zone="staging.chasesets.com"; record_name="@"; record_type="A"; echo "$record_type $record_name $zone"',
      ),
      code: "topology-zone-shape-contradiction",
      message: "real apex 'staging.chasesets.com'",
    },
    {
      bite: "#5572 DOKS shadow host",
      file: ".github/workflows/doks-readiness.yml",
      planted: workflowWithRun("curl --fail https://marketplace.doks.staging.chasesets.com/health/ready"),
      repaired: workflowWithRun("curl --fail https://marketplace.staging.chasesets.com/health/ready"),
      code: "topology-assertion-undeclared",
      message: "diagnostic-only",
    },
    {
      bite: "#5668 post-flip stale DNS phase",
      file: ".github/workflows/post-flip.yml",
      planted: workflowWithRun(`
custom_domain="assets.staging.chasesets.com"
record_name="\${custom_domain%.chasesets.com}"
doctl compute domain records list chasesets.com --output json | jq -e \\
  --arg record_name "$record_name" '.[] | select(.name == $record_name)'
`),
      repaired: workflowWithRun(`
custom_domain="assets.staging.chasesets.com"
record_name="\${custom_domain%.staging.chasesets.com}"
doctl compute domain records list staging.chasesets.com --output json | jq -e \\
  --arg record_name "$record_name" '.[] | select(.name == $record_name)'
`),
      code: "topology-zone-shape-contradiction",
      message: "queries parent zone",
    },
    {
      bite: "#5656→#5659 removed host smoke",
      file: "scripts/arbitrary-smoke.mjs",
      planted: 'await fetch("https://admin.staging.chasesets.com/health/ready");\n',
      repaired: 'await fetch("https://admin.staging.chasesets.com/health/ready");\n',
      removeManifestHost: "admin.staging.chasesets.com",
      code: "topology-assertion-undeclared",
      message: "admin.staging.chasesets.com",
    },
  ])(
    "negative control FAILS then passes through real discovery: $bite",
    ({ bite, file, planted, repaired, removeManifestHost, code, message }) => {
      const root = createFixture({ [file]: planted }, { removeManifestHost });

      const before = runGuard(root);
      expect(before.exitCode).toBe(1);
      expect(before.stderr).toContain(`[${code}]`);
      expect(before.stderr).toContain(message);

      write(root, file, repaired);
      if (removeManifestHost) copyFileSync(manifestPath, join(root, "scripts/environment-topology-manifest.json"));
      const after = runGuard(root);
      expect(after.exitCode).toBe(0);
      expect(after.stdout).toContain("scanned");
      if (process.env.TOPOLOGY_CONTROL_EVIDENCE === "1") {
        console.log(
          `[${bite}] failing-before exit=${before.exitCode}\n${before.stderr.trim()}\n` +
            `[${bite}] passing-after exit=${after.exitCode}`,
        );
      }
    },
  );

  it.each([
    ["literal inline URL", workflowWithRun("curl https://retired.staging.chasesets.com/health/ready")],
    ["shell variable assembly", workflowWithRun('d="retired.staging.chasesets.com"; curl "https://$d/health/ready"')],
    [
      "parameter expansion / suffix strip",
      workflowWithRun(
        'custom_domain="retired.staging.chasesets.com"; record_name="${custom_domain%.chasesets.com}"; curl "https://${custom_domain}"',
      ),
    ],
    [
      "bash array accumulation",
      workflowWithRun(
        "live_urls=(--url https://staging.chasesets.com/); live_urls+=(--url https://retired.staging.chasesets.com/)",
      ),
    ],
    [
      "interpolated vars fallback",
      `name: evasion
on:
  workflow_dispatch:
    inputs:
      host:
        default: \${{ vars.STAGING_HOST || 'retired.staging.chasesets.com' }}
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - run: curl "\${{ inputs.host }}"
`,
    ],
    [
      "case environment dispatch",
      workflowWithRun(
        'case "$environment" in staging) webhook_url="https://retired.staging.chasesets.com/hook" ;; esac; curl "$webhook_url"',
      ),
    ],
    [
      "actions/github-script string comparison",
      workflowWithStep(`uses: actions/github-script@0000000000000000000000000000000000000000
        with:
          script: |
            if (after.domain !== "retired.staging.chasesets.com") throw new Error("stale");`),
    ],
    [
      "composite/reusable input default",
      `name: composite
inputs:
  target:
    default: https://retired.staging.chasesets.com
runs:
  using: composite
  steps:
    - shell: bash
      run: curl "\${{ inputs.target }}"
`,
      ".github/actions/unfamiliar/action.yml",
    ],
    [
      "TF_VAR env host literal",
      `name: terraform
jobs:
  probe:
    runs-on: ubuntu-latest
    env:
      TF_VAR_public_host: https://retired.staging.chasesets.com
    steps:
      - run: terraform plan
`,
    ],
    [
      "concatenation across YAML block lines",
      workflowWithRun(`curl "https://retired.staging." + \\
  "chasesets.com/health/ready"`),
    ],
  ])(
    "normalizes evasion shape '$0' to the same semantic category",
    (_shape, source, file = ".github/workflows/evasion.yml") => {
      const root = createFixture({ [file]: source });

      const result = runGuard(root);

      expect(result.exitCode).toBe(1);
      expect(violationCodes(result.stderr)).toEqual(["topology-assertion-undeclared"]);
      expect(result.stderr).toContain("retired.staging.chasesets.com");
    },
  );

  it("finds a workflow-shaped assertion at an arbitrary path without a path exemption list", () => {
    const root = createFixture({
      "unfamiliar/nested/pipeline.yaml": workflowWithRun("curl https://retired.staging.chasesets.com/health/ready"),
    });

    const result = scanEnvironmentTopology({ root });

    expect(result.discovery.semanticFiles).toBe(1);
    expect(result.discovery.scannedFiles).toBe(result.discovery.totalFiles);
    expect(result.violations.map(({ code }) => code)).toContain("topology-assertion-undeclared");
    const guardSource = readFileSync(guardEntrypoint, "utf8");
    expect(guardSource).not.toMatch(/(?:exemption|allowlist)(?:Files|Paths|List)\s*=/i);
  });

  it("fails closed when a workflow cannot be parsed", () => {
    const root = createFixture({ ".github/workflows/broken.yml": "name: [unterminated" });

    const result = runGuard(root);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[topology-workflow-parse-failed]");
  });

  it("fails closed when the manifest is absent", () => {
    const root = createFixture();
    rmSync(join(root, "scripts/environment-topology-manifest.json"));

    const result = runGuard(root);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[topology-manifest-absent]");
  });

  it("fails closed when a topology assertion cannot be resolved", () => {
    const root = createFixture({
      ".github/workflows/unresolvable.yml": workflowWithRun(
        'doctl compute domain records list "$unknown_zone" --output json',
      ),
    });

    const result = runGuard(root);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[topology-assertion-unresolvable]");
  });

  it("reconciles the manifest against Terraform zone derivation and delegated catalog record ownership", () => {
    const manifest = loadEnvironmentTopology(repositoryRoot);
    expect(reconcileEnvironmentDnsTerraform(repositoryRoot, manifest)).toEqual([]);

    const root = createFixture();
    write(
      root,
      "infrastructure/digitalocean/environment-dns/main.tf",
      'resource "digitalocean_record" "catalog_assets" { domain = var.root_domain name = "assets" }\n',
    );
    expect(reconcileEnvironmentDnsTerraform(root, loadEnvironmentTopology(root))).toEqual([
      expect.objectContaining({ code: "topology-terraform-diverged" }),
    ]);
  });
});

function applicationHostTable(manifest) {
  const lines = ["| Environment | Application hosts |", "| --- | --- |"];
  for (const [environment, declaration] of Object.entries(manifest.environments)) {
    lines.push(`| ${environment} | ${declaration.applicationHosts.map((host) => `\`${host}\``).join(", ")} |`);
  }
  return lines.join("\n");
}

function workflowWithRun(run) {
  return `name: topology control
on: workflow_dispatch
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - name: Assert topology
        run: |
${run
  .trim()
  .split("\n")
  .map((line) => `          ${line}`)
  .join("\n")}
`;
}

function workflowWithStep(step) {
  return `name: topology control
on: workflow_dispatch
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - ${step}
`;
}

function createFixture(files = {}, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "environment-topology-guard-"));
  fixtureRoots.push(root);
  copy(root, schemaPath, "scripts/environment-topology-manifest.schema.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (options.removeManifestHost) {
    for (const environment of Object.values(manifest.environments)) {
      environment.applicationHosts = environment.applicationHosts.filter((host) => host !== options.removeManifestHost);
    }
  }
  write(root, "scripts/environment-topology-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  write(
    root,
    "infrastructure/digitalocean/environment-dns/locals.tf",
    `locals {
  environment_zone = local.is_production ? var.root_domain : "\${var.environment}.\${var.root_domain}"
  doks_diagnostic_records = {
    apex = { name = "doks" fqdn = "doks.\${local.environment_zone}" }
    www = { name = "www.doks" fqdn = "www.doks.\${local.environment_zone}" }
    admin = { name = "admin.doks" fqdn = "admin.doks.\${local.environment_zone}" }
    marketplace = { name = "marketplace.doks" fqdn = "marketplace.doks.\${local.environment_zone}" }
  }
}
`,
  );
  write(
    root,
    "infrastructure/digitalocean/environment-dns/main.tf",
    `resource "digitalocean_record" "catalog_assets" {
  domain = digitalocean_domain.environment[0].name
  name = "assets"
}
`,
  );
  for (const [file, source] of Object.entries(files)) write(root, file, source);
  return root;
}

function runGuard(root) {
  const result = spawnSync(process.execPath, [guardEntrypoint, "--repository-root", root], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function violationCodes(stderr) {
  return [...new Set([...stderr.matchAll(/\[(topology-[a-z-]+)\]/g)].map((match) => match[1]))];
}

function copy(root, source, relativePath) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function write(root, relativePath, source) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source, "utf8");
}
