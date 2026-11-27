import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { englishTranslations } from "@chase-sets/localization/locales/en";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as article from "./article";
import * as llms from "./llms";
import * as manifest from "./manifest";
import * as portal from "./portal";
import {
  buildDeveloperLlmsTxt,
  buildDeveloperManifest,
  developerPortalResponseHeaders,
  developerPortalRobotsMeta,
} from "../developer-route-data";
import { developerPortalEnglishTranslations } from "../localization/locales/en";
import * as ownedArticle from "./article";
import * as ownedLlms from "./llms";
import * as ownedManifest from "./manifest";
import * as ownedPortal from "./portal";

const request = new Request("https://chasesets.com/developers");
const resourceArgs = { request, params: {}, context: {} } as never;
const articleArgs = { request, params: { slug: "developer-quickstart" }, context: {} } as never;

afterEach(() => vi.unstubAllEnvs());

describe("developer portal routes", () => {
  it("re-exports exactly the same named and default bindings at the public paths", () => {
    expect({ ...portal }).toEqual({ ...ownedPortal });
    expect({ ...article }).toEqual({ ...ownedArticle });
    expect({ ...manifest }).toEqual({ ...ownedManifest });
    expect({ ...llms }).toEqual({ ...ownedLlms });
  });

  it("keeps every route gated off by default", async () => {
    vi.stubEnv("CHASE_SETS_M86_DEVELOPER_PORTAL_READY", undefined);
    for (const load of [
      portal.loader,
      () => article.loader(articleArgs),
      () => manifest.loader(resourceArgs),
      () => llms.loader(resourceArgs),
    ]) {
      await expect(async () => load()).rejects.toMatchObject({ status: 404 });
    }
  });

  it("loads the portal, articles, manifest, and llms.txt only after readiness", async () => {
    vi.stubEnv("CHASE_SETS_M86_DEVELOPER_PORTAL_READY", "true");
    vi.stubEnv("CHASE_SETS_PUBLIC_ORIGIN", undefined);
    expect(portal.loader()).toBeNull();
    const articleData = article.loader(articleArgs);
    expect(articleData).toMatchObject({
      article: { title: "Developer quickstart" },
    });
    await expect(async () => article.loader(resourceArgs)).rejects.toMatchObject({ status: 404 });

    const manifestResponse = manifest.loader(resourceArgs);
    expect(manifestResponse.headers.get("Content-Type")).toBe("application/json");
    const llmsResponse = llms.loader(resourceArgs);
    expect(llmsResponse.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    for (const response of [manifestResponse, llmsResponse]) {
      expect(response.status).toBe(200);
      for (const [name, value] of Object.entries(developerPortalResponseHeaders)) {
        expect(response.headers.get(name)).toBe(value);
      }
    }
    await expect(manifestResponse.json()).resolves.toEqual(buildDeveloperManifest("https://chasesets.com"));
    await expect(llmsResponse.text()).resolves.toBe(buildDeveloperLlmsTxt("https://chasesets.com"));
  });

  it("preserves HTML metadata, headers and the missing-article fallback", () => {
    expect(portal.headers()).toEqual(developerPortalResponseHeaders);
    expect(article.headers()).toEqual(developerPortalResponseHeaders);
    expect(portal.meta({} as never)).toEqual([
      { title: "Developer Portal | Chase Sets" },
      {
        name: "description",
        content: "Documentation for the Chase Sets MCP endpoint, OAuth authorization, and generated tool catalog.",
      },
      developerPortalRobotsMeta,
    ]);
    expect(
      article.meta({
        data: {
          article: {
            title: "Developer quickstart",
            description: "Connect to MCP.",
          },
        },
      } as never),
    ).toEqual([
      { title: "Developer quickstart | Chase Sets Developers" },
      { name: "description", content: "Connect to MCP." },
      developerPortalRobotsMeta,
    ]);
    expect(article.meta({} as never)).toEqual([{ title: "Developer article not found" }, developerPortalRobotsMeta]);
  });

  it("preserves the compatibility snapshot's developer chrome keys and values", () => {
    expect(developerPortalEnglishTranslations).toEqual(
      Object.fromEntries(
        Object.entries(englishTranslations).filter(([key]) => key.startsWith("publicPresence.developers.")),
      ),
    );
  });

  it("documents the exact agent-readable policies projection and llms.txt ordering without changing gate posture", () => {
    const contract = readFileSync(
      resolve(import.meta.dirname, "../../../../docs/developer-article-contract.md"),
      "utf8",
    );
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
