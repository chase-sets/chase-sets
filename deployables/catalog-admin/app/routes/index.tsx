import { redirect } from "react-router";

export function loader() {
  throw redirect("/dimensions");
}

export default function CatalogAdminIndexRoute() {
  return null;
}
