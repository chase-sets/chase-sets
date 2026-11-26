import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EbaySellerSetup, type SellerSetupState } from "../ui/seller-setup";
import { readSetupLists } from "../api/setup-listing";
import { choice, setupRead } from "./setup-fixtures";

const boundary = vi.hoisted(() => ({ ebay: vi.fn(), locations: vi.fn() }));
vi.mock("@chase-sets/platform-runtime/auth", () => ({ requireActorFromAuthApi: vi.fn(async () => ({})) }));
vi.mock("../ui/api-client", () => ({ createEbayConnectionClient: () => boundary.ebay }));
vi.mock("../../../support/request-support/setup-locations", () => ({
  readConnectionSetupLocations: boundary.locations,
}));
const render = (state: SellerSetupState, failed = false) => {
  const router = createMemoryRouter([
    { path: "/", element: <EbaySellerSetup state={state} connectionId="connection-1" failed={failed} /> },
  ]);
  try {
    return renderToStaticMarkup(<RouterProvider router={router} />);
  } finally {
    router.dispose();
  }
};
describe("ebay-sandbox-setup-page", () => {
  beforeEach(() => vi.clearAllMocks());
  it("renders loading, incomplete, empty, selection, error and activated states with design-system components", async () => {
    const lists = await readSetupLists("synthetic-token", setupRead);
    const loaded = {
      kind: "loaded" as const,
      lists,
      selection: null,
      locations: [{ storageLocationId: "storage-1", name: "Chase shelf" }],
      active: false,
    };
    expect(render({ kind: "loading" })).toContain("Loading eBay seller setup");
    expect(render({ kind: "error" })).toContain("could not be saved or loaded");
    const incomplete = render({ ...loaded, lists: { ...lists, payment: { status: "incomplete", items: [] } } });
    expect(incomplete).toContain("incomplete list");
    expect(incomplete).not.toContain("<select");
    const empty = render({ ...loaded, lists: { ...lists, payment: { status: "complete", items: [] } } });
    expect(empty).toContain("https://www.sandbox.ebay.com/sh/ovw");
    expect(empty).not.toContain("<select");
    const selection = render(loaded);
    expect(selection).toContain('name="fulfillmentPolicyId"');
    expect(selection).toContain('name="merchantLocationKey"');
    expect(selection).toContain("Save selection and activate");
    expect(selection).not.toContain('value="fulfillment-1" selected');
    expect(selection).not.toContain("channels.ebay.setup.");
    expect(render(loaded, true)).toContain("could not be saved or loaded");
    const active = render({
      ...loaded,
      active: true,
      selection: {
        connectionId: "connection-1",
        setupGeneration: 1,
        policies: choice().policies.map((item) => ({ ...item, materialFingerprint: `v1:${"a".repeat(64)}` })),
        locationPairs: choice().locationPairs.map((item) => ({ ...item, materialFingerprint: `v1:${"b".repeat(64)}` })),
      },
    });
    expect(active).toContain("Sandbox connection activated");
    expect(active).toContain("warehouse-1");
    expect(active).toContain("Replace selection");
  });
  const url = new URL("http://localhost/account/channels/ebay?connectionId=connection-1");
  const args = (request = new Request(url)) => ({ request, params: {}, context: {}, url, pattern: url.pathname });
});
