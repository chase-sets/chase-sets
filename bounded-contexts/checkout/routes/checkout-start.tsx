import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createCheckoutRequestApiClient } from "../support/request-support/api-client";

export async function loader(_args: LoaderFunctionArgs) {
  throw redirect("/account/cart");
}

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "orders.manage" });
  const api = createCheckoutRequestApiClient(request);

  const session = await api.createCheckoutSession({ source: { type: "cart" } });

  return redirect(`/checkout/${session.session_id}`);
}

export default function CheckoutStartRoute() {
  return null;
}
