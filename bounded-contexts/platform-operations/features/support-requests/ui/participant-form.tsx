import { createContext, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useNavigation } from "react-router";
import { Banner, Button, HiddenInput, Stack, Text } from "@chase-sets/design-system";
import { RouterForm } from "@chase-sets/design-system/react-router";
import { t } from "@chase-sets/localization";
import type { ParticipantRouteRecovery } from "../../../support/request-support/participant-recovery";
export type { ParticipantRouteRecovery } from "../../../support/request-support/participant-recovery";
const State = createContext<
  Readonly<{ accountId: string; tenantId: string; recovery: ParticipantRouteRecovery | null }>
>({ accountId: "", tenantId: "", recovery: null });

export function ParticipantRoute({
  accountId,
  tenantId,
  recovery,
  children,
}: Readonly<{
  accountId: string;
  tenantId: string;
  recovery: ParticipantRouteRecovery | null;
  children: ReactNode;
}>) {
  const current = recovery?.accountId === accountId && recovery.tenantId === tenantId ? recovery : null;
  const heading = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (current?.phase === "ambiguous") heading.current?.focus();
  }, [current]);
  return (
    <State.Provider value={{ accountId, tenantId, recovery: current }}>
      {current?.phase === "ambiguous" ? (
        <Stack gap={3}>
          <Text as="div" ref={heading} tabIndex={-1} role="status" aria-live="polite">
            {t("support.participantAttempt.checkBeforeRetry")}
          </Text>
          <Banner tone="warning" title={t("support.participantAttempt.ambiguous")} />
          {current.descriptor ? (
            <RouterForm method="post">
              <HiddenInput name="intent" value="check-status" readOnly />
              <HiddenInput name="participantRecovery" value={JSON.stringify(current)} readOnly />
              <Button type="submit">{t("support.participantAttempt.checkStatus")}</Button>
            </RouterForm>
          ) : null}
        </Stack>
      ) : null}
      {children}
    </State.Provider>
  );
}

export function ParticipantForm({ children, ...props }: ComponentProps<typeof RouterForm>) {
  const navigation = useNavigation();
  const state = useContext(State);
  const [attemptId, setAttemptId] = useState(() => crypto.randomUUID());
  const [evidenceAttemptId, setEvidenceAttemptId] = useState(() => crypto.randomUUID());
  const busy = navigation.state !== "idle";
  const disabled = state.recovery?.phase === "ambiguous";
  return (
    <RouterForm
      {...props}
      disabled={disabled || props.disabled}
      submitting={busy || props.submitting}
      onChange={(event) => {
        if (!busy && !disabled) {
          setAttemptId(crypto.randomUUID());
          setEvidenceAttemptId(crypto.randomUUID());
        }
        props.onChange?.(event);
      }}
    >
      <HiddenInput name="participantAttemptId" value={attemptId} readOnly />
      <HiddenInput name="evidenceAttemptId" value={evidenceAttemptId} readOnly />
      <HiddenInput name="participantAccountId" value={state.accountId} readOnly />
      <HiddenInput name="participantTenantId" value={state.tenantId} readOnly />
      {children}
    </RouterForm>
  );
}
