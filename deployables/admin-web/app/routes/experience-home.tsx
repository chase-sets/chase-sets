import { redirect } from "react-router";

export function loader() {
  throw redirect("/experience/platform-feedback");
}

export default function ExperienceHomeRoute() {
  return null;
}
