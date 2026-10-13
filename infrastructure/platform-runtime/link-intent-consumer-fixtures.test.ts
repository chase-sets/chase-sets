import { expect, it } from "vitest";
import type { LinkIntent, LinkParameters, ParsedLinkIntent } from "@chase-sets/outbound-messaging";
import { links } from "@chase-sets/discovery/integration/link-intents";
import type { LinkIntentCatalog } from "@chase-sets/platform-runtime/link-intents";
import { buildCanonicalLink, linkIntentFixtures, parseCanonicalLink } from "@chase-sets/platform-runtime/link-intents";

// The same public input/output contract is available to the inbound and share-sheet successors.
export function consumeLink(
  catalog: LinkIntentCatalog,
  intent: LinkIntent,
  parameters: LinkParameters,
): ParsedLinkIntent {
  return parseCanonicalLink(catalog, buildCanonicalLink(catalog, intent.id, parameters).url);
}

it("link-intent-public-consumer-boundary typed owner fixtures", () => {
  expect(links("item-detail", { path: { id: "item-1" }, query: { market: "sell" } }).href).toBe(
    "/items/item-1?market=sell",
  );
  expect(typeof linkIntentFixtures).toBe("function");
  if (false) {
    // @ts-expect-error Route identities are owner-closed.
    links("missing-route", { path: {} });
    // @ts-expect-error Required path keys are owner-closed.
    links("item-detail", { path: {} });
    // @ts-expect-error Query keys and enum values are owner-closed.
    links("item-detail", { path: { id: "item-1" }, query: { market: "other" } });
    // @ts-expect-error An extra path key is not accepted.
    links("item-detail", { path: { id: "item-1", other: "value" } });
  }
});
