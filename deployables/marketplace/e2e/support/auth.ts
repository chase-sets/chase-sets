import { createHash } from "node:crypto";
import { relative } from "node:path";
import { expect, type APIResponse, type Page, type TestInfo } from "@playwright/test";
import { CHASE_SETS_COMMIT_RECEIPT_HEADER, decodeCommitReceipt } from "@chase-sets/http/responses";

const privilegedRequestTimeoutMs = 15_000;
const privilegedResponseBodyLimitBytes = 64 * 1024;
// Auth's authoritative opaque-token adapter emits `session_` followed by 18
// random bytes encoded as lowercase hex. The response projection consumed here
// needs only that field; the remaining success-schema fields fit inside the
// explicit 16 KiB evolution headroom.
const sessionTokenMaximumCharacters = "session_".length + 18 * 2;
const registrationSuccessProjectionMaxBytes = new TextEncoder().encode(
  JSON.stringify({ sessionToken: "x".repeat(sessionTokenMaximumCharacters) }),
).byteLength;
const registrationSuccessResponseHeadroomBytes = 16 * 1024;
export const registrationSuccessResponseBodyLimitBytes =
  registrationSuccessProjectionMaxBytes + registrationSuccessResponseHeadroomBytes;
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
  identityDigest?: string;
};

export type SyntheticMarketplaceAccountIdentity = Readonly<{
  invocationNamespace: string;
  projectName: string;
  specPath: string;
  titlePath: readonly string[];
}>;

export function createSyntheticMarketplaceAccount(
  identity: SyntheticMarketplaceAccountIdentity,
): MarketplaceE2EAccount {
  const digest = digestSyntheticMarketplaceAccountIdentity(identity);
  return {
    email: `marketplace-e2e-${digest}@chasesets.test`,
    password: `Marketplace-E2E-${digest}-aA1!`,
    displayName: `Marketplace E2E ${digest}`,
    shouldRegister: true,
    identityDigest: digest,
  };
}

export function syntheticMarketplaceAccountFor(
  testInfo: Pick<TestInfo, "file" | "project" | "titlePath">,
  options: Readonly<{ invocationNamespace?: string }> = {},
) {
  return createSyntheticMarketplaceAccount({
    invocationNamespace: options.invocationNamespace ?? readSyntheticInvocationNamespace(),
    projectName: testInfo.project.name,
    specPath: testInfo.file,
    titlePath: testInfo.titlePath,
  });
}

function readSyntheticInvocationNamespace() {
  const runId = process.env.GITHUB_RUN_ID?.trim() ?? "";
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT?.trim() ?? "";
  if (runId || runAttempt) {
    if (!runId || !runAttempt) {
      throw new Error("synthetic account setup failed (incomplete-hosted-invocation-namespace)");
    }
    return `${runId}:${runAttempt}`;
  }

  const localNamespace = process.env.CHASE_SETS_E2E_INVOCATION_NAMESPACE?.trim() ?? "";
  if (!localNamespace) {
    throw new Error("synthetic account setup failed (missing-local-invocation-namespace)");
  }
  return localNamespace;
}

function digestSyntheticMarketplaceAccountIdentity(identity: SyntheticMarketplaceAccountIdentity) {
  const invocationNamespace = identity.invocationNamespace.trim();
  const projectName = identity.projectName.trim();
  const normalizedSpecPath = normalizeSpecPath(identity.specPath);
  if (!invocationNamespace || !projectName || !normalizedSpecPath || identity.titlePath.length === 0) {
    throw new Error("synthetic account setup failed (invalid-logical-identity)");
  }

  const hash = createHash("sha256");
  hashLengthDelimited(hash, "marketplace-synthetic-account/v1");
  hashLengthDelimited(hash, invocationNamespace);
  hashLengthDelimited(hash, projectName);
  hashLengthDelimited(hash, normalizedSpecPath);
  hashLengthDelimited(hash, String(identity.titlePath.length));
  for (const title of identity.titlePath) {
    hashLengthDelimited(hash, title);
  }
  return hash.digest("hex");
}

function hashLengthDelimited(hash: ReturnType<typeof createHash>, value: string) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  hash.update(length);
  hash.update(bytes);
}

function normalizeSpecPath(specPath: string) {
  const candidate = specPath.trim();
  if (!candidate) {
    return "";
  }
  const repositoryRelative = candidate.startsWith(process.cwd()) ? relative(process.cwd(), candidate) : candidate;
  return repositoryRelative.replaceAll("\\", "/").replace(/^\.\//, "");
}

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

/**
 * Resolve the server-minted registration consent resolution before registering.
 *
 * A synthetic client is still a client: it has to bring a value only the server
 * can mint, exactly like the product path. Omitting this is the shape that took
 * down a hosted CI shard, so it is done here rather than waived as "test
 * support".
 */
export async function resolveRegistrationConsentSubmission(page: Page, origin: string) {
  const response = await page.request.get(`${origin}/api/auth/registration-consent`);
  expect(response.status(), "registration consent resolution should be readable anonymously").toBe(200);
  return { resolution: await response.json(), affirmed: false };
}

export async function registerOrSignInSyntheticAccount(
  page: Page,
  origin: string,
  account: Pick<MarketplaceE2EAccount, "displayName" | "email" | "password" | "identityDigest">,
) {
  await provisionSyntheticAccountInvitation(origin, account);

  const response = await page.request.post(`${origin}/api/auth/register`, {
    data: {
      displayName: account.displayName,
      email: account.email,
      password: account.password,
      registrationConsent: await resolveRegistrationConsentSubmission(page, origin),
    },
  });

  if (response.status() === 403) {
    throw new Error("synthetic registration failed (registration-admission-required)");
  }
  if (response.status() === 409) {
    throw new Error("synthetic registration failed (registration-conflict)");
  }
  if (response.status() !== 201) {
    throw new Error("synthetic registration failed (unexpected-status)");
  }

  const body = await readBoundedApiJson(response, registrationSuccessResponseBodyLimitBytes);
  const sessionToken = readRegistrationSessionToken(body);
  await addSessionCookie(page, origin, sessionToken);
  return sessionToken;
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

async function provisionSyntheticAccountInvitation(
  origin: string,
  account: Pick<MarketplaceE2EAccount, "displayName" | "email" | "password" | "identityDigest">,
) {
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
    expectedStatus: [201, 400],
    operation: "platform admin invitation",
    discardResponseBody: true,
    data: {
      invitationId: createSyntheticInvitationId(account),
      accountId: actor.account.account_id,
      email: account.email,
      roleKey: "viewer",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
  });

  if (invitationResponse.status === 400) {
    throw new Error("synthetic invitation failed (invitation-already-authored)");
  }

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
  let identityCommit: ReturnType<typeof decodeCommitReceipt>[number] | undefined;
  try {
    identityCommit = decodeCommitReceipt(headers.get(CHASE_SETS_COMMIT_RECEIPT_HEADER)).find(
      (source) => source.sourceContextName === "identity",
    );
  } catch {
    throw new Error("synthetic invitation failed (missing-identity-commit-receipt)");
  }
  if (!identityCommit) {
    throw new Error("synthetic invitation failed (missing-identity-commit-receipt)");
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
  expectedStatus: number | readonly number[];
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
    const expectedStatuses = Array.isArray(options.expectedStatus) ? options.expectedStatus : [options.expectedStatus];
    if (!expectedStatuses.includes(response.status)) {
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
    return { body, headers: response.headers, status: response.status };
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
    body.sessionToken.length > sessionTokenMaximumCharacters
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

function createSyntheticInvitationId(
  account: Pick<MarketplaceE2EAccount, "displayName" | "email" | "password" | "identityDigest">,
) {
  const identityDigest =
    account.identityDigest ??
    digestSyntheticMarketplaceAccountIdentity({
      invocationNamespace: "legacy-synthetic-helper/v1",
      projectName: account.email,
      specPath: account.password,
      titlePath: [account.displayName],
    });
  if (!/^[0-9a-f]{64}$/.test(identityDigest)) {
    throw new Error("synthetic account setup failed (invalid-identity-digest)");
  }
  return `ivt_e2e_${identityDigest}`;
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

async function readBoundedApiJson(response: APIResponse, bodyLimitBytes: number): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await response.body();
  } catch {
    throw new Error("synthetic registration failed (response-read)");
  }
  if (bytes.byteLength > bodyLimitBytes) {
    throw new Error("synthetic registration failed (response-too-large)");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("synthetic registration failed (invalid-json)");
  }
}

function readRegistrationSessionToken(body: unknown) {
  const sessionToken = isRecord(body) ? body.sessionToken : undefined;
  if (
    typeof sessionToken !== "string" ||
    sessionToken.length === 0 ||
    sessionToken.length > sessionTokenMaximumCharacters
  ) {
    throw new Error("synthetic registration failed (invalid-response)");
  }
  return sessionToken;
}
