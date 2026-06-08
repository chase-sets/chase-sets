import { redirect } from "react-router";

export function loader() {
  throw redirect("/support/requests");
}

export default function SupportHomeRoute() {
  return null;
}
