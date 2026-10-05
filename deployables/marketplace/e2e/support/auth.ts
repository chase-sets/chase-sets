import { createHash } from "node:crypto";
import { dirname, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, type TestInfo } from "@playwright/test";

const marketplaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const registrationTimeoutMs = 15_000;
const maximumTextCharacters = 320;
const maximumPermissions = 128;
const maximumPermissionCharacters = 128;
// Every bounded string can occupy six JSON bytes per character. Registration
// creates one personal account/membership; include every SessionRow field,
// including optional started_at, rather than sizing from a frozen fixture.
export const registrationResponseBodyLimitBytes = Math.ceil(
  (2_048 + 18 * maximumTextCharacters * 6 + maximumPermissions * maximumPermissionCharacters * 6) * 1.25,
);

export type MarketplaceE2EAccount = { email: string; password: string; displayName: string; shouldRegister: boolean };
type SyntheticTestIdentity = Pick<TestInfo, "file" | "titlePath"> & { project: Pick<TestInfo["project"], "name"> };

export function syntheticAccountFor(
  testInfo: SyntheticTestIdentity,
  env: Readonly<Record<string, string | undefined>> = process.env,
  root = marketplaceRoot,
): MarketplaceE2EAccount {
  const namespace =
    env.GITHUB_RUN_ID?.trim() && env.GITHUB_RUN_ATTEMPT?.trim()
      ? `${env.GITHUB_RUN_ID.trim()}:${env.GITHUB_RUN_ATTEMPT.trim()}`
      : env.CHASE_SETS_E2E_INVOCATION_NAMESPACE?.trim();
  if (!namespace) throw new Error("synthetic identity failed (missing-CHASE_SETS_E2E_INVOCATION_NAMESPACE)");
  if (!testInfo.project.name || !testInfo.titlePath.length || testInfo.titlePath.some((title) => !title)) {
    throw new Error("synthetic identity failed (incomplete-test-identity)");
  }
  const tuple = [
    "marketplace-e2e-auth/v1",
    namespace,
    testInfo.project.name,
    canonicalSpecPath(testInfo.file, root),
    ...testInfo.titlePath,
  ];
  const digest = createHash("sha256");
  for (const part of tuple) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.byteLength);
    digest.update(length).update(bytes);
  }
  const identity = digest.digest("hex");
  return {
    email: `${identity}@chasesets.test`,
    password: `E2e!${identity}`,
    displayName: `E2E ${identity}`,
    shouldRegister: true,
  };
}

function canonicalSpecPath(file: string, root: string) {
  const windows = /^[a-z]:[\\/]/i.test(root);
  const paths = windows ? win32 : posix;
  const normalizedRoot = paths.resolve(root.replaceAll("\\", "/"));
  const normalizedFile = file.replaceAll("\\", "/");
  if (
    (!windows && /^[a-z]:/i.test(normalizedFile)) ||
    (windows && /^[a-z]:/i.test(normalizedFile) && !paths.isAbsolute(normalizedFile))
  ) {
    throw new Error("synthetic identity failed (invalid-spec-path)");
  }
  const absolute = paths.resolve(normalizedRoot, normalizedFile);
  const relative = paths.relative(normalizedRoot, absolute).replaceAll("\\", "/");
  if (
    !relative ||
    paths.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith("../") ||
    !relative.startsWith("e2e/")
  ) {
    throw new Error("synthetic identity failed (spec-outside-marketplace)");
  }
  return relative;
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
  const response = await page.request.post(`${origin}/api/auth/password-sign-in`, {
    data: { email: account.email, password: account.password },
  });
  const accountIdentifier = createHash("sha256").update(account.email.trim().toLowerCase()).digest("hex").slice(0, 12);
  expect(
    response.status(),
    `password sign-in should start a session (account=sha256:${accountIdentifier}, status=${response.status()})`,
  ).toBe(200);
  const body = (await response.json()) as { sessionToken: string };
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
  await page.getByRole("radio", { name: /^Password$/i }).click();
  const password = page.getByLabel(/^Password$/i);
  await expect(password, "marketplace sign-in form must expose the password step").toBeVisible();
  await password.fill(account.password);
  await page.getByRole("button", { name: /^Sign in$/i }).click();
}

export async function resolveRegistrationConsentSubmission(page: Page, origin: string) {
  const response = await page.request.get(`${origin}/api/auth/registration-consent`);
  expect(response.status(), "registration consent resolution should be readable anonymously").toBe(200);
  return { resolution: await response.json(), affirmed: false };
}

export async function registerSyntheticAccount(
  page: Page,
  origin: string,
  account: Pick<MarketplaceE2EAccount, "displayName" | "email" | "password">,
) {
  const registrationConsent = await resolveRegistrationConsentSubmission(page, origin);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), registrationTimeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(new URL("/api/auth/register", origin), {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: account.displayName,
          email: account.email,
          password: account.password,
          registrationConsent,
        }),
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw registrationFailure(controller.signal.aborted ? "timeout" : "network");
    }
    const { sessionToken, bytes } = await consumeSyntheticRegistrationResponse(response, controller.signal);
    console.log(
      `synthetic registration status=201 bytes=${bytes} cap=${registrationResponseBodyLimitBytes} headroom-percent=${Math.floor((registrationResponseBodyLimitBytes / bytes - 1) * 100)}`,
    );
    await addSessionCookie(page, origin, sessionToken);
    return sessionToken;
  } finally {
    clearTimeout(timeout);
  }
}

export async function consumeSyntheticRegistrationResponse(response: Response, signal: AbortSignal) {
  const body = await readRegistrationJson(response, signal);
  if (response.status !== 201) {
    const allowedCodes = [
      "registration_admission_required",
      "display_name_already_taken",
      "identity_mutation_conflict",
      "email_already_taken",
    ];
    const error = isRecord(body.value) && isRecord(body.value.error) ? body.value.error : null;
    const code =
      (response.status === 403 || response.status === 409) &&
      error &&
      typeof error.code === "string" &&
      allowedCodes.includes(error.code)
        ? error.code
        : "unclassified-refusal";
    throw registrationFailure(`status=${response.status}, code=${code}`);
  }
  if (!isRegistrationStarted(body.value)) throw registrationFailure("invalid-response");
  if (registrationResponseBodyLimitBytes < Math.ceil(body.bytes * 1.25))
    throw registrationFailure("insufficient-live-headroom");
  return { sessionToken: body.value.sessionToken, bytes: body.bytes };
}

async function readRegistrationJson(
  response: Response,
  signal: AbortSignal,
): Promise<{ value: unknown; bytes: number }> {
  const reader = response.body?.getReader();
  const cancel = () => {
    void reader?.cancel().catch(() => undefined);
  };
  if (
    !/^(application\/json|application\/[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
  ) {
    cancel();
    throw registrationFailure("unexpected-content-type");
  }
  if (!reader) throw registrationFailure("empty-response");
  let rejectAbort: (error: Error) => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    rejectAbort(registrationFailure("timeout"));
    cancel();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (signal.aborted) throw registrationFailure("timeout");
    while (true) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) throw registrationFailure("timeout");
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > registrationResponseBodyLimitBytes) {
        cancel();
        throw registrationFailure("response-too-large");
      }
      chunks.push(chunk.value);
    }
    const content = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)) as unknown, bytes };
    } catch {
      throw registrationFailure("invalid-json");
    }
  } catch (error) {
    cancel();
    if (error instanceof RegistrationFailure) throw error;
    throw registrationFailure(signal.aborted ? "timeout" : "response-read");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

class RegistrationFailure extends Error {}
function registrationFailure(classification: string) {
  return new RegistrationFailure(`synthetic registration failed (${classification})`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []) {
  return (
    keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => keys.includes(key) || optional.includes(key))
  );
}
function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximumTextCharacters;
}
function nullableString(value: unknown) {
  return value === null || boundedString(value);
}
function timestamp(value: unknown) {
  return (
    boundedString(value) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))
  );
}

function isRegistrationStarted(value: unknown): value is { sessionToken: string } {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["type", "userId", "accountId", "sessionId", "sessionToken", "session", "memberships"]) ||
    value.type !== "session-started" ||
    !boundedString(value.userId) ||
    !boundedString(value.accountId) ||
    !boundedString(value.sessionId) ||
    typeof value.sessionToken !== "string" ||
    !/^session_[0-9a-f]{36}$/.test(value.sessionToken)
  )
    return false;
  const session = value.session;
  if (
    !isRecord(session) ||
    !exactKeys(
      session,
      [
        "session_id",
        "user_id",
        "user_display_name",
        "user_primary_email",
        "account_id",
        "account_display_name",
        "account_name",
        "available_account_ids",
        "authentication_method",
        "status",
        "expires_at",
        "updated_at",
      ],
      ["started_at"],
    ) ||
    session.session_id !== value.sessionId ||
    session.user_id !== value.userId ||
    session.account_id !== value.accountId ||
    ![session.user_display_name, session.user_primary_email, session.account_display_name, session.account_name].every(
      nullableString,
    ) ||
    !Array.isArray(session.available_account_ids) ||
    session.available_account_ids.length !== 1 ||
    session.available_account_ids[0] !== value.accountId ||
    session.authentication_method !== "password" ||
    session.status !== "active" ||
    !timestamp(session.expires_at) ||
    !timestamp(session.updated_at) ||
    (Object.hasOwn(session, "started_at") && !timestamp(session.started_at))
  )
    return false;
  if (!Array.isArray(value.memberships) || value.memberships.length !== 1) return false;
  const member: unknown = value.memberships[0];
  return (
    isRecord(member) &&
    exactKeys(member, ["membershipId", "accountId", "roleKey", "status", "rolePermissions"]) &&
    boundedString(member.membershipId) &&
    member.accountId === value.accountId &&
    member.roleKey === "owner" &&
    member.status === "active" &&
    Array.isArray(member.rolePermissions) &&
    member.rolePermissions.length > 0 &&
    member.rolePermissions.length <= maximumPermissions &&
    member.rolePermissions.every(
      (permission: unknown) =>
        typeof permission === "string" && permission.length > 0 && permission.length <= maximumPermissionCharacters,
    ) &&
    new Set(member.rolePermissions).size === member.rolePermissions.length
  );
}
