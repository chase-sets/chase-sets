import { t } from "@chase-sets/localization";
import {
  Button,
  HiddenInput,
  LinkButton,
  MarketplaceNotice,
  NativeSelect,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import { RouterForm } from "@chase-sets/design-system/react-router";
import { useState } from "react";
import type { SetupLists } from "../api/setup-listing";
import type { SetupSelection } from "../domain/setup-selection";

export type SellerSetupState =
  | { kind: "loading" | "error" }
  | {
      kind: "loaded";
      lists: SetupLists;
      selection: SetupSelection | null;
      locations: readonly { storageLocationId: string; name: string }[];
      active: boolean;
    };
export function EbaySellerSetup({
  state,
  connectionId,
  pending = false,
  failed = false,
}: {
  state: SellerSetupState;
  connectionId: string;
  pending?: boolean;
  failed?: boolean;
}) {
  const types = ["fulfillment", "payment", "return"] as const;
  const [pairCount, setPairCount] = useState(
    state.kind === "loaded" ? Math.max(1, state.selection?.locationPairs.length ?? 0) : 1,
  );
  const blocked = state.kind === "loaded" && Object.values(state.lists).some((list) => list.status !== "complete");
  const empty =
    state.kind === "loaded" &&
    (Object.values(state.lists).some((list) => list.items.length === 0) || state.locations.length === 0);
  return (
    <PageSection title={t("channels.ebay.setup.title")}>
      <Stack gap={3}>
        {state.kind === "loading" ? <Text>{t("channels.ebay.setup.loading")}</Text> : null}
        {state.kind === "error" || failed ? (
          <MarketplaceNotice
            tone="danger"
            title={t("channels.ebay.setup.error")}
            description={t("channels.ebay.setup.retry")}
          />
        ) : null}
        {blocked ? (
          <MarketplaceNotice
            tone="warning"
            title={t("channels.ebay.setup.incomplete")}
            description={t("channels.ebay.setup.retry")}
          />
        ) : null}
        {state.kind === "loaded" && state.active && state.selection ? (
          <>
            <MarketplaceNotice
              tone="success"
              title={t("channels.ebay.setup.activated")}
              description={t("channels.ebay.setup.saved")}
            />
            {state.selection.policies.map((item) => (
              <Text key={item.policyType}>
                {t(`channels.ebay.setup.${item.policyType}`)}: {item.policyId}
              </Text>
            ))}
            {state.selection.locationPairs.map((item) => (
              <Text key={JSON.stringify([item.storageLocationId, item.merchantLocationKey])}>
                {item.storageLocationId}: {item.merchantLocationKey}
              </Text>
            ))}
          </>
        ) : null}
        {!blocked && empty ? (
          <>
            <Text>{t("channels.ebay.setup.empty")}</Text>
            <LinkButton href="https://www.sandbox.ebay.com/sh/ovw">{t("channels.ebay.setup.sellerHub")}</LinkButton>
            <LinkButton href="/account/inventory/locations">{t("channels.connections.locations")}</LinkButton>
          </>
        ) : null}
        {state.kind === "loaded" && !blocked && !empty ? (
          <RouterForm method="post">
            <Stack gap={3}>
              <HiddenInput name="intent" value="select-setup" />
              <HiddenInput name="connectionId" value={connectionId} />
              <HiddenInput name="setupGeneration" value={String(state.selection?.setupGeneration ?? 0)} />
              {types.map((type) => (
                <NativeSelect
                  key={type}
                  name={`${type}PolicyId`}
                  label={t(`channels.ebay.setup.${type}`)}
                  required
                  disabled={pending}
                  defaultValue={state.selection?.policies.find((item) => item.policyType === type)?.policyId ?? ""}
                  items={[
                    { value: "", label: t("channels.ebay.setup.choose") },
                    ...state.lists[type].items.map((item) => ({
                      value: String(item[`${type}PolicyId`]),
                      label: String(item.name),
                    })),
                  ]}
                />
              ))}
              <Text>{t("channels.ebay.setup.pairs")}</Text>
              {Array.from({ length: pairCount }, (_, index) => (
                <Stack key={index} gap={2}>
                  <NativeSelect
                    name="storageLocationId"
                    label={t("channels.connections.locations")}
                    disabled={pending}
                    defaultValue={state.selection?.locationPairs[index]?.storageLocationId ?? ""}
                    items={[
                      { value: "", label: t("channels.ebay.setup.unpaired") },
                      ...state.locations.map((location) => ({
                        value: location.storageLocationId,
                        label: location.name,
                      })),
                    ]}
                  />
                  <NativeSelect
                    name="merchantLocationKey"
                    label={t("channels.ebay.setup.location")}
                    disabled={pending}
                    defaultValue={state.selection?.locationPairs[index]?.merchantLocationKey ?? ""}
                    items={[
                      { value: "", label: t("channels.ebay.setup.unpaired") },
                      ...state.lists.locations.items.map((item) => ({
                        value: String(item.merchantLocationKey),
                        label: String(item.name ?? item.merchantLocationKey),
                      })),
                    ]}
                  />
                </Stack>
              ))}
              <Button
                type="button"
                tone="secondary"
                disabled={pending || pairCount >= 200}
                onClick={() => setPairCount(pairCount + 1)}
              >
                {t("channels.ebay.setup.addPair")}
              </Button>
              <Button type="submit" disabled={pending} loading={pending}>
                {t(state.active ? "channels.ebay.setup.replace" : "channels.ebay.setup.activate")}
              </Button>
            </Stack>
          </RouterForm>
        ) : null}
      </Stack>
    </PageSection>
  );
}
