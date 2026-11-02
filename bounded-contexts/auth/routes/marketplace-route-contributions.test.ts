import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "@chase-sets/typescript-compiler-api";
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

const MIGRATED_COMPONENTS = new Set([
  "SignInPage",
  "RegisterPage",
  "AccountSelectionPage",
  "SessionDetailPage",
  "AgentGrantDetailPage",
]);

type SourceImport = Readonly<{ source: string; imported: string }>;

function routeFiles() {
  return readdirSync(join(authRoot, "routes"), { recursive: true })
    .filter((file): file is string => typeof file === "string")
    .filter((file) => /\.(?:ts|tsx)$/u.test(file) && !/\.test\./u.test(file));
}

function mountedComponents(file: string, seen = new Set<string>()): string[] {
  const absolute = join(authRoot, file);
  if (seen.has(absolute)) return [];
  seen.add(absolute);
  const source = ts.createSourceFile(file, readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true);
  const imports = new Map<string, SourceImport>();
  const components = new Set<string>();

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.importClause) {
      const modulePath = node.moduleSpecifier.text;
      const named = node.importClause.namedBindings;
      if (node.importClause.name) imports.set(node.importClause.name.text, { source: modulePath, imported: "default" });
      if (named && ts.isNamedImports(named)) {
        for (const specifier of named.elements) {
          imports.set(specifier.name.text, {
            source: modulePath,
            imported: specifier.propertyName?.text ?? specifier.name.text,
          });
        }
      }
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (ts.isIdentifier(node.tagName)) {
        const imported = imports.get(node.tagName.text);
        if (imported && MIGRATED_COMPONENTS.has(imported.imported)) components.add(imported.imported);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);

  const exportDefault = source.statements.find(
    (statement): statement is ts.ExportAssignment => ts.isExportAssignment(statement) && !statement.isExportEquals,
  );
  if (exportDefault && ts.isIdentifier(exportDefault.expression)) {
    const target = imports.get(exportDefault.expression.text);
    if (target?.imported === "default" && target.source.startsWith(".")) {
      const targetFile = join(dirname(file), `${target.source}.tsx`);
      for (const component of mountedComponents(targetFile, seen)) components.add(component);
    }
  }
  return [...components];
}

function migratedRouteMounts() {
  const mounts = new Map<string, string[]>();
  for (const file of routeFiles()) {
    for (const component of mountedComponents(join("routes", file))) {
      const files = mounts.get(component) ?? [];
      files.push(join("routes", file).replaceAll("\\", "/"));
      mounts.set(component, files);
    }
  }
  return Object.fromEntries([...mounts].map(([component, files]) => [component, files.sort()]));
}

describe("Auth marketplace route contributions", () => {
  it("enumerates every route mount of the migrated auth page components", () => {
    expect(migratedRouteMounts()).toEqual({
      SignInPage: [
        "routes/access-admin/sign-in.tsx",
        "routes/catalog-admin/sign-in.tsx",
        "routes/marketplace/sign-in.tsx",
      ],
      RegisterPage: ["routes/marketplace/register.tsx"],
      AccountSelectionPage: ["routes/access-admin/account-select.tsx", "routes/marketplace/account-select.tsx"],
      SessionDetailPage: ["routes/access-admin/sessions-detail.tsx", "routes/marketplace/account-sessions-detail.tsx"],
      AgentGrantDetailPage: ["routes/marketplace/account-agents-detail.tsx"],
    });
  });

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

  it("declares the Auth-owned invitation recipient route", () => {
    expect(marketplaceRoutes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routeId: "invite",
          routePath: "invite/:invitationId",
          fileExport: "./routes/marketplace/invite",
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
          routeId: "account-agents-consent",
          routePath: "account/agents/consent",
          fileExport: "./routes/marketplace/account-agents-consent",
          sourceContext: "auth",
          delivery: "server-only",
          authorization: { kind: "authenticated", requiredPermissions: [] },
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
