import { redirect } from "react-router";

export function loader() {
  throw redirect("/access/accounts");
}

export default function AccessHomeRoute() {
  return null;
}
