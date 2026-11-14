import type { FormEventHandler } from "react";
import {
  Banner,
  Button,
  Form,
  LinkButton,
  NativeSelect,
  Page,
  PageHeader,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { SellerShippingSetupResult } from "../../../support/request-support/api-client";

export const shippingSetupFields = [
  "name",
  "line1",
  "line2",
  "city",
  "state",
  "postalCode",
  "country",
  "labelPreference",
] as const;
export type ShippingSetupValues = Record<(typeof shippingSetupFields)[number], string>;
export const emptyShippingSetupValues: ShippingSetupValues = {
  name: "",
  line1: "",
  line2: "",
  city: "",
  state: "",
  postalCode: "",
  country: "US",
  labelPreference: "prepaid-label",
};
export function shippingSetupValues(result: SellerShippingSetupResult | null): ShippingSetupValues {
  return result?.setup
    ? { ...result.setup.origin, line2: result.setup.origin.line2 ?? "", labelPreference: result.setup.labelPreference }
    : emptyShippingSetupValues;
}

export function ShippingSetupPage({
  result,
  values,
  error,
  missingIdentity = false,
  unavailable = false,
  pending = false,
  onSubmit,
}: {
  result: SellerShippingSetupResult | null;
  values: ShippingSetupValues;
  error?: string | null;
  missingIdentity?: boolean;
  unavailable?: boolean;
  pending?: boolean;
  onSubmit?: FormEventHandler<HTMLFormElement>;
}) {
  return (
    <Page>
      <Stack gap={5}>
        <PageHeader
          title={t("fulfillment.shippingSetup.title")}
          description={t("fulfillment.shippingSetup.description")}
        />
        <LinkButton href="/account/sell-list" tone="secondary">
          {t("fulfillment.shippingSetup.back")}
        </LinkButton>
        {missingIdentity ? (
          <Banner tone="warning" title={t("fulfillment.shippingSetup.missingIdentity")} />
        ) : (
          <>
            {error ? <Banner tone="danger" title={error} /> : null}
            {unavailable ? (
              <LinkButton href="/sell/shipping-setup">{t("fulfillment.shippingSetup.retry")}</LinkButton>
            ) : (
              <>
                {result?.setup ? (
                  <Banner
                    tone={result.supportStatus === "enabled" ? "success" : "warning"}
                    title={
                      result.supportStatus === "enabled"
                        ? t("fulfillment.shippingSetup.savedSupported")
                        : t("fulfillment.shippingSetup.savedPending")
                    }
                  />
                ) : (
                  <Text>{t("fulfillment.shippingSetup.empty")}</Text>
                )}
                <Form method="post" action="/sell/shipping-setup" onSubmit={onSubmit} submitting={pending}>
                  {shippingSetupFields
                    .filter((field) => field !== "labelPreference")
                    .map((field) => (
                      <TextInput
                        key={field}
                        name={field}
                        label={t(`fulfillment.shippingSetup.${field}`)}
                        defaultValue={values[field]}
                        required={field !== "line2"}
                        maxLength={200}
                      />
                    ))}
                  <NativeSelect
                    name="labelPreference"
                    label={t("fulfillment.shippingSetup.labelPreference")}
                    defaultValue={values.labelPreference}
                    required
                    items={[
                      {
                        value: "prepaid-label",
                        label: t("checkout.features.sellList.ui.guestSellCheckoutPage.label.prepaid"),
                      },
                      {
                        value: "seller-label-later",
                        label: t("checkout.features.sellList.ui.guestSellCheckoutPage.label.later"),
                      },
                    ]}
                  />
                  <Button type="submit" disabled={pending}>
                    {pending ? t("fulfillment.shippingSetup.saving") : t("fulfillment.shippingSetup.save")}
                  </Button>
                </Form>
              </>
            )}
          </>
        )}
      </Stack>
    </Page>
  );
}
