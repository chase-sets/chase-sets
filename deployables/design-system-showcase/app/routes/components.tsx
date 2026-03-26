import type { MetaFunction } from "react-router";
import { ComponentsView } from "../../src/views/components-view";

export const meta: MetaFunction = () => [
  { title: "Components Showcase" },
];

export default function ComponentsShowcaseRoute() {
  return <ComponentsView />;
}
