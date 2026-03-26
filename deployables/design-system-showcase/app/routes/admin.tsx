import type { MetaFunction } from "react-router";
import { AdminView } from "../../src/views/admin-view";

export const meta: MetaFunction = () => [
  { title: "Admin Showcase" },
];

export default function AdminShowcaseRoute() {
  return <AdminView />;
}
