import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { matchRoutes } from "react-router";
import { links as marketplace } from "@chase-sets/marketplace/integration/link-intents";
import {
  mapReviewOpportunityToNotification,
  mapReviewReminderToNotification,
  mapReviewRevealedToNotification,
} from "../../bounded-contexts/marketplace/features/reviews/integrations/notifications/notification-intents";
import { mapProductAlertMatchToNotification } from "../../bounded-contexts/discovery/features/product-alerts/integrations/notifications/notification-intents";
import { buildCanonicalLink, composeLinkIntents, linkIntentFixtures, parseCanonicalLink } from "./link-intents";
import { resolveWebHostRouteRecords } from "./web";
import type { AccountId } from "@chase-sets/primitives/typed-ids";

it("link-intent-current-action-compatibility", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const contexts = execFileSync("git", ["ls-files", "bounded-contexts/*/context.json"], { cwd: root, encoding: "utf8" })
    .trim()
    .split(/\r?\n/)
    .map((path) => {
      const manifest = JSON.parse(readFileSync(`${root}/${path}`, "utf8"));
      return { contextName: manifest.contextName, packageName: manifest.packageName, manifest };
    });
  const catalog = composeLinkIntents(contexts);
  const inventory = JSON.parse(
    readFileSync(`${root}/scripts/check-structure/link-intent-action-producers.json`, "utf8"),
  );
  const fixtures = linkIntentFixtures(catalog);
  for (const producer of inventory) {
    if (producer.classification !== "business-navigation") continue;
    for (const intentId of producer.intentIds) {
      const intent = catalog.intents.find((row) => row.id === intentId)!;
      const fixture = fixtures.find((row) => row.intentId === intentId)!;
      const built = buildCanonicalLink(catalog, intentId, fixture.parameters);
      const routes = resolveWebHostRouteRecords(contexts, intent.host).map((row) => ({
        id: `${row.contextName}.${row.routeId}`,
        path: `/${row.routePath}`,
      }));
      expect(matchRoutes(routes, built.href)?.at(-1)?.route.id, `${producer.id} -> ${intentId}`).toBe(intentId);
      expect(parseCanonicalLink(catalog, built.url)).toMatchObject({ kind: "intent", intent: { id: intentId } });
    }
  }
  const accountId = "account-1" as AccountId;
  for (const authorRole of ["buyer", "seller"] as const) {
    const input = {
      orderId: "order-1",
      authorAccountId: accountId,
      authorRole,
      subjectDisplayName: null,
      correlationId: "trace-1",
      armedAt: "2026-01-01",
      eligibleAt: "2026-01-01",
    };
    for (const mapper of [mapReviewOpportunityToNotification, mapReviewReminderToNotification]) {
      const message = mapper(input);
      expect(message.actionHref).toBe(`/account/${authorRole === "buyer" ? "purchases" : "sales"}/order-1/review`);
      expect(parseCanonicalLink(catalog, `https://marketplace.chasesets.com${message.actionHref}`).kind).toBe("intent");
    }
  }
  const revealed = mapReviewRevealedToNotification({
    reviewId: "review-1",
    orderId: "order-1",
    subjectAccountId: accountId,
    subjectRole: "seller",
    authorDisplayName: null,
    correlationId: "trace-1",
  });
  expect(revealed.actionHref).toBe(marketplace("account-review", { path: { reviewId: "review-1" } }).href);
  for (const marketSide of ["listing", "offer"] as const) {
    const message = mapProductAlertMatchToNotification({
      marketSide,
      accountId,
      alertId: "alert-1",
      activityId: "activity-1",
      catalogItemId: "item-1",
      itemTitle: "item",
      productSummary: null,
      priceAmount: "1",
      priceCurrencyCode: "USD",
      correlationId: "trace-1",
    });
    expect(message.actionHref).toBe(`/items/item-1${marketSide === "offer" ? "?market=sell" : ""}`);
    expect(parseCanonicalLink(catalog, `https://marketplace.chasesets.com${message.actionHref}`).kind).toBe("intent");
  }
});
