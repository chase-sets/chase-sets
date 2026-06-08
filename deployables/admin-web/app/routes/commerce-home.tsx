import { redirect } from "react-router";

export function loader() {
  throw redirect("/commerce/terms/schedules");
}

export default function CommerceHomeRoute() {
  return null;
}
