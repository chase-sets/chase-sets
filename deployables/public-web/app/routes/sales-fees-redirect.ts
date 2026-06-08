import { redirect } from "react-router";

export function loader() {
  throw redirect("/sales-fees", { status: 301 });
}
