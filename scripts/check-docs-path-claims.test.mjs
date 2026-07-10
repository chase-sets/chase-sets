import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkDocsPathClaims,
  collectDocsPathClaimViolations,
  docsPathClaimsAllowlist,
  findMarkdownLinkClaims,
  findPathTokenClaims,
} from "./check-docs-path-claims.mjs";

const temporaryRoots = [];

function createTempRepo() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "chase-sets-docs-path-claims-"));
  temporaryRoots.push(rootDir);
  return rootDir;
}

function write(rootDir, relativePath, content) {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

afterEach(() => {
  for (const rootDir of temporaryRoots.splice(0)) {
    rmSync(rootDir, { force: true, recursive: true });
  }
});

describe("findMarkdownLinkClaims", () => {
  it("extracts a relative link target", () => {
    const content = "See [Widget Policy](./widget-policy.md) for details.\n";
    expect(findMarkdownLinkClaims(content)).toEqual([{ line: 1, target: "./widget-policy.md" }]);
  });

  it("skips http(s), mailto, absolute, and anchor-only targets", () => {
    const content = [
      "[External](https://example.com/docs)",
      "[Secure](http://example.com/docs)",
      "[Email](mailto:support@example.com)",
      "[Absolute](/api/marketplace)",
      "[Anchor only](#section)",
    ].join("\n");

    expect(findMarkdownLinkClaims(content)).toEqual([]);
  });

  it("strips an anchor or query suffix before reporting the target", () => {
    const content = "[Leaf](./architecture/leaf.md#section?x=1)\n";
    expect(findMarkdownLinkClaims(content)).toEqual([{ line: 1, target: "./architecture/leaf.md" }]);
  });
});

describe("findPathTokenClaims", () => {
  it("extracts an inline-code token starting with a tracked repo-root prefix", () => {
    const content = "See `bounded-contexts/widgets/features/policy/domain/domain.ts` for the rule.\n";
    expect(findPathTokenClaims(content)).toEqual([
      { line: 1, token: "bounded-contexts/widgets/features/policy/domain/domain.ts" },
    ]);
  });

  it("ignores tokens that do not start with a tracked repo-root prefix", () => {
    const content = "Run `pnpm run env:check` then edit `app/core/clients/baseDomainClient.server.ts`.\n";
    expect(findPathTokenClaims(content)).toEqual([]);
  });

  it("skips a glob/wildcard citation", () => {
    const content = [
      "See `infrastructure/platform-runtime/mcp*.ts` for the native bridge.",
      "Registry tests pin `bounded-contexts/*/context.json`.",
    ].join("\n");

    expect(findPathTokenClaims(content)).toEqual([]);
  });

  it("does not scan a fenced code block", () => {
    const content = ["```bash", "cat bounded-contexts/widgets/README.md", "```", ""].join("\n");
    expect(findPathTokenClaims(content)).toEqual([]);
  });

  it("ignores a bare repo-root prefix with no path beneath it", () => {
    const content = "Everything under `docs/` is Markdown.\n";
    expect(findPathTokenClaims(content)).toEqual([]);
  });
});

describe("collectDocsPathClaimViolations", () => {
  it("reports a broken relative markdown link", async () => {
    const rootDir = createTempRepo();
    write(rootDir, "docs/README.md", "See [Missing](./missing.md).\n");

    expect(await collectDocsPathClaimViolations({ rootDir })).toEqual([
      { file: "docs/README.md", line: 1, claim: "./missing.md", kind: "link" },
    ]);
  });

  it("reports a stale inline-code path token", async () => {
    const rootDir = createTempRepo();
    write(rootDir, "docs/README.md", "See `bounded-contexts/widgets/domain.ts` for the rule.\n");

    expect(await collectDocsPathClaimViolations({ rootDir })).toEqual([
      { file: "docs/README.md", line: 1, claim: "bounded-contexts/widgets/domain.ts", kind: "path-token" },
    ]);
  });

  it("does not report a resolvable link or path token", async () => {
    const rootDir = createTempRepo();
    write(rootDir, "bounded-contexts/widgets/domain.ts", "export const x = 1;\n");
    write(
      rootDir,
      "docs/README.md",
      "See [Widgets](../bounded-contexts/widgets/domain.ts) or `bounded-contexts/widgets/domain.ts`.\n",
    );

    expect(await collectDocsPathClaimViolations({ rootDir })).toEqual([]);
  });

  it("does not report an allowlisted token", async () => {
    const rootDir = createTempRepo();
    write(
      rootDir,
      "docs/architecture/bounded-context-structure.md",
      "R02 forbids `contracts/dev-seeds` from existing.\n",
    );

    expect(await collectDocsPathClaimViolations({ rootDir })).toEqual([]);
  });

  it("still reports an unallowlisted token in the same file that has an allowlist entry", async () => {
    const rootDir = createTempRepo();
    write(
      rootDir,
      "docs/architecture/bounded-context-structure.md",
      "R02 forbids `contracts/dev-seeds` and `contracts/still-missing`.\n",
    );

    expect(await collectDocsPathClaimViolations({ rootDir })).toEqual([
      {
        file: "docs/architecture/bounded-context-structure.md",
        line: 1,
        claim: "contracts/still-missing",
        kind: "path-token",
      },
    ]);
  });

  it("skips an external-repo path that does not start with a tracked prefix", async () => {
    const rootDir = createTempRepo();
    write(rootDir, "docs/README.md", "See `app/core/clients/baseDomainClient.server.ts` in the other repo.\n");

    expect(await collectDocsPathClaimViolations({ rootDir })).toEqual([]);
  });

  it("every allowlist entry names a real file and a claim that does not resolve from repo root", () => {
    for (const entry of docsPathClaimsAllowlist) {
      expect(typeof entry.file, entry.file).toBe("string");
      expect(entry.file.length > 0, entry.file).toBe(true);
      expect(typeof entry.token, entry.file).toBe("string");
      expect(entry.token.length > 0, entry.file).toBe(true);
      expect(typeof entry.reason, entry.file).toBe("string");
      expect(entry.reason.length > 0, entry.file).toBe(true);
    }
  });
});

describe("checkDocsPathClaims", () => {
  it("passes on a repo with no path claims", async () => {
    const rootDir = createTempRepo();
    write(rootDir, "docs/README.md", "# Docs\n");

    await expect(checkDocsPathClaims({ rootDir })).resolves.toEqual({ passed: true, violations: [] });
  });

  // The full-corpus sweep grows with the codebase (231+ Markdown files at the
  // time this guard landed); same rationale as the issue-reference-comment
  // guard's repo-wide sweep.
  it("keeps every committed Markdown file's path claims resolvable, modulo the documented allowlist", async () => {
    const result = await checkDocsPathClaims();

    expect(
      result.violations,
      result.violations.map((violation) => `${violation.file}:${violation.line} ${violation.claim}`).join("\n"),
    ).toEqual([]);
  }, 30_000);
});
