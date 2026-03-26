import type { MetaFunction } from "react-router";
import { MarketplaceView } from "../../src/views/marketplace-view";

export const meta: MetaFunction = () => [
  { title: "Marketplace Showcase" },
];

export default function MarketplaceShowcaseRoute() {
  return <MarketplaceView />;
}
