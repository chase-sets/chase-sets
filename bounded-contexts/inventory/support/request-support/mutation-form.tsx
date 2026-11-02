import { createContext, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Button, Form, HiddenInput, LinkButton, Stack, Text } from "@chase-sets/design-system";
import { RouterForm } from "@chase-sets/design-system/react-router";
import { t } from "@chase-sets/localization";
import { inventoryApi } from "../../client";
import { createInventoryMutationRecovery, type InventoryRecoveryAuthority } from "./mutation-recovery";
import type { InventoryMutationFamily } from "../runtime-support/mutation-intent";

const families: readonly InventoryMutationFamily[] = [
  "item-create",
  "item-adjust",
  "listing-stock-ensure",
  "hold-create",
  "hold-release",
  "location-create",
  "location-update",
  "location-archive",
  "restock-record",
  "import-create",
  "import-resolve-row",
];

type Controller = ReturnType<typeof createInventoryMutationRecovery>;
const RecoveryContext = createContext<Readonly<{
  controllers: ReadonlyMap<InventoryMutationFamily, Controller>;
  changed: () => void;
  ready: boolean;
}> | null>(null);

export function InventoryMutationProvider({
  authority,
  children,
  navigationPending = false,
}: {
  authority: InventoryRecoveryAuthority;
  children: ReactNode;
  navigationPending?: boolean;
}) {
  const [controllers, setControllers] = useState<ReadonlyMap<InventoryMutationFamily, Controller>>(new Map());
  const [, render] = useState(0);
  const status = useRef<HTMLParagraphElement>(null);
  const wasNavigating = useRef(false);
  const changed = () => render((value) => value + 1);
  const confirmAutomatically = (controller: Controller) => {
    void controller.confirm((id) => inventoryApi.getMutationAttempt(id)).then(changed);
  };
  useEffect(() => {
    try {
      const next = new Map(
        families.map((family) => [family, createInventoryMutationRecovery(authority, family, window.sessionStorage)]),
      );
      setControllers(next);
      for (const controller of next.values()) {
        if (controller.snapshot().state === "confirming") confirmAutomatically(controller);
      }
    } catch {
      setControllers(new Map());
    }
  }, [authority.accountId, authority.actorUserId]);
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      for (const controller of controllers.values()) {
        if (controller.snapshot().state !== "submitting") continue;
        controller.possibleSendLoss();
        changed();
        confirmAutomatically(controller);
      }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [controllers]);
  useEffect(() => {
    const completed = wasNavigating.current && !navigationPending;
    wasNavigating.current = navigationPending;
    if (!completed) return;
    for (const controller of controllers.values()) {
      if (controller.snapshot().state !== "submitting") continue;
      controller.possibleSendLoss();
      changed();
      confirmAutomatically(controller);
    }
  }, [navigationPending, controllers]);
  const pending = [...controllers.values()].filter((controller) => controller.snapshot().state !== "editing");
  const unavailable = controllers.size !== families.length;
  const state = unavailable
    ? "failed-safe"
    : (pending.find((controller) => controller.snapshot().writesDisabled)?.snapshot().state ??
      pending.at(-1)?.snapshot().state ??
      "editing");
  useEffect(() => {
    if (["ambiguous", "reauth-required", "succeeded", "failed-safe"].includes(state)) status.current?.focus();
  }, [state]);
  const message =
    state === "editing"
      ? t("inventory.recovery.editing")
      : state === "submitting"
        ? t("inventory.recovery.submitting")
        : state === "confirming"
          ? t("inventory.recovery.confirming")
          : state === "succeeded"
            ? t("inventory.recovery.succeeded")
            : state === "reauth-required"
              ? t("inventory.recovery.reauth")
              : state === "failed-safe"
                ? t("inventory.recovery.failedSafe")
                : t("inventory.recovery.ambiguous");
  return (
    <RecoveryContext.Provider value={{ controllers, changed, ready: !unavailable }}>
      <Stack gap={4}>
        <Text ref={status} role="status" aria-live="polite" tabIndex={-1}>
          {message}
        </Text>
        {[...controllers.entries()]
          .filter(([family, controller]) => family === "import-create" && controller.snapshot().state === "succeeded")
          .map(([family, controller]) => {
            const result = controller.snapshot().result;
            const jobId = result && typeof result === "object" && "jobId" in result ? result.jobId : null;
            return typeof jobId === "string" && /^job_[A-Za-z0-9_-]+$/.test(jobId) ? (
              <LinkButton key={family} href={`/account/inventory/imports?jobId=${encodeURIComponent(jobId)}`}>
                {t("inventory.features.importBatches.ui.importBatchPage.latest.batch")}
              </LinkButton>
            ) : null;
          })}
        {[...controllers.entries()]
          .filter(([, controller]) => ["ambiguous", "reauth-required"].includes(controller.snapshot().state))
          .map(([family, controller]) => (
            <Stack key={family} gap={2}>
              <Button
                type="button"
                onClick={() => {
                  void controller.confirm((id) => inventoryApi.getMutationAttempt(id)).then(changed);
                }}
              >
                {t("inventory.recovery.check")}
              </Button>
              <Button
                type="button"
                tone="secondary"
                onClick={() => {
                  if (window.confirm(t("inventory.recovery.discardConfirmation"))) {
                    controller.discard();
                    changed();
                  }
                }}
              >
                {t("inventory.recovery.discard")}
              </Button>
            </Stack>
          ))}
        {children}
      </Stack>
    </RecoveryContext.Provider>
  );
}

type MutationRecoveryProps = {
  family: InventoryMutationFamily;
  targetId: string;
  enabled?: boolean;
  mutationIntents?: readonly string[];
};

function useMutationForm({
  family,
  targetId,
  enabled = true,
  mutationIntents,
  onSubmit,
}: MutationRecoveryProps & Pick<ComponentProps<typeof Form>, "onSubmit">) {
  const recovery = useContext(RecoveryContext);
  const hidden = useRef<HTMLInputElement>(null);
  const controller = recovery?.controllers.get(family);
  const disabled = enabled && (!recovery?.ready || !controller || controller.snapshot().writesDisabled);
  const submit: NonNullable<ComponentProps<typeof Form>["onSubmit"]> = (event) => {
    if (!enabled) {
      onSubmit?.(event);
      return;
    }
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    if (mutationIntents && submitter instanceof HTMLButtonElement && !mutationIntents.includes(submitter.value)) {
      onSubmit?.(event);
      return;
    }
    if (disabled || !controller || !hidden.current || !recovery) {
      event.preventDefault();
      return;
    }
    try {
      hidden.current.value = controller.begin(targetId);
      onSubmit?.(event);
      if (event.defaultPrevented) controller.refusedBeforeAcceptance();
      else setTimeout(() => recovery.changed(), 0);
    } catch {
      event.preventDefault();
      recovery?.changed();
    }
  };
  return { hidden, disabled, submit };
}

export function InventoryMutationForm({
  family,
  targetId,
  enabled,
  mutationIntents,
  children,
  onSubmit,
  ...props
}: ComponentProps<typeof Form> & MutationRecoveryProps) {
  const { hidden, disabled, submit } = useMutationForm({ family, targetId, enabled, mutationIntents, onSubmit });
  return (
    <Form {...props} disabled={props.disabled || disabled} onSubmit={submit}>
      <HiddenInput ref={hidden} name="inventoryMutationAttemptId" defaultValue="" />
      {children}
    </Form>
  );
}

export function InventoryMutationRouterForm({
  family,
  targetId,
  enabled,
  mutationIntents,
  children,
  onSubmit,
  ...props
}: ComponentProps<typeof RouterForm> & MutationRecoveryProps) {
  const { hidden, disabled, submit } = useMutationForm({ family, targetId, enabled, mutationIntents, onSubmit });
  return (
    <RouterForm {...props} disabled={props.disabled || disabled} onSubmit={submit}>
      <HiddenInput ref={hidden} name="inventoryMutationAttemptId" defaultValue="" />
      {children}
    </RouterForm>
  );
}
