import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { loadAfterWrite, navigateAfterWrite } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  createIdentityRequestApiClient,
  requireActorFromIdentityApi,
} from "../../support/route-support/identity-request";
import { IdentityApiError, type ShippingAddress } from "../../support/request-support/api-client";
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

function emptyAddressList(): ListResponse<ShippingAddress> {
  return { items: [], total: 0, count: 0 };
}

function identityApiErrorStatus(error: unknown) {
  return error instanceof IdentityApiError ? error.status : null;
}

function identityApiErrorBody(error: unknown) {
  return error instanceof IdentityApiError ? error.body : null;
}

function identityApiErrorCode(error: unknown) {
  const body = identityApiErrorBody(error);
  const apiError = typeof body === "object" && body !== null && "error" in body ? body.error : null;
  const code = typeof apiError === "object" && apiError !== null ? (apiError as { code?: unknown }).code : null;
  return typeof code === "string" && code.trim() ? code : null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromIdentityApi({
    request,
    permission: "accounts.view",
  });
  const api = createIdentityRequestApiClient(request);
  const response = await loadAfterWrite({
    request,
    load: () => api.listShippingAddresses<ListResponse<ShippingAddress>>(actor.accountId),
    isNotFound: (error) => identityApiErrorStatus(error) === 404,
    getStatus: identityApiErrorStatus,
    getErrorCode: identityApiErrorCode,
    getBody: identityApiErrorBody,
  });

  if (response.kind === "pending") {
    return {
      addresses: emptyAddressList().items,
      loadError: t("identity.routes.marketplace.accountShippingAddresses.addresses.updating"),
    };
  }

  if (response.kind === "permanent-failure") {
    if ("error" in response) {
      throw response.error;
    }
    throw new Response("Shipping addresses are unavailable.", { status: 404 });
  }

  return { addresses: response.data.items, loadError: null };
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
      return redirect(
        navigateAfterWrite(
          await api.createShippingAddress(actor.accountId, addressBody(formData)),
          "/account/shipping-addresses",
        ),
      );
    }
    if (intent === "update" && shippingAddressId) {
      return redirect(
        navigateAfterWrite(
          await api.updateShippingAddress(actor.accountId, shippingAddressId, addressBody(formData)),
          "/account/shipping-addresses",
        ),
      );
    }
    if (intent === "default" && shippingAddressId) {
      return redirect(
        navigateAfterWrite(
          await api.setDefaultShippingAddress(actor.accountId, shippingAddressId),
          "/account/shipping-addresses",
        ),
      );
    }
    if (intent === "archive" && shippingAddressId) {
      return redirect(
        navigateAfterWrite(
          await api.archiveShippingAddress(actor.accountId, shippingAddressId),
          "/account/shipping-addresses",
        ),
      );
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
  return <ShippingAddressPage addresses={data.addresses} errorMessage={actionData?.error ?? data.loadError ?? null} />;
}
