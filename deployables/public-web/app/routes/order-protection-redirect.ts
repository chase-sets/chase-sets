import { redirect } from "react-router";

export function loader() {
  throw redirect("/order-protection", { status: 301 });
}
