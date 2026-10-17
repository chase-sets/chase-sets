import { readFileSync } from "node:fs";
import ts from "@chase-sets/typescript-compiler-api";
import { afterEach, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import { t } from "@chase-sets/localization";
import { AuthApiError } from "../../client";
import { AUTH_ACTION_INTENTS, authApiActionError, type AuthActionIntent } from "./auth-action-errors";
import { defineAuthHost, toAuthActionError } from "./auth-host";
import { SOCIAL_LOGIN_ERROR_MESSAGES, socialLoginErrorMessage } from "./social-login-errors";
import { loader as signInLoader } from "../../routes/marketplace/sign-in";
import { loader as registerLoader } from "../../routes/marketplace/register";

const marker = "Bearer synthetic-source-partition-marker";
afterEach(() => vi.unstubAllGlobals());

const unauthorizedCopy = {
  password: "auth.support.apiSupport.passwordRoutes.invalid.email.or.password",
  "phone-code-consume": "auth.support.apiSupport.phoneCodeRoutes.phone.code.is.invalid.or.has",
  "magic-link-consume": "auth.support.apiSupport.magicLinkRoutes.magic.link.is.invalid.or.has",
  "account-selection": "auth.support.apiSupport.accountSelectionRoutes.account.selection.is.invalid.or.has",
} as const;

function expectedUnauthorizedCopy(intent: AuthActionIntent) {
  return t(
    unauthorizedCopy[intent as keyof typeof unauthorizedCopy] ?? "auth.support.routeSupport.authHost.request.failed",
  );
}

it.each(AUTH_ACTION_INTENTS)("uses safe intent-specific FORM copy for a legacy 401: %s", (intent) => {
  const result = authApiActionError(new AuthApiError(401, { error: marker }), intent);
  expect(result).toEqual({
    error: expectedUnauthorizedCopy(intent),
    intent,
    classification: "FORM",
    errors: { fieldErrors: {}, formErrors: [expectedUnauthorizedCopy(intent)] },
  });
  if (intent !== "password") expect(result.error).not.toBe(t(unauthorizedCopy.password));
  expect(JSON.stringify(result)).not.toContain(marker);
});

it.each([
  ["phone-code-consume", "Phone code is invalid or has expired."],
  ["magic-link-consume", "Magic link is invalid or has expired."],
  ["passkey-sign-in", "Passkey challenge is invalid or expired."],
  ["invitation-accept", "Invitation acceptance token is invalid or expired."],
  ["account-selection", "Account selection is invalid or has expired."],
] as const)("regresses the reviewer's legacy 401 probe: %s", async (intent, message) => {
  const error = { error: message };
  const host = defineAuthHost({
    signInPath: "/sign-in",
    fallbackPath: "/account",
    defaultSuccessPath: "/account",
    accountSelectionPath: "/account/select",
    signedOutReturnTo: "/sign-in",
    allowManualMagicLinkTokenEntry: true,
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(error, { status: 401 })));
  const request = new Request("https://marketplace.test/sign-in", {
    method: "POST",
    body: new URLSearchParams({ intent, phone: "+13125550101", code: "000000", tokenId: "t", token: "t" }),
  });
  const args: ActionFunctionArgs = {
    request,
    params: {},
    context: {},
    url: new URL(request.url),
    pattern: "/sign-in",
  };
  const result =
    intent === "invitation-accept" || intent === "account-selection"
      ? toAuthActionError(new AuthApiError(401, error), intent)
      : await host.createSignInAction()(args);
  expect(result).toMatchObject({
    error: expectedUnauthorizedCopy(intent),
    intent,
    classification: "FORM",
    errors: { fieldErrors: {}, formErrors: [expectedUnauthorizedCopy(intent)] },
  });
  expect(result).not.toMatchObject({ error: t(unauthorizedCopy.password) });
});
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
  for (const producer of [
    "phone-code",
    "magic-link",
    "password",
    "register",
    "invitation",
    "passkey",
    "account-selection",
  ]) {
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
    new Set(["phone-code", "magic-link", "password", "register", "invitation", "passkey", "account-selection"]),
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
