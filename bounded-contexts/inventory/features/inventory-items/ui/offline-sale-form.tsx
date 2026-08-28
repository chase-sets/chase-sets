import { t } from "@chase-sets/localization";
import {
  Button,
  Checkbox,
  CurrencyInput,
  HiddenInput,
  LinkButton,
  NativeSelect,
  NumberField,
  Stack,
  Text,
  Textarea,
} from "@chase-sets/design-system";
import { RouterForm } from "@chase-sets/design-system/react-router";
import { useNavigation } from "react-router";
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
  verificationState = "fresh",
}: {
  result: InventoryOfflineSaleResult | null | undefined;
  authoritativeAvailableQuantity?: number;
  verificationState?: "fresh" | "pending" | "unverified";
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
  const isVerifiedComplete = isComplete && verificationState === "fresh";
  const verificationMessage =
    verificationState === "pending"
      ? t("inventory.features.inventoryItems.ui.offlineSaleForm.result.pending")
      : verificationState === "unverified"
        ? t("inventory.features.inventoryItems.ui.offlineSaleForm.result.unverified")
        : null;
  const outcomeMessage = isComplete
    ? isVerifiedComplete
      ? t("inventory.features.inventoryItems.ui.offlineSaleForm.completed", {
          count: result.appliedQuantity,
          available: authoritativeAvailableQuantity ?? 0,
        })
      : null
    : isRefused
      ? t("inventory.features.inventoryItems.ui.offlineSaleForm.refused", { count: result.refusedQuantity })
      : t("inventory.features.inventoryItems.ui.offlineSaleForm.partial", {
          applied: result.appliedQuantity,
          refused: result.refusedQuantity,
        });

  return (
    <Stack ref={resultRef} gap={2} role={isVerifiedComplete ? "status" : "alert"} tabIndex={-1}>
      {verificationMessage ? <Text weight="semibold">{verificationMessage}</Text> : null}
      {outcomeMessage ? <Text weight="semibold">{outcomeMessage}</Text> : null}
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
  confirmedResult,
  itemId,
  authoritativeAvailableQuantity,
  errorMessage,
}: {
  initialIdempotencyKey: string;
  canHonorOffline: boolean;
  result?: InventoryOfflineSaleResult | null;
  confirmedResult?: InventoryOfflineSaleResult | null;
  itemId?: string;
  authoritativeAvailableQuantity?: number;
  errorMessage?: string | null;
}) {
  const navigation = useNavigation();
  const [idempotencyKey, setIdempotencyKey] = useState(initialIdempotencyKey);
  const [collisionMode, setCollisionMode] = useState<"protect-orders" | "honor-offline">("protect-orders");
  const [quantity, setQuantity] = useState<number | null>(null);
  const [salePriceAmount, setSalePriceAmount] = useState<string | null>(null);
  const [channel, setChannel] = useState("");
  const [note, setNote] = useState("");
  const [submissionStarted, setSubmissionStarted] = useState(false);
  const submissionStartedRef = useRef(false);
  const submittingItemId =
    navigation.state === "submitting" && navigation.formData?.get("intent") === "record-offline-sale"
      ? String(navigation.formData.get("itemId") ?? "")
      : null;
  const isSubmitting = submissionStarted || (submittingItemId !== null && (!itemId || submittingItemId === itemId));

  useEffect(() => {
    if (navigation.state === "idle") {
      submissionStartedRef.current = false;
      setSubmissionStarted(false);
    }
  }, [navigation.state]);

  useEffect(() => {
    if (confirmedResult ?? result) {
      setIdempotencyKey(initialIdempotencyKey);
      setQuantity(null);
      setSalePriceAmount(null);
      setChannel("");
      setNote("");
      setCollisionMode("protect-orders");
    }
  }, [confirmedResult, initialIdempotencyKey, result]);

  return (
    <RouterForm
      spacing="none"
      method="post"
      submitting={isSubmitting}
      onSubmit={(event) => {
        if (submissionStartedRef.current) {
          event.preventDefault();
          return;
        }

        submissionStartedRef.current = true;
        setSubmissionStarted(true);
      }}
    >
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
          value={quantity}
          onValueChange={setQuantity}
        />
        <CurrencyInput
          label={t("inventory.features.inventoryItems.ui.offlineSaleForm.price.per.item")}
          name="salePriceAmount"
          currencyCode="USD"
          value={salePriceAmount}
          onValueChange={setSalePriceAmount}
        />
        <NativeSelect
          label={t("inventory.features.inventoryItems.ui.offlineSaleForm.channel")}
          name="channel"
          required
          value={channel}
          onChange={(event) => setChannel(event.target.value)}
          placeholder={t("inventory.features.inventoryItems.ui.offlineSaleForm.channel.placeholder")}
          items={inventoryOfflineSaleChannels.map((channel) => ({
            value: channel,
            label: t(`inventory.features.inventoryItems.ui.offlineSaleForm.channel.${channel}`),
          }))}
        />
        <Textarea
          label={t("inventory.features.inventoryItems.ui.offlineSaleForm.note")}
          name="note"
          rows={3}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
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
        <Button type="submit" disabled={isSubmitting}>
          {t("inventory.features.inventoryItems.ui.offlineSaleForm.submit")}
        </Button>
        <OfflineSaleResult result={result} authoritativeAvailableQuantity={authoritativeAvailableQuantity} />
      </Stack>
    </RouterForm>
  );
}
