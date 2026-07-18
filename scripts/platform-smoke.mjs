import process from "node:process";
import { getPlatformSmokeCliArgs } from "./platform-smoke-args.mjs";
import { resolveSyntheticWaitlistEmail } from "./platform-smoke-email.mjs";
import { fetchWithTimeout } from "./platform-smoke-fetch.mjs";
import { resolvePlatformSmokeUrls } from "./platform-smoke-url-config.mjs";
import { ensureWorktreeSandboxEnvironment } from "./lib/sandbox.mjs";
import {
  ADMIN_TOPOLOGY_MODES,
  selectAdminDeployedApiSmokeProbes,
  selectAdminDeployedPageSmokeRows,
} from "./admin-shell-smoke-matrix.mjs";
import { hasRetiredAdminVerifiedChip } from "./admin-shell-smoke-assertions.mjs";
import {
  isNativeMcpPermissionBoundaryError,
  isNativeMcpPermissionBoundaryResult,
  nativeMcpHeadersForRevision,
  nativeMcpJsonRpcRequestForRevision,
  nativeMcpProtocolMatrix,
  shouldInitializeNativeMcpRevision,
  summarizeNativeMcpAnonymousDiscoveryTools,
  summarizeNativeMcpImportSourceKeys,
} from "./platform-smoke-native-mcp.mjs";
import { createReadAfterWriteReceiptFromCommitReceipt } from "./platform-smoke-freshness.mjs";

const cliArgs = getPlatformSmokeCliArgs(process.argv);
const { env: sandboxEnv } = ensureWorktreeSandboxEnvironment();

function getSmokeEnv(name) {
  return process.env[name] ?? sandboxEnv[name] ?? "";
}

const { landingUrl, adminUrl, marketplaceUrl, marketplaceRootUrl, redirectUrl } = resolvePlatformSmokeUrls({
  cliArgs,
  env: process.env,
  sandboxEnv,
});

if (!landingUrl || !adminUrl) {
  throw new Error(
    "Usage: node scripts/platform-smoke.mjs https://landing... https://admin... [https://marketplace...] [https://legacy...]",
  );
}

const syntheticEmail = resolveSyntheticWaitlistEmail({ env: process.env, sandboxEnv });
const adminEmail = getSmokeEnv("PLATFORM_ADMIN_EMAIL");
const adminPassword = getSmokeEnv("PLATFORM_ADMIN_PASSWORD");
const writeWaitlist = (getSmokeEnv("SMOKE_WRITE_WAITLIST") || "true").toLowerCase() !== "false";
const requireLanding = readBooleanEnv("SMOKE_REQUIRE_LANDING", true);
const requireAdmin = readBooleanEnv("SMOKE_REQUIRE_ADMIN", false);
const requireAdminGoogleWorkspaceSso = readBooleanEnv("SMOKE_REQUIRE_ADMIN_GOOGLE_WORKSPACE_SSO", false);
const requireMarketplace = readBooleanEnv("SMOKE_REQUIRE_MARKETPLACE", false);
const requireMarketplaceRoot = readBooleanEnv("SMOKE_REQUIRE_MARKETPLACE_ROOT", false);
const requireLegacyRedirect = readBooleanEnv("SMOKE_REQUIRE_LEGACY_REDIRECT", false);
const requireSocialLogin = readBooleanEnv("SMOKE_REQUIRE_SOCIAL_LOGIN", false);
const requireNativeMcp = readBooleanEnv("SMOKE_REQUIRE_NATIVE_MCP", true);
const requireFulfillmentPostage = readBooleanEnv("SMOKE_REQUIRE_FULFILLMENT_POSTAGE", true);
const adminTopologyMode = getSmokeEnv("SMOKE_ADMIN_TOPOLOGY") || "staging";
if (!ADMIN_TOPOLOGY_MODES.includes(adminTopologyMode)) {
  throw new Error(`SMOKE_ADMIN_TOPOLOGY must be one of: ${ADMIN_TOPOLOGY_MODES.join(", ")}.`);
}
const smokeUtmSource = getSmokeEnv("SMOKE_UTM_SOURCE") || getSmokeEnv("SMOKE_SOURCE") || "smoke";
const smokeUtmMedium = getSmokeEnv("SMOKE_UTM_MEDIUM") || "automation";
const smokeUtmCampaign = getSmokeEnv("SMOKE_UTM_CAMPAIGN") || "platform-smoke";
const smokeUtmContent = getSmokeEnv("SMOKE_UTM_CONTENT") || null;
const smokeUtmTerm = getSmokeEnv("SMOKE_UTM_TERM") || null;
const adminGoogleWorkspaceHostedDomain = getSmokeEnv("SMOKE_ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAIN") || "chasesets.com";
const nativeMcpAccountId = getSmokeEnv("SMOKE_NATIVE_MCP_ACCOUNT_ID") || null;
const fetchAttempts = readPositiveIntegerEnv("SMOKE_FETCH_ATTEMPTS", 6);
const fetchRetryDelayMs = readPositiveIntegerEnv("SMOKE_FETCH_RETRY_DELAY_MS", 5_000);
const fetchTimeoutMs = readPositiveIntegerEnv("SMOKE_FETCH_TIMEOUT_MS", 15_000);
const commitReceiptHeader = "Chase-Sets-Commit-Receipt";
const readAfterWriteHeader = "Chase-Sets-Read-After-Write";
const readTargetContextHeader = "Chase-Sets-Read-Target-Context";

function readBooleanEnv(name, defaultValue) {
  const value = getSmokeEnv(name).trim().toLowerCase();
  if (!value) {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(value);
}

function readPositiveIntegerEnv(name, defaultValue) {
  const value = getSmokeEnv(name).trim();
  if (!value) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function describeFetchError(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
  return `${error.message}${cause}`;
}

async function smokeFetch(label, input, init) {
  return fetchWithTimeout(fetch, input, init, { label, timeoutMs: fetchTimeoutMs });
}

function createSmokePagePath() {
  const params = new URLSearchParams({
    utm_source: smokeUtmSource,
    utm_medium: smokeUtmMedium,
    utm_campaign: smokeUtmCampaign,
  });

  if (smokeUtmContent) {
    params.set("utm_content", smokeUtmContent);
  }

  if (smokeUtmTerm) {
    params.set("utm_term", smokeUtmTerm);
  }

  return `/?${params.toString()}`;
}

async function fetchWithRetry(label, input, init, isSuccess) {
  let lastError;
  let lastResponse;

  for (let attempt = 1; attempt <= fetchAttempts; attempt += 1) {
    try {
      const response = await smokeFetch(label, input, init);
      if (isSuccess(response)) {
        return response;
      }

      lastResponse = response;
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
      lastResponse = undefined;
    }

    if (attempt < fetchAttempts) {
      const detail = lastResponse ? `${lastResponse.status} ${lastResponse.statusText}` : describeFetchError(lastError);
      console.warn(
        `${label} attempt ${attempt}/${fetchAttempts} failed for ${input}: ${detail}; retrying in ${fetchRetryDelayMs}ms.`,
      );
      await delay(fetchRetryDelayMs);
    }
  }

  if (lastResponse) {
    throw new Error(`${label} failed for ${input} with ${lastResponse.status} ${lastResponse.statusText}.`);
  }

  throw new Error(`${label} failed for ${input}: ${describeFetchError(lastError)}`);
}

async function expectOk(label, input, init) {
  const response = await fetchWithRetry(label, input, init, (candidate) => candidate.ok);
  return response;
}

async function expectEventually(label, action, isSuccess, describeFailure) {
  let lastValue;

  for (let attempt = 1; attempt <= fetchAttempts; attempt += 1) {
    lastValue = await action();
    if (isSuccess(lastValue)) {
      return lastValue;
    }

    if (attempt < fetchAttempts) {
      console.warn(
        `${label} attempt ${attempt}/${fetchAttempts} did not match expected state: ${describeFailure(lastValue)}; retrying in ${fetchRetryDelayMs}ms.`,
      );
      await delay(fetchRetryDelayMs);
    }
  }

  throw new Error(`${label} did not match expected state: ${describeFailure(lastValue)}.`);
}

async function expectTextContains(label, input, expectedText) {
  const response = await expectOk(label, input);
  const text = await response.text();
  const missing = expectedText.filter((value) => !text.includes(value));
  if (missing.length > 0) {
    throw new Error(`${label} did not include expected text: ${missing.join(", ")}.`);
  }
}

async function expectAdminHtmlPage({ adminOrigin, sessionToken, row }) {
  const response = await expectOk(`${row.id} ${row.path}`, `${adminOrigin}${row.path}`, {
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    throw new Error(`${row.id} ${row.path} returned '${contentType}' instead of HTML.`);
  }

  const text = await response.text();
  const expectedText = [
    ...row.expectedText,
    "Access",
    "Catalog",
    "Commerce",
    "Growth",
    "Support",
    "Platform",
    "Account menu",
  ];
  const missing = expectedText.filter((value) => !text.includes(value));
  if (missing.length > 0) {
    throw new Error(`${row.id} ${row.path} did not include expected text: ${missing.join(", ")}.`);
  }
  if (hasRetiredAdminVerifiedChip(text)) {
    throw new Error(`${row.id} ${row.path} rendered the retired Verified chip text.`);
  }
}

async function expectAdminApiProbe({ adminOrigin, sessionToken, probe }) {
  const response = await fetchWithRetry(
    `${probe.id} ${probe.path}`,
    `${adminOrigin}${probe.path}`,
    {
      method: probe.method,
      headers: {
        Accept: probe.accept,
        Authorization: `Bearer ${sessionToken}`,
      },
    },
    (candidate) => probe.expectedStatuses.includes(candidate.status),
  );
  const contentType = response.headers.get("content-type") ?? "";
  if (!probe.expectedContentTypes.some((expected) => contentType.includes(expected))) {
    throw new Error(`${probe.id} ${probe.path} returned '${contentType}' instead of controlled API/stream content.`);
  }

  await response.body?.cancel();
}

async function expectSocialLoginProviders(marketplaceOrigin) {
  const response = await expectOk(
    "marketplace social login providers",
    `${marketplaceOrigin}/api/auth/social/providers`,
  );
  const body = await response.json();
  const providerNames = new Set(
    Array.isArray(body.providers) ? body.providers.map((provider) => provider?.providerName) : [],
  );

  for (const providerName of ["google", "facebook"]) {
    if (!providerNames.has(providerName)) {
      throw new Error(`Marketplace social login providers did not include '${providerName}'.`);
    }
  }
}

async function expectSocialLoginStartRedirect({ origin, providerName, providerHost }) {
  const input = `${origin}/api/auth/social/${providerName}/start?returnTo=%2Faccount`;
  const response = await fetchWithRetry(
    `marketplace ${providerName} Social Login start`,
    input,
    { redirect: "manual" },
    (candidate) => candidate.status === 302,
  );
  const location = response.headers.get("location");
  if (!location) {
    throw new Error(`Marketplace ${providerName} Social Login start did not include a Location header.`);
  }

  const redirect = new URL(location, input);
  if (redirect.host !== providerHost) {
    throw new Error(
      `Marketplace ${providerName} Social Login redirected to '${redirect.host}' instead of '${providerHost}'.`,
    );
  }

  const expectedRedirectUri = `${origin}/api/auth/social/${providerName}/callback`;
  if (redirect.searchParams.get("redirect_uri") !== expectedRedirectUri) {
    throw new Error(
      `Marketplace ${providerName} Social Login did not use the marketplace callback URI '${expectedRedirectUri}'.`,
    );
  }
}

async function expectMarketplaceSocialLoginStarts(marketplaceOrigin) {
  await expectSocialLoginStartRedirect({
    origin: marketplaceOrigin,
    providerName: "google",
    providerHost: "accounts.google.com",
  });
  await expectSocialLoginStartRedirect({
    origin: marketplaceOrigin,
    providerName: "facebook",
    providerHost: "www.facebook.com",
  });
}

async function expectAdminGoogleWorkspaceSsoStart(adminOrigin) {
  const input = `${adminOrigin}/api/auth/social/google/start?journey=admin&returnTo=%2Fcatalog`;
  const response = await fetchWithRetry(
    "admin Google Workspace SSO start",
    input,
    { redirect: "manual" },
    (candidate) => candidate.status === 302,
  );
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Admin Google Workspace SSO start did not include a Location header.");
  }

  const redirect = new URL(location, input);
  if (redirect.host !== "accounts.google.com") {
    throw new Error(`Admin Google Workspace SSO redirected to '${redirect.host}' instead of 'accounts.google.com'.`);
  }
  if (redirect.searchParams.get("redirect_uri") !== `${adminOrigin}/api/auth/social/google/callback`) {
    throw new Error("Admin Google Workspace SSO did not use the admin Google callback URI.");
  }
  if (redirect.searchParams.get("hd") !== adminGoogleWorkspaceHostedDomain) {
    throw new Error(
      `Admin Google Workspace SSO did not include the expected hosted-domain hint '${adminGoogleWorkspaceHostedDomain}'.`,
    );
  }
}

async function expectUcpEndpoints(origin) {
  const profileResponse = await expectOk("UCP business profile", `${origin}/.well-known/ucp`);
  const profile = await profileResponse.json();
  const services = profile.ucp?.services?.["dev.ucp.shopping"] ?? [];
  const endpoints = new Set(
    Array.isArray(services) ? services.map((service) => `${service?.transport}:${service?.endpoint}`) : [],
  );
  for (const expectedEndpoint of [`rest:${origin}/ucp/v1`, `mcp:${origin}/ucp/mcp`]) {
    if (!endpoints.has(expectedEndpoint)) {
      throw new Error(`UCP business profile did not advertise ${expectedEndpoint}.`);
    }
  }

  const restResponse = await expectOk("UCP REST profile", `${origin}/ucp/v1`);
  const restProfile = await restResponse.json();
  if (restProfile.ucp?.services?.["dev.ucp.shopping"] === undefined) {
    throw new Error("UCP REST profile did not return the business profile.");
  }

  const mcpResponse = await expectOk("UCP MCP tools", `${origin}/ucp/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" }),
  });
  const mcpBody = await mcpResponse.json();
  const toolNames = new Set(Array.isArray(mcpBody.result?.tools) ? mcpBody.result.tools.map((tool) => tool?.name) : []);
  for (const expectedTool of ["search_catalog", "lookup_catalog", "create_checkout"]) {
    if (!toolNames.has(expectedTool)) {
      throw new Error(`UCP MCP tools did not include ${expectedTool}.`);
    }
  }

  const oauthResponse = await expectOk(
    "UCP OAuth authorization server metadata",
    `${origin}/.well-known/oauth-authorization-server`,
  );
  const oauthMetadata = await oauthResponse.json();
  if (!oauthMetadata.code_challenge_methods_supported?.includes("S256")) {
    throw new Error("UCP OAuth metadata did not advertise PKCE S256.");
  }
  if (!oauthMetadata.grant_types_supported?.includes("refresh_token")) {
    throw new Error("UCP OAuth metadata did not advertise refresh_token grants.");
  }
  if (oauthMetadata.introspection_endpoint !== `${origin}/ucp/oauth/introspect`) {
    throw new Error("UCP OAuth metadata did not advertise the token introspection endpoint.");
  }
}

async function expectNativeMcpAuthenticationBoundary(origin) {
  const response = await expectOk("native MCP anonymous discovery", `${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" }),
  });
  const summary = summarizeNativeMcpAnonymousDiscoveryTools(await response.json());
  if (!summary.isValid) {
    throw new Error(summary.diagnostic);
  }
}

async function expectNativeMcpInventoryRead({ origin, sessionToken, accountId }) {
  const commonHeaders = {
    Authorization: `Bearer ${sessionToken}`,
    "Content-Type": "application/json",
  };

  for (const revision of nativeMcpProtocolMatrix) {
    if (shouldInitializeNativeMcpRevision(revision)) {
      await expectOk(`native MCP ${revision} initialize`, `${origin}/mcp`, {
        method: "POST",
        headers: nativeMcpHeadersForRevision(revision, "initialize", undefined, commonHeaders),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `initialize-${revision}`,
          method: "initialize",
          params: { protocolVersion: revision },
        }),
      });
    }

    const toolsResponse = await expectOk(`native MCP ${revision} authenticated tools`, `${origin}/mcp`, {
      method: "POST",
      headers: nativeMcpHeadersForRevision(revision, "tools/list", undefined, commonHeaders),
      body: JSON.stringify(nativeMcpJsonRpcRequestForRevision(revision, `tools-${revision}`, "tools/list")),
    });
    const toolsBody = await toolsResponse.json();
    const toolNames = new Set(
      Array.isArray(toolsBody.result?.tools) ? toolsBody.result.tools.map((tool) => tool?.name) : [],
    );
    if (!toolNames.has("inventory.list-import-sources")) {
      throw new Error(`Native MCP ${revision} tools did not include inventory.list-import-sources.`);
    }

    const listSourcesResponse = await expectOk(`native MCP ${revision} inventory source read`, `${origin}/mcp`, {
      method: "POST",
      headers: nativeMcpHeadersForRevision(revision, "tools/call", "inventory.list-import-sources", commonHeaders),
      body: JSON.stringify(
        nativeMcpJsonRpcRequestForRevision(revision, `list-import-sources-${revision}`, "tools/call", {
          name: "inventory.list-import-sources",
          arguments: { accountId },
        }),
      ),
    });
    const listSourcesBody = await listSourcesResponse.json();
    if (listSourcesBody.error) {
      if (isNativeMcpPermissionBoundaryError(listSourcesBody.error, "inventory.view")) {
        console.warn(
          `Native MCP ${revision} inventory source read reached the authenticated permission boundary; skipping inventory-specific read proof.`,
        );
        return;
      }
      throw new Error(
        `Native MCP ${revision} inventory source read returned JSON-RPC error: ${listSourcesBody.error.message}.`,
      );
    }
    if (isNativeMcpPermissionBoundaryResult(listSourcesBody.result, "inventory.view")) {
      console.warn(
        `Native MCP ${revision} inventory source read reached the authenticated permission boundary; skipping inventory-specific read proof.`,
      );
      return;
    }
    const sourceSummary = summarizeNativeMcpImportSourceKeys(listSourcesBody.result);
    if (!sourceSummary.hasExpectedSource) {
      throw new Error(
        `Native MCP ${revision} inventory source read did not include the TCGplayer CSV source. ${sourceSummary.diagnostic}`,
      );
    }
  }
}

async function expectMarketplaceSurface(label, origin) {
  await expectOk(`${label} home`, `${origin}/`);
  await expectOk(`${label} search`, `${origin}/search`);
  await expectOk(`${label} platform API health`, `${origin}/api/health/ready`);
  await expectUcpEndpoints(origin);
}

async function expectAdminCommercialTermsPages(adminOrigin, sessionToken) {
  for (const { path, expectedText } of [
    { path: "/commerce/terms/schedules", expectedText: ["Commercial Terms", "Active and scheduled terms"] },
    { path: "/commerce/terms/agreements", expectedText: ["Commercial Terms", "Active and scheduled terms"] },
  ]) {
    const response = await expectOk(`admin Commercial Terms page ${path}`, `${adminOrigin}${path}`, {
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      throw new Error(`Admin Commercial Terms page ${path} returned '${contentType}' instead of HTML.`);
    }

    const text = await response.text();
    const missing = expectedText.filter((value) => !text.includes(value));
    if (missing.length > 0) {
      throw new Error(`Admin Commercial Terms page ${path} did not include expected text: ${missing.join(", ")}.`);
    }
  }
}

async function expectAdminDeployedPageMatrix(adminOrigin, sessionToken) {
  const rows = selectAdminDeployedPageSmokeRows({ requireFulfillmentPostage });
  if (!requireFulfillmentPostage) {
    console.warn("Skipping fulfillment postage admin page smoke; SMOKE_REQUIRE_FULFILLMENT_POSTAGE is not true.");
  }
  for (const row of rows) {
    await expectAdminHtmlPage({ adminOrigin, sessionToken, row });
  }
}

async function expectAdminDeployedApiProbes(adminOrigin, sessionToken) {
  const probes = selectAdminDeployedApiSmokeProbes({ requireFulfillmentPostage, topologyMode: adminTopologyMode });
  if (!requireFulfillmentPostage) {
    console.warn("Skipping fulfillment postage admin API smoke; SMOKE_REQUIRE_FULFILLMENT_POSTAGE is not true.");
  }
  for (const probe of probes) {
    await expectAdminApiProbe({ adminOrigin, sessionToken, probe });
  }
}

async function expectRedirect(label, input, expectedAuthority) {
  const response = await fetchWithRetry(label, input, { redirect: "manual" }, (candidate) => candidate.status === 302);

  const location = response.headers.get("location");
  if (!location) {
    throw new Error(`${label} did not include a Location header.`);
  }

  const redirected = new URL(location, input);
  if (redirected.host !== expectedAuthority) {
    throw new Error(`${label} redirected to '${redirected.host}' instead of '${expectedAuthority}'.`);
  }
  if (redirected.protocol !== "https:") {
    throw new Error(`${label} redirected with '${redirected.protocol}' instead of 'https:'.`);
  }
}

async function main() {
  if (requireMarketplace && !marketplaceUrl) {
    throw new Error("Marketplace URL is required when SMOKE_REQUIRE_MARKETPLACE=true.");
  }
  if (requireMarketplaceRoot && !marketplaceRootUrl) {
    throw new Error("Marketplace root URL is required when SMOKE_REQUIRE_MARKETPLACE_ROOT=true.");
  }
  if (requireLegacyRedirect && !redirectUrl) {
    throw new Error("Legacy redirect URL is required when SMOKE_REQUIRE_LEGACY_REDIRECT=true.");
  }
  if (requireAdmin && (!adminEmail || !adminPassword)) {
    throw new Error("PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD are required when SMOKE_REQUIRE_ADMIN=true.");
  }

  if (requireLanding) {
    await expectOk("landing home", `${landingUrl}/`);
    await expectOk("platform API health through landing", `${landingUrl}/api/health/ready`);
  } else {
    console.warn("Skipping landing smoke; SMOKE_REQUIRE_LANDING is not true.");
  }
  if (requireNativeMcp && requireLanding) {
    await expectNativeMcpAuthenticationBoundary(landingUrl);
  } else if (requireNativeMcp) {
    console.warn("Skipping native MCP smoke; landing smoke is disabled.");
  } else {
    console.warn("Skipping native MCP smoke; SMOKE_REQUIRE_NATIVE_MCP is not true.");
  }
  await expectOk("admin home", `${adminUrl}/`);
  await expectOk("platform API health through admin", `${adminUrl}/api/health/ready`);
  if (requireAdminGoogleWorkspaceSso) {
    await expectAdminGoogleWorkspaceSsoStart(adminUrl);
  }

  if (marketplaceUrl) {
    await expectMarketplaceSurface("marketplace", marketplaceUrl);
    if (requireSocialLogin) {
      await expectSocialLoginProviders(marketplaceUrl);
      await expectMarketplaceSocialLoginStarts(marketplaceUrl);
      await expectTextContains("marketplace sign-in social login controls", `${marketplaceUrl}/sign-in`, [
        "Continue with Google",
        "Continue with Facebook",
      ]);
      await expectTextContains("marketplace registration social login controls", `${marketplaceUrl}/register`, [
        "Continue with Google",
        "Continue with Facebook",
      ]);
    } else {
      console.warn("Skipping social login smoke; SMOKE_REQUIRE_SOCIAL_LOGIN is not true.");
    }
  }

  if (marketplaceRootUrl) {
    await expectMarketplaceSurface("marketplace root", marketplaceRootUrl);
  }

  if (redirectUrl) {
    await expectRedirect("legacy staging redirect", `${redirectUrl}/`, new URL(landingUrl).host);
  }

  let waitlistCommitReceipt = null;
  const writeLandingWaitlist = writeWaitlist && requireLanding;
  if (writeWaitlist && !requireLanding) {
    console.warn("Skipping waitlist smoke; landing smoke is disabled.");
  }

  if (writeLandingWaitlist) {
    const smokePagePath = createSmokePagePath();

    const waitlistSignupResponse = await expectOk("waitlist signup", `${landingUrl}/api/public-presence/waitlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: syntheticEmail,
        role: "both",
        interests: ["low-sales-fees"],
        marketingConsent: true,
        website: "",
        source: {
          pagePath: smokePagePath,
          referrer: null,
          utmSource: smokeUtmSource,
          utmMedium: smokeUtmMedium,
          utmCampaign: smokeUtmCampaign,
          utmContent: smokeUtmContent,
          utmTerm: smokeUtmTerm,
        },
      }),
    });
    waitlistCommitReceipt = waitlistSignupResponse.headers.get(commitReceiptHeader);
    if (!waitlistCommitReceipt) {
      throw new Error(`waitlist signup did not return ${commitReceiptHeader}.`);
    }
    if (!createReadAfterWriteReceiptFromCommitReceipt(waitlistCommitReceipt)) {
      throw new Error(`waitlist signup returned malformed ${commitReceiptHeader}.`);
    }
  }

  if (adminEmail && adminPassword) {
    const authResponse = await expectOk("admin password sign-in", `${adminUrl}/api/auth/password-sign-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    });
    const authBody = await authResponse.json();
    if (authBody.type !== "session-started" || !authBody.sessionToken) {
      throw new Error("Admin sign-in did not return a session token.");
    }
    const authenticatedMcpAccountId = nativeMcpAccountId || authBody.session?.account_id || null;
    if (requireNativeMcp && authenticatedMcpAccountId) {
      await expectNativeMcpInventoryRead({
        origin: adminUrl,
        sessionToken: authBody.sessionToken,
        accountId: authenticatedMcpAccountId,
      });
    } else if (!requireNativeMcp) {
      console.warn("Skipping authenticated native MCP smoke; SMOKE_REQUIRE_NATIVE_MCP is not true.");
    } else {
      console.warn("Skipping authenticated native MCP smoke; no account id was available.");
    }

    if (writeLandingWaitlist) {
      await expectEventually(
        "admin waitlist list",
        async () => {
          const waitlistReadAfterWriteReceipt = createReadAfterWriteReceiptFromCommitReceipt(waitlistCommitReceipt);
          if (!waitlistReadAfterWriteReceipt) {
            throw new Error(`waitlist signup returned malformed ${commitReceiptHeader}.`);
          }
          const waitlistResponse = await expectOk(
            "admin waitlist list",
            `${adminUrl}/api/public-presence/admin/waitlist?search=${encodeURIComponent(syntheticEmail)}`,
            {
              headers: {
                Authorization: `Bearer ${authBody.sessionToken}`,
                [readAfterWriteHeader]: waitlistReadAfterWriteReceipt,
                [readTargetContextHeader]: "public-presence",
              },
            },
          );
          return waitlistResponse.json();
        },
        (waitlistBody) => waitlistBody.items?.some((item) => item.email === syntheticEmail),
        (waitlistBody) =>
          `synthetic waitlist signup '${syntheticEmail}' was not found in ${waitlistBody.items?.length ?? 0} item(s)`,
      );
    }

    await expectAdminCommercialTermsPages(adminUrl, authBody.sessionToken);
    await expectAdminDeployedPageMatrix(adminUrl, authBody.sessionToken);
    await expectAdminDeployedApiProbes(adminUrl, authBody.sessionToken);
  } else {
    console.warn("Skipping authenticated admin smoke; admin credentials were not provided.");
  }

  console.log("Platform smoke checks passed.");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
