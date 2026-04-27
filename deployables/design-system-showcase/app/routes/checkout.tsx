import type { MetaFunction } from "react-router";
import { CheckoutView } from "../../src/views/checkout-view";

export const meta: MetaFunction = () => [
  { title: "Checkout Showcase" },
];

export default function CheckoutShowcaseRoute() {
  return <CheckoutView />;
}
