import { createHash } from "node:crypto";
import { expect, type APIResponse, type Page } from "@playwright/test";
import { CHASE_SETS_COMMIT_RECEIPT_HEADER, decodeCommitReceipt } from "@chase-sets/http/responses";

const privilegedRequestTimeoutMs = 15_000;
const privilegedResponseBodyLimitBytes = 64 * 1024;
const privilegedSessionTokenLimitCharacters = 8 * 1024;
// Event-store global positions are non-negative PostgreSQL bigint values. The
// endpoint emits exactly this object, so the largest valid body is the 19-digit
// signed-bigint maximum; 64 additional bytes leave explicit encoding headroom.
const maximumProjectionPosition = "9223372036854775807";
const projectionCheckpointSchemaMaxBytes = new TextEncoder().encode(
  JSON.stringify({ lastGlobalPosition: maximumProjectionPosition }),
).byteLength;
const projectionCheckpointResponseHeadroomBytes = 64;
export const projectionCheckpointResponseBodyLimitBytes =
  projectionCheckpointSchemaMaxBytes + projectionCheckpointResponseHeadroomBytes;

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

  const passwordMethod = page.getByRole("radio", { name: /^Password$/i });
  await passwordMethod.click();

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
  await provisionSyntheticAccountInvitation(origin, account.email);
  const consentResponse = await page.request.get(`${origin}/api/auth/registration-consent`);
  expect(consentResponse.status(), "marketplace registration should resolve the active consent bundle").toBe(200);
  const registrationConsent = (await consentResponse.json()) as {
    operationId: string;
    snapshot: {
      bundleKey: "registration";
      requirements: readonly { policyKey: string; version: string; href: string }[];
    };
  };

  const response = await page.request.post(`${origin}/api/auth/register`, {
    data: {
      displayName: account.displayName,
      email: account.email,
      password: account.password,
      registrationConsent: {
        ...registrationConsent,
        affirmed: registrationConsent.snapshot.requirements.length > 0,
      },
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

  const accountIdentifier = createHash("sha256").update(account.email.trim().toLowerCase()).digest("hex").slice(0, 12);
  expect(
    response.status(),
    `${label} should start a session (account=sha256:${accountIdentifier}, status=${response.status()})`,
  ).toBe(200);
  return (await response.json()) as { sessionToken: string };
}

async function provisionSyntheticAccountInvitation(origin: string, email: string) {
  const adminEmail = firstConfiguredEnvValue("PLATFORM_ADMIN_EMAIL", "TF_VAR_platform_admin_email");
  const adminPassword = firstConfiguredEnvValue("PLATFORM_ADMIN_PASSWORD", "TF_VAR_platform_admin_password");
  if (!adminEmail || !adminPassword) {
    return;
  }

  const adminSessionResponse = await privilegedRequest(origin, "/api/auth/password-sign-in", {
    method: "POST",
    data: { email: adminEmail, password: adminPassword },
    expectedStatus: 200,
    operation: "platform-admin password sign-in",
  });
  const adminCookie = `chase_sets_session=${readPrivilegedSessionToken(adminSessionResponse.body)}`;
  const actor = await getCurrentActorDisplay(origin, adminCookie);
  const invitationResponse = await privilegedRequest(origin, "/api/identity/invitations", {
    method: "POST",
    headers: { Cookie: adminCookie },
    expectedStatus: 201,
    operation: "platform admin invitation",
    discardResponseBody: true,
    data: {
      invitationId: createSmokeInvitationId(),
      accountId: actor.account.account_id,
      email,
      roleKey: "viewer",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
  });

  await waitForAuthInvitationProjection(origin, adminCookie, invitationResponse.headers);
}

async function getCurrentActorDisplay(origin: string, adminCookie: string) {
  const response = await privilegedRequest(origin, "/api/identity/current-actor-display", {
    method: "GET",
    headers: { Cookie: adminCookie },
    expectedStatus: 200,
    operation: "platform admin current actor",
  });
  const body = response.body;
  if (!isRecord(body) || !isRecord(body.account) || typeof body.account.account_id !== "string") {
    throw new Error("platform admin current actor failed (invalid-response)");
  }

  return body as { account: { account_id: string } };
}

async function waitForAuthInvitationProjection(origin: string, adminCookie: string, headers: Headers) {
  const identityCommit = decodeCommitReceipt(headers.get(CHASE_SETS_COMMIT_RECEIPT_HEADER)).find(
    (source) => source.sourceContextName === "identity",
  );
  if (!identityCommit) {
    return;
  }

  let lastObservedPosition = "0";
  await expect
    .poll(
      async () => {
        const refreshResponse = await privilegedRequest(origin, "/api/platform/projections/refresh-checkpoint", {
          method: "POST",
          headers: { Cookie: adminCookie },
          data: {
            targetContextName: "auth",
            projectionName: "auth-identity-invitation-projection",
            sourceContextName: "identity",
          },
          expectedStatus: 200,
          operation: "platform admin projection refresh",
          responseBodyLimitBytes: projectionCheckpointResponseBodyLimitBytes,
        });
        lastObservedPosition = readProjectionCheckpoint(refreshResponse.body);
        return BigInt(lastObservedPosition) >= BigInt(identityCommit.maxGlobalPosition);
      },
      { intervals: [1_000, 2_000, 5_000], timeout: 90_000 },
    )
    .toBe(true);
}

type PrivilegedRequestOptions = {
  method: "GET" | "POST";
  headers?: Readonly<Record<string, string>>;
  data?: unknown;
  expectedStatus: number;
  operation: PrivilegedOperation;
  discardResponseBody?: boolean;
  responseBodyLimitBytes?: number;
  timeoutMs?: number;
};

type PrivilegedOperation =
  | "platform-admin password sign-in"
  | "platform admin current actor"
  | "platform admin invitation"
  | "platform admin projection refresh";

export async function privilegedRequest(origin: string, path: string, options: PrivilegedRequestOptions) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? privilegedRequestTimeoutMs);
  let response: Response;
  try {
    response = await fetch(new URL(path, origin), {
      method: options.method,
      headers: {
        Accept: "application/json",
        ...(options.data === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      body: options.data === undefined ? undefined : JSON.stringify(options.data),
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    const classification = controller.signal.aborted ? "timeout" : "network";
    throw new Error(`${options.operation} failed (${classification})`);
  }

  try {
    if (response.status !== options.expectedStatus) {
      try {
        await response.body?.cancel();
      } catch {
        // The fixed status classification remains authoritative when cleanup fails.
      }
      throw new Error(`${options.operation} failed (unexpected-status)`);
    }
    const body = options.discardResponseBody
      ? await discardPrivilegedBody(response, options.operation, controller.signal)
      : await readPrivilegedJson(
          response,
          options.operation,
          controller.signal,
          options.responseBodyLimitBytes ?? privilegedResponseBodyLimitBytes,
        );
    return { body, headers: response.headers };
  } finally {
    clearTimeout(timeout);
  }
}

async function discardPrivilegedBody(response: Response, operation: PrivilegedOperation, signal: AbortSignal) {
  try {
    await response.body?.cancel();
    return undefined;
  } catch {
    const classification = signal.aborted ? "timeout" : "response-read";
    throw new Error(`${operation} failed (${classification})`);
  }
}

async function readPrivilegedJson(
  response: Response,
  operation: PrivilegedOperation,
  signal: AbortSignal,
  responseBodyLimitBytes: number,
): Promise<unknown> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    try {
      await response.body?.cancel();
    } catch {
      // The bounded content-type classification remains authoritative when cleanup fails.
    }
    throw new Error(`${operation} failed (unexpected-content-type)`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error(`${operation} failed (empty-response)`);
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > responseBodyLimitBytes) {
        await reader.cancel();
        throw new Error(`${operation} failed (response-too-large)`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === `${operation} failed (response-too-large)`) {
      throw error;
    }
    const classification = signal.aborted ? "timeout" : "response-read";
    throw new Error(`${operation} failed (${classification})`);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error(`${operation} failed (invalid-json)`);
  }
}

function readPrivilegedSessionToken(body: unknown) {
  if (
    !isRecord(body) ||
    typeof body.sessionToken !== "string" ||
    body.sessionToken.length === 0 ||
    body.sessionToken.length > privilegedSessionTokenLimitCharacters
  ) {
    throw new Error("platform-admin password sign-in failed (invalid-response)");
  }

  return body.sessionToken;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProjectionCheckpoint(body: unknown) {
  const position = isRecord(body) ? body.lastGlobalPosition : undefined;
  if (
    typeof position !== "string" ||
    !/^(0|[1-9]\d{0,18})$/.test(position) ||
    BigInt(position) > BigInt(maximumProjectionPosition)
  ) {
    throw new Error("platform admin projection refresh failed (invalid-response)");
  }

  return position;
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
