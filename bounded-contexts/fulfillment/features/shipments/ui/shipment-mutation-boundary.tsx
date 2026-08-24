import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useSubmit } from "react-router";
import { MarketplaceNotice, Stack } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import {
  listShipmentMutationDescriptors,
  persistShipmentMutationDescriptor,
  purgeShipmentMutationDescriptor,
  updateShipmentMutationDescriptor,
  type ShipmentMutationClientState,
} from "./mutation-recovery";

async function formIntentHash(formData: FormData) {
  const entries = [...formData.entries()]
    .filter(([key]) => key !== "mutationAttemptId")
    .map(([key, value]) => [
      key,
      typeof value === "string" ? value : { name: value.name, size: value.size, type: value.type },
    ])
    .sort(([left], [right]) => String(left).localeCompare(String(right)));
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(entries)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function ShipmentMutationBoundary({
  tenantId,
  sellerAccountId,
  defaultShipmentId,
  children,
}: {
  tenantId: string;
  sellerAccountId: string;
  defaultShipmentId?: string;
  children: ReactNode;
}) {
  const submit = useSubmit();
  const [hydrated, setHydrated] = useState(false);
  const [state, setState] = useState<ShipmentMutationClientState>("editing");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setHydrated(true);
    let cancelled = false;
    void listShipmentMutationDescriptors(tenantId, sellerAccountId)
      .then(async (descriptors) => {
        for (const descriptor of descriptors) {
          if (cancelled || descriptor.automaticRecoveryReadAt || !descriptor.sentAt) continue;
          const observedAt = new Date().toISOString();
          await updateShipmentMutationDescriptor(descriptor, {
            automaticRecoveryReadAt: observedAt,
            lastObservedAt: observedAt,
          });
          const response = await fetch(
            `/api/marketplace/account/sales/shipments/${encodeURIComponent(descriptor.shipmentId)}/mutation-recovery`,
            { method: "GET", credentials: "same-origin", headers: { "Idempotency-Key": descriptor.mutationAttemptId } },
          ).catch(() => null);
          if (!response || cancelled) continue;
          if (response.status === 401) {
            setState("reauthentication-required");
            continue;
          }
          const body = (await response.json().catch(() => null)) as { status?: ShipmentMutationClientState } | null;
          const recoveryState = body?.status ?? "confirming";
          setState(recoveryState);
          if (["succeeded", "failed-safe", "conflict"].includes(recoveryState)) {
            await purgeShipmentMutationDescriptor(descriptor);
          }
        }
      })
      .catch(() => setState("recovery-storage-required"));
    return () => {
      cancelled = true;
    };
  }, [tenantId, sellerAccountId]);

  async function onSubmitCapture(event: FormEvent<HTMLDivElement>) {
    const nativeEvent = event.nativeEvent as SubmitEvent;
    const form = event.target as HTMLFormElement;
    if (!(form instanceof HTMLFormElement) || form.method.toLowerCase() !== "post") return;
    event.preventDefault();
    setMessage(null);
    const submitter = nativeEvent.submitter as HTMLButtonElement | HTMLInputElement | null;
    const formData = new FormData(form);
    if (submitter?.name) formData.set(submitter.name, submitter.value);
    const command = String(formData.get("intent") ?? "");
    const shipmentId = String(formData.get("shipmentId") ?? defaultShipmentId ?? "");
    const target = String(formData.get("lineId") ?? "") || null;
    try {
      const descriptor = await persistShipmentMutationDescriptor({
        tenantId,
        sellerAccountId,
        shipmentId,
        command,
        target,
        intentHash: await formIntentHash(formData),
      });
      formData.set("mutationAttemptId", descriptor.mutationAttemptId);
      const sentAt = new Date().toISOString();
      await updateShipmentMutationDescriptor(descriptor, { sentAt, lastObservedAt: sentAt, state: "submitting" });
      setState("submitting");
      void submit(formData, { method: "post", action: form.action || undefined });
    } catch (error) {
      setState("recovery-storage-required");
      setMessage(
        error instanceof Error
          ? error.message
          : t("fulfillment.features.shipments.ui.shipmentMutationBoundary.storage.required"),
      );
    }
  }

  return (
    <Stack gap={3}>
      {!hydrated || state === "recovery-storage-required" ? (
        <MarketplaceNotice
          tone={state === "recovery-storage-required" ? "danger" : "info"}
          title={t("fulfillment.features.shipments.ui.shipmentMutationBoundary.secure.recovery.required")}
          description={
            message ?? t("fulfillment.features.shipments.ui.shipmentMutationBoundary.secure.recovery.description")
          }
        />
      ) : null}
      {state !== "editing" && state !== "submitting" && state !== "recovery-storage-required" ? (
        <MarketplaceNotice
          tone={state === "ambiguous" || state === "partial" ? "warning" : "info"}
          title={t("fulfillment.features.shipments.ui.shipmentMutationBoundary.action.recovery")}
          description={t("fulfillment.features.shipments.ui.shipmentMutationBoundary.recovery.state", { state })}
        />
      ) : null}
      <Stack
        gap={0}
        onSubmitCapture={onSubmitCapture}
        aria-busy={state === "submitting" || undefined}
        aria-disabled={!hydrated || state === "recovery-storage-required" || undefined}
        inert={!hydrated || state === "recovery-storage-required" ? true : undefined}
      >
        {children}
      </Stack>
    </Stack>
  );
}
