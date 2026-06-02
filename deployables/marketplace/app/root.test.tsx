import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseLoaderData, mockUseLocation } = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockUseLocation: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    Links: () => null,
    Meta: () => null,
    Outlet: () => null,
    Scripts: () => null,
    ScrollRestoration: () => null,
    useLoaderData: mockUseLoaderData,
    useLocation: mockUseLocation,
  };
});

import { Layout, loader } from "./root";

function createLoaderArgs(url: string): Parameters<typeof loader>[0] {
  return {
    request: new Request(url),
    params: {},
    context: {},
    url: new URL(url),
    pattern: "*",
  };
}

describe("marketplace root layout", () => {
  beforeEach(() => {
    mockUseLocation.mockReturnValue({
      pathname: "/search",
      search: "?search=charizard",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("falls back to a safe origin when loader data is unavailable", () => {
    mockUseLoaderData.mockReturnValue(undefined);

    const html = renderToString(
      <Layout>
        <main>Marketplace Search</main>
      </Layout>,
    );

    expect(html).toContain(`href="${window.location.origin}/search?search=charizard"`);
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('rel="icon" href="/favicon.svg"');
    expect(html).toContain('rel="alternate icon" href="/favicon.ico"');
    expect(html).toContain("Marketplace Search");
  });

  it("uses the loader origin when it is available", () => {
    mockUseLoaderData.mockReturnValue({
      actor: null,
      origin: "https://marketplace.example",
      shouldIndex: true,
    });

    const html = renderToString(
      <Layout>
        <main>Marketplace Search</main>
      </Layout>,
    );

    expect(html).toContain('href="https://marketplace.example/search?search=charizard"');
  });

  it("can noindex staging through environment configuration", () => {
    vi.stubEnv("CHASE_SETS_MARKETPLACE_INDEXING", "false");
    mockUseLoaderData.mockReturnValue({
      actor: null,
      origin: "https://marketplace.staging.chasesets.com",
      shouldIndex: false,
    });

    const html = renderToString(
      <Layout>
        <main>Marketplace Search</main>
      </Layout>,
    );

    expect(html).toContain('name="robots" content="noindex,nofollow"');
  });

  it("redirects anonymous production proof marketplace requests to sign-in", async () => {
    vi.stubEnv("CHASE_SETS_MARKETPLACE_PROOF_ACCESS_REQUIRED", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: "Authentication required." }), { status: 401 })),
      ),
    );

    let thrown: unknown;
    try {
      await loader(createLoaderArgs("https://marketplace.chasesets.com/search?q=charizard"));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("Location")).toBe("/sign-in?returnTo=%2Fsearch%3Fq%3Dcharizard");
  });

  it("allows proof sign-in routes to render before an actor exists", async () => {
    vi.stubEnv("CHASE_SETS_MARKETPLACE_PROOF_ACCESS_REQUIRED", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: "Authentication required." }), { status: 401 })),
      ),
    );

    const data = await loader(createLoaderArgs("https://marketplace.chasesets.com/sign-in?returnTo=%2F"));

    expect(data.actor).toBeNull();
    expect(data.origin).toBe("https://marketplace.chasesets.com");
  });

  it("does not expose sitemap routes before proof access is authenticated", async () => {
    vi.stubEnv("CHASE_SETS_MARKETPLACE_PROOF_ACCESS_REQUIRED", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: "Authentication required." }), { status: 401 })),
      ),
    );

    let thrown: unknown;
    try {
      await loader(createLoaderArgs("https://marketplace.chasesets.com/sitemap.xml"));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("Location")).toBe("/sign-in?returnTo=%2Fsitemap.xml");
  });

  it("requires the proof access permission for signed-in production proof actors", async () => {
    vi.stubEnv("CHASE_SETS_MARKETPLACE_PROOF_ACCESS_REQUIRED", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            actor: {
              userId: "usr_1",
              accountId: "acc_1",
              tenantId: "acc_1",
              sessionId: "ses_1",
              permissions: ["accounts.view"],
            },
          }),
        ),
      ),
    );

    let thrown: unknown;
    try {
      await loader(createLoaderArgs("https://marketplace.chasesets.com/search"));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(403);
  });
});
