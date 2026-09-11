import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const channelsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

type RouteContribution = Readonly<{
  routeId?: string;
  routePath?: string;
  fileExport?: string;
  sourceContext?: string;
  authorization?: { kind?: string; requiredPermissions?: readonly string[] };
}>;

type ShellContribution = Readonly<{
  deployable?: string;
  key?: string;
  href?: string;
  order?: number;
  requiredPermissions?: readonly string[];
}>;

function manifest() {
  return JSON.parse(readFileSync(join(channelsRoot, "context.json"), "utf8")) as {
    deployableContributions?: Array<{ deployable?: string; routes?: RouteContribution[] }>;
    shellContributions?: ShellContribution[];
  };
}

function marketplaceRoutes() {
  return (
    manifest()
      .deployableContributions?.filter((contribution) => contribution.deployable === "marketplace-web")
      .flatMap((contribution) => contribution.routes ?? []) ?? []
  );
}

describe("Channels marketplace route contributions", () => {
  it("declares the account-scoped connection list and detail routes", () => {
    expect(marketplaceRoutes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routeId: "channels-connections",
          routePath: "account/channels",
          fileExport: "./routes/marketplace/account-channels",
          sourceContext: "channels",
          authorization: expect.objectContaining({ requiredPermissions: ["channels.view"] }),
        }),
        expect.objectContaining({
          routeId: "channels-connection-detail",
          routePath: "account/channels/:connectionId",
          fileExport: "./routes/marketplace/account-channels-connection",
          sourceContext: "channels",
          authorization: expect.objectContaining({ requiredPermissions: ["channels.view"] }),
        }),
      ]),
    );
  });

  it("gates the single Channels top-nav entry on channels.view and points at the reachable connection list", () => {
    const shellContributions = manifest().shellContributions ?? [];
    expect(shellContributions).toHaveLength(1);
    expect(shellContributions[0]).toMatchObject({
      deployable: "marketplace-web",
      href: "/account/channels",
      requiredPermissions: ["channels.view"],
    });
  });
});
