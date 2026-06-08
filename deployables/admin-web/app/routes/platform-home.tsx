import { redirect } from "react-router";

export function loader() {
  throw redirect("/platform/projections");
}

export default function PlatformHomeRoute() {
  return null;
}
