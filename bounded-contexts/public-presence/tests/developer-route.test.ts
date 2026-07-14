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
    await expect(manifest.json()).resolves.toMatchObject({ indexing: "disabled" });

    const llms = llmsLoader({ request, params: {}, context: {} } as never);
    expect(llms.headers.get("Content-Type")).toContain("text/plain");
    expect(llms.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    await expect(llms.text()).resolves.toContain("Chase Sets Developer Portal");
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
});
