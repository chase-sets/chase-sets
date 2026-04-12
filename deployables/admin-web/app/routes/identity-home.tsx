import { redirect } from "react-router";

export function loader() {
  throw redirect("/identity/accounts");
}

export default function IdentityHomeRoute() {
  return null;
}
