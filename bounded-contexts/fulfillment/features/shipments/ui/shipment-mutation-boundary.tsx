import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useSubmit } from "react-router";
import { MarketplaceNotice, Stack } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import {
  completeShipmentMutationDescriptor,
  listShipmentMutationDescriptors,
  persistShipmentMutationDescriptor,
  updateShipmentMutationDescriptor,
  type ShipmentMutationClientState,
  type ShipmentMutationRecoveryDescriptor,
} from "./mutation-recovery";

const COMPLETED_STATES = new Set(["succeeded", "failed-safe", "conflict"]);
const RESOLVED_STATES = new Set([...COMPLETED_STATES, "unchanged"]);

function compareCodePointStrings(left: string, right: string) {
  const leftCodePoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightCodePoints = Array.from(right, (value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(leftCodePoints.length, rightCodePoints.length); index += 1) {
    const difference = leftCodePoints[index]! - rightCodePoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftCodePoints.length - rightCodePoints.length;
}

async function formIntentHash(formData: FormData) {
  const entries = [...formData.entries()]
    .filter(([key]) => key !== "mutationAttemptId")
    .map(([key, value]) => [
      key,
      typeof value === "string" ? value : { name: value.name, size: value.size, type: value.type },
    ])
    .sort(([left], [right]) => compareCodePointStrings(String(left), String(right)));
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(entries)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readShipmentMutationRecovery(descriptor: ShipmentMutationRecoveryDescriptor) {
  const observedAt = new Date().toISOString();
  const observed = await updateShipmentMutationDescriptor(descriptor, {
    automaticRecoveryReadAt: observedAt,
    lastObservedAt: observedAt,
  });
  const response = await fetch(
    `/api/marketplace/account/sales/shipments/${encodeURIComponent(descriptor.shipmentId)}/mutation-recovery`,
    { method: "GET", credentials: "same-origin", headers: { "Idempotency-Key": descriptor.mutationAttemptId } },
  ).catch(() => null);
  if (!response) return null;
  if (response.status === 401) {
    await updateShipmentMutationDescriptor(observed, { state: "reauthentication-required" });
    return "reauthentication-required" as const;
  }
  const body = (await response.json().catch(() => null)) as { status?: ShipmentMutationClientState } | null;
  const recoveryState = body?.status ?? "confirming";
  if (COMPLETED_STATES.has(recoveryState)) {
    await completeShipmentMutationDescriptor(observed, recoveryState as "succeeded" | "failed-safe" | "conflict");
  } else if (recoveryState !== "editing" && recoveryState !== "recovery-storage-required") {
    await updateShipmentMutationDescriptor(observed, { state: recoveryState });
  }
  return recoveryState;
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
  const unresolved = state !== "editing" && state !== "submitting" && !RESOLVED_STATES.has(state);
  const mutationsDisabled = !hydrated || unresolved;

  useEffect(() => {
    setHydrated(false);
    let cancelled = false;
    void listShipmentMutationDescriptors(tenantId, sellerAccountId)
      .then(async (descriptors) => {
        let outstandingState: ShipmentMutationClientState = "editing";
        for (const descriptor of descriptors) {
          if (cancelled) return;
          if (RESOLVED_STATES.has(descriptor.state)) continue;
          if (descriptor.automaticRecoveryReadAt || !descriptor.sentAt) continue;
          const recoveryState = (await readShipmentMutationRecovery(descriptor)) ?? "confirming";
          if (recoveryState !== "editing" && !RESOLVED_STATES.has(recoveryState)) {
            outstandingState = recoveryState === "submitting" ? "confirming" : recoveryState;
          }
        }
        if (!cancelled) setState(outstandingState);
      })
      .catch(() => {
        if (!cancelled) setState("recovery-storage-required");
      })
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, sellerAccountId]);

  async function onSubmitCapture(event: FormEvent<HTMLDivElement>) {
    const nativeEvent = event.nativeEvent as SubmitEvent;
    const form = event.target as HTMLFormElement;
    if (!(form instanceof HTMLFormElement) || form.method.toLowerCase() !== "post") return;
    event.preventDefault();
    if (mutationsDisabled) return;
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
      const sentDescriptor = await updateShipmentMutationDescriptor(descriptor, {
        sentAt,
        lastObservedAt: sentAt,
        state: "submitting",
      });
      setState("submitting");
      await submit(formData, { method: "post", action: form.action || undefined });
      const recoveryState = await readShipmentMutationRecovery(sentDescriptor);
      setState(recoveryState ?? "confirming");
    } catch (error) {
      setState("recovery-storage-required");
      setMessage(t("fulfillment.features.shipments.ui.shipmentMutationBoundary.storage.required"));
    }
  }

  return (
    <Stack gap={3}>
      {!hydrated ? (
        <MarketplaceNotice
          tone="info"
          title={t("fulfillment.features.shipments.ui.shipmentMutationBoundary.preparing.title")}
          description={t("fulfillment.features.shipments.ui.shipmentMutationBoundary.preparing.description")}
        />
      ) : state === "recovery-storage-required" ? (
        <MarketplaceNotice
          tone="danger"
          title={t("fulfillment.features.shipments.ui.shipmentMutationBoundary.secure.recovery.required")}
          description={
            message ?? t("fulfillment.features.shipments.ui.shipmentMutationBoundary.secure.recovery.description")
          }
        />
      ) : null}
      {hydrated && state !== "editing" && state !== "submitting" && state !== "recovery-storage-required" ? (
        <MarketplaceNotice
          tone={state === "ambiguous" || state === "partial" ? "warning" : "info"}
          title={t("fulfillment.features.shipments.ui.shipmentMutationBoundary.action.recovery")}
          description={t("fulfillment.features.shipments.ui.shipmentMutationBoundary.recovery.state", { state })}
        />
      ) : null}
      <Stack gap={0} onSubmitCapture={onSubmitCapture} aria-busy={state === "submitting" || undefined}>
        <Stack as="fieldset" gap={0} minWidth="0" disabled={mutationsDisabled}>
          {children}
        </Stack>
      </Stack>
    </Stack>
  );
}
