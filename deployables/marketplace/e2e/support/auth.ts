import { expect, type APIResponse, type Page } from "@playwright/test";
import { CHASE_SETS_COMMIT_RECEIPT_HEADER, decodeCommitReceipt } from "@chase-sets/http/responses";

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
  const body = await startPasswordSession(page, origin, account, "password sign-in");
  expect(body.sessionToken, "password sign-in should return a session token").toBeTruthy();
  await addSessionCookie(page, origin, body.sessionToken);
  return body.sessionToken;
}

export async function signInThroughMarketplaceForm(
  page: Page,
  account: Pick<MarketplaceE2EAccount, "email" | "password">,
) {
  const identifier = page.getByLabel(/Email or phone/i);
  await expect(identifier, "marketplace sign-in form must expose the identifier step").toBeVisible();
  await identifier.fill(account.email);
  await page.getByRole("button", { name: /^Continue$/i }).click();

  const password = page.getByLabel(/^Password$/i);
  await expect(password, "marketplace sign-in form must expose the password step").toBeVisible();
  await password.fill(account.password);
  await page.getByRole("button", { name: /^Sign in$/i }).click();
}

export async function registerOrSignInSyntheticAccount(
  page: Page,
  origin: string,
  account: Pick<MarketplaceE2EAccount, "displayName" | "email" | "password">,
) {
  await provisionSyntheticAccountInvitation(page, origin, account.email);

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

  if (response.status() === 403) {
    const body = await parseJsonResponse(response);
    if (body?.error?.code === "registration_admission_required") {
      return signInWithPassword(page, origin, account);
    }
  }

  expect(response.status(), "marketplace registration should start a session").toBe(201);
  const body = (await response.json()) as { sessionToken?: string };
  expect(body.sessionToken, "marketplace registration should return a session token").toBeTruthy();
  await addSessionCookie(page, origin, body.sessionToken!);
  return body.sessionToken!;
}

async function startPasswordSession(
  page: Page,
  origin: string,
  account: Pick<MarketplaceE2EAccount, "email" | "password">,
  label: string,
) {
  const response = await page.request.post(`${origin}/api/auth/password-sign-in`, {
    data: {
      email: account.email,
      password: account.password,
    },
  });

  expect(response.status(), `${label} should start a session`).toBe(200);
  return (await response.json()) as { sessionToken: string };
}

async function provisionSyntheticAccountInvitation(page: Page, origin: string, email: string) {
  const adminEmail = firstConfiguredEnvValue("PLATFORM_ADMIN_EMAIL", "TF_VAR_platform_admin_email");
  const adminPassword = firstConfiguredEnvValue("PLATFORM_ADMIN_PASSWORD", "TF_VAR_platform_admin_password");
  if (!adminEmail || !adminPassword) {
    return;
  }

  const adminSession = await startPasswordSession(
    page,
    origin,
    { email: adminEmail, password: adminPassword },
    "platform-admin password sign-in",
  );
  const adminCookie = `chase_sets_session=${adminSession.sessionToken}`;
  const actor = await getCurrentActorDisplay(page, origin, adminCookie);
  const invitationResponse = await page.request.post(`${origin}/api/identity/invitations`, {
    headers: { Cookie: adminCookie },
    data: {
      invitationId: createSmokeInvitationId(),
      accountId: actor.account.account_id,
      email,
      roleKey: "viewer",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
  });

  expect(invitationResponse.status(), "platform admin should create a smoke account invitation").toBe(201);
  await waitForAuthInvitationProjection(page, origin, adminCookie, invitationResponse);
}

async function getCurrentActorDisplay(page: Page, origin: string, adminCookie: string) {
  const response = await page.request.get(`${origin}/api/identity/current-actor-display`, {
    headers: { Cookie: adminCookie },
  });
  expect(response.status(), "platform admin current actor should be readable").toBe(200);
  return (await response.json()) as { account: { account_id: string } };
}

async function waitForAuthInvitationProjection(page: Page, origin: string, adminCookie: string, response: APIResponse) {
  const identityCommit = decodeCommitReceipt(response.headers()[CHASE_SETS_COMMIT_RECEIPT_HEADER.toLowerCase()]).find(
    (source) => source.sourceContextName === "identity",
  );
  if (!identityCommit) {
    return;
  }

  let lastObservedPosition = "0";
  await expect
    .poll(
      async () => {
        const refreshResponse = await page.request.post(`${origin}/api/platform/projections/refresh`, {
          headers: { Cookie: adminCookie },
        });
        expect(refreshResponse.status(), "platform admin should refresh projection status").toBe(200);
        const body = (await refreshResponse.json()) as ProjectionRefreshResponse;
        const authInvitationProjection = body.projectionGroups?.find(
          (group) =>
            group.targetContextName === "auth" && group.projectionName === "auth-identity-invitation-projection",
        );
        lastObservedPosition = maxObservedPosition(authInvitationProjection, "identity") ?? lastObservedPosition;
        return BigInt(lastObservedPosition) >= BigInt(identityCommit.maxGlobalPosition);
      },
      { intervals: [1_000, 2_000, 5_000], timeout: 90_000 },
    )
    .toBe(true);
}

type ProjectionRefreshResponse = {
  projectionGroups?: readonly ProjectionGroupStatus[];
};

type ProjectionGroupStatus = {
  targetContextName?: string;
  projectionName?: string;
  subscriptions?: readonly ProjectionSubscriptionStatus[];
};

type ProjectionSubscriptionStatus = {
  sourceContextName?: string;
  lastGlobalPosition?: string;
};

function maxObservedPosition(group: ProjectionGroupStatus | undefined, sourceContextName: string) {
  const positions =
    group?.subscriptions
      ?.filter((subscription) => subscription.sourceContextName === sourceContextName)
      .map((subscription) => subscription.lastGlobalPosition)
      .filter((position): position is string => typeof position === "string" && /^(0|[1-9]\d*)$/.test(position)) ?? [];

  return positions.reduce((max, position) => (BigInt(position) > BigInt(max) ? position : max), "0");
}

function createSmokeInvitationId() {
  return `ivt_smoke_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function firstConfiguredEnvValue(...names: readonly string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim() ?? "";
    if (value) {
      return value;
    }
  }

  return "";
}

async function parseJsonResponse(response: APIResponse) {
  try {
    return (await response.json()) as { error?: { code?: string } };
  } catch {
    return null;
  }
}
