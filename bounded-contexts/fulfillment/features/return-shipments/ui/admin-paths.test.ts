import { matchRoutes } from "react-router";
import { describe, expect, it } from "vitest";
import { resolveWebHostRouteRecords } from "@chase-sets/platform-runtime/web";
import { contextManifest } from "../../../index";
import { returnIntakeHref, returnIntakePath } from "./admin-paths";

const adminRoutes = resolveWebHostRouteRecords(
  [
    {
      contextName: "fulfillment",
      packageName: "@chase-sets/fulfillment",
      manifest: contextManifest as Parameters<typeof resolveWebHostRouteRecords>[0][number]["manifest"],
    },
  ],
  "admin-web",
);

function servedBy(href: string) {
  const routes = adminRoutes.map((route) => ({ id: route.routeId, path: `/${route.routePath}` }));
  const matched = matchRoutes(routes, new URL(href, "https://admin.example").pathname);
  const route = adminRoutes.find((candidate) => candidate.routeId === matched?.at(-1)?.route.id);
  return route ? { routeId: route.routeId, section: route.section } : null;
}

describe("Return Intake admin paths", () => {
  it("names the station at the route admin-web serves in its Commerce section", () => {
    expect(servedBy(returnIntakePath)).toEqual({ routeId: expect.any(String), section: "commerce" });
    expect(servedBy(returnIntakeHref("fac_east", { result: "completed" }))).toEqual(servedBy(returnIntakePath));
    expect(servedBy("/return-intake")).toBeNull();
  });

  it("keeps the facility first and encodes every query value", () => {
    expect(returnIntakeHref("fac east", { identifier: "1Z 99&x" })).toBe(
      "/commerce/return-intake?facilityId=fac+east&identifier=1Z+99%26x",
    );
  });
});
