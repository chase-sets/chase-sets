import process from "node:process";
import { getPlatformSmokeCliArgs } from "./platform-smoke-args.mjs";
import { ensureWorktreeSandboxEnvironment } from "./lib/sandbox.mjs";

const cliArgs = getPlatformSmokeCliArgs(process.argv);
const { env: sandboxEnv } = ensureWorktreeSandboxEnvironment();

function getSmokeEnv(name) {
  return process.env[name] ?? sandboxEnv[name] ?? "";
}

function getExplicitEnv(name) {
  return process.env[name] ?? "";
}

function getConfiguredUrl(primaryName, cliValue, fallbackName) {
  return (
    getExplicitEnv(primaryName) ||
    (fallbackName ? getExplicitEnv(fallbackName) : "") ||
    cliValue ||
    sandboxEnv[primaryName] ||
    (fallbackName ? sandboxEnv[fallbackName] : "") ||
    ""
  );
}

const landingUrl = validateHttpUrl(
  trimTrailingSlash(
    getConfiguredUrl("LANDING_WEB_URL", cliArgs[0] || "", "PUBLIC_WEB_URL"),
  ),
  "landing URL",
);
const adminUrl = validateHttpUrl(
  trimTrailingSlash(getConfiguredUrl("ADMIN_WEB_URL", cliArgs[1] || "")),
  "admin URL",
);
const marketplaceUrl = validateHttpUrl(
  trimTrailingSlash(getConfiguredUrl("MARKETPLACE_WEB_URL", cliArgs[2] || "")),
  "marketplace URL",
);
const redirectUrl = validateHttpUrl(
  trimTrailingSlash(getConfiguredUrl("LEGACY_PUBLIC_URL", cliArgs[3] || "")),
  "legacy redirect URL",
);
const syntheticEmail =
  getSmokeEnv("SMOKE_WAITLIST_EMAIL") ||
  getSmokeEnv("SMOKE_EMAIL") ||
  "ops+smoke@chasesets.com";
const adminEmail = getSmokeEnv("PLATFORM_ADMIN_EMAIL");
const adminPassword = getSmokeEnv("PLATFORM_ADMIN_PASSWORD");
const writeWaitlist =
  (getSmokeEnv("SMOKE_WRITE_WAITLIST") || "true").toLowerCase() !== "false";
const requireAdmin = readBooleanEnv("SMOKE_REQUIRE_ADMIN", false);
const requireMarketplace = readBooleanEnv("SMOKE_REQUIRE_MARKETPLACE", false);
const requireLegacyRedirect = readBooleanEnv("SMOKE_REQUIRE_LEGACY_REDIRECT", false);
const requireSocialLogin = readBooleanEnv("SMOKE_REQUIRE_SOCIAL_LOGIN", false);
const smokeUtmSource = getSmokeEnv("SMOKE_UTM_SOURCE") || getSmokeEnv("SMOKE_SOURCE") || "smoke";
const smokeUtmMedium = getSmokeEnv("SMOKE_UTM_MEDIUM") || "automation";
const smokeUtmCampaign = getSmokeEnv("SMOKE_UTM_CAMPAIGN") || "platform-smoke";
const smokeUtmContent = getSmokeEnv("SMOKE_UTM_CONTENT") || null;
const smokeUtmTerm = getSmokeEnv("SMOKE_UTM_TERM") || null;
const fetchAttempts = readPositiveIntegerEnv("SMOKE_FETCH_ATTEMPTS", 6);
const fetchRetryDelayMs = readPositiveIntegerEnv("SMOKE_FETCH_RETRY_DELAY_MS", 5_000);

if (!landingUrl || !adminUrl) {
  throw new Error(
    "Usage: node scripts/platform-smoke.mjs https://landing... https://admin... [https://marketplace...] [https://legacy...]",
  );
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function validateHttpUrl(value, label) {
  if (!value) {
    return value;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute URL.`);
  }

  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(`${label} must include an http(s) scheme and hostname.`);
  }

  return value;
}

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
      const response = await fetch(input, init);
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
      const detail = lastResponse
        ? `${lastResponse.status} ${lastResponse.statusText}`
        : describeFetchError(lastError);
      console.warn(
        `${label} attempt ${attempt}/${fetchAttempts} failed for ${input}: ${detail}; retrying in ${fetchRetryDelayMs}ms.`,
      );
      await delay(fetchRetryDelayMs);
    }
  }

  if (lastResponse) {
    throw new Error(
      `${label} failed for ${input} with ${lastResponse.status} ${lastResponse.statusText}.`,
    );
  }

  throw new Error(`${label} failed for ${input}: ${describeFetchError(lastError)}`);
}

async function expectOk(label, input, init) {
  const response = await fetchWithRetry(label, input, init, (candidate) => candidate.ok);
  return response;
}

async function expectTextContains(label, input, expectedText) {
  const response = await expectOk(label, input);
  const text = await response.text();
  const missing = expectedText.filter((value) => !text.includes(value));
  if (missing.length > 0) {
    throw new Error(`${label} did not include expected text: ${missing.join(", ")}.`);
  }
}

async function expectSocialLoginProviders(marketplaceOrigin) {
  const response = await expectOk(
    "marketplace social login providers",
    `${marketplaceOrigin}/api/auth/social/providers`,
  );
  const body = await response.json();
  const providerNames = new Set(
    Array.isArray(body.providers)
      ? body.providers.map((provider) => provider?.providerName)
      : [],
  );

  for (const providerName of ["google", "facebook"]) {
    if (!providerNames.has(providerName)) {
      throw new Error(
        `Marketplace social login providers did not include '${providerName}'.`,
      );
    }
  }
}

async function expectRedirect(label, input, expectedAuthority) {
  const response = await fetchWithRetry(
    label,
    input,
    { redirect: "manual" },
    (candidate) => candidate.status === 302,
  );

  const location = response.headers.get("location");
  if (!location) {
    throw new Error(`${label} did not include a Location header.`);
  }

  const redirected = new URL(location, input);
  if (redirected.host !== expectedAuthority) {
    throw new Error(
      `${label} redirected to '${redirected.host}' instead of '${expectedAuthority}'.`,
    );
  }
  if (redirected.protocol !== "https:") {
    throw new Error(`${label} redirected with '${redirected.protocol}' instead of 'https:'.`);
  }
}

async function main() {
  if (requireMarketplace && !marketplaceUrl) {
    throw new Error("Marketplace URL is required when SMOKE_REQUIRE_MARKETPLACE=true.");
  }
  if (requireLegacyRedirect && !redirectUrl) {
    throw new Error("Legacy redirect URL is required when SMOKE_REQUIRE_LEGACY_REDIRECT=true.");
  }
  if (requireAdmin && (!adminEmail || !adminPassword)) {
    throw new Error(
      "PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD are required when SMOKE_REQUIRE_ADMIN=true.",
    );
  }

  await expectOk("landing home", `${landingUrl}/`);
  await expectOk("platform API health through landing", `${landingUrl}/api/health/ready`);
  await expectOk("admin home", `${adminUrl}/`);
  await expectOk("platform API health through admin", `${adminUrl}/api/health/ready`);

  if (marketplaceUrl) {
    await expectOk("marketplace home", `${marketplaceUrl}/`);
    await expectOk("marketplace search", `${marketplaceUrl}/search`);
    await expectOk(
      "platform API health through marketplace",
      `${marketplaceUrl}/api/health/ready`,
    );
    if (requireSocialLogin) {
      await expectSocialLoginProviders(marketplaceUrl);
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

  if (redirectUrl) {
    await expectRedirect(
      "legacy staging redirect",
      `${redirectUrl}/`,
      new URL(landingUrl).host,
    );
  }

  if (writeWaitlist) {
    const smokePagePath = createSmokePagePath();

    await expectOk("waitlist signup", `${landingUrl}/api/public-presence/waitlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: syntheticEmail,
        role: "both",
        interests: ["low-seller-fees"],
        emailConsent: true,
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
  }

  if (adminEmail && adminPassword) {
    const authResponse = await expectOk(
      "admin password sign-in",
      `${adminUrl}/api/auth/password-sign-in`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: adminEmail, password: adminPassword }),
      },
    );
    const authBody = await authResponse.json();
    if (authBody.type !== "session-started" || !authBody.sessionToken) {
      throw new Error("Admin sign-in did not return a session token.");
    }

    const waitlistResponse = await expectOk(
      "admin waitlist list",
      `${adminUrl}/api/public-presence/admin/waitlist?search=${encodeURIComponent(
        syntheticEmail,
      )}`,
      {
        headers: {
          Authorization: `Bearer ${authBody.sessionToken}`,
        },
      },
    );
    const waitlistBody = await waitlistResponse.json();
    if (
      writeWaitlist &&
      !waitlistBody.items?.some((item) => item.email === syntheticEmail)
    ) {
      throw new Error(`Synthetic waitlist signup '${syntheticEmail}' was not found.`);
    }
  } else {
    console.warn("Skipping authenticated admin smoke; admin credentials were not provided.");
  }

  console.log("Platform smoke checks passed.");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
