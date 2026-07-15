// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
import { defineAuthHost } from "./auth-host";
import { createMagicLinkLandingLoader, MagicLinkLandingPage } from "./magic-link-landing";

const host = defineAuthHost({
  signInPath: "/sign-in",
  fallbackPath: "/account",
  defaultSuccessPath: "/account",
  accountSelectionPath: "/account/select",
  signedOutReturnTo: "/search",
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function createLoaderArgs(request: Request): LoaderFunctionArgs {
  return {
    request,
    params: {},
    context: {},
  } as LoaderFunctionArgs;
}

function createSessionStartedResult() {
  return {
    type: "session-started",
    userId: "usr_1",
    sessionId: "ses_1",
    sessionToken: "session_token",
    session: {
      session_id: "ses_1",
      user_id: "usr_1",
      user_display_name: null,
      user_primary_email: "seller@example.test",
      account_id: "acc_1",
      account_display_name: "Seller",
      account_name: "Seller",
      available_account_ids: ["acc_1"],
      authentication_method: "magic-link",
      status: "active",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    },
    memberships: [],
  };
}

describe("magic link landing route", () => {
  it("renders one top-level heading when authentication cannot continue", () => {
    render(
      <MagicLinkLandingPage
        data={{
          title: "Magic link expired or was already used",
          description: "Request a new sign-in link to continue.",
          signInHref: "/sign-in",
        }}
      />,
    );

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Magic link expired or was already used" })).toBeTruthy();
  });

  it("consumes a token from a GET landing route and starts the browser session", async () => {
    let requestBody: unknown;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json(createSessionStartedResult());
    });
    vi.stubGlobal("fetch", fetch);
    const loader = createMagicLinkLandingLoader({ authHost: host, signInPath: "/sign-in" });

    const response = await loader(
      createLoaderArgs(new Request("https://marketplace.test/sign-in/magic?token=magic_token&returnTo=/account/cart")),
    );

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("Location")).toBe("/account/cart");
    expect((response as Response).headers.getSetCookie().join(";")).toContain("chase_sets_session=session_token");
    expect(requestBody).toEqual({ token: "magic_token" });
  });

  it("renders a re-request affordance when the link is missing its token", async () => {
    const loader = createMagicLinkLandingLoader({ authHost: host, signInPath: "/sign-in" });

    const data = await loader(
      createLoaderArgs(new Request("https://marketplace.test/sign-in/magic?returnTo=/account/cart")),
    );

    expect(data).toEqual({
      title: "Magic link could not be completed",
      description: "This sign-in link is missing its token. Request a new link to continue.",
      signInHref: "/sign-in?returnTo=%2Faccount%2Fcart",
    });
  });

  it("renders a re-request affordance when the token is invalid, expired, or consumed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({ error: "Magic link is invalid or has expired." }, { status: 401 }),
      ),
    );
    const loader = createMagicLinkLandingLoader({ authHost: host, signInPath: "/sign-in" });

    const data = await loader(
      createLoaderArgs(new Request("https://marketplace.test/sign-in/magic?token=consumed&returnTo=/account/cart")),
    );

    expect(data).toEqual({
      title: "Magic link expired or was already used",
      description: "Request a new sign-in link to continue.",
      signInHref: "/sign-in?returnTo=%2Faccount%2Fcart",
    });
  });
});
