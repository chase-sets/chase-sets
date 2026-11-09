import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { CHASE_SETS_READ_TARGET_CONTEXT_HEADER } from "@chase-sets/http/responses";
import { resolveCurrentActorDisplay, resolveMarketplaceRootTheme, type CurrentActorDisplay } from "../../server";

const actor: ResolvedActor = {
  userId: "usr_identity_root",
  accountId: "acc_identity_root",
  tenantId: "acc_identity_root",
  sessionId: "ses_identity_root",
  membershipId: "mbr_identity_root",
  roleKey: "manager",
  permissions: ["accounts.view"],
};
const display: CurrentActorDisplay = {
  account: { account_id: actor.accountId, display_name: "Root Cards", name: "Root Cards LLC", badges: ["founder"] },
  membership: { membership_id: actor.membershipId, role_key: actor.roleKey },
  user: { user_id: actor.userId, display_name: "Root User", primary_email: "root@example.test" },
};
const guests: ReadonlyArray<readonly [string, ResolvedActor | null]> = [
  ["null actor", null],
  ["guest actor", { ...actor, roleKey: "guest-buyer" }],
];

function request(cookie = "") {
  return new Request("http://localhost/account", {
    headers: { cookie, authorization: "Bearer synthetic-root", "Idempotency-Key": "synthetic-root-key" },
  });
}

function stubRead(body: unknown, status = 200) {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json(body, { status });
    }),
  );
  return requests;
}

function expectIdentityRead(requests: Request[], path: string, cookie: string) {
  expect(requests.map((read) => new URL(read.url).pathname)).toEqual([`/api/identity/${path}`]);
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer synthetic-root");
  expect(requests[0]?.headers.get("cookie")).toBe(cookie || null);
  expect(requests[0]?.headers.get("Idempotency-Key")).toBeNull();
  expect(requests[0]?.headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("identity");
}

afterEach(() => vi.unstubAllGlobals());

describe("marketplace root actor display resolver skips guests and fails soft", () => {
  it.each(guests)("skips Identity reads for %s", async (_name, guest) => {
    const requests = stubRead(display);
    expect(await resolveCurrentActorDisplay(request(), guest)).toBeNull();
    expect(requests).toEqual([]);
  });

  it("returns the signed-in display object with existing root forwarding semantics", async () => {
    const requests = stubRead(display);
    expect(await resolveCurrentActorDisplay(request("session=synthetic"), actor)).toEqual(display);
    expectIdentityRead(requests, "current-actor-display", "session=synthetic");
  });

  it("returns null on a failed display read", async () => {
    const requests = stubRead({}, 503);
    expect(await resolveCurrentActorDisplay(request(), actor)).toBeNull();
    expectIdentityRead(requests, "current-actor-display", "");
  });
});

describe("marketplace root theme resolver preserves preference, cookie, system and failure fallbacks", () => {
  it.each(guests)("keeps system defaults and skips Identity for %s even with a cookie", async (_name, guest) => {
    const requests = stubRead({ colorMode: "light", reducedMotion: "reduce" });
    expect(await resolveMarketplaceRootTheme(request("chase_sets_color_mode=dark"), guest)).toEqual({
      colorMode: "system",
      cookieSeedColorMode: null,
      viewer: null,
    });
    expect(requests).toEqual([]);
  });

  it.each([
    {
      name: "preference over cookie",
      preferences: { colorMode: "dark", reducedMotion: "reduce" },
      cookie: "chase_sets_color_mode=light",
      colorMode: "dark",
      seed: "dark",
    },
    {
      name: "system preference over cookie",
      preferences: { colorMode: "system", reducedMotion: "user" },
      cookie: "chase_sets_color_mode=dark",
      colorMode: "system",
      seed: "system",
    },
    {
      name: "cookie without preference",
      preferences: { reducedMotion: "user" },
      cookie: "chase_sets_color_mode=light",
      colorMode: "light",
      seed: null,
    },
    {
      name: "system without preference or cookie",
      preferences: { reducedMotion: "user" },
      cookie: "",
      colorMode: "system",
      seed: null,
    },
  ])("preserves $name", async ({ preferences, cookie, colorMode, seed }) => {
    const requests = stubRead(preferences);
    expect(await resolveMarketplaceRootTheme(request(cookie), actor)).toEqual({
      colorMode,
      cookieSeedColorMode: seed,
      viewer: { actor, preferences: { colorMode: preferences.colorMode, reducedMotion: preferences.reducedMotion } },
    });
    expectIdentityRead(requests, "preferences", cookie);
  });

  it.each(["chase_sets_color_mode=light", ""])("preserves failure fallback for cookie %s", async (cookie) => {
    const requests = stubRead({}, 503);
    expect(await resolveMarketplaceRootTheme(request(cookie), actor)).toEqual({
      colorMode: cookie ? "light" : "system",
      cookieSeedColorMode: null,
      viewer: cookie ? { actor, preferences: { colorMode: "light", reducedMotion: "user" } } : null,
    });
    expectIdentityRead(requests, "preferences", cookie);
  });
});
