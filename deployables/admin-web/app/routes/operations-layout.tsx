import type { LoaderFunctionArgs } from "react-router";
import { Outlet } from "react-router";
import { requireIdentityAdminActor } from "../auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireIdentityAdminActor(request);
  return null;
}

export default function OperationsLayoutRoute() {
  return <Outlet />;
}
