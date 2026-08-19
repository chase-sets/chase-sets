import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  authenticateAdmin,
  createReadAfterWriteHeaderFactoryFromUrl,
  expectAdminPageReady,
  expectPageOk,
  isProjectionFreshnessTimeoutResponse,
  skipDeployedAdminE2e,
  waitForProjectionPositionFromResponse,
  waitForProjectionPositionFromUrl,
  type ReadAfterWriteHeaderFactory,
} from "./support/admin-e2e";

type PostagePolicyDetailApiResponse = Readonly<{
  policy_id: string;
  status: string;
  activation_reason: string | null;
  history: readonly Readonly<{
    event_type: string;
    reason: string | null;
    status: string;
  }>[];
}>;

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pullRequestIdentity() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  expect(eventPath, "GITHUB_EVENT_PATH must identify the pull_request event payload").toBeTruthy();
  const event = JSON.parse(readFileSync(eventPath!, "utf8")) as {
    number?: number;
    pull_request?: { number?: number; head?: { sha?: string } };
  };
  const pr = event.pull_request?.number ?? event.number;
  const head = event.pull_request?.head?.sha;
  expect(pr, "pull request number must be present in the event payload").toBeGreaterThan(0);
  expect(head, "pull_request.head.sha must be a full commit identity").toMatch(/^[0-9a-f]{40}$/);
  return { pr: pr!, head: head! };
}

async function setAuthenticatedColorMode(page: Page, mode: "light" | "dark") {
  const themeRoot = page.locator("[data-chase-theme]").first();
  await expect(themeRoot).toBeVisible();
  await expect(themeRoot).toHaveAttribute("data-chase-theme", "");
  await themeRoot.evaluate((element, nextMode) => element.setAttribute("data-color-mode", nextMode), mode);
  await expect(themeRoot).toHaveAttribute("data-color-mode", mode);
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

test.describe("commerce admin postage policies", () => {
  test("operator creates, previews, and activates a postage policy @admin-commerce", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await page.setViewportSize({ width: 1280, height: 900 });
    await authenticateAdmin(page, "/commerce/postage-policies", "/access/sign-in");
    await expectPageOk(page, "/commerce/postage-policies");
    await expect(page).toHaveURL(/\/commerce\/postage-policies$/);
    await expectAdminPageReady(page, { heading: "Postage Policies" });

    const uniqueSuffix = Date.now().toString(36);
    const label = `E2E postage policy ${uniqueSuffix}`;
    const policyVersion = `e2e-${uniqueSuffix}`;
    const createForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Create draft" }) });
    let policyId: string | null = null;

    try {
      await createForm.getByLabel("Label", { exact: true }).fill(label);
      await createForm.getByLabel("Policy version", { exact: true }).fill(policyVersion);
      await expect(createForm.getByLabel("Label", { exact: true })).toHaveValue(label);
      await expect(createForm.getByLabel("Policy version", { exact: true })).toHaveValue(policyVersion);
      await createForm.getByRole("button", { name: "Create draft" }).click();
      await page.waitForURL(
        (url) =>
          url.pathname === "/commerce/postage-policies" &&
          url.searchParams.has("policy") &&
          url.search.includes("afterWrite"),
        {
          timeout: 30_000,
        },
      );
      const createUrl = new URL(page.url());
      policyId = createUrl.searchParams.get("policy");
      expect(policyId, "create redirect should include the postage policy id").toMatch(/^opp_/);
      await waitForOrderingPostagePolicyProjection(page, createUrl, `create postage policy ${policyId}`);
      await page.goto(`/commerce/postage-policies?policy=${policyId}`, { waitUntil: "domcontentloaded" });
      // The selected policy opens in a modal SideSheet, which makes the underlying page
      // heading inert; assert readiness against the drawer's own title heading (the label).
      await expectAdminPageReady(page, { heading: label });
      const policyDrawer = page.getByRole("dialog", { name: label });
      await expect(policyDrawer).toBeVisible();
      await expect(policyDrawer.getByRole("textbox", { name: "Policy version" }).first()).toHaveValue(policyVersion);

      await policyDrawer.getByRole("button", { name: "Preview result" }).click();
      await expect(policyDrawer.getByText("Preview Result").last()).toBeVisible();
      await expect(policyDrawer.getByText(/Packages:/)).toBeVisible();
      await expect(policyDrawer.getByText(/Mailpiece:/)).toBeVisible();
      await expect(policyDrawer.getByText(/Parcel required:/)).toBeVisible();

      const assertPostagePolicyState = async () => {
        await expect(page).toHaveURL(new RegExp(`/commerce/postage-policies\\?policy=${policyId}$`));
        await expect(policyDrawer).toBeVisible();
        await expect(policyDrawer.getByText(`Policy ID: ${policyId}`)).toBeVisible();
        await expect(policyDrawer.getByText("draft").first()).toBeVisible();
        await expect(policyDrawer.getByText("Preview Result").last()).toBeVisible();
        await expect(policyDrawer.getByText(/Packages:/)).toBeVisible();
        await expect(policyDrawer.getByText(/Mailpiece:/)).toBeVisible();
        await expect(policyDrawer.getByText(/Parcel required:/)).toBeVisible();
        const underlyingRows = page.locator('[inert] table tbody tr');
        expect(
          await underlyingRows.count(),
          "underlying policy table must retain at least two rows",
        ).toBeGreaterThanOrEqual(2);
        await expect(underlyingRows.nth(0)).toBeVisible();
        await expect(underlyingRows.nth(1)).toBeVisible();
      };

      await assertPostagePolicyState();
      const identity = pullRequestIdentity();
      for (const [offset, theme] of ["light", "dark"].entries()) {
        await setAuthenticatedColorMode(page, theme as "light" | "dark");
        await assertPostagePolicyState();
        const imageName = `issue-6020-postage-policy-${theme}.png`;
        const png = await page.screenshot({ fullPage: true });
        expect(png.length, `${imageName} must contain a bounded PNG payload`).toBeGreaterThan(8);
        expect(png.length, `${imageName} must stay within the 20 MiB evidence bound`).toBeLessThanOrEqual(
          20 * 1024 * 1024,
        );
        expect(
          png.subarray(0, pngSignature.length).equals(pngSignature),
          `${imageName} must have the PNG signature`,
        ).toBe(true);
        const pngSha256 = createHash("sha256").update(png).digest("hex");
        await testInfo.attach(imageName, { body: png, contentType: "image/png" });
        console.log(
          `ISSUE_6020_HOSTED_EVIDENCE ${JSON.stringify({
            schemaVersion: "issue-6020-hosted-evidence/v1",
            entryIndex: offset + 3,
            entryCount: 4,
            pr: identity.pr,
            head: identity.head,
            suite: "admin_commerce",
            spec: "deployables/admin-web/e2e/commerce-postage-policies.spec.ts",
            state: "postage-policy",
            theme,
            route: "/commerce/postage-policies?policy=:policyId",
            anchors: [
              "created-policy-drawer-open",
              "populated-preview",
              "policy-id-visible",
              "policy-state-draft",
              "underlying-policy-rows>=2",
            ],
            imageName,
            pngBytes: png.length,
            pngSha256,
          })}`,
        );
      }

      const activationForm = policyDrawer
        .locator("form")
        .filter({ has: page.getByLabel("Activation reason", { exact: true }) });
      const activationReason = `E2E activation ${uniqueSuffix}`;
      await activationForm.getByLabel("Activation reason", { exact: true }).fill(activationReason);
      await expect(activationForm.getByLabel("Activation reason", { exact: true })).toHaveValue(activationReason);
      await activationForm.getByRole("button", { name: "Activate" }).click();
      await page
        .getByRole("alertdialog", { name: `Activate ${label}?` })
        .getByRole("button", { name: "Activate" })
        .click();
      await page.waitForURL(
        (url) =>
          url.pathname === "/commerce/postage-policies" &&
          url.searchParams.get("policy") === policyId &&
          url.search.includes("afterWrite"),
        {
          timeout: 30_000,
        },
      );
      const activationUrl = new URL(page.url());
      const activatedPolicyId = activationUrl.searchParams.get("policy");
      expect(activatedPolicyId, "activation redirect should include the postage policy id").toBe(policyId);
      const activationReadAfterWriteHeaders = createReadAfterWriteHeaderFactoryFromUrl(activationUrl, {
        targetContextName: "ordering",
        label: `activate postage policy ${activatedPolicyId}`,
      });
      await waitForOrderingPostagePolicyProjection(page, activationUrl, `activate postage policy ${activatedPolicyId}`);
      await waitForPostagePolicyActivationReadModel(
        page,
        activatedPolicyId!,
        activationReason,
        activationReadAfterWriteHeaders,
      );
      await page.goto(`/commerce/postage-policies?policy=${activatedPolicyId}`, { waitUntil: "domcontentloaded" });
      await expectActivatedPolicy(page, label, activationReason);
      await expect(
        page.getByRole("dialog", { name: label }).getByRole("row").filter({ hasText: "activated" }),
      ).toBeVisible();
    } finally {
      if (policyId) {
        const retireResponse = await page.request.post(
          `${apiOrigin(page)}/api/marketplace/admin/postage-policies/${policyId}/retire`,
          { data: { retirementReason: `E2E cleanup ${uniqueSuffix}` } },
        );
        expect(retireResponse.status(), `retire postage policy ${policyId} should return 200`).toBe(200);
        await waitForProjectionPositionFromResponse(page, retireResponse, {
          sourceContextName: "ordering",
          targetContextName: "ordering",
          projectionName: "ordering-postage-policy-projection",
          label: `retire postage policy ${policyId}`,
        });
      }
    }
  });
});

async function waitForOrderingPostagePolicyProjection(page: Page, url: URL, label: string) {
  await waitForProjectionPositionFromUrl(page, url, {
    sourceContextName: "ordering",
    targetContextName: "ordering",
    projectionName: "ordering-postage-policy-projection",
    label,
  });
}

async function waitForPostagePolicyActivationReadModel(
  page: Page,
  policyId: string,
  activationReason: string,
  readAfterWriteHeaders: ReadAfterWriteHeaderFactory,
) {
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `${apiOrigin(page)}/api/marketplace/admin/postage-policies/${policyId}`,
          { headers: readAfterWriteHeaders() },
        );
        if (await isProjectionFreshnessTimeoutResponse(response)) {
          return "projection-pending";
        }
        expect(response.status(), `postage policy detail read model query should return 200`).toBe(200);

        const body = (await response.json()) as PostagePolicyDetailApiResponse;
        const activationHistoryPresent = body.history.some(
          (entry) => entry.event_type === "activated" && entry.status === "active" && entry.reason === activationReason,
        );
        return body.status === "active" && body.activation_reason === activationReason && activationHistoryPresent
          ? "active"
          : `${body.status}:${body.activation_reason ?? "missing-reason"}:${
              activationHistoryPresent ? "history-present" : "history-missing"
            }`;
      },
      { intervals: [1_000, 2_000, 5_000], timeout: 90_000 },
    )
    .toBe("active");
}

async function expectActivatedPolicy(page: Page, label: string, activationReason: string) {
  await expect(async () => {
    await expectAdminPageReady(page, { heading: label }, { timeoutMs: 15_000 });
    const drawer = page.getByRole("dialog", { name: label });
    const activeVisible = await drawer
      .getByText("active")
      .first()
      .isVisible({ timeout: 1_000 })
      .catch(() => false);
    const reasonVisible = await drawer
      .getByText(`Activation reason: ${activationReason}`)
      .isVisible({ timeout: 1_000 })
      .catch(() => false);
    if (!activeVisible || !reasonVisible) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
    }
    expect(activeVisible && reasonVisible).toBe(true);
  }).toPass({ intervals: [1_000, 2_000, 5_000], timeout: 90_000 });
}

function apiOrigin(page: Page) {
  return new URL(page.url()).origin;
}
