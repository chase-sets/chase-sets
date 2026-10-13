import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";

type Caller = { path: string; line: number; kind: "journey" | "owner" | "http" };
const root = fileURLToPath(new URL("../../../../../", import.meta.url));

function discover(path: string, text: string): Caller[] {
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const values = new Map<string, ts.Expression>();
  const methods = new Map<string, string>();
  const calls: Caller[] = [];
  function strings(node: ts.Node | undefined, seen = new Set<string>()): string {
    if (!node) return "";
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      seen.add(node.text);
      return strings(values.get(node.text), seen);
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return strings(node.expression, seen);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return strings(node.left, new Set(seen)) + strings(node.right, new Set(seen));
    if (ts.isTemplateExpression(node))
      return (
        node.head.text +
        node.templateSpans
          .map((span) => (strings(span.expression, new Set(seen)) || "{id}") + span.literal.text)
          .join("")
      );
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) return strings(node.arguments?.[0], seen);
    return "";
  }
  function method(node: ts.Expression): string {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node)) return strings(node.argumentExpression);
    if (ts.isIdentifier(node)) {
      const value = values.get(node.text);
      return (
        methods.get(node.text) ??
        (value &&
        (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value) || ts.isIdentifier(value))
          ? method(value)
          : node.text)
      );
    }
    return "";
  }
  function definitions(node: ts.Node) {
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.initializer) values.set(node.name.text, node.initializer);
      if (ts.isObjectBindingPattern(node.name))
        for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name))
            methods.set(
              element.name.text,
              element.propertyName
                ? ts.isIdentifier(element.propertyName)
                  ? element.propertyName.text
                  : strings(element.propertyName)
                : element.name.text,
            );
        }
    }
    ts.forEachChild(node, definitions);
  }
  definitions(file);
  function visit(node: ts.Node) {
    let kind: Caller["kind"] | null = null;
    if (ts.isCallExpression(node)) {
      const name = method(node.expression);
      if (name === "acceptInvitationForUser") kind = "owner";
      else if (name === "acceptInvitation") kind = "journey";
      else if (
        name !== "buildUrl" &&
        node.arguments.some((argument) => /(?:^|\/)invitations\/(?:[^/]+\/)?accept$/.test(strings(argument)))
      )
        kind = "http";
    }
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) ? node.name.text : strings(node.name)) === "type" &&
      strings(node.initializer) === "AcceptInvitation"
    )
      kind = "owner";
    if (kind) calls.push({ path, line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, kind });
    ts.forEachChild(node, visit);
  }
  visit(file);
  return calls;
}

describe("invitation-acceptance-caller-partition", () => {
  it("classifies the complete tracked code-shape inventory, not path vocabulary", () => {
    const paths = execFileSync("git", ["ls-files", "--", "*.ts", "*.tsx"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    })
      .trim()
      .split(/\r?\n/)
      .filter((path) => !/(?:\.test\.|\.spec\.|\/tests\/|\/__tests__\/|\/e2e\/)/.test(path));
    const callers = paths.flatMap((path) =>
      discover(path, readFileSync(new URL(path, new URL("../../../../../", import.meta.url)), "utf8")),
    );
    writeFileSync(
      new URL("../../../../../artifacts/7420/caller-partition.json", import.meta.url),
      JSON.stringify(
        {
          callers,
          journeyZeroSets: ["admin", "mcp", "ucp", "cli", "worker", "bootstrap"],
          seedClassification:
            "Identity Invitation reconciler: synthetic owner-only fixture, never Auth attempt or Session authority",
        },
        null,
        2,
      ),
    );
    const actual = callers.map((caller) => `${caller.path}:${caller.kind}`).sort();
    expect(actual).toEqual(
      [
        "bounded-contexts/auth/client.ts:http",
        "bounded-contexts/auth/features/invitation-acceptance/api/journey.ts:owner",
        "bounded-contexts/auth/routes/marketplace/invite.tsx:journey",
        "bounded-contexts/auth/support/api-support/invitation-routes.ts:http",
        "bounded-contexts/auth/support/api-support/invitation-routes.ts:owner",
        "bounded-contexts/identity/api.ts:http",
        "bounded-contexts/identity/api.ts:owner",
        "bounded-contexts/identity/features/invitations/api/acceptance-operation.ts:owner",
        "bounded-contexts/identity/server.ts:http",
        "bounded-contexts/identity/support/runtime-support/seed.ts:owner",
      ].sort(),
    );
  });
  it.each([
    "client.acceptInvitationForUser({});",
    "const {acceptInvitationForUser: send} = client; send({});",
    'const key = "accept" + "InvitationForUser"; client[key]({});',
    'const command = "Accept" + "Invitation"; sender({type: command});',
    'const base = "/invitations/"; fetch(base + "accept", {});',
    "fetch(`/internal/auth/invitations/${id}/accept`, {});",
  ])("finds unclassified arbitrary-path and alias/computed/concatenated writers: %s", (source) => {
    expect(discover("arbitrary/no-domain-vocabulary.ts", source)).toHaveLength(1);
    expect(discover("bounded-contexts/identity/support/runtime-support/seed.ts", source)).toHaveLength(1);
  });
});
