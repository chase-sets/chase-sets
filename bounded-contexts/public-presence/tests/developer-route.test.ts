import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developerPortalRobotsMeta } from "../features/developer-portal/domain/developer-portal-readiness";
import { loader as articleLoader, meta as articleMeta } from "../routes/developers/article";
import { loader as llmsLoader } from "../routes/developers/llms";
import { loader as manifestLoader } from "../routes/developers/manifest";
import { loader as portalLoader, meta as portalMeta } from "../routes/developers/portal";

const request = new Request("https://chasesets.com/developers");

afterEach(() => vi.unstubAllEnvs());

describe("developer portal routes", () => {
  it("keeps every route gated off by default", () => {
    vi.stubEnv("CHASE_SETS_M86_DEVELOPER_PORTAL_READY", "false");
    expect(() => portalLoader()).toThrowError(Response);
    expect(() =>
      articleLoader({ request, params: { slug: "developer-quickstart" }, context: {} } as never),
    ).toThrowError(Response);
    expect(() => manifestLoader({ request, params: {}, context: {} } as never)).toThrowError(Response);
    expect(() => llmsLoader({ request, params: {}, context: {} } as never)).toThrowError(Response);
  });

  it("loads the portal, articles, manifest, and llms.txt only after readiness", async () => {
    vi.stubEnv("CHASE_SETS_M86_DEVELOPER_PORTAL_READY", "true");
    expect(portalLoader()).toBeNull();
    expect(articleLoader({ request, params: { slug: "developer-quickstart" }, context: {} } as never)).toMatchObject({
      article: { title: "Developer quickstart" },
    });

    const manifest = manifestLoader({ request, params: {}, context: {} } as never);
    expect(manifest.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    await expect(manifest.json()).resolves.toMatchObject({
      schemaVersion: 1,
      indexing: "disabled",
      policies: [
        {
          policyKey: "agent-connector-terms",
          title: "Agent Connector Terms",
          url: "https://chasesets.com/agent-terms",
        },
      ],
    });

    const llms = llmsLoader({ request, params: {}, context: {} } as never);
    expect(llms.headers.get("Content-Type")).toContain("text/plain");
    expect(llms.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const llmsText = await llms.text();
    expect(llmsText).toContain("Chase Sets Developer Portal");
    expect(llmsText).toContain("[Agent Connector Terms](https://chasesets.com/agent-terms)");
  });

  it("always emits noindex,nofollow metadata for HTML pages", () => {
    expect(portalMeta({} as never)).toContainEqual(developerPortalRobotsMeta);
    expect(
      articleMeta({
        data: {
          article: {
            title: "Developer quickstart",
            description: "Connect to MCP.",
          },
        },
      } as never),
    ).toContainEqual(developerPortalRobotsMeta);
  });

  it("documents the exact agent-readable policies projection and llms.txt ordering without changing gate posture", () => {
    const contract = readFileSync(resolve(import.meta.dirname, "../docs/developer-article-contract.md"), "utf8");
    expect(contract).toContain("a `policies` array");
    expect(contract).toContain(
      '{ "policyKey": "agent-connector-terms", "title": "Agent Connector Terms", "url": "<normalized-origin>/agent-terms" }',
    );
    expect(contract).toContain(
      "then the Agent Connector Terms policy entry with label `Agent Connector Terms` and URL `<normalized-origin>/agent-terms`, then the machine-readable developer manifest",
    );
    expect(contract).toContain("`CHASE_SETS_M86_DEVELOPER_PORTAL_READY` flag defaults to false");
  });
});
