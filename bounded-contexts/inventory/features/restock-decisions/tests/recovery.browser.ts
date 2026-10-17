import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { UNSAFE_decodeViaTurboStream } from "react-router";
import { readFreshWriteToken } from "@chase-sets/http/responses";
import { createPgPool, createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { closeMultiContextTestPools } from "@chase-sets/bounded-context-runtime/test-support";
import type { JsonObject } from "@chase-sets/primitives/json";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";
import { inventorySeedIds } from "../../../support/seed-support/ids";
import { buildInventoryItemProjectionHandlers } from "../../inventory-items/read-model/projection";
import { buildInventoryRestockDecisionProjectionHandlers } from "../read-model/projection";
import { registerImportRecoveryBrowserTests } from "../../import-batches/tests/recovery.browser";

const path = "/account/inventory/restock-decisions";
const mutationRequest = (request: { url(): string; method(): string }) =>
  request.method() === "POST" && new URL(request.url()).pathname === `${path}.data`;

type SignIn = (page: Page, baseUrl: string) => Promise<void>;

async function fixture(page: Page, info: TestInfo, signIn: SignIn) {
  const baseUrl = String(info.project.use.baseURL);
  if (!["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname)) throw new Error("Owned local browser required");
  const env = parseEnv(
    readFileSync(
      process.env.CHASE_SETS_SANDBOX_ENV_FILE ?? new URL("../../../../../.env.sandbox.local", import.meta.url),
      "utf8",
    ),
  );
  const catalog = info.config.metadata.catalogDatabaseUrl;
  if (catalog !== env.DATABASE_URL_CATALOG || !env.DATABASE_URL_INVENTORY)
    throw new Error("Owned local Inventory database required");
  const database = new URL(env.DATABASE_URL_INVENTORY);
  const catalogDatabase = new URL(String(catalog));
  if (
    !["localhost", "127.0.0.1"].includes(database.hostname) ||
    database.host !== catalogDatabase.host ||
    database.pathname !== catalogDatabase.pathname.replace(/_catalog$/, "_inventory") ||
    !/^\/cs_[a-z0-9_]+_inventory$/.test(database.pathname)
  )
    throw new Error("Owned local Inventory database required");
  await signIn(page, baseUrl);
  const session = await page.request.get("/api/auth/session");
  expect(session.status()).toBe(200);
  const { actor } = await session.json();
  const context = {
    tenantId: parseTypedId(String(actor.tenantId), "tnt"),
    audit: {
      performedByUserId: parseTypedId(String(actor.userId), "usr"),
      forAccountId: parseTypedId(String(actor.accountId), "acc"),
    },
  };
  const pool = createPgPool(database.toString(), { max: 2 });
  const events = createPostgresEventStore({ pool });
  const token = randomUUID();
  const itemId = `inv_c2_browser_${token}`;
  const decisionId = `rstk_c2_browser_${token}`;
  const orderId = `ord_c2_browser_${token}`;
  try {
    const original = await pool.query<{ payload: JsonObject }>(
      "SELECT payload FROM event_store_events WHERE stream_id = $1 AND stream_version = 1 AND payload ->> 'accountId' = $2",
      [`inventory.item-${inventorySeedIds.items.charizardBaseSetNearMint}`, actor.accountId],
    );
    expect(original.rows).toHaveLength(1);
    if (!events.appendToStreams) throw new Error("Atomic fixture append required");
    const seeded = await events.appendToStreams([
      {
        streamId: `inventory.item-${itemId}`,
        expectedVersion: "no_stream",
        context,
        events: [
          {
            eventType: "inventory.item.created",
            payload: { ...original.rows[0].payload, itemId, totalQuantity: 1 },
          },
        ],
      },
      {
        streamId: `inventory.restock-decision-${decisionId}`,
        expectedVersion: "no_stream",
        context,
        events: [
          {
            eventType: "inventory.restock-decision.pending",
            payload: {
              decisionId,
              itemId,
              accountId: actor.accountId,
              orderId,
              quantity: 2,
              source: "shipment-returned",
              sourceRef: { orderId, reservationRequestId: `rsv_c2_browser_${token}` },
              shipmentId: null,
              returnReason: null,
              pendingAt: new Date().toISOString(),
            },
          },
        ],
      },
    ]);
    const handlers = {
      ...buildInventoryItemProjectionHandlers(pool),
      ...buildInventoryRestockDecisionProjectionHandlers(pool),
    };
    for (const stream of seeded)
      for (const event of stream.storedEvents) await handlers[event.eventType]!(toTransportEvent(event));
    await expect
      .poll(async () =>
        (await page.request.get("/api/inventory/restock-decisions?limit=250&offset=0"))
          .json()
          .then((result) => result.items.some((item: { decision_id: string }) => item.decision_id === decisionId)),
      )
      .toBe(true);
    return { actor, decisionId, itemId, pool, events, close: () => closeMultiContextTestPools({ inventory: pool }) };
  } catch (error) {
    await closeMultiContextTestPools({ inventory: pool });
    throw error;
  }
}

export function registerRestockRecoveryBrowserTests(
  signIn: SignIn,
  captureAccessibilityEvidence: (input: { page: Page; testInfo: TestInfo; surface: string }) => Promise<void>,
  importSignIn: SignIn = signIn,
) {
  registerImportRecoveryBrowserTests(importSignIn, captureAccessibilityEvidence);

  test.describe("@marketplace-seller @browser-e2e-seed issue-7169-c2-route-isolation AC2/9/10/11/13", () => {
    for (const outcome of ["restock", "write-off"] as const) {
      test(`real ${outcome} action loses its response and restores the exact result without another write`, async ({
        page,
      }, info) => {
        const owned = await fixture(page, info, signIn);
        try {
          await page.goto(path);
          const forms = page
            .locator("form")
            .filter({ has: page.locator(`input[name="decisionId"][value="${owned.decisionId}"]`) });
          const form = forms.filter({ has: page.locator(`input[name="intent"][value="${outcome}"]`) });
          const button = form.getByRole("button", {
            name: outcome === "restock" ? "Restock" : "Write off",
            exact: true,
          });
          await expect(button).toBeEnabled();
          expect(await form.locator('[name="expectedVersion"]').inputValue()).toBe("1");
          let posts = 0;
          let attemptId = "";
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          let accepted!: () => void;
          const committed = new Promise<void>((resolve) => {
            accepted = resolve;
          });
          await page.route(
            (url) => url.pathname === `${path}.data`,
            async (route) => {
              if (!mutationRequest(route.request())) return route.continue();
              posts++;
              const fields = new URLSearchParams(route.request().postData() ?? "");
              attemptId = fields.get("inventoryMutationAttemptId") ?? "";
              expect(attemptId).toMatch(/^[a-f0-9-]{36}$/);
              expect(fields.get("expectedVersion")).toBe("1");
              expect(fields.get("decisionId")).toBe(owned.decisionId);
              await gate;
              const result = await route.fetch({ maxRedirects: 0 });
              expect(result.status()).toBe(202);
              const redirect = await UNSAFE_decodeViaTurboStream(new Response(await result.text()).body!, globalThis);
              expect(redirect.value).toMatchObject({ status: 302 });
              const value = redirect.value;
              if (
                typeof value !== "object" ||
                value === null ||
                !("redirect" in value) ||
                typeof value.redirect !== "string"
              )
                throw new Error("Expected the real action redirect");
              const destination = new URL(value.redirect, String(info.project.use.baseURL));
              expect(destination.origin).toBe(new URL(String(info.project.use.baseURL)).origin);
              expect(destination.pathname).toBe(path);
              expect([...destination.searchParams.keys()]).toEqual(["afterWrite"]);
              expect(destination.hash).toBe("");
              const hint = readFreshWriteToken(destination);
              expect(hint).not.toBeNull();
              expect(hint!.sources).toHaveLength(1);
              expect(hint!.sources[0].sourceContextName).toBe("inventory");
              const committedItem = await owned.events.readStream({ streamId: `inventory.item-${owned.itemId}` });
              const committedDecision = await owned.events.readStream({
                streamId: `inventory.restock-decision-${owned.decisionId}`,
              });
              expect([...hint!.sources[0].eventIds].sort()).toEqual(
                [...committedItem.slice(1), ...committedDecision.slice(1)].map((event) => event.eventId).sort(),
              );
              await route.abort("failed");
              accepted();
            },
          );
          const responseLoss = page.waitForEvent("requestfailed", { predicate: mutationRequest });
          await button.click({ noWaitAfter: true });
          try {
            await expect(page.getByRole("status").filter({ hasText: "Submitting" })).toBeVisible();
            await expect(forms.getByRole("button", { name: "Restock", exact: true })).toBeDisabled();
            await expect(forms.getByRole("button", { name: "Write off", exact: true })).toBeDisabled();
          } finally {
            release();
          }
          await committed;
          await responseLoss;
          await page.goto(path);
          const status = page.getByRole("status").filter({ hasText: "original Inventory change is confirmed" });
          await expect(status).toBeVisible();
          await expect(status).toBeFocused();
          await expect(status).toHaveAttribute("aria-live", "polite");
          expect(posts).toBe(1);
          const receipt = await page.request.get(`/api/inventory/mutation-attempts/${attemptId}`);
          expect(receipt.status()).toBe(200);
          expect(receipt.headers()["cache-control"]).toBe("private, no-store");
          expect(await receipt.json()).toMatchObject({
            family: "restock-record",
            targetId: owned.decisionId,
            result: { decisionId: owned.decisionId, version: 2 },
          });
          const item = await owned.events.readStream({ streamId: `inventory.item-${owned.itemId}` });
          expect(item.map((event) => event.eventType)).toEqual(
            outcome === "restock" ? ["inventory.item.created", "inventory.item.adjusted"] : ["inventory.item.created"],
          );
          const before = await owned.events.readStream({ streamId: `inventory.restock-decision-${owned.decisionId}` });
          expect(before.map((event) => event.eventType)).toEqual([
            "inventory.restock-decision.pending",
            "inventory.restock-decision.recorded",
          ]);
          expect(before[1].payload.outcome).toBe(outcome === "restock" ? "restocked" : "written-off");
          expect(
            await page.evaluate(() =>
              Object.keys(sessionStorage).filter((key) => key.startsWith("inventory-mutation/v1:")),
            ),
          ).toEqual([]);
          await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
          await page.reload();
          expect(posts).toBe(1);
          expect(await owned.events.readStream({ streamId: `inventory.restock-decision-${owned.decisionId}` })).toEqual(
            before,
          );
        } finally {
          await owned.close();
        }
      });
    }

    test("aborted possible send restores ambiguity, disables both outcomes and shows focused responsive recovery", async ({
      page,
    }, info) => {
      const owned = await fixture(page, info, signIn);
      try {
        await page.goto(path);
        let posts = 0;
        await page.route(
          (url) => url.pathname === `${path}.data`,
          async (route) => {
            if (!mutationRequest(route.request())) return route.continue();
            posts++;
            return route.abort("failed");
          },
        );
        const forms = page
          .locator("form")
          .filter({ has: page.locator(`input[name="decisionId"][value="${owned.decisionId}"]`) });
        const responseLoss = page.waitForEvent("requestfailed", { predicate: mutationRequest });
        await forms.getByRole("button", { name: "Restock", exact: true }).click();
        await responseLoss;
        await page.goto(path);
        for (const width of [390, 1280]) {
          await page.setViewportSize({ width, height: 850 });
          const status = page.getByRole("status").filter({ hasText: "result is uncertain" });
          await expect(status).toBeVisible();
          await expect(status).toBeFocused();
          await expect(forms.getByRole("button", { name: "Restock", exact: true })).toBeDisabled();
          await expect(forms.getByRole("button", { name: "Write off", exact: true })).toBeDisabled();
          await expect(page.getByRole("button", { name: "Check original result", exact: true })).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await info.attach(`restock-ambiguous-${width}.png`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: "image/png",
          });
        }
        await page.getByRole("button", { name: "Check original result", exact: true }).click();
        expect(posts).toBe(1);
        const history = await owned.events.readStream({ streamId: `inventory.restock-decision-${owned.decisionId}` });
        expect(history).toHaveLength(1);
        await page.evaluate((accountId) => {
          const key = `inventory-mutation/v1:${encodeURIComponent(accountId)}:restock-record`;
          const stored = JSON.parse(sessionStorage.getItem(key)!);
          sessionStorage.setItem(key, JSON.stringify({ ...stored, actorUserId: "usr_foreign_synthetic" }));
        }, owned.actor.accountId);
        await page.reload();
        await expect(page.getByRole("status").filter({ hasText: "Sign in" })).toBeFocused();
        expect(posts).toBe(1);
      } finally {
        await owned.close();
      }
    });
  });
}
