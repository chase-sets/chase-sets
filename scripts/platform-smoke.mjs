import process from "node:process";

const landingUrl = validateHttpUrl(
  trimTrailingSlash(
    process.env.LANDING_WEB_URL ??
      process.env.PUBLIC_WEB_URL ??
      process.argv[2] ??
      "",
  ),
  "landing URL",
);
const adminUrl = validateHttpUrl(
  trimTrailingSlash(process.env.ADMIN_WEB_URL ?? process.argv[3] ?? ""),
  "admin URL",
);
const marketplaceUrl = validateHttpUrl(
  trimTrailingSlash(process.env.MARKETPLACE_WEB_URL ?? process.argv[4] ?? ""),
  "marketplace URL",
);
const redirectUrl = validateHttpUrl(
  trimTrailingSlash(process.env.LEGACY_PUBLIC_URL ?? process.argv[5] ?? ""),
  "legacy redirect URL",
);
const syntheticEmail =
  process.env.SMOKE_WAITLIST_EMAIL ??
  process.env.SMOKE_EMAIL ??
  "ops+smoke@chasesets.com";
const adminEmail = process.env.PLATFORM_ADMIN_EMAIL ?? "";
const adminPassword = process.env.PLATFORM_ADMIN_PASSWORD ?? "";
const writeWaitlist =
  (process.env.SMOKE_WRITE_WAITLIST ?? "true").toLowerCase() !== "false";
const requireAdmin = readBooleanEnv("SMOKE_REQUIRE_ADMIN", false);
const requireMarketplace = readBooleanEnv("SMOKE_REQUIRE_MARKETPLACE", false);
const requireLegacyRedirect = readBooleanEnv("SMOKE_REQUIRE_LEGACY_REDIRECT", false);
const smokeUtmSource = process.env.SMOKE_UTM_SOURCE ?? process.env.SMOKE_SOURCE ?? "smoke";
const smokeUtmMedium = process.env.SMOKE_UTM_MEDIUM ?? "automation";
const smokeUtmCampaign = process.env.SMOKE_UTM_CAMPAIGN ?? "platform-smoke";
const smokeUtmContent = process.env.SMOKE_UTM_CONTENT ?? null;
const smokeUtmTerm = process.env.SMOKE_UTM_TERM ?? null;

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
  const value = process.env[name]?.trim().toLowerCase();
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
