import { redirect } from "react-router";

export function loader() {
  return redirect("/help/getting-started/frequently-asked-questions", { status: 301 });
}

export default function FaqRedirectRoute() {
  return null;
}
