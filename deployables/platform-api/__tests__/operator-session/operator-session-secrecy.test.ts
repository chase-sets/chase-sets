import catalogManifest from "@chase-sets/catalog/context";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "@chase-sets/typescript-compiler-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getObservabilityRuntime } from "@chase-sets/observability";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { admin, adminPath, mounted, push, session, unpair } from "./fixture";

afterEach(() => vi.restoreAllMocks());
describe("operator-session failures stop before real host sinks", () => {
  it("grant entry points add no audit, event, span, readiness, receipt, config or snapshot sink", () => {
    const dependencies = new Set([
      "node:crypto",
      "hono",
      "@chase-sets/event-core-postgres",
      "@chase-sets/http/rate-limit",
      "@chase-sets/auth-context",
      "@chase-sets/http/responses",
      "@chase-sets/platform-runtime/http",
      "../domain/value",
      "./operation",
      "./request",
      "./runtime",
      "./store",
      "./grants",
    ]);
    for (const name of ["grants", "operation", "request", "route"]) {
      const content = readFileSync(
        new URL(`../../../../bounded-contexts/catalog/features/operator-session/api/${name}.ts`, import.meta.url),
        "utf8",
      );
      const source = ts.createSourceFile(name + ".ts", content, ts.ScriptTarget.Latest, true);
      function inspect(node: ts.Node) {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          expect(dependencies.has(node.moduleSpecifier.text), node.moduleSpecifier.text).toBe(true);
        }
        if (ts.isCallExpression(node)) {
          expect(node.expression.getText(source)).not.toMatch(
            /console\.|recordException|(?:audit|telemetry|logger|span)\.|appendEvents|writeFile|fetch\b|import\b/,
          );
        }
        ts.forEachChild(node, inspect);
      }
      inspect(source);
    }
  });
  it("does not expose hostile bearer/hash/cookie/exception markers to responses, console or host logger", async () => {
    const bearer = "SYNTHETIC_GRANT_MARKER_8471".padEnd(43, "x");
    const hash = createHash("sha256").update(bearer).digest("hex");
    const cookie = "SYNTHETIC_COOKIE_MARKER_8471";
    const exception = "SYNTHETIC_EXCEPTION_MARKER_8471";
    const consoleSinks = [
      vi.spyOn(console, "error"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "log"),
    ];
    const logger = getObservabilityRuntime().logger;
    const loggerSinks = [
      vi.spyOn(logger, "error"),
      vi.spyOn(logger, "warn"),
      vi.spyOn(logger, "info"),
      vi.spyOn(logger, "debug"),
    ];
    const fail = async () => {
      throw new Error([bearer, hash, cookie, exception].join(":"));
    };
    const pool: PgTransactionalPool = { connect: fail, query: fail };
    const app = mounted(catalogManifest, pool);
    for (const response of [
      await admin(app),
      await admin(app, "GET", adminPath, {}),
      await admin(app, "DELETE", adminPath),
      await push(app, bearer, session(0, cookie)),
      await unpair(app, bearer),
    ]) {
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ code: "custody-unavailable" });
    }
    expect(loggerSinks[2]!.mock.calls.some(([message]) => message === "HTTP request completed.")).toBe(true);
    expect(loggerSinks[0]).not.toHaveBeenCalled();
    expect(consoleSinks[0]).not.toHaveBeenCalled();
    const recorded = JSON.stringify([...consoleSinks, ...loggerSinks].map((sink) => sink.mock.calls));
    for (const marker of [bearer, hash, cookie, exception]) expect(recorded).not.toContain(marker);
  });
});
