// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { t } from "@chase-sets/localization";
import { afterEach, describe, expect, it, vi } from "vitest";
import MarketplaceAccountRoute, {
  action as profileAction,
  loader as profileLoader,
} from "../routes/marketplace/account";
import MarketplaceAccountSecurityRoute, {
  action as securityAction,
  loader as securityLoader,
} from "../routes/marketplace/account-security";
import MarketplaceAccountTeamRoute, {
  action as teamAction,
  loader as teamLoader,
} from "../routes/marketplace/account-team";
import { IdentityApiError } from "../client";

const marker = "Bearer synthetic-inline-error-control";
const actor = {
  sessionId: "ses_identity",
  tenantId: "tnt_identity",
  userId: "usr_identity",
  accountId: "acc_identity",
  membershipId: "mbr_identity",
  roleKey: "owner",
  permissions: ["accounts.manage", "accounts.view", "security.manage", "memberships.manage", "memberships.view"],
};

const routes = [
  {
    source: "account",
    path: "/account",
    action: profileAction,
    loader: profileLoader,
    Component: MarketplaceAccountRoute,
    forms: [{ intent: "update-profile", name: "Card Vault LLC", displayName: "Card Vault" }],
  },
  {
    source: "account-security",
    path: "/account/security",
    action: securityAction,
    loader: securityLoader,
    Component: MarketplaceAccountSecurityRoute,
    forms: [
      { intent: "update-user", displayName: "Alex", givenName: "Alex", familyName: "Collector" },
      { intent: "create-api-key", name: "Ops" },
      { intent: "rotate-api-key", apiKeyId: "key_identity" },
      { intent: "revoke-api-key", apiKeyId: "key_identity" },
    ],
  },
  {
    source: "account-team",
    path: "/account/team",
    action: teamAction,
    loader: teamLoader,
    Component: MarketplaceAccountTeamRoute,
    forms: [
      { intent: "create-invitation", email: "invitee@example.com", roleKey: "viewer" },
      { intent: "change-role", membershipId: "mbr_identity", roleKey: "viewer" },
      { intent: "revoke", membershipId: "mbr_identity" },
      { intent: "reinstate", membershipId: "mbr_identity" },
      { intent: "cancel-invitation", invitationId: "ivt_identity" },
    ],
  },
] as const;

const cases = routes.flatMap((route) => route.forms.map((form) => ({ ...route, form, intent: form.intent })));
const admitted = [
  { status: 400, code: "validation_failed", kind: "validation" },
  { status: 400, code: "validation_error", kind: "validation" },
  { status: 422, code: "validation_failed", kind: "validation" },
  { status: 422, code: "validation_error", kind: "validation" },
  { status: 404, code: "not_found", kind: "domain" },
  { status: 409, code: "conflict", kind: "domain" },
] as const;

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function errorBody(code: unknown) {
  return { error: { code, message: marker, credentials: marker }, secret: marker };
}

function args(path: string, form: Record<string, string>): Parameters<typeof profileAction>[0] {
  return {
    request: new Request(`https://chasesets.test${path}`, {
      method: "POST",
      body: new URLSearchParams(form),
      headers: { authorization: marker },
    }),
    params: {},
    context: undefined,
  };
}

function stubMutation(mutation: (request: Request) => Response | Promise<Response>) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.includes("/api/auth/session")) return json({ actor });
    return mutation(request);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function mutationCalls(fetch: ReturnType<typeof stubMutation>) {
  return fetch.mock.calls.filter(
    ([input]) => !String(input instanceof Request ? input.url : input).includes("/api/auth/session"),
  );
}

function silenceLogs() {
  return ["error", "warn", "log", "info", "debug"].map((method) =>
    vi.spyOn(console, method as "error").mockImplementation(() => {}),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Identity marketplace route action errors", () => {
  it("derives the complete ten-intent caller partition from the route sources", () => {
    for (const route of routes) {
      const source = readFileSync(
        path.resolve(import.meta.dirname, `../routes/marketplace/${route.source}.tsx`),
        "utf8",
      );
      const file = ts.createSourceFile(route.source, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const intents: string[] = [];
      function visit(node: ts.Node) {
        if (
          ts.isPropertyAssignment(node) &&
          node.name.getText(file) === "intents" &&
          ts.isObjectLiteralExpression(node.initializer)
        ) {
          for (const property of node.initializer.properties) {
            if (property.name && (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name)))
              intents.push(property.name.text);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(file);
      expect(intents.sort()).toEqual(route.forms.map((form) => form.intent).sort());
    }
    expect(cases).toHaveLength(10);
  });

  it.each(cases)(
    "$intent admits only safe catalogue failures with upstream status",
    async ({ action, path, form, intent }) => {
      const logs = silenceLogs();
      for (const failure of admitted) {
        const fetch = stubMutation(() => json(errorBody(failure.code), failure.status));
        const result = await action(args(path, form));
        expect(result).toMatchObject({
          data: {
            failure: {
              kind: failure.kind,
              status: failure.status,
              code: failure.code,
              intent,
              message: expect.any(String),
            },
          },
          init: { status: failure.status },
        });
        expect(Object.keys((result as { data: object }).data)).toEqual(["failure"]);
        const safeFailure = (result as { data: { failure: Record<string, unknown> } }).data.failure;
        expect(Object.keys(safeFailure).sort()).toEqual(["code", "intent", "kind", "message", "status"]);
        expect(safeFailure.message).toBe(
          failure.kind === "validation"
            ? t("identity.support.routeSupport.accountActionErrors.validation")
            : failure.code === "not_found"
              ? t("identity.support.routeSupport.accountActionErrors.notFound")
              : t("identity.support.routeSupport.accountActionErrors.conflict"),
        );
        expect(JSON.stringify(result)).not.toContain(marker);
        expect(mutationCalls(fetch)).toHaveLength(1);
      }
      expect(JSON.stringify(logs.map((log) => log.mock.calls))).not.toContain(marker);
    },
  );

  it.each(cases)(
    "$intent rejects status/code mismatches and secret-bearing negatives",
    async ({ action, path, form }) => {
      const logs = silenceLogs();
      const negatives = [
        ...[401, 403, 500, 503].flatMap((status) => admitted.map(({ code }) => ({ status, code }))),
        ...[400, 422, 404, 409].flatMap((status) =>
          ["validation_failed", "validation_error", "not_found", "conflict", "authorization_forbidden", "unknown", null]
            .filter((code) => !admitted.some((entry) => entry.status === status && entry.code === code))
            .map((code) => ({ status, code })),
        ),
      ];
      for (const failure of negatives) {
        const fetch = stubMutation(() => json(errorBody(failure.code), failure.status));
        await expect(action(args(path, form))).rejects.toMatchObject({
          status: failure.status,
          body: errorBody(failure.code),
        });
        expect(mutationCalls(fetch)).toHaveLength(1);
      }
      const unexpected = [
        new Response(marker, { status: 400 }),
        new TypeError(marker),
        new SyntaxError(marker),
        new Error(marker),
        { status: 400, body: errorBody("validation_failed") },
        Object.assign(new Error(marker), { status: 409, body: errorBody("validation_failed") }),
      ];
      for (const error of unexpected) {
        const fetch = stubMutation(() => {
          throw error;
        });
        await expect(action(args(path, form))).rejects.toBe(error);
        expect(mutationCalls(fetch)).toHaveLength(1);
      }
      for (const status of [200, 400]) {
        const fetch = stubMutation(
          () => new Response("not-json", { status, headers: { "content-type": "application/json" } }),
        );
        await expect(action(args(path, form))).rejects.toBeInstanceOf(status === 200 ? SyntaxError : IdentityApiError);
        expect(mutationCalls(fetch)).toHaveLength(1);
      }
      expect(logs.flatMap((log) => log.mock.calls)).toEqual([]);
    },
  );

  it.each(routes)("$source missing/unknown intent preserves redirect without mutations", async ({ action, path }) => {
    const unknownForms: Record<string, string>[] = [{}, { intent: "unknown" }];
    for (const form of unknownForms) {
      const fetch = stubMutation(() => {
        throw new Error("unexpected mutation");
      });
      const result = await action(args(path, form));
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(302);
      expect((result as Response).headers.get("Location")).toBe(path);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(mutationCalls(fetch)).toHaveLength(0);
    }
  });

  it.each(routes)(
    "$source authorization and form parsing errors stay outside the classifier",
    async ({ action, path, forms }) => {
      const logs = silenceLogs();
      const authorizationError = new IdentityApiError(400, errorBody("validation_failed"));
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          throw authorizationError;
        }),
      );
      await expect(action(args(path, forms[0]))).rejects.toMatchObject({ name: "AuthResolutionError", status: 503 });
      const fetch = stubMutation(() => {
        throw new Error("unexpected mutation");
      });
      const invalid = args(path, forms[0]);
      const parseError = new TypeError(marker);
      vi.spyOn(invalid.request, "formData").mockRejectedValue(parseError);
      await expect(action(invalid)).rejects.toBe(parseError);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(logs.flatMap((log) => log.mock.calls)).toEqual([]);
    },
  );

  it.each(routes)("$source retains, replaces, clears and escalates real routed failures", async (route) => {
    let failure: { status: number; code: string } | null = admitted[0];
    let writes = 0;
    let loaderReads = 0;
    const account = {
      account_id: actor.accountId,
      account_type: "business",
      badges: [],
      display_name: "Card Vault",
      name: "Card Vault LLC",
      status: "active",
      updated_at: "2026-10-01T12:00:00Z",
    };
    const user = {
      user_id: actor.userId,
      display_name: "Alex",
      given_name: "Alex",
      family_name: "Collector",
      primary_email: "alex@example.com",
      contact_methods: [],
      auth_methods: [],
      status: "active",
      updated_at: "",
    };
    stubMutation((request) => {
      const url = new URL(request.url);
      if (request.method !== "GET") {
        writes++;
        return failure
          ? json(errorBody(failure.code), failure.status)
          : json({ id: "written", secret: "synthetic-one-time-secret", keyPrefix: "key_test" });
      }
      loaderReads++;
      if (url.pathname.endsWith(`/accounts/${actor.accountId}`)) return json(account);
      if (url.pathname.endsWith(`/users/${actor.userId}`)) return json(user);
      if (url.pathname.endsWith("/current-actor-display")) return json(null);
      return json({ items: [], total: 0, count: 0 });
    });
    const router = createMemoryRouter(
      [
        {
          path: route.path,
          action: route.action,
          loader: route.loader,
          Component: route.Component,
          HydrateFallback: () => null,
          errorElement: <div data-testid="boundary">Unexpected failure</div>,
        },
      ],
      { initialEntries: [route.path] },
    );
    try {
      render(<RouterProvider router={router} />);
      const intent = route.forms[0].intent;
      await waitFor(() => expect(document.querySelector(`input[name="intent"][value="${intent}"]`)).not.toBeNull());
      const input = document.querySelector<HTMLInputElement>(`input[name="intent"][value="${intent}"]`)!;
      const form = input.closest("form")!;
      if (route.source === "account-team")
        fireEvent.change(screen.getByLabelText("Email"), { target: { value: "invitee@example.com" } });
      const transitions: string[] = [];
      const unsubscribe = router.subscribe((state) => transitions.push(state.navigation.state));
      const submit = async () => {
        const body = new URLSearchParams();
        for (const [key, value] of new FormData(form)) body.append(key, String(value));
        await act(async () => {
          await router.navigate(route.path, { formMethod: "post", body });
        });
        await waitFor(() => expect(router.state.navigation.state).toBe("idle"));
      };
      const readsBefore = loaderReads;
      await submit();
      const first = screen.getByRole("alert").textContent;
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.queryByTestId("boundary")).toBeNull();
      expect(form.isConnected).toBe(true);
      expect(router.state.loaderData["0"]).toBeTruthy();
      expect(router.state.actionData?.["0"]).toMatchObject({ failure: { status: 400, intent } });
      expect(transitions).toContain("submitting");
      expect(transitions.at(-1)).toBe("idle");
      expect(loaderReads).toBe(readsBefore);
      failure = admitted[5];
      await submit();
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.getByRole("alert").textContent).not.toBe(first);
      expect(document.body.textContent).not.toContain(marker);
      failure = null;
      await submit();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(form.isConnected).toBe(true);
      expect(loaderReads).toBeGreaterThan(readsBefore);
      expect(transitions).toContain("loading");
      failure = { status: 500, code: "validation_failed" };
      await submit();
      expect(screen.getByTestId("boundary")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(writes).toBe(route.source === "account-team" ? 5 : 4);
      unsubscribe();
    } finally {
      router.dispose();
    }
  });

  it("does not retry or change submit semantics", async () => {
    for (const { action, path, form } of cases) {
      const requests: Request[] = [];
      const fetch = stubMutation((request) => {
        requests.push(request);
        return json(errorBody("conflict"), 409);
      });
      await action(args(path, form));
      expect(mutationCalls(fetch)).toHaveLength(1);
      expect(["POST", "PUT"]).toContain(requests[0].method);
      const body = await requests[0].json();
      for (const [key, value] of Object.entries(form)) {
        if (["intent", "apiKeyId", "membershipId", "invitationId"].includes(key)) continue;
        expect(body[key]).toBe(value);
      }
    }
  });
});
