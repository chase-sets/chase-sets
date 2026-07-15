import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_SIGN_IN_METHODS, type SignInMethod } from "../support/route-support/auth-host";

const authRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

type RouteContribution = Readonly<{
  routeId?: string;
  routePath?: string;
  fileExport?: string;
  sourceContext?: string;
}>;

function marketplaceRoutes() {
  const manifest = JSON.parse(readFileSync(join(authRoot, "context.json"), "utf8")) as {
    deployableContributions?: Array<{
      deployable?: string;
      routes?: RouteContribution[];
    }>;
  };

  return (
    manifest.deployableContributions
      ?.filter((contribution) => contribution.deployable === "marketplace-web")
      .flatMap((contribution) => contribution.routes ?? []) ?? []
  );
}

function anonymousRoutes() {
  const manifest = JSON.parse(readFileSync(join(authRoot, "context.json"), "utf8")) as {
    anonymousRoutes?: Array<{
      routePath?: string;
      methods?: string[];
      match?: string;
    }>;
  };

  return manifest.anonymousRoutes ?? [];
}

const REQUIRED_ANONYMOUS_SIGN_IN_ROUTES = {
  password: ["/api/auth/password-sign-in"],
  "phone-code": ["/api/auth/phone-code/request", "/api/auth/phone-code/consume"],
  "magic-link": ["/api/auth/magic-link/request", "/api/auth/magic-link/consume"],
  passkey: ["/api/auth/passkeys/sign-in"],
} as const satisfies Readonly<Record<SignInMethod, readonly string[]>>;

describe("Auth marketplace route contributions", () => {
  it("declares the Auth-owned guest checkout exit route", () => {
    expect(marketplaceRoutes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routeId: "guest-checkout-exit",
          routePath: "guest-checkout/exit",
          fileExport: "./routes/marketplace/guest-checkout-exit",
          sourceContext: "auth",
        }),
      ]),
    );
  });

  it("declares the Auth-owned magic-link landing route", () => {
    expect(marketplaceRoutes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routeId: "sign-in-magic",
          routePath: "sign-in/magic",
          fileExport: "./routes/marketplace/sign-in-magic",
          sourceContext: "auth",
        }),
      ]),
    );
  });

  it("declares the Auth-owned connected-agents routes", () => {
    expect(marketplaceRoutes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routeId: "account-agents",
          routePath: "account/agents",
          fileExport: "./routes/marketplace/account-agents",
          sourceContext: "auth",
        }),
        expect.objectContaining({
          routeId: "account-agents-detail",
          routePath: "account/agents/:id",
          fileExport: "./routes/marketplace/account-agents-detail",
          sourceContext: "auth",
        }),
      ]),
    );
  });

  it("declares Auth-owned anonymous API routes", () => {
    expect(anonymousRoutes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routePath: "/api/auth/session",
          methods: ["GET", "HEAD"],
        }),
        expect.objectContaining({
          routePath: "/api/auth/guest-checkout/start",
          methods: ["POST"],
        }),
        expect.objectContaining({
          routePath: "/api/auth/social/",
          methods: ["GET", "HEAD"],
          match: "prefix",
        }),
      ]),
    );
  });

  it("keeps every advertised sign-in method anonymously reachable", () => {
    const anonymousPostRoutes = new Set(
      anonymousRoutes().flatMap((route) =>
        route.methods?.includes("POST") && route.routePath ? [route.routePath] : [],
      ),
    );

    for (const method of DEFAULT_SIGN_IN_METHODS) {
      for (const routePath of REQUIRED_ANONYMOUS_SIGN_IN_ROUTES[method]) {
        expect(anonymousPostRoutes, `${method} requires anonymous POST ${routePath}`).toContain(routePath);
      }
    }
  });
});
