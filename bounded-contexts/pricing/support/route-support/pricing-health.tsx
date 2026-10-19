import { useEffect } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation, useRevalidator } from "react-router";
import { Button, NativeSelect } from "@chase-sets/design-system";
import { RouterForm } from "@chase-sets/design-system/react-router";
import { defineFormAction } from "@chase-sets/platform-runtime/http";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createPricingRequestApiClient, PricingApiError } from "../request-support/api-client";
import { PricingHealthPage } from "../../features/pricing-health/ui/page";
import { healthCopy as copy } from "../../features/pricing-health/ui/copy";

export const PRICING_HEALTH_HREF = "/account/desk/pricing-health";
export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "pricing.view" });
  try {
    const policyId = new URL(request.url).searchParams.get("policyId") ?? undefined;
    return { data: await createPricingRequestApiClient(request).getPricingHealth(policyId), loadFailed: false };
  } catch (error) {
    if (error instanceof PricingApiError) {
      if (error.status >= 500) return { data: null, loadFailed: true };
      throw new Response(null, { status: error.status });
    }
    throw error;
  }
}

export const action = defineFormAction({
  authorization: { permission: "pricing.manage" },
  intents: {
    compute: async ({ request, formData }) => {
      const policyId = String(formData.get("policyId") ?? "");
      await createPricingRequestApiClient(request).computePricingHealth(policyId);
      return redirect(`${PRICING_HEALTH_HREF}?${new URLSearchParams({ policyId })}`);
    },
  },
  onUnknownIntent: () => ({ error: copy("computeError") }),
  onError: (error) => {
    if (error instanceof PricingApiError && [401, 403, 404].includes(error.status))
      throw new Response(null, { status: error.status });
    return { error: copy("computeError") };
  },
});

export default function PricingHealthRoute() {
  const { data, loadFailed } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { error?: string } | undefined;
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!data?.computing || revalidator.state !== "idle") return;
    const timer = setTimeout(() => void revalidator.revalidate(), 2000);
    return () => clearTimeout(timer);
  }, [data?.computing, revalidator.state, revalidator.revalidate]);
  return (
    <PricingHealthPage
      data={data}
      loading={navigation.state === "loading" && navigation.formMethod?.toLowerCase() === "get"}
      error={loadFailed ? copy("error.description") : actionData?.error}
      policySelector={
        data && data.policies.length > 1 ? (
          <RouterForm method="get" action={PRICING_HEALTH_HREF}>
            <NativeSelect
              label={copy("policy")}
              name="policyId"
              defaultValue={data.target?.policyId ?? ""}
              required
              placeholder={copy("choose")}
              items={data.policies.map(({ policyId, name }) => ({ value: policyId, label: name }))}
            />
            <Button type="submit" tone="secondary">
              {copy("show")}
            </Button>
          </RouterForm>
        ) : null
      }
      computeAction={
        data?.target && data.canCompute ? (
          <RouterForm method="post">
            <input type="hidden" name="intent" value="compute" />
            <input type="hidden" name="policyId" value={data.target.policyId} />
            <Button
              type="submit"
              disabled={navigation.state !== "idle" || data.computing}
              loading={navigation.state === "submitting"}
            >
              {copy("compute")}
            </Button>
          </RouterForm>
        ) : null
      }
    />
  );
}
