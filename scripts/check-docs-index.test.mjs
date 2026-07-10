import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkContextDocReferences, checkDocsIndex } from "./check-docs-index.mjs";

const temporaryRoots = [];

function createTempRepo() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "chase-sets-docs-index-"));
  temporaryRoots.push(rootDir);
  write(rootDir, "README.md", "- [Docs](docs/README.md)\n");
  write(rootDir, "docs/README.md", "# Docs\n");
  return rootDir;
}

function write(rootDir, relativePath, content) {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

afterEach(() => {
  for (const rootDir of temporaryRoots.splice(0)) {
    rmSync(rootDir, { force: true, recursive: true });
  }
});

describe("checkDocsIndex", () => {
  it("reports Markdown files under docs that are unreachable from the docs indexes", async () => {
    const rootDir = createTempRepo();
    write(rootDir, "docs/architecture/orphan.md", "# Orphan\n");

    await expect(checkDocsIndex({ repoRoot: rootDir })).resolves.toEqual({
      orphanDocs: ["docs/architecture/orphan.md"],
      proseAccuracyIssues: [],
    });
  });

  it("treats docs linked through indexed docs as reachable", async () => {
    const rootDir = createTempRepo();
    write(rootDir, "docs/README.md", "- [Architecture](./architecture/root.md)\n");
    write(rootDir, "docs/architecture/root.md", "- [Leaf](./leaf.md)\n");
    write(rootDir, "docs/architecture/leaf.md", "# Leaf\n");

    await expect(checkDocsIndex({ repoRoot: rootDir })).resolves.toEqual({ orphanDocs: [], proseAccuracyIssues: [] });
  });

  it("pins push-wake glossary coverage and DNS incident prose ownership", async () => {
    const rootDir = createTempRepo();
    write(
      rootDir,
      "docs/README.md",
      [
        "- [Glossary](./GLOSSARY.md)",
        "- [Environment Domain Names](./architecture/environment-domain-names.md)",
        "- [DigitalOcean Platform Deployment](./runbooks/digitalocean-platform-deployment.md)",
        "",
      ].join("\n"),
    );
    write(
      rootDir,
      "docs/GLOSSARY.md",
      [
        "| Term | Owning source | Notes |",
        "| --- | --- | --- |",
        "| Wake Intent | [Projection Wake-Intent Scheduler](./architecture/projection-wake-scheduler.md) | Durable wake request. |",
        "| Projection Wake Relay | [Projection Wake Relay](./architecture/projection-wake-relay.md) | Relay. |",
        "| Projection Interest Index | [Projection Interest Index](./architecture/projection-interest-index.md) | Mapping. |",
        "| Source-Context Wake Registry | [Source-Context Wake Registry](./architecture/source-context-wake-registry.md) | Rollout source. |",
        "| Platform Work-Signal Composite | [Platform Work-Signal Composite](./architecture/work-signal-composite.md) | Shared wake primitive. |",
        "",
      ].join("\n"),
    );
    write(
      rootDir,
      "docs/architecture/environment-domain-names.md",
      "# Environment Domain Names\n\nPre-launch conditional: production proof mode may attach a marketplace host.\n",
    );
    write(
      rootDir,
      "docs/runbooks/digitalocean-platform-deployment.md",
      "# DigitalOcean Platform Deployment Runbook\n\n### Staging DNS Operations\n\nMay 17, 2026 and May 26, 2026 incident history lives here.\n",
    );

    await expect(checkDocsIndex({ repoRoot: rootDir })).resolves.toEqual({ orphanDocs: [], proseAccuracyIssues: [] });
  });
});

describe("checkContextDocReferences", () => {
  it("reports bounded-context docs with zero inbound references", async () => {
    const rootDir = createTempRepo();
    write(rootDir, "bounded-contexts/widgets/docs/orphan-policy.md", "# Orphan Policy\n");

    await expect(checkContextDocReferences({ repoRoot: rootDir })).resolves.toEqual({
      orphanContextDocs: ["bounded-contexts/widgets/docs/orphan-policy.md"],
    });
  });

  it("treats a context README link as a reference", async () => {
    const rootDir = createTempRepo();
    write(rootDir, "bounded-contexts/widgets/docs/widget-policy.md", "# Widget Policy\n");
    write(
      rootDir,
      "bounded-contexts/widgets/README.md",
      "Widget policy is documented in [Widget Policy](./docs/widget-policy.md).\n",
    );

    await expect(checkContextDocReferences({ repoRoot: rootDir })).resolves.toEqual({ orphanContextDocs: [] });
  });

  it("treats a link from another Markdown file as a reference", async () => {
    const rootDir = createTempRepo();
    write(rootDir, "bounded-contexts/widgets/docs/widget-policy.md", "# Widget Policy\n");
    write(
      rootDir,
      "docs/architecture/overview.md",
      "See [Widget Policy](../../bounded-contexts/widgets/docs/widget-policy.md).\n",
    );

    await expect(checkContextDocReferences({ repoRoot: rootDir })).resolves.toEqual({ orphanContextDocs: [] });
  });

  it("treats a code/test/config mention as a reference", async () => {
    const rootDir = createTempRepo();
    write(rootDir, "bounded-contexts/widgets/docs/widget-policy.md", "# Widget Policy\n");
    write(
      rootDir,
      "bounded-contexts/widgets/features/policy/domain/domain.ts",
      "// Policy rules: see bounded-contexts/widgets/docs/widget-policy.md\n",
    );

    await expect(checkContextDocReferences({ repoRoot: rootDir })).resolves.toEqual({ orphanContextDocs: [] });
  });

  it("does not count a doc's own content as a reference to itself", async () => {
    const rootDir = createTempRepo();
    write(
      rootDir,
      "bounded-contexts/widgets/docs/widget-policy.md",
      "# Widget Policy\n\nSelf-reference: widget-policy.md\n",
    );

    await expect(checkContextDocReferences({ repoRoot: rootDir })).resolves.toEqual({
      orphanContextDocs: ["bounded-contexts/widgets/docs/widget-policy.md"],
    });
  });
});
