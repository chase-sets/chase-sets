import process from "node:process";

const publicUrl = trimTrailingSlash(
  process.env.PUBLIC_WEB_URL ?? process.argv[2] ?? "",
);
const adminUrl = trimTrailingSlash(
  process.env.ADMIN_WEB_URL ?? process.argv[3] ?? "",
);
const syntheticEmail =
  process.env.SMOKE_WAITLIST_EMAIL ??
  process.env.SMOKE_EMAIL ??
  "ops+smoke@chasesets.com";
const adminEmail = process.env.PLATFORM_ADMIN_EMAIL ?? "";
const adminPassword = process.env.PLATFORM_ADMIN_PASSWORD ?? "";
const writeWaitlist =
  (process.env.SMOKE_WRITE_WAITLIST ?? "true").toLowerCase() !== "false";
const smokeUtmSource = process.env.SMOKE_UTM_SOURCE ?? process.env.SMOKE_SOURCE ?? "smoke";
const smokeUtmMedium = process.env.SMOKE_UTM_MEDIUM ?? "automation";
const smokeUtmCampaign = process.env.SMOKE_UTM_CAMPAIGN ?? "landing-smoke";
const smokeUtmContent = process.env.SMOKE_UTM_CONTENT ?? null;
const smokeUtmTerm = process.env.SMOKE_UTM_TERM ?? null;

if (!publicUrl || !adminUrl) {
  throw new Error(
    "Usage: PUBLIC_WEB_URL=https://... ADMIN_WEB_URL=https://... node scripts/landing-smoke.mjs",
  );
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
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

async function main() {
  await expectOk("public home", `${publicUrl}/`);
  await expectOk("public health", `${publicUrl}/api/health/ready`);
  await expectOk("admin home", `${adminUrl}/`);

  if (writeWaitlist) {
    const smokePagePath = createSmokePagePath();

    await expectOk("waitlist signup", `${publicUrl}/api/public-presence/waitlist`, {
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

  console.log("Landing smoke checks passed.");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
