import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { authorityAnchors, deriveEnvironmentHosts, renderEnvironmentHosts } from "./environment-topology-guard.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const registryRelativePath = "scripts/environment-hosts.json";
const guardRelativePath = "scripts/environment-topology-guard.mjs";
const temporaryRoots = new Set();

function readRegistry(root = repositoryRoot) {
  return JSON.parse(readFileSync(resolve(root, registryRelativePath), "utf8"));
}

function writeRelative(root, path, content) {
  const absolutePath = resolve(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function addTrackedFile(root, path, content) {
  writeRelative(root, path, content);
  git(root, "add", "--", path);
}

function replaceInFile(root, path, search, replacement) {
  const absolutePath = resolve(root, path);
  const source = readFileSync(absolutePath, "utf8");
  expect(source).toContain(search);
  writeFileSync(absolutePath, source.replace(search, replacement));
}

function fixturePaths() {
  const registry = readRegistry();
  return [
    registryRelativePath,
    "scripts/environment-hosts.schema.json",
    "docs/architecture/environment-domain-names.md",
    ...authorityAnchors.map((anchor) => anchor.file),
    ...registry.sanctionedReferences.map((sanction) => sanction.path),
  ];
}

function makeFixture({ initializeGit = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "environment-topology-"));
  temporaryRoots.add(root);
  for (const path of new Set(fixturePaths())) {
    const destination = resolve(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(resolve(repositoryRoot, path), destination);
  }
  if (initializeGit) {
    git(root, "init", "--quiet");
    git(root, "add", "--", ".");
  }
  return root;
}

function makeAuthorityFixture() {
  const root = mkdtempSync(join(tmpdir(), "environment-topology-authority-"));
  temporaryRoots.add(root);
  for (const path of new Set(authorityAnchors.map((anchor) => anchor.file))) {
    const destination = resolve(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(resolve(repositoryRoot, path), destination);
  }
  return root;
}

function copyTrackedRepositoryFile(root, path) {
  const destination = resolve(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(resolve(repositoryRoot, path), destination);
  git(root, "add", "--", path);
}

function runCli(root) {
  const result = spawnSync(process.execPath, [guardRelativePath, "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    status: result.status,
    stderr: result.stderr,
    report: result.stdout ? JSON.parse(result.stdout) : null,
  };
}

function writeRegistry(root, mutate, { renderDocumentation = false } = {}) {
  const registry = readRegistry(root);
  mutate(registry);
  writeFileSync(resolve(root, registryRelativePath), `${JSON.stringify(registry, null, 2)}\n`);
  if (renderDocumentation) {
    const documentationPath = resolve(root, "docs/architecture/environment-domain-names.md");
    const documentation = readFileSync(documentationPath, "utf8");
    const rendered = renderEnvironmentHosts(registry);
    writeFileSync(
      documentationPath,
      documentation.replace(/<!-- environment-hosts:start -->[\s\S]*?<!-- environment-hosts:end -->/, rendered),
    );
  }
}

function expectCode(result, code, path) {
  expect(result.status).toBe(1);
  expect(result.report.passed).toBe(false);
  expect(result.report.violations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code,
        ...(path ? { path } : {}),
      }),
    ]),
  );
}

function retiredHost(registry = readRegistry()) {
  return registry.hosts.find((entry) => entry.status === "retired").host;
}

function diagnosticHost(registry = readRegistry()) {
  return registry.hosts.find(
    (entry) => entry.status === "current" && entry.class === "diagnostic" && entry.host.split(".").length > 4,
  ).host;
}

function removeStagingWwwFromAuthority(root) {
  replaceInFile(root, "infrastructure/digitalocean/platform/locals.tf", '    "www",\n', "");
}

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

describe("environment topology authority derivation", () => {
  it("every derived host cites an authority anchor", () => {
    const result = deriveEnvironmentHosts(repositoryRoot);

    expect(result.violations).toEqual([]);
    expect(result.artifact.hosts.length).toBeGreaterThan(0);
    for (const host of result.artifact.hosts) {
      expect(host.sources.length).toBeGreaterThan(0);
      expect(host.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            anchorId: expect.stringMatching(/^A(?:[1-9]|1[0-2])$/),
            sourceText: expect.any(String),
          }),
        ]),
      );
      expect(host.sources.every((source) => source.sourceText.length > 0)).toBe(true);
    }
  });

  it.each(authorityAnchors.flatMap((anchor) => ["unreadable", "diverged"].map((mode) => [anchor.id, mode, anchor])))(
    "%s fails closed when %s",
    (_anchorId, mode, anchor) => {
      const root = makeAuthorityFixture();
      if (mode === "unreadable") {
        rmSync(resolve(root, anchor.file));
      } else {
        const target = anchor.perturbationText ?? anchor.fragments[0];
        replaceInFile(root, anchor.file, target, target.replace("=", " ="));
      }

      const result = deriveEnvironmentHosts(root);

      expect(result.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: mode === "unreadable" ? "topology-authority-unreadable" : "topology-authority-diverged",
            path: anchor.file,
          }),
        ]),
      );
      expect(result.violations).toEqual(expect.arrayContaining([expect.objectContaining({ anchorId: anchor.id })]));
    },
  );
});

describe("environment host registry reconciliation", () => {
  it("fails when a derived host is missing from the registry", () => {
    const root = makeFixture();
    writeRegistry(root, (registry) => {
      const index = registry.hosts.findIndex((entry) => entry.status === "current");
      registry.hosts.splice(index, 1);
    });

    expectCode(runCli(root), "topology-inventory-diverged", registryRelativePath);
  });

  it("fails when a registry current host is not derived", () => {
    const root = makeFixture();
    writeRegistry(root, (registry) => {
      registry.hosts.push({
        host: ["not-derived", registry.rootDomain].join("."),
        status: "current",
        environment: "production",
        class: "application",
        templated: false,
        authorityAnchor: "A3",
      });
    });

    expectCode(runCli(root), "topology-inventory-diverged", registryRelativePath);
  });

  it("fails when current-host metadata disagrees with its derivation", () => {
    const root = makeFixture();
    writeRegistry(root, (registry) => {
      registry.hosts.find((entry) => entry.status === "current" && entry.class === "diagnostic").class = "application";
    });

    expectCode(runCli(root), "topology-inventory-diverged", registryRelativePath);
  });

  it("rejects a nested unknown key", () => {
    const root = makeFixture();
    writeRegistry(root, (registry) => {
      registry.hosts[0].unexpected = true;
    });

    expectCode(runCli(root), "topology-registry-invalid", registryRelativePath);
  });

  it("rejects an unknown sanctioned-reference key", () => {
    const root = makeFixture();
    writeRegistry(root, (registry) => {
      registry.sanctionedReferences[0].unexpected = true;
    });

    expectCode(runCli(root), "topology-registry-invalid", registryRelativePath);
  });

  it("rejects a date-only retiredOn", () => {
    const root = makeFixture();
    writeRegistry(root, (registry) => {
      registry.hosts.find((entry) => entry.status === "retired").retiredOn = "2026-07-19";
    });

    expectCode(runCli(root), "topology-registry-invalid", registryRelativePath);
  });

  it("rejects duplicate hosts across statuses", () => {
    const root = makeFixture();
    writeRegistry(root, (registry) => {
      const current = registry.hosts.find((entry) => entry.status === "current");
      registry.hosts.push({
        host: current.host,
        status: "reserved",
        environment: current.environment,
        class: current.class,
        templated: current.templated,
        reservedFor: "Duplicate-status negative control for issue 6103.",
      });
    });

    expectCode(runCli(root), "topology-inventory-diverged", registryRelativePath);
  });

  it("fails when the rendered documentation block diverges", () => {
    const root = makeFixture();
    replaceInFile(root, "docs/architecture/environment-domain-names.md", "| Host | Status |", "| Name | State |");

    expectCode(runCli(root), "topology-doc-diverged", "docs/architecture/environment-domain-names.md");
  });
});

describe("Git-index byte corpus", () => {
  it("enumerates the corpus from git ls-files, not a filesystem walk", () => {
    const root = makeFixture();
    const host = retiredHost(readRegistry(root));
    writeRelative(root, "untracked/probe.bin", Buffer.from(`probe=${host}`));

    const untracked = runCli(root);
    expect(untracked.status).toBe(0);
    expect(untracked.report.corpus.sweptFiles).toBe(untracked.report.corpus.trackedFiles);

    git(root, "add", "--", "untracked/probe.bin");
    expectCode(runCli(root), "retired-host-referenced", "untracked/probe.bin");
  });

  it.each([
    ["arbitrary tracked path", "evidence/probe.data", (host) => `endpoint=${host}`],
    [
      "reusable workflow_call with no steps",
      "elsewhere/reusable.yml",
      (host) =>
        `on:\n  workflow_call:\njobs:\n  delegated:\n    uses: owner/repo/.github/workflows/x.yml@main\n    with:\n      endpoint: ${host}\n`,
    ],
    ["non-mjs sibling", "misc/probe.txt", (host) => `curl https://${host}/ready`],
    ["Markdown sibling", "notes/probe.md", (host) => `Retired endpoint: https://${host}/ready`],
    ["JSON sibling", "configuration/probe.json", (host) => JSON.stringify({ endpoint: `https://${host}` })],
    ["YAML block scalar sibling", "configuration/probe.yaml", (host) => `endpoint: |\n  https://${host}/ready\n`],
  ])("flags %s through real discovery", (_name, path, content) => {
    const root = makeFixture();
    addTrackedFile(root, path, content(retiredHost(readRegistry(root))));

    expectCode(runCli(root), "retired-host-referenced", path);
  });

  it("sweeps non-UTF-8 bytes instead of skipping the file", () => {
    const root = makeFixture();
    const host = Buffer.from(retiredHost(readRegistry(root)), "ascii");
    addTrackedFile(root, "binary/probe.bin", Buffer.concat([Buffer.from([0xff, 0x00]), host, Buffer.from([0xfe])]));

    expectCode(runCli(root), "retired-host-referenced", "binary/probe.bin");
  });

  it("accepts the declared below-boundary fragmented-literal limit", () => {
    const root = makeFixture();
    const [label, ...domain] = retiredHost(readRegistry(root)).split(".");
    const midpoint = Math.floor(label.length / 2);
    addTrackedFile(
      root,
      "limits/fragmented.txt",
      `a="${label.slice(0, midpoint)}"; b="${label.slice(midpoint)}"; c="${domain.join(".")}"`,
    );

    expect(runCli(root).status).toBe(0);
  });

  it("allows the legitimate parent-zone preview query shape", () => {
    const root = makeFixture();
    const registry = readRegistry(root);
    const preview = registry.hosts.find((entry) => entry.environment === "preview" && entry.host.startsWith("*"));
    addTrackedFile(
      root,
      "operations/preview-query.sh",
      `doctl compute domain records list ${registry.rootDomain} --output json\nrecord=${preview.host.split(".")[0]}.preview\n`,
    );

    expect(runCli(root).status).toBe(0);
  });
});

describe("recorded-bite negative controls", () => {
  it("flags the ingress-wait legacy host at a real call site", () => {
    const root = makeFixture();
    const path = ".github/workflows/platform-pr.yml";
    copyTrackedRepositoryFile(root, path);
    const source = readFileSync(resolve(root, path), "utf8");
    writeFileSync(resolve(root, path), `${source}\n# --url https://${retiredHost(readRegistry(root))}/\n`);

    expectCode(runCli(root), "retired-host-referenced", path);
  });

  it("flags a staging-reset redirect after that host is recorded retired", () => {
    const root = makeFixture();
    const registry = readRegistry(root);
    const host = ["www-staging", registry.rootDomain].join(".");
    writeRegistry(root, (draft) => {
      draft.hosts.push({
        host,
        status: "retired",
        environment: "staging",
        class: "application",
        templated: false,
        retiredIn: "https://github.com/chase-sets/chase-sets/issues/6103",
        retiredOn: "2026-07-25T12:00:00-05:00",
      });
    });
    const path = ".github/workflows/platform-staging-reset.yml";
    copyTrackedRepositoryFile(root, path);
    const source = readFileSync(resolve(root, path), "utf8");
    writeFileSync(resolve(root, path), `${source}\n# redirect=https://${host}\n`);

    expectCode(runCli(root), "retired-host-referenced", path);
  });

  it("flags a DOKS diagnostic shadow host in an unsanctioned file", () => {
    const root = makeFixture();
    const path = "operations/readiness.txt";
    addTrackedFile(root, path, `https://${diagnosticHost(readRegistry(root))}/health/ready`);

    expectCode(runCli(root), "diagnostic-host-referenced", path);
  });

  it("flags a same-diff retirement at the default violation arm", () => {
    const root = makeFixture();
    const registry = readRegistry(root);
    const host = ["www", "staging", registry.rootDomain].join(".");
    const workflowPath = ".github/workflows/platform-pr.yml";
    copyTrackedRepositoryFile(root, workflowPath);
    const workflow = readFileSync(resolve(root, workflowPath), "utf8");
    writeFileSync(resolve(root, workflowPath), `${workflow}\n# current-gate=https://${host}/health/ready\n`);
    expect(runCli(root).status).toBe(0);

    removeStagingWwwFromAuthority(root);
    writeRegistry(root, (draft) => {
      const entry = draft.hosts.find((candidate) => candidate.host === host);
      entry.status = "retired";
      delete entry.authorityAnchor;
      entry.retiredIn = "https://github.com/chase-sets/chase-sets/issues/6103";
      entry.retiredOn = "2026-07-25T12:00:00-05:00";
    });

    const result = runCli(root);

    expectCode(result, "retired-host-referenced", workflowPath);
    expect(result.report.violations.find((violation) => violation.path === workflowPath).message).toContain(
      "without an exact sanction",
    );
  });

  it("fails inventory reconciliation when Terraform removes a host without a registry edit", () => {
    const root = makeFixture();
    removeStagingWwwFromAuthority(root);

    expectCode(runCli(root), "topology-inventory-diverged", registryRelativePath);
  });
});

describe("fail-closed controls", () => {
  it("fails for a missing registry", () => {
    const root = makeFixture();
    rmSync(resolve(root, registryRelativePath));
    expectCode(runCli(root), "topology-registry-invalid");
  });

  it("fails for an unparseable registry", () => {
    const root = makeFixture();
    writeFileSync(resolve(root, registryRelativePath), "{");
    expectCode(runCli(root), "topology-registry-invalid");
  });

  it("fails for a schema-invalid registry", () => {
    const root = makeFixture();
    writeRegistry(root, (registry) => {
      registry.schemaVersion = 2;
    });
    expectCode(runCli(root), "topology-registry-invalid");
  });

  it("fails when a corpus file is unreadable", () => {
    const root = makeFixture();
    addTrackedFile(root, "unreadable/probe", "initial");
    rmSync(resolve(root, "unreadable/probe"));
    mkdirSync(resolve(root, "unreadable/probe"));

    expectCode(runCli(root), "topology-corpus-unreadable", "unreadable/probe");
  });

  it("fails outside a Git worktree", () => {
    const root = makeFixture({ initializeGit: false });
    expectCode(runCli(root), "topology-corpus-discovery-failed", ".");
  });

  it("fails when git ls-files returns zero tracked paths", () => {
    const root = makeFixture();
    git(root, "rm", "--cached", "-r", "--", ".");
    expectCode(runCli(root), "topology-corpus-empty", ".");
  });

  it.each(["path gone", "token gone", "count increased"])("fails for a stale sanction when %s", (mode) => {
    const root = makeFixture();
    const registry = readRegistry(root);
    const sanction = registry.sanctionedReferences.find((entry) => entry.path.includes("stripe-webhook-endpoint.mjs"));
    const absolutePath = resolve(root, sanction.path);
    if (mode === "path gone") {
      rmSync(absolutePath);
    } else if (mode === "token gone") {
      replaceInFile(root, sanction.path, sanction.token, "removed.example.invalid");
    } else {
      const source = readFileSync(absolutePath, "utf8");
      writeFileSync(absolutePath, `${source}\n// ${sanction.token}\n`);
    }

    expectCode(runCli(root), "topology-sanction-stale", sanction.path);
  });
});
