import { readFileSync } from "node:fs";
import ts from "@chase-sets/typescript-compiler-api";
import { expect, it } from "vitest";
import { AuthApiError } from "../../client";
import { authApiActionError } from "./auth-action-errors";
import { SOCIAL_LOGIN_ERROR_MESSAGES, socialLoginErrorMessage } from "./social-login-errors";
import { loader as signInLoader } from "../../routes/marketplace/sign-in";
import { loader as registerLoader } from "../../routes/marketplace/register";

const marker = "Bearer synthetic-source-partition-marker";
function source(relative: string) {
  return ts.createSourceFile(
    relative,
    readFileSync(new URL(relative, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

it("keeps browser-facing error adapters free of server runtime imports", () => {
  const file = source("./auth-action-errors.ts");
  const serverImports = file.statements.filter(
    (node) =>
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.endsWith("/server") &&
      !node.importClause?.isTypeOnly,
  );
  expect(serverImports.map((node) => node.getText(file))).toEqual([]);
});

it("derives the legacy producer partition from source with an unknown fail-closed default", () => {
  const outcomes: { producer: string; status: number }[] = [];
  for (const producer of ["phone-code", "magic-link", "password", "register", "invitation", "passkey"]) {
    const file = source(`../api-support/${producer}-routes.ts`);
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "json" &&
        node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0]) &&
        node.arguments[0].properties.some(
          (property) => ts.isPropertyAssignment(property) && property.name.getText(file) === "error",
        ) &&
        node.arguments[1] &&
        ts.isNumericLiteral(node.arguments[1])
      ) {
        outcomes.push({ producer, status: Number(node.arguments[1].text) });
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  expect(new Set(outcomes.map((row) => row.producer))).toEqual(
    new Set(["phone-code", "magic-link", "password", "register", "invitation", "passkey"]),
  );
  for (const { status } of outcomes) {
    const result = authApiActionError(new AuthApiError(status, { error: marker }), "password");
    expect(result.classification).toBe(status === 401 || status === 409 ? "FORM" : "INDETERMINATE");
    expect(result.errors.fieldErrors).toEqual({});
    expect(JSON.stringify(result)).not.toContain(marker);
  }
  for (const status of [400, 401, 403, 404, 409, 429, 500, 503]) {
    expect(
      authApiActionError(new AuthApiError(status, { error: { code: "unknown", message: marker } }), "password")
        .classification,
    ).toBe("INDETERMINATE");
  }
});

it("rejects raw message and token markers at social destinations", () => {
  const file = source("../api-support/social-login-routes.ts");
  const routed = new Set<string>();
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "redirectToFallback"
    ) {
      const value = node.arguments[0];
      if (value && ts.isStringLiteral(value)) routed.add(value.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  // Admission and link-conflict codes come from the existing typed branches.
  routed.add("registration_admission_required");
  routed.add("disposable_email_domain");
  routed.add("provider_already_linked");
  expect([...routed].sort()).toEqual(Object.keys(SOCIAL_LOGIN_ERROR_MESSAGES).sort());
  for (const value of [
    marker,
    "constructor",
    "__proto__",
    "provider_failed ",
    "Invalid email or password.",
    ...routed,
  ]) {
    const request = new Request(`https://marketplace.test/sign-in?socialLoginError=${encodeURIComponent(value)}`);
    for (const loader of [signInLoader, registerLoader]) {
      const result = loader({ request, params: {}, context: {}, url: new URL(request.url), pattern: "/sign-in" });
      expect(result.socialLoginError).toBe(socialLoginErrorMessage(value));
      expect(JSON.stringify(result)).not.toContain(marker);
    }
  }
  expect(socialLoginErrorMessage(null)).toBeNull();
});
