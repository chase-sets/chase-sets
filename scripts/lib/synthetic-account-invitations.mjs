import { normalizeString } from "./cli-options.mjs";

const CHASE_SETS_COMMIT_RECEIPT_HEADER = "chase-sets-commit-receipt";
const DEFAULT_INVITATION_PROJECTION_TIMEOUT_MS = 90_000;
const DEFAULT_INVITATION_PROJECTION_POLL_MS = 1_000;

export async function provisionSyntheticAccountInvitation(input) {
  const label = normalizeString(input.label) ?? "Synthetic account";
  const adminEmail = normalizeString(input.adminEmail);
  const adminPassword = normalizeString(input.adminPassword);
  const missingCredentials = [];
  if (!adminEmail) {
    missingCredentials.push(input.adminEmailCredentialName ?? "adminEmail");
  }
  if (!adminPassword) {
    missingCredentials.push(input.adminPasswordCredentialName ?? "adminPassword");
  }
  if (missingCredentials.length > 0) {
    throw new Error(
      `${label} synthetic account invitation requires platform admin credentials before creating the registration bypass. Missing ${missingCredentials.join(
        ", ",
      )}.`,
    );
  }

  const baseUrl = stripTrailingSlash(input.baseUrl);
  const fetchImpl = input.fetchImpl ?? fetch;
  const adminSession = await startPasswordSession(fetchImpl, baseUrl, {
    email: adminEmail,
    password: adminPassword,
    label: `${label} platform-admin password sign-in`,
  });
  const adminCookie = `chase_sets_session=${adminSession}`;
  const actorResponse = await fetchImpl(`${baseUrl}/api/identity/current-actor-display`, {
    headers: { Cookie: adminCookie },
  });
  const actorStatus = responseStatus(actorResponse);
  if (actorStatus !== 200) {
    throw syntheticInvitationHttpError(
      `${label} platform admin actor lookup failed with HTTP ${actorStatus}.`,
      actorStatus,
    );
  }

  const actor = await responseJson(actorResponse);
  const accountId = normalizeString(actor?.account?.account_id);
  if (!accountId) {
    throw new Error(`${label} platform admin actor lookup did not return an account id.`);
  }

  const invitationResponse = await fetchImpl(`${baseUrl}/api/identity/invitations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({
      invitationId: createSyntheticInvitationId(input.invitationIdPrefix),
      accountId,
      email: input.email,
      roleKey: input.roleKey ?? "viewer",
      expiresAt: input.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }),
  });
  const invitationStatus = responseStatus(invitationResponse);
  if (invitationStatus !== 201) {
    throw syntheticInvitationHttpError(
      `${label} synthetic account invitation failed with HTTP ${invitationStatus}.`,
      invitationStatus,
    );
  }

  await waitForAuthInvitationProjection(fetchImpl, baseUrl, adminCookie, invitationResponse, {
    label,
    timeoutMs: input.projectionTimeoutMs ?? DEFAULT_INVITATION_PROJECTION_TIMEOUT_MS,
    pollMs: input.projectionPollMs ?? DEFAULT_INVITATION_PROJECTION_POLL_MS,
    waitForTimeout: input.waitForTimeout,
  });

  return { status: "provisioned" };
}

async function startPasswordSession(fetchImpl, baseUrl, input) {
  const response = await fetchImpl(`${baseUrl}/api/auth/password-sign-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: input.email, password: input.password }),
  });
  const status = responseStatus(response);
  if (status !== 200) {
    throw syntheticInvitationHttpError(`${input.label} failed with HTTP ${status}.`, status);
  }
  const sessionToken = (await responseJson(response))?.sessionToken;
  if (!sessionToken) {
    throw new Error(`${input.label} did not return a session token.`);
  }
  return sessionToken;
}

async function waitForAuthInvitationProjection(fetchImpl, baseUrl, adminCookie, response, options) {
  const identityCommit = decodeCommitReceipt(responseHeader(response, CHASE_SETS_COMMIT_RECEIPT_HEADER))?.find(
    (source) => source.sourceContextName === "identity",
  );
  if (!identityCommit) {
    return;
  }

  const deadline = Date.now() + options.timeoutMs;
  let lastObservedPosition = "0";
  while (Date.now() < deadline) {
    const refreshResponse = await fetchImpl(`${baseUrl}/api/platform/projections/refresh`, {
      method: "POST",
      headers: { Cookie: adminCookie },
    });
    const refreshStatus = responseStatus(refreshResponse);
    if (refreshStatus !== 200) {
      throw syntheticInvitationHttpError(
        `${options.label} auth invitation projection refresh failed with HTTP ${refreshStatus}.`,
        refreshStatus,
      );
    }

    const body = await responseJson(refreshResponse);
    const authInvitationProjection = body?.projectionGroups?.find(
      (group) => group?.targetContextName === "auth" && group?.projectionName === "auth-identity-invitation-projection",
    );
    lastObservedPosition = maxObservedPosition(authInvitationProjection, "identity") ?? lastObservedPosition;
    if (BigInt(lastObservedPosition) >= BigInt(identityCommit.maxGlobalPosition)) {
      return;
    }

    await wait(options.pollMs, options.waitForTimeout);
  }

  throw new Error(
    `${options.label} auth invitation projection did not reach identity position ${identityCommit.maxGlobalPosition}; last observed ${lastObservedPosition}.`,
  );
}

function responseStatus(response) {
  return typeof response?.status === "function" ? response.status() : response?.status;
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function responseHeader(response, name) {
  const headers = typeof response?.headers === "function" ? response.headers() : response?.headers;
  if (!headers) {
    return null;
  }
  if (typeof headers.get === "function") {
    return headers.get(name);
  }
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

function maxObservedPosition(group, sourceContextName) {
  const positions =
    group?.subscriptions
      ?.filter((subscription) => subscription?.sourceContextName === sourceContextName)
      .map((subscription) => subscription?.lastGlobalPosition)
      .filter((position) => typeof position === "string" && /^(0|[1-9]\d*)$/.test(position)) ?? [];

  return positions.reduce((max, position) => (BigInt(position) > BigInt(max) ? position : max), "0");
}

function decodeCommitReceipt(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    return Array.isArray(parsed) ? parsed.filter(isSourceCommitPosition) : [];
  } catch {
    return [];
  }
}

function isSourceCommitPosition(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.sourceContextName === "string" &&
    value.sourceContextName.length > 0 &&
    typeof value.maxGlobalPosition === "string" &&
    /^(0|[1-9]\d*)$/.test(value.maxGlobalPosition) &&
    Array.isArray(value.eventIds) &&
    value.eventIds.every((eventId) => typeof eventId === "string" && eventId.length > 0)
  );
}

function createSyntheticInvitationId(prefix = "ivt_synthetic_account") {
  const normalizedPrefix = String(prefix)
    .replace(/[^A-Za-z0-9_:-]/g, "_")
    .slice(0, 80);
  return `${normalizedPrefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function wait(ms, waitForTimeout) {
  if (typeof waitForTimeout === "function") {
    await waitForTimeout(ms);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function stripTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function syntheticInvitationHttpError(message, status) {
  const error = new Error(message);
  if (Number(status) >= 500) {
    error.reason = "platform-temporary-unavailable";
  }
  return error;
}
