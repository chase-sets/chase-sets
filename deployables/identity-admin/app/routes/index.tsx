import { redirect } from "react-router";

export function loader() {
  throw redirect("/accounts");
}

export default function IdentityAdminIndexRoute() {
  return null;
}
