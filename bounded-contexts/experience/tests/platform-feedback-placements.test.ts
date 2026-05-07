import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

async function routeSource(path: string) {
  return readFile(join(process.cwd(), "..", "..", path), "utf8");
}

describe("platform feedback prompt placements", () => {
  it("places checkout feedback after completed payment outcomes", async () => {
    const source = await routeSource(
      "bounded-contexts/payments/routes/marketplace/account-payment.tsx",
    );

    expect(source).toContain("PlatformFeedbackPrompt");
    expect(source).toContain('workflow="checkout-payment"');
    expect(source).toContain("payment.status === \"captured\"");
    expect(source).toContain("zeroDollarBalanceCovered");
    expect(source).toContain("payment.processor_amount === \"0.00\"");
    expect(source).toContain("payment.status !== \"pending-confirmation\"");
    expect(source).toContain("payment.status !== \"failed\"");
    expect(source).toContain("payment.status !== \"cancelled\"");
  });

  it("places listing, offer, and inventory feedback prompts with workflow context", async () => {
    const routes = await Promise.all([
      routeSource("bounded-contexts/marketplace/routes/account-listing.tsx"),
      routeSource("bounded-contexts/marketplace/routes/account-listings.tsx"),
      routeSource("bounded-contexts/discovery/routes/item-detail.tsx"),
      routeSource("bounded-contexts/marketplace/routes/account-offer-submitted.tsx"),
      routeSource("bounded-contexts/marketplace/routes/account-offer-match.tsx"),
      routeSource("bounded-contexts/inventory/routes/marketplace/account-inventory.tsx"),
      routeSource("bounded-contexts/inventory/routes/marketplace/account-inventory-item.tsx"),
    ]);
    const combinedSource = routes.join("\n");

    for (const workflow of [
      "listing-publish",
      "listing-update",
      "offer-submit",
      "offer-accept",
      "inventory-create",
      "inventory-adjust",
    ]) {
      expect(combinedSource).toContain(workflow);
    }

    expect(combinedSource.match(/PlatformFeedbackPrompt/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(combinedSource).toContain("relatedEntities");
  });
});
