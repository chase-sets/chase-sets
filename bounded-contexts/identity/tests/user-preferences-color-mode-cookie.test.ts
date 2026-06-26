import { describe, expect, it } from "vitest";
import {
  USER_PREFERENCES_COLOR_MODE_COOKIE_NAME,
  createUserPreferencesColorModeCookieSeedHeaders,
  readUserPreferencesColorModeCookie,
  serializeUserPreferencesColorModeCookie,
} from "../features/preferences/api/color-mode-cookie";

describe("user preferences color mode cookie mirror", () => {
  it("reads only supported color mode values from the cookie mirror", () => {
    expect(
      readUserPreferencesColorModeCookie(
        new Request("https://admin.test/catalog", {
          headers: { cookie: `${USER_PREFERENCES_COLOR_MODE_COOKIE_NAME}=dark` },
        }),
      ),
    ).toBe("dark");
    expect(
      readUserPreferencesColorModeCookie(
        new Request("https://admin.test/catalog", {
          headers: { cookie: `${USER_PREFERENCES_COLOR_MODE_COOKIE_NAME}=sepia` },
        }),
      ),
    ).toBeNull();
    expect(
      readUserPreferencesColorModeCookie(
        new Request("https://admin.test/catalog", {
          headers: { cookie: `${USER_PREFERENCES_COLOR_MODE_COOKIE_NAME}=%` },
        }),
      ),
    ).toBeNull();
  });

  it("serializes a server-readable mirror cookie for first paint", () => {
    expect(serializeUserPreferencesColorModeCookie("light", new Request("https://admin.test/catalog"))).toContain(
      `${USER_PREFERENCES_COLOR_MODE_COOKIE_NAME}=light; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000; Secure`,
    );
  });

  it("seeds the cookie only when the signed-in read model differs from the mirror", () => {
    const matchingRequest = new Request("https://admin.test/catalog", {
      headers: { cookie: `${USER_PREFERENCES_COLOR_MODE_COOKIE_NAME}=dark` },
    });
    const missingRequest = new Request("https://admin.test/catalog");

    expect(createUserPreferencesColorModeCookieSeedHeaders(matchingRequest, "dark")).toBeNull();
    expect(createUserPreferencesColorModeCookieSeedHeaders(missingRequest, "dark")?.get("Set-Cookie")).toContain(
      `${USER_PREFERENCES_COLOR_MODE_COOKIE_NAME}=dark`,
    );
  });
});
