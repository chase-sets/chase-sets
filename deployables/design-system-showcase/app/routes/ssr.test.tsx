import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MarketplaceShowcaseRoute, { meta as marketplaceMeta } from "./marketplace";

describe("design system showcase SSR routes", () => {
  it("renders the marketplace showcase route on the server", () => {
    const html = renderToString(<MarketplaceShowcaseRoute />);

    expect(html).toContain("Marketplace");
  });

  it("returns showcase route metadata", () => {
    expect(marketplaceMeta({} as never)).toEqual([{ title: "Marketplace Showcase" }]);
  });
});
