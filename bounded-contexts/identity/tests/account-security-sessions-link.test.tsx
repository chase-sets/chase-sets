// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecurityPage } from "../features/api-keys/ui/account-security-page";
import { action, loader } from "../routes/marketplace/account-security";

const user = {
  user_id: "usr_alex",
  display_name: "Alex Clerk",
  given_name: "Alex",
  family_name: "Clerk",
  primary_email: "alex@example.com",
  status: "active",
  contact_methods: [],
  auth_methods: ["password"],
  updated_at: "2026-05-13T12:00:00.000Z",
};
const apiKeys = [
  {
    api_key_id: "key_storefront",
    user_id: user.user_id,
    user_display_name: user.display_name,
    user_primary_email: user.primary_email,
    name: "Storefront",
    key_prefix: "key_store_",
    status: "active",
    last_used_at: null,
    updated_at: user.updated_at,
  },
];
const pageSource = readFileSync(
  new NodeURL("../features/api-keys/ui/account-security-page.tsx", import.meta.url),
  "utf8",
);

function assertDesignSystemLink(source: string) {
  const file = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const links: ts.JsxOpeningElement[] = [];
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(file) === "LinkButton") links.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(links).toHaveLength(1);
  expect(
    links[0].attributes.properties.map((prop) => (ts.isJsxAttribute(prop) ? prop.name.getText(file) : "spread")),
  ).toEqual(["href", "tone"]);
  expect(source).toMatch(/LinkButton,[\s\S]*from "@chase-sets\/design-system"/);
}

type Manifest = {
  deployableContributions: {
    deployable: string;
    routes: { routePath: string; sourceContext: string; fileExport: string }[];
  }[];
};
function marketplaceSessions(manifest: Manifest) {
  return manifest.deployableContributions
    .filter(({ deployable }) => deployable === "marketplace-web")
    .flatMap(({ routes }) => routes)
    .filter(({ routePath }) => routePath === "account/sessions");
}
function assertAuthOwner(auth: Manifest, identity: Manifest) {
  expect(marketplaceSessions(auth)).toEqual([
    expect.objectContaining({
      sourceContext: "auth",
      fileExport: "./routes/marketplace/account-sessions",
    }),
  ]);
  expect(marketplaceSessions(identity)).toEqual([]);
}

function assertFormIntents(intents: string[]) {
  expect(intents).toEqual(["update-user", "create-api-key", "rotate-api-key", "revoke-api-key"]);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("account-security-sessions-link", () => {
  it.each([{ keys: apiKeys }, { keys: [] }])(
    "renders one visible localized Sessions destination with exact href",
    ({ keys }) => {
      render(<SecurityPage user={user} apiKeys={keys} />);
      const links = screen.getAllByRole("link", { name: "Manage sessions" });
      expect(links).toHaveLength(1);
      expect(links[0].getAttribute("href")).toBe("/account/sessions");
      const section = screen.getByRole("heading", { name: "Security Signals" }).closest("section")!;
      expect(within(section).getByRole("link", { name: "Manage sessions" })).toBe(links[0]);
    },
  );

  it("uses the existing design-system LinkButton with native keyboard-reachable anchor semantics", () => {
    assertDesignSystemLink(pageSource);
    render(<SecurityPage user={user} apiKeys={apiKeys} />);
    const link = screen.getByRole("link", { name: "Manage sessions" });
    expect(link.tagName).toBe("A");
    expect(link.tabIndex).toBe(0);
    link.focus();
    expect(document.activeElement).toBe(link);
    expect(link.closest("form")).toBeNull();
  });

  it("rejects named mutant raw-anchor-instead-of-LinkButton", () => {
    expect(() =>
      assertDesignSystemLink(pageSource.replaceAll("<LinkButton", "<a").replaceAll("</LinkButton>", "</a>")),
    ).toThrow();
  });

  it("retains profile/API-key form intents and protection metrics without any loader call from render", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<SecurityPage user={user} apiKeys={apiKeys} />);
    expect(screen.getByRole("button", { name: "Update Profile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create API Key" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rotate" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(screen.getByRole("button", { name: "Confirm revoke" })).toBeTruthy();
    const intents = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="intent"]')).map(
      ({ value }) => value,
    );
    assertFormIntents(intents);
    expect(screen.getByText("Account Protection")).toBeTruthy();
    expect(screen.getAllByText("Password").length).toBeGreaterThan(0);
    expect(screen.getByText("1 total keys tracked")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects named mutant changed-profile-form-intent", () => {
    expect(() =>
      assertFormIntents(["manage-sessions", "create-api-key", "rotate-api-key", "revoke-api-key"]),
    ).toThrow();
  });

  it.each(["loader", "action"])(
    "keeps %s permission-gated without Security data reads for an unauthorized actor",
    async (kind) => {
      const fetch = vi.fn(async (_input: RequestInfo | URL) =>
        Response.json({
          actor: {
            sessionId: "ses_test",
            tenantId: "tnt_test",
            userId: user.user_id,
            accountId: "acc_test",
            membershipId: "mbr_test",
            roleKey: "viewer",
            permissions: [],
          },
        }),
      );
      vi.stubGlobal("fetch", fetch);
      const request = new Request(
        "https://chasesets.test/account/security",
        kind === "action"
          ? {
              method: "POST",
              body: new URLSearchParams({ intent: "update-user", displayName: "Alex" }),
            }
          : undefined,
      );
      const call =
        kind === "loader" ? loader({ request, params: {}, context: {} }) : action({ request, params: {}, context: {} });
      await expect(call).rejects.toMatchObject({ status: 403 });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0][0])).toContain("/api/auth/session");
    },
  );

  it("keeps the contributed destination exclusively Auth-owned and rejects named mutant missing-Auth-route", () => {
    const auth = JSON.parse(readFileSync(new NodeURL("../../auth/context.json", import.meta.url), "utf8")) as Manifest;
    const identity = JSON.parse(readFileSync(new NodeURL("../context.json", import.meta.url), "utf8")) as Manifest;
    assertAuthOwner(auth, identity);
    const mutant = structuredClone(auth);
    for (const contribution of mutant.deployableContributions)
      contribution.routes = contribution.routes.filter(({ routePath }) => routePath !== "account/sessions");
    expect(() => assertAuthOwner(mutant, identity)).toThrow();
  });
});
