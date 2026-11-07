import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";
import { buildAuthApi } from "../../api";
import { createAuthSessionMcpHandlers } from "../../features/sessions/api/mcp";
import {
  SESSION_GENERATION_ADVANCED_EVENT_TYPE,
  SESSION_GENERATION_SCHEMA_MIGRATION_ID,
  USER_SESSION_AUTHORITY_STREAM_PREFIX,
} from "../../features/sessions/domain/session-generation";
import { module as authModule } from "../../index";
import { createAuthServicesFake } from "../auth-support/test-support";

type SessionSurfaceKind =
  | "interactive-start"
  | "direct-start"
  | "token-write"
  | "actor-resolution"
  | "authority-stream"
  | "authority-advance";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

const CALL_KINDS: Readonly<Record<string, SessionSurfaceKind>> = {
  startInteractiveAuth: "interactive-start",
  upsertSessionToken: "token-write",
  readAuthenticatedSession: "actor-resolution",
  resolveActorFromSessionId: "actor-resolution",
  resolveActorFromSessionToken: "actor-resolution",
  getSessionByTokenHash: "actor-resolution",
};

/**
 * Classifies code shape, not path vocabulary: calls (direct, member, aliased,
 * or computed) to the Session start/token/resolution seams, `type:
 * "StartSession"` command literals, and every reference to the User Session
 * Authority stream or its advance event by name or by literal.
 */
function discover(path: string, text: string): string[] {
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const values = new Map<string, ts.Expression>();
  const aliases = new Map<string, string>();
  const found: string[] = [];
  function literal(node: ts.Node | undefined, seen = new Set<string>()): string {
    if (!node) return "";
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      seen.add(node.text);
      return literal(values.get(node.text), seen);
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
      return literal(node.expression, seen);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return literal(node.left, new Set(seen)) + literal(node.right, new Set(seen));
    return "";
  }
  function callee(node: ts.Expression): string {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node)) return literal(node.argumentExpression);
    if (ts.isIdentifier(node)) return aliases.get(node.text) ?? node.text;
    return "";
  }
  function definitions(node: ts.Node) {
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.initializer) {
        values.set(node.name.text, node.initializer);
        if (ts.isPropertyAccessExpression(node.initializer) || ts.isIdentifier(node.initializer))
          aliases.set(node.name.text, callee(node.initializer));
      }
      if (ts.isObjectBindingPattern(node.name))
        for (const element of node.name.elements)
          if (ts.isIdentifier(element.name))
            aliases.set(
              element.name.text,
              element.propertyName
                ? literal(element.propertyName) || element.propertyName.getText(file)
                : element.name.text,
            );
    }
    if (ts.isImportSpecifier(node) && node.propertyName) aliases.set(node.name.text, node.propertyName.text);
    ts.forEachChild(node, definitions);
  }
  definitions(file);
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const kind = CALL_KINDS[callee(node.expression)];
      if (kind) found.push(`${path}:${kind}`);
    }
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) ? node.name.text : literal(node.name)) === "type" &&
      literal(node.initializer) === "StartSession"
    )
      found.push(`${path}:direct-start`);
    if (ts.isIdentifier(node) && !ts.isImportSpecifier(node.parent) && !ts.isExportSpecifier(node.parent)) {
      if (node.text === "toUserSessionAuthorityStreamId" || node.text === "USER_SESSION_AUTHORITY_STREAM_PREFIX")
        found.push(`${path}:authority-stream`);
      if (node.text === "SESSION_GENERATION_ADVANCED_EVENT_TYPE") found.push(`${path}:authority-advance`);
    }
    if (ts.isStringLiteralLike(node)) {
      if (
        node.text.startsWith(USER_SESSION_AUTHORITY_STREAM_PREFIX.slice(0, -1)) &&
        node.text !== SESSION_GENERATION_ADVANCED_EVENT_TYPE
      )
        found.push(`${path}:authority-stream`);
      if (node.text === SESSION_GENERATION_ADVANCED_EVENT_TYPE) found.push(`${path}:authority-advance`);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

let inventoryCache: readonly string[] | null = null;

/** Every non-test TypeScript source in the worktree (tracked or new, never ignored), scanned once. */
function trackedSourceInventory(): readonly string[] {
  inventoryCache ??= execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.ts", "*.tsx", "*.mts"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    },
  )
    .trim()
    .split(/\r?\n/)
    .filter((path) => !/(?:\.test\.|\.spec\.|\/tests\/|\/__tests__\/|\/e2e\/|test-support\.ts$)/.test(path))
    .flatMap((path) => discover(path, readFileSync(`${root}${path}`, "utf8")))
    .sort();
  return inventoryCache;
}

const ROUTES = "bounded-contexts/auth/support/api-support";
const SESSIONS = "bounded-contexts/auth/features/sessions";
const RUNTIME_SUPPORT = "bounded-contexts/auth/support/runtime-support";

describe("session-start-caller-inventory", () => {
  const ofKind = (kind: SessionSurfaceKind) => trackedSourceInventory().filter((entry) => entry.endsWith(`:${kind}`));

  it("names the ten interactive callers and the only two direct Session starts", () => {
    expect(ofKind("interactive-start")).toEqual(
      [
        "bounded-contexts/auth/features/invitation-acceptance/api/journey.ts",
        `${ROUTES}/account-selection-routes.ts`,
        `${ROUTES}/guest-checkout-routes.ts`,
        `${ROUTES}/invitation-routes.ts`,
        `${ROUTES}/magic-link-routes.ts`,
        `${ROUTES}/magic-link-routes.ts`,
        `${ROUTES}/passkey-routes.ts`,
        `${ROUTES}/passkey-routes.ts`,
        `${ROUTES}/password-routes.ts`,
        `${ROUTES}/phone-code-routes.ts`,
        `${ROUTES}/phone-code-routes.ts`,
        `${ROUTES}/register-routes.ts`,
        `${ROUTES}/social-login-routes.ts`,
      ].map((path) => `${path}:interactive-start`),
    );
    // Both direct starts reach the generation-guarded `SessionServices.commandHandler`:
    // the interactive contract (services.ts) and seed/bootstrap reconciliation (seed.ts).
    expect(ofKind("direct-start")).toEqual([
      `${RUNTIME_SUPPORT}/seed.ts:direct-start`,
      `${RUNTIME_SUPPORT}/services.ts:direct-start`,
    ]);
    // Only the interactive contract writes a session token, after its guarded start commits.
    expect(ofKind("token-write")).toEqual([`${RUNTIME_SUPPORT}/services.ts:token-write`]);
  });

  it("keeps every actor/token resolution inside Auth's generation-aware resolver", () => {
    expect(ofKind("actor-resolution")).toEqual([
      // token -> Session id -> request: every hop ends in services.ts#getSessionForAuth.
      `${RUNTIME_SUPPORT}/runtime.ts:actor-resolution`,
      `${RUNTIME_SUPPORT}/runtime.ts:actor-resolution`,
      `${RUNTIME_SUPPORT}/runtime.ts:actor-resolution`,
      `${RUNTIME_SUPPORT}/services.ts:actor-resolution`,
    ]);
  });

  it("finds aliased, member, and computed callers outside Auth vocabulary", () => {
    for (const source of [
      "startInteractiveAuth(services, {});",
      "auth.startInteractiveAuth(services, {});",
      "const { startInteractiveAuth: begin } = auth; begin(services, {});",
      'const key = "startInteractive" + "Auth"; auth[key](services, {});',
      "import { startInteractiveAuth as begin } from './x'; begin(services, {});",
    ])
      expect(discover("arbitrary/no-auth-vocabulary.ts", source)).toEqual([
        "arbitrary/no-auth-vocabulary.ts:interactive-start",
      ]);
    expect(
      discover("arbitrary/no-auth-vocabulary.ts", 'const kind = "Start" + "Session"; send({ type: kind });'),
    ).toEqual(["arbitrary/no-auth-vocabulary.ts:direct-start"]);
  });

  it("registers the Session Generation expand migration in the real Auth schema ledger", () => {
    const migration = authModule.schemaMigrations?.find(
      (entry) => entry.migrationId === SESSION_GENERATION_SCHEMA_MIGRATION_ID,
    );
    expect(migration?.statements.join("\n")).toContain(
      "ADD COLUMN IF NOT EXISTS session_generation integer NOT NULL DEFAULT 0",
    );
    expect(migration?.statements.join("\n")).not.toMatch(/DROP|UPDATE|started_at/i);
    expect(authModule.schemaSql).toContain("session_generation integer NOT NULL DEFAULT 0");
  });
});

describe("route-negative", () => {
  it("has no producer of a User Session Authority advance", () => {
    const inventory = trackedSourceInventory();
    // Only the fold names the advance event; nothing outside it can append one.
    expect([...new Set(inventory.filter((entry) => entry.endsWith(":authority-advance")))]).toEqual([
      `${SESSIONS}/domain/session-generation.ts:authority-advance`,
    ]);
    // The authority stream is named only where it is defined and where the
    // start guard and the resolver read it.
    expect([...new Set(inventory.filter((entry) => entry.endsWith(":authority-stream")))]).toEqual([
      `${SESSIONS}/api/runtime.ts:authority-stream`,
      `${SESSIONS}/domain/session-generation.ts:authority-stream`,
    ]);
  });

  it("exposes no advance or bulk sign-out route or Session tool", () => {
    const routes = buildAuthApi(createAuthServicesFake()).routes.map((route) => `${route.method} ${route.path}`);
    const mcp = createAuthSessionMcpHandlers(
      createAuthServicesFake().sessions as Parameters<typeof createAuthSessionMcpHandlers>[0],
    );
    const tools = [...Object.keys(mcp.toolHandlers), ...Object.keys(mcp.resourceHandlers)];

    expect(routes).toContain("POST /sign-out");
    expect(tools).toContain("auth.revoke-session");
    for (const surface of [...routes, ...tools])
      expect(surface).not.toMatch(
        /generation|authority|bulk|sign-out-(?:all|other|everywhere)|revoke-(?:all|other)|other-sessions/i,
      );
  });
});
