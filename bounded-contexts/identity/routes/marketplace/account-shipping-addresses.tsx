import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { parseStrictTypedUlid } from "@chase-sets/primitives/typed-ids";
import { defineFormAction, defineResourceRoute } from "@chase-sets/platform-runtime/http";
import { navigateAfterWrite } from "@chase-sets/http/responses";
import {
  accountMutationResponse,
  requireInterruptionSafeClient,
} from "../../features/account-management/api/marketplace-action";
import type { MutationResult } from "../../features/account-management/api/runtime";
import { AccountMutationBoundary } from "../../features/account-management/ui/controller";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  createIdentityRequestApiClient,
  requireActorFromIdentityApi,
} from "../../support/route-support/identity-request";
import { IdentityApiError, type ShippingAddress } from "../../support/request-support/api-client";
import { ShippingAddressPage } from "../../features/shipping-addresses/ui/shipping-address-page";
import contextManifest from "../../context.json";
import { identityApiErrorAdapter } from "../../support/request-support/route-api-error";
import { classifyAccountActionError } from "../../support/route-support/account-action-errors";
import { shippingAddressActionErrors } from "../../features/shipping-addresses/ui/action-errors";

function addressIdentity(value: string) {
  try {
    return parseStrictTypedUlid(value, "adr");
  } catch {
    return undefined;
  }
}

function unknownAction() {
  const message = t("identity.routes.marketplace.accountShippingAddresses.unknown.action");
  return {
    failure: {
      message,
      intent: "unknown",
      classification: "INDETERMINATE",
      errors: { fieldErrors: {}, formErrors: [message] },
    },
  } as const;
}

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
    addressVerificationDecision: text(formData, "addressVerificationDecision") || null,
  };
}

function emptyAddressList(): ListResponse<ShippingAddress> {
  return { items: [], total: 0, count: 0 };
}

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "account-shipping-addresses",
  authorization: ({ request }) => requireActorFromIdentityApi({ request, permission: "accounts.view" }),
  errorAdapter: identityApiErrorAdapter,
  load: ({ request, actor }) =>
    createIdentityRequestApiClient(request).listShippingAddresses<ListResponse<ShippingAddress>>(actor!.accountId),
  map: (response, { actor }) => ({
    addresses: response.items,
    loadError: null,
    mutationActor: { tenantId: actor!.tenantId, userId: actor!.userId, accountId: actor!.accountId },
  }),
  onPending: (_result, { actor }) => ({
    mutationActor: { tenantId: actor!.tenantId, userId: actor!.userId, accountId: actor!.accountId },
    addresses: emptyAddressList().items,
    loadError: t("identity.routes.marketplace.accountShippingAddresses.addresses.updating"),
  }),
  messages: { notFound: "Shipping addresses are unavailable." },
});

async function handleShippingAddressAction(intent: string, request: Request, formData: FormData, accountId: string) {
  const shippingAddressId = text(formData, "shippingAddressId");
  const api = createIdentityRequestApiClient(request);

  try {
    if (intent === "create") {
      const result = await api.createShippingAddress<MutationResult>(accountId, addressBody(formData));
      return accountMutationResponse(
        result,
        "/account/shipping-addresses",
        navigateAfterWrite(result, "/account/shipping-addresses"),
      );
    }
    if (intent === "update" && shippingAddressId) {
      const result = await api.updateShippingAddress<MutationResult>(
        accountId,
        shippingAddressId,
        addressBody(formData),
      );
      return accountMutationResponse(
        result,
        "/account/shipping-addresses",
        navigateAfterWrite(result, "/account/shipping-addresses"),
      );
    }
    if (intent === "default" && shippingAddressId) {
      const result = await api.setDefaultShippingAddress<MutationResult>(accountId, shippingAddressId);
      return accountMutationResponse(
        result,
        "/account/shipping-addresses",
        navigateAfterWrite(result, "/account/shipping-addresses"),
      );
    }
    if (intent === "archive" && shippingAddressId) {
      const result = await api.archiveShippingAddress<MutationResult>(accountId, shippingAddressId);
      return accountMutationResponse(
        result,
        "/account/shipping-addresses",
        navigateAfterWrite(result, "/account/shipping-addresses"),
      );
    }
    return unknownAction();
  } catch (error) {
    if (!(error instanceof IdentityApiError)) throw error;
    const code = identityApiErrorAdapter.getErrorCode(error);
    const failure =
      classifyAccountActionError(error) ??
      (error.status === 400 && code === "shipping_address_undeliverable"
        ? ({
            kind: "validation",
            status: 400,
            code,
            message: t("identity.features.shippingAddresses.errors.undeliverable"),
          } as const)
        : error.status === 409 && code === "address_standardization_suggested"
          ? ({
              kind: "domain",
              status: 409,
              code,
              message: t("identity.features.shippingAddresses.api.route.address.standardization.suggested"),
            } as const)
          : null);
    if (!failure) throw error;
    const normalized = shippingAddressActionErrors(error, intent, failure.message);
    const message = Object.values(normalized.errors.fieldErrors)[0]?.[0] ?? failure.message;
    const identity = intent === "update" ? addressIdentity(shippingAddressId) : undefined;
    return data(
      { failure: { ...failure, ...normalized, message, intent, ...(identity ? { shippingAddressId: identity } : {}) } },
      { status: failure.status },
    );
  }
}

export const action = requireInterruptionSafeClient(
  defineFormAction({
    authorization: ({ request }) => requireActorFromIdentityApi({ request, permission: "accounts.manage" }),
    intents: {
      create: ({ request, formData, actor }) =>
        handleShippingAddressAction("create", request, formData, actor!.accountId),
      update: ({ request, formData, actor }) =>
        handleShippingAddressAction("update", request, formData, actor!.accountId),
      default: ({ request, formData, actor }) =>
        handleShippingAddressAction("default", request, formData, actor!.accountId),
      archive: ({ request, formData, actor }) =>
        handleShippingAddressAction("archive", request, formData, actor!.accountId),
    },
    onUnknownIntent: unknownAction,
  }),
);

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("identity.routes.marketplace.accountShippingAddresses.shipping.addresses.marketplace"),
  });

export default function MarketplaceAccountShippingAddressesRoute() {
  const data = useLoaderData<typeof loader>();
  return (
    <AccountMutationBoundary
      key={`${data.mutationActor.tenantId}:${data.mutationActor.userId}:${data.mutationActor.accountId}`}
      actor={data.mutationActor}
    >
      <ShippingAddressPage addresses={data.addresses} errorMessage={data.loadError ?? null} />
    </AccountMutationBoundary>
  );
}
