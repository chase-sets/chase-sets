import { redirect } from "react-router";

export function loader() {
  throw redirect("/growth/google-shopping");
}

export default function GrowthHomeRoute() {
  return null;
}
