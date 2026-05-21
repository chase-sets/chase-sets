import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  createIdentityRequestApiClient,
  requireActorFromIdentityApi,
} from "../../support/route-support/identity-request";
import type { ShippingAddress } from "../../support/request-support/api-client";
import { ShippingAddressPage } from "../../features/shipping-addresses/ui/shipping-address-page";

type ActionData = Readonly<{ error?: string }>;

function text(formData: FormData, name: string) {
  return String(formData.get(name) ?? "").trim();
}

function nullableText(formData: FormData, name: string) {
  const value = text(formData, name);
  return value.length > 0 ? value : null;
}

function addressBody(formData: FormData) {
  return {
    label: nullableText(formData, "label"),
    name: text(formData, "name"),
    company: nullableText(formData, "company"),
    line1: text(formData, "line1"),
    line2: nullableText(formData, "line2"),
    city: text(formData, "city"),
    state: text(formData, "state"),
    postalCode: text(formData, "postalCode"),
    country: text(formData, "country") || "US",
    phone: nullableText(formData, "phone"),
    email: nullableText(formData, "email"),
    makeDefault: text(formData, "makeDefault") === "true",
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromIdentityApi({
    request,
    permission: "accounts.view",
  });
  const api = createIdentityRequestApiClient(request);
  const response = await api.listShippingAddresses<ListResponse<ShippingAddress>>(actor.accountId);
  return { addresses: response.items };
}

export async function action({ request }: ActionFunctionArgs) {
  const actor = await requireActorFromIdentityApi({
    request,
    permission: "accounts.manage",
  });
  const formData = await request.formData();
  const intent = text(formData, "intent");
  const shippingAddressId = text(formData, "shippingAddressId");
  const api = createIdentityRequestApiClient(request);

  try {
    if (intent === "create") {
      await api.createShippingAddress(actor.accountId, addressBody(formData));
      return redirect("/account/shipping-addresses");
    }
    if (intent === "update" && shippingAddressId) {
      await api.updateShippingAddress(actor.accountId, shippingAddressId, addressBody(formData));
      return redirect("/account/shipping-addresses");
    }
    if (intent === "default" && shippingAddressId) {
      await api.setDefaultShippingAddress(actor.accountId, shippingAddressId);
      return redirect("/account/shipping-addresses");
    }
    if (intent === "archive" && shippingAddressId) {
      await api.archiveShippingAddress(actor.accountId, shippingAddressId);
      return redirect("/account/shipping-addresses");
    }
    return { error: t("identity.routes.marketplace.accountShippingAddresses.unknown.action") };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : t("identity.routes.marketplace.accountShippingAddresses.request.failed"),
    } satisfies ActionData;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("identity.routes.marketplace.accountShippingAddresses.shipping.addresses.marketplace"),
  });

export default function MarketplaceAccountShippingAddressesRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ActionData | undefined;
  return <ShippingAddressPage addresses={data.addresses} errorMessage={actionData?.error ?? null} />;
}
