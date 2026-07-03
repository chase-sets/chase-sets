import { expect, type Page } from "@playwright/test";

export type MarketplaceE2EAccount = {
  email: string;
  password: string;
  displayName: string;
  shouldRegister: boolean;
};

export async function addSessionCookie(page: Page, origin: string, sessionToken: string) {
  await page.context().addCookies([
    {
      name: "chase_sets_session",
      value: sessionToken,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
      secure: origin.startsWith("https://"),
    },
  ]);

  const sessionCookie = (await page.context().cookies(origin)).find((cookie) => cookie.name === "chase_sets_session");
  expect(sessionCookie, "browser context should store the auth session cookie").toBeTruthy();
}

export async function signInWithPassword(
  page: Page,
  origin: string,
  account: Pick<MarketplaceE2EAccount, "email" | "password">,
) {
  const response = await page.request.post(`${origin}/api/auth/password-sign-in`, {
    data: {
      email: account.email,
      password: account.password,
    },
  });

  expect(response.status(), "password sign-in should start a session").toBe(200);
  const body = (await response.json()) as { sessionToken?: string };
  expect(body.sessionToken, "password sign-in should return a session token").toBeTruthy();
  await addSessionCookie(page, origin, body.sessionToken!);
  return body.sessionToken!;
}

export async function registerOrSignInSyntheticAccount(
  page: Page,
  origin: string,
  account: Pick<MarketplaceE2EAccount, "displayName" | "email" | "password">,
) {
  const response = await page.request.post(`${origin}/api/auth/register`, {
    data: {
      displayName: account.displayName,
      email: account.email,
      password: account.password,
    },
  });

  if (response.status() === 409) {
    return signInWithPassword(page, origin, account);
  }

  expect(response.status(), "marketplace registration should start a session").toBe(201);
  const body = (await response.json()) as { sessionToken?: string };
  expect(body.sessionToken, "marketplace registration should return a session token").toBeTruthy();
  await addSessionCookie(page, origin, body.sessionToken!);
  return body.sessionToken!;
}
