import { t } from "@chase-sets/localization";
import {
  Button,
  Checkbox,
  CurrencyInput,
  Form,
  HiddenInput,
  LinkButton,
  NativeSelect,
  NumberField,
  Stack,
  Text,
  Textarea,
} from "@chase-sets/design-system";
import { useEffect, useRef, useState } from "react";
import {
  inventoryOfflineSaleChannels,
  type InventoryOfflineSaleChannel,
  type InventoryOfflineSaleRequest,
  type InventoryOfflineSaleResult,
} from "../../../client";

type OfflineSaleClient = Readonly<{
  recordOfflineSale(itemId: string, request: InventoryOfflineSaleRequest): Promise<InventoryOfflineSaleResult>;
}>;

export function createOfflineSaleFormToken() {
  return crypto.randomUUID();
}

export function offlineSaleRequestFromForm(formData: FormData): InventoryOfflineSaleRequest {
  const salePriceAmount = String(formData.get("salePriceAmount") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();

  return {
    quantity: Number(formData.get("quantity") ?? 0),
    salePriceAmount: salePriceAmount || null,
    channel: String(formData.get("channel") ?? "") as InventoryOfflineSaleChannel,
    note: note || null,
    collisionMode: String(formData.get("collisionMode") ?? "protect-orders") as "protect-orders" | "honor-offline",
    confirmSellerCannotFulfill: formData.get("confirmSellerCannotFulfill") === "true",
    idempotencyKey: String(formData.get("idempotencyKey") ?? ""),
  };
}

export function submitOfflineSaleForm(
  client: OfflineSaleClient,
  itemId: string,
  formData: FormData,
): Promise<InventoryOfflineSaleResult> {
  return client.recordOfflineSale(itemId, offlineSaleRequestFromForm(formData));
}

export function OfflineSaleResult({
  result,
  authoritativeAvailableQuantity,
}: {
  result: InventoryOfflineSaleResult | null | undefined;
  authoritativeAvailableQuantity?: number;
}) {
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    resultRef.current?.focus();
  }, [result]);

  if (!result) {
    return null;
  }

  const isComplete = result.appliedQuantity === result.requestedQuantity;
  const isRefused = result.appliedQuantity === 0;

  return (
    <Stack ref={resultRef} gap={2} role={isComplete ? "status" : "alert"} tabIndex={-1}>
      <Text weight="semibold">
        {isComplete
          ? t("inventory.features.inventoryItems.ui.offlineSaleForm.completed", {
              count: result.appliedQuantity,
              available: authoritativeAvailableQuantity ?? 0,
            })
          : isRefused
            ? t("inventory.features.inventoryItems.ui.offlineSaleForm.refused", { count: result.refusedQuantity })
            : t("inventory.features.inventoryItems.ui.offlineSaleForm.partial", {
                applied: result.appliedQuantity,
                refused: result.refusedQuantity,
              })}
      </Text>
      {result.collision?.affectedOrders.map((order) => (
        <LinkButton key={order.orderId} href={`/account/sales/${order.orderId}`} tone="secondary" size="sm">
          {t("inventory.features.inventoryItems.ui.offlineSaleForm.affected.order", { orderId: order.orderId })}
        </LinkButton>
      ))}
    </Stack>
  );
}

export function OfflineSaleForm({
  initialIdempotencyKey,
  canHonorOffline,
  result,
  itemId,
  authoritativeAvailableQuantity,
  errorMessage,
}: {
  initialIdempotencyKey: string;
  canHonorOffline: boolean;
  result?: InventoryOfflineSaleResult | null;
  itemId?: string;
  authoritativeAvailableQuantity?: number;
  errorMessage?: string | null;
}) {
  const [idempotencyKey] = useState(initialIdempotencyKey);
  const [collisionMode, setCollisionMode] = useState<"protect-orders" | "honor-offline">("protect-orders");

  return (
    <Form spacing="none" method="post">
      <Stack gap={3}>
        <HiddenInput type="hidden" name="intent" value="record-offline-sale" />
        <HiddenInput type="hidden" name="idempotencyKey" value={idempotencyKey} />
        {itemId ? <HiddenInput type="hidden" name="itemId" value={itemId} /> : null}
        {errorMessage ? <Text role="alert">{errorMessage}</Text> : null}
        <NumberField
          label={t("inventory.features.inventoryItems.ui.offlineSaleForm.quantity")}
          name="quantity"
          min={1}
          step={1}
          required
        />
        <CurrencyInput
          label={t("inventory.features.inventoryItems.ui.offlineSaleForm.price.per.item")}
          name="salePriceAmount"
          currencyCode="USD"
        />
        <NativeSelect
          label={t("inventory.features.inventoryItems.ui.offlineSaleForm.channel")}
          name="channel"
          required
          placeholder={t("inventory.features.inventoryItems.ui.offlineSaleForm.channel.placeholder")}
          items={inventoryOfflineSaleChannels.map((channel) => ({
            value: channel,
            label: t(`inventory.features.inventoryItems.ui.offlineSaleForm.channel.${channel}`),
          }))}
        />
        <Textarea label={t("inventory.features.inventoryItems.ui.offlineSaleForm.note")} name="note" rows={3} />
        {canHonorOffline ? (
          <>
            <NativeSelect
              label={t("inventory.features.inventoryItems.ui.offlineSaleForm.order.commitments")}
              name="collisionMode"
              value={collisionMode}
              onChange={(event) => setCollisionMode(event.target.value as "protect-orders" | "honor-offline")}
              items={[
                {
                  value: "protect-orders",
                  label: t("inventory.features.inventoryItems.ui.offlineSaleForm.protect.orders"),
                },
                {
                  value: "honor-offline",
                  label: t("inventory.features.inventoryItems.ui.offlineSaleForm.honor.offline"),
                },
              ]}
            />
            {collisionMode === "honor-offline" ? (
              <Checkbox
                label={t("inventory.features.inventoryItems.ui.offlineSaleForm.honor.confirmation")}
                name="confirmSellerCannotFulfill"
                value="true"
                required
              />
            ) : null}
          </>
        ) : (
          <HiddenInput type="hidden" name="collisionMode" value="protect-orders" />
        )}
        <Button type="submit">{t("inventory.features.inventoryItems.ui.offlineSaleForm.submit")}</Button>
        <OfflineSaleResult result={result} authoritativeAvailableQuantity={authoritativeAvailableQuantity} />
      </Stack>
    </Form>
  );
}
