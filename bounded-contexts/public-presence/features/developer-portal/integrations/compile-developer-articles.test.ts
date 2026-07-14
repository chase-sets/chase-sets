import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { compileDeveloperArticleCorpus, compileMcpToolCatalog } from "./compile-developer-articles.mjs";

const execFileAsync = promisify(execFile);
const compilerPath = resolve("features/developer-portal/integrations/compile-developer-articles.mjs");

const developerSource = `---
slug: example
title: Example developer article
description: A planned UCP integration.
audience: developer
category: getting-started
reviewedAt: "2026-07-13"
citedPolicies: []
relatedFlows: []
claimCategories: []
promiseTable:
  - claim: The example renders.
    issues: ["#4357"]
    tests: []
---
## Start here

Read the [developer portal](/developers).
`;

describe("developer article compiler", () => {
  it("compiles a developer-only corpus onto /developers paths", async () => {
    await expect(
      compileDeveloperArticleCorpus([{ fileName: "example.en.md", source: developerSource }]),
    ).resolves.toMatchObject([
      {
        audience: "developer",
        href: "/developers/example",
        description: "A planned UCP integration.",
      },
    ]);
  });

  it("rejects consumer articles from the developer corpus", async () => {
    await expect(
      compileDeveloperArticleCorpus([
        { fileName: "example.en.md", source: developerSource.replace("audience: developer", "audience: buyer") },
      ]),
    ).rejects.toThrow("audience must be 'developer' for this corpus");
  });

  it("generates complete available and planned tool descriptors from the MCP registry", () => {
    const catalog = compileMcpToolCatalog();
    expect(catalog.some((tool) => tool.availability === "available")).toBe(true);
    expect(catalog.some((tool) => tool.availability === "planned")).toBe(true);
    expect(catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "discovery.search-market",
          availability: "available",
          risk: "read",
          inputSchema: expect.objectContaining({ type: "object" }),
          permissionBoundary: expect.objectContaining({ scope: "public" }),
          expectedUsage: expect.any(Array),
        }),
      ]),
    );
  });

  it("keeps the committed developer manifests in sync", async () => {
    await expect(
      execFileAsync(process.execPath, ["--experimental-strip-types", compilerPath, "--check"]),
    ).resolves.toMatchObject({ stderr: "" });
  });
});
