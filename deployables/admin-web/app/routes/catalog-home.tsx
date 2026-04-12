import { redirect } from "react-router";

export function loader() {
  throw redirect("/catalog/dimensions");
}

export default function CatalogHomeRoute() {
  return null;
}
