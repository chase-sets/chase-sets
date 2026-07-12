import { redirect } from "react-router";

export function loader() {
  return redirect("/help/buying/refunds-and-returns", { status: 301 });
}

export default function RefundsAndReturnsRedirectRoute() {
  return null;
}
