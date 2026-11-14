import {
  data,
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import { t } from "@chase-sets/localization";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { createSellerShippingSetupRequestClient, FulfillmentApiError } from "../support/request-support/api-client";
import { parseShippingSetup, SellerShippingError } from "../features/seller-checkout-readiness/domain/shipping-setup";
import {
  emptyShippingSetupValues,
  ShippingSetupPage,
  shippingSetupFields,
  shippingSetupValues,
  type ShippingSetupValues,
} from "../features/seller-checkout-readiness/ui/shipping-setup-page";

const privateHeaders = { "Cache-Control": "no-store" };
export async function loader({ request }: LoaderFunctionArgs) {
  let scope: string | null = null;
  try {
    const client = await createSellerShippingSetupRequestClient(request);
    if (!client)
      return data({ scope: null, result: null, missingIdentity: true, error: null }, { headers: privateHeaders });
    scope = client.scope;
    const result = await client.api.getSellerShippingSetup(client.mode);
    return data({ scope: client.scope, result, missingIdentity: false, error: null }, { headers: privateHeaders });
  } catch {
    return data(
      { scope, result: null, missingIdentity: false, error: t("fulfillment.shippingSetup.loadError") },
      { status: 503, headers: privateHeaders },
    );
  }
}

// Choices cross this boundary, never owner, support or readiness assertions.
export async function action({ request }: ActionFunctionArgs) {
  const failure = (scope: string | null, values: ShippingSetupValues, error: string, status = 400) =>
    data({ scope, values, error }, { status, headers: privateHeaders });
  const origin = request.headers.get("origin");
  if (
    (origin && origin !== resolvePublicRequestOrigin(request)) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    return failure(null, emptyShippingSetupValues, t("fulfillment.shippingSetup.saveError"), 403);
  }
  let scope: string | null = null;
  let values = emptyShippingSetupValues;
  try {
    const client = await createSellerShippingSetupRequestClient(request);
    if (!client) return failure(null, values, t("fulfillment.shippingSetup.missingIdentity"));
    scope = client.scope;
    const form = await request.formData();
    values = { ...emptyShippingSetupValues };
    for (const field of shippingSetupFields) {
      const value = form.get(field);
      values[field] = typeof value === "string" ? value : "";
    }
    if (
      [...form.keys()].some((key) => !shippingSetupFields.some((field) => field === key)) ||
      shippingSetupFields.some((field) => form.getAll(field).length !== 1 || typeof form.get(field) !== "string")
    ) {
      return failure(scope, values, t("fulfillment.shippingSetup.invalid"));
    }
    const { labelPreference, ...originValues } = values;
    const input = parseShippingSetup({ origin: originValues, labelPreference });
    await client.api.saveSellerShippingSetup(client.mode, input);
    return data({ scope, values: null, error: null }, { headers: privateHeaders });
  } catch (error) {
    return failure(
      scope,
      values,
      t(
        error instanceof SellerShippingError || (error instanceof FulfillmentApiError && error.status === 400)
          ? "fulfillment.shippingSetup.invalid"
          : "fulfillment.shippingSetup.saveError",
      ),
    );
  }
}

export const meta: MetaFunction = () => buildOpenGraphMeta({ title: t("fulfillment.shippingSetup.title") });

export default function SellerShippingSetupRoute() {
  const loaded = useLoaderData<typeof loader>();
  const submitted = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const currentAction = submitted?.scope === loaded.scope ? submitted : undefined;
  return (
    <ShippingSetupPage
      key={loaded.scope}
      result={loaded.result}
      values={currentAction?.values ?? shippingSetupValues(loaded.result)}
      error={currentAction?.error ?? loaded.error}
      missingIdentity={loaded.missingIdentity}
      unavailable={Boolean(loaded.error) && !currentAction?.values}
      pending={navigation.state !== "idle"}
      onSubmit={(event) => {
        event.preventDefault();
        void submit(event.currentTarget);
      }}
    />
  );
}
