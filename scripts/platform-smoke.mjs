import process from "node:process";
import { getPlatformSmokeCliArgs } from "./platform-smoke-args.mjs";
import { ensureWorktreeSandboxEnvironment } from "./lib/sandbox.mjs";

const cliArgs = getPlatformSmokeCliArgs(process.argv);
const { env: sandboxEnv } = ensureWorktreeSandboxEnvironment();

function getSmokeEnv(name) {
  return process.env[name] ?? sandboxEnv[name] ?? "";
}

const landingUrl = validateHttpUrl(
  trimTrailingSlash(
    getSmokeEnv("LANDING_WEB_URL") ||
      getSmokeEnv("PUBLIC_WEB_URL") ||
      cliArgs[0] ||
      "",
  ),
  "landing URL",
);
const adminUrl = validateHttpUrl(
  trimTrailingSlash(getSmokeEnv("ADMIN_WEB_URL") || cliArgs[1] || ""),
  "admin URL",
);
const marketplaceUrl = validateHttpUrl(
  trimTrailingSlash(getSmokeEnv("MARKETPLACE_WEB_URL") || cliArgs[2] || ""),
  "marketplace URL",
);
const redirectUrl = validateHttpUrl(
  trimTrailingSlash(getSmokeEnv("LEGACY_PUBLIC_URL") || cliArgs[3] || ""),
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
const smokeUtmSource = getSmokeEnv("SMOKE_UTM_SOURCE") || getSmokeEnv("SMOKE_SOURCE") || "smoke";
const smokeUtmMedium = getSmokeEnv("SMOKE_UTM_MEDIUM") || "automation";
const smokeUtmCampaign = getSmokeEnv("SMOKE_UTM_CAMPAIGN") || "platform-smoke";
const smokeUtmContent = getSmokeEnv("SMOKE_UTM_CONTENT") || null;
const smokeUtmTerm = getSmokeEnv("SMOKE_UTM_TERM") || null;

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

async function expectOk(label, input, init) {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new Error(`${label} failed with ${response.status} ${response.statusText}`);
  }
  return response;
}

async function expectRedirect(label, input, expectedAuthority) {
  const response = await fetch(input, { redirect: "manual" });
  if (response.status !== 302) {
    throw new Error(`${label} expected temporary 302 redirect but received ${response.status}.`);
  }

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
