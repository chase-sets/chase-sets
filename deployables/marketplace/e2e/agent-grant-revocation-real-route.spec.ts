import { expect, test } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPgPool, createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import {
  createAgentGrantRevocations,
  createLinkedPlatformAuthorizationStore,
  ownedBrowserIdentityDatabase,
} from "@chase-sets/identity/seed-support/account-management-browser";
import type { Pool } from "pg";
import { registerSyntheticAccount } from "./support/auth";

test.use({ trace: "off", video: "off", screenshot: "off" });
test("revocation-real-route synthetic Account, completion, retained forms, reload and foreign Account denial @marketplace-account", async ({
  page,
  baseURL,
}, info) => {
  if (!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname))
    throw new Error("local browser sandbox required");
  const platformApiUrl: unknown = info.config.metadata.platformApiUrl;
  if (typeof platformApiUrl !== "string" || !["localhost", "127.0.0.1"].includes(new URL(platformApiUrl).hostname))
    throw new Error("local browser API sandbox required");
  const identity = createHash("sha256").update(randomUUID()).digest("hex");
  const actor = {
    email: `${identity}@chasesets.test`,
    password: `E2e!${identity}`,
    displayName: "Synthetic Revocation Account A",
  };
  await registerSyntheticAccount(page, baseURL, actor, { freshReadRoute: "/account/security" });
  const response = await page.request.get("/api/identity/current-actor-display");
  expect(response.status()).toBe(200);
  const display = await response.json();
  const registration = await page.request.post(`${platformApiUrl}/ucp/oauth/register`, {
    data: {
      client_name: "Synthetic Revocation Agent",
      client_uri: "https://synthetic.example/profile",
      redirect_uris: ["https://synthetic.example/callback"],
      scope: "order:read",
    },
  });
  expect(registration.status()).toBe(201);
  const { client_id: clientId } = await registration.json();
  const pool = createPgPool(
    ownedBrowserIdentityDatabase(
      info.config.metadata.identityDatabaseUrl,
      info.config.metadata.catalogDatabaseUrl,
    ).toString(),
    { max: 2 },
  );
  const grantId = `synthetic_${randomUUID()}`;
  const tokenMarker = `SYNTHETIC_REVOCATION_PRIVATE_${randomUUID()}`;
  try {
    const events = createPostgresEventStore({ pool });
    const history = await readCompleteStream(events, {
      streamId: `identity.user-${display.user.user_id}`,
      maxEvents: 10000,
    });
    if (history[0]?.payload.primaryEmail !== actor.email) throw new Error("registered synthetic owner required");
    await createLinkedPlatformAuthorizationStore(pool).grant({
      authorizationId: grantId,
      accountId: display.account.account_id,
      userId: display.user.user_id,
      clientId,
      platformProfileUrl: "https://synthetic.example/profile",
      scopes: ["order:read"],
      accessTokenHash: tokenMarker,
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      grantedAt: new Date().toISOString(),
    });
    const owner = createAgentGrantRevocations(pool, events);
    const proof = {
      environment: "staging" as const,
      namespace: "synthetic-local-browser-only",
      releaseCommit: "a".repeat(40),
      imageDigest: `sha256:${"b".repeat(64)}`,
      evidenceId: "synthetic-local-browser-control",
      fenceId: "synthetic-local-only",
      capturedAt: new Date().toISOString(),
      expectedReplicas: ["synthetic-local-api", "synthetic-local-worker"],
      replicas: ["platform-api", "platform-worker"].map((role, index) => ({
        id: index ? "synthetic-local-worker" : "synthetic-local-api",
        uid: `synthetic-local-${index}`,
        role: role as "platform-api" | "platform-worker",
        commit: "a".repeat(40),
        digest: `sha256:${"b".repeat(64)}`,
        supportVersion: 1,
      })),
    };
    // Synthetic local control; explicitly not AC8 serving-set/capture authority.
    if (!(await owner.isActivated()))
      await owner.activate(
        proof,
        {
          tenantId: "tnt_identity",
          audit: { performedByUserId: "usr_identity_deployment", forAccountId: "acc_identity_deployment" },
        },
        { revalidate: async () => proof },
      );
    await page.goto(`/account/agents/${grantId}`);
    await expect(page.getByRole("heading", { name: "Synthetic Revocation Agent" })).toBeVisible();
    await expect(
      page.getByText("You can revoke access or confirm interrupted cleanup.", { exact: true }),
    ).toBeVisible();
    const mandate = page.locator('form:has(input[name="intent"][value="update-mandate"])');
    const webhook = page.locator('form:has(input[name="intent"][value="update-webhook"])');
    await expect(mandate).toBeVisible();
    await expect(webhook).toBeVisible();
    let posts = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === `/account/agents/${grantId}.data`) posts++;
    });
    await page.screenshot({ path: info.outputPath("editing.png"), fullPage: true });
    await page.getByRole("button", { name: "Revoke access", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke access", exact: true }).click();
    await expect(page.getByText("Access revoked and cleanup complete.", { exact: true })).toBeVisible();
    expect(posts).toBe(1);
    await expect(page.getByRole("button", { name: "Revoke access", exact: true })).toHaveCount(0);
    await expect(mandate).toBeVisible();
    await expect(webhook).toBeVisible();
    expect(await owner.readProgress(display.account.account_id, grantId)).toBe("completed");
    await page.screenshot({ path: info.outputPath("completed.png"), fullPage: true });
    await page.reload();
    await expect(page.getByRole("button", { name: "Revoke access", exact: true })).toHaveCount(0);
    await expect(mandate).toBeVisible();
    await expect(webhook).toBeVisible();
    const stored = await page.evaluate(() =>
      Object.entries(sessionStorage).filter(([key]) => key.startsWith("agent-grant-revocation:")),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0][1]).toMatch(/^[a-f0-9-]{36}$/i);
    const safeDom = await page.locator("body").innerText();
    expect(safeDom).not.toContain(tokenMarker);
    expect(JSON.stringify(stored)).not.toContain(tokenMarker);
    await writeFile(info.outputPath("completed.txt"), safeDom);
    const otherId = createHash("sha256").update(randomUUID()).digest("hex");
    await registerSyntheticAccount(
      page,
      baseURL,
      {
        email: `${otherId}@chasesets.test`,
        password: `E2e!${otherId}`,
        displayName: "Synthetic Revocation Account B",
      },
      { freshReadRoute: "/account/security" },
    );
    await page.goto(`/account/agents/${grantId}`);
    await expect(page.getByRole("heading", { name: "Synthetic Revocation Agent" })).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toContain(tokenMarker);
    await page.screenshot({ path: info.outputPath("foreign-account.png"), fullPage: true });
    for (const name of await readdir(info.outputDir)) {
      const bytes = await readFile(path.join(info.outputDir, name));
      expect(bytes.includes(Buffer.from(tokenMarker))).toBe(false);
    }
    await writeFile(
      info.outputPath("verdict.json"),
      JSON.stringify(
        {
          fixture: "isolated-synthetic",
          activation: "synthetic-control-not-live-authority",
          posts,
          phase: "completed",
          retainedForms: true,
          foreignAccountDenied: true,
          artifactScan: "PASS",
        },
        null,
        2,
      ),
    );
  } finally {
    await (pool as Pool).end();
  }
});
