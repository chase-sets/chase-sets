import { redirect } from "react-router";

export function loader() {
  return redirect("/help/buying/order-protection", { status: 301 });
}

export default function OrderProtectionRedirectRoute() {
  return null;
}
