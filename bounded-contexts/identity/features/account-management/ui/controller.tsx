import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useLocation, useNavigate, useRevalidator } from "react-router";
import { Banner, Button, Stack, Text } from "@chase-sets/design-system";
import { RouterForm, type RouterFormProps } from "@chase-sets/design-system/react-router";
import { t } from "@chase-sets/localization";
import type { OneTimeApiKeySecret } from "../../api-keys/api/one-time-secret";
import { actionFields, actionTargetField, type AttemptBinding, type MutationAction } from "../domain/contract";
import { descriptorDisposition, formIntentDigest, type ClientState, type MutationDescriptor } from "./descriptor";
import { sendMutation, type MutationFailure } from "./transport";
import type { ShippingAddressSnapshot } from "../../shipping-addresses/domain/domain";

type Controller = Readonly<{
  state: ClientState;
  activeForm: HTMLFormElement | null;
  ready: boolean;
  isHeld: (form: HTMLFormElement) => boolean;
  submit: (event: FormEvent<HTMLFormElement>, onMutation?: MutationNotificationHandler) => void;
}>;
const MutationContext = createContext<Controller | null>(null);

export type MutationNotification =
  | Readonly<{ type: "accepted" }>
  | Readonly<{ type: "failure"; failure: MutationFailure }>;
export type MutationNotificationHandler = (notification: MutationNotification) => void;

export function AccountMutationForm({
  onMutation,
  ...props
}: RouterFormProps & { onMutation?: MutationNotificationHandler }) {
  const controller = useContext(MutationContext);
  const ref = useRef<HTMLFormElement>(null);
  const entered = useRef<FormData | null>(null);
  const [held, setHeld] = useState(false);
  const busy =
    held ||
    (controller?.activeForm === ref.current &&
      ["submitting", "confirming", "reauth-required", "route-denied"].includes(controller.state));
  useLayoutEffect(() => {
    setHeld(Boolean(ref.current && controller?.isHeld(ref.current)));
  }, [controller]);
  useLayoutEffect(() => {
    if (controller?.state === "succeeded") {
      entered.current = null;
      return;
    }
    if (!ref.current || !entered.current || controller?.activeForm !== ref.current) return;
    // RouterForm's canonical disabled fieldset remounts its uncontrolled controls.
    for (const control of ref.current.elements) {
      if (
        !(
          control instanceof HTMLInputElement ||
          control instanceof HTMLSelectElement ||
          control instanceof HTMLTextAreaElement
        )
      )
        continue;
      const value = entered.current.get(control.name);
      if (control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type))
        control.checked = entered.current.getAll(control.name).includes(control.value);
      else if (typeof value === "string" && !(control instanceof HTMLInputElement && control.type === "file"))
        control.value = value;
    }
  }, [busy, controller?.state]);
  return (
    <RouterForm
      {...props}
      ref={ref}
      disabled={!controller?.ready || busy}
      submitting={controller?.activeForm === ref.current && controller.state === "submitting"}
      onChange={(event) => {
        entered.current = new FormData(event.currentTarget);
        props.onChange?.(event);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!controller?.ready || busy) return;
        entered.current = new FormData(event.currentTarget);
        controller.submit(event, onMutation);
      }}
    />
  );
}

export function AccountMutationBoundary({
  actor,
  children,
  onRecoveryDescriptor,
}: {
  actor: AttemptBinding;
  children: ReactNode | ((secret: OneTimeApiKeySecret | null) => ReactNode);
  onRecoveryDescriptor?: (descriptor: MutationDescriptor | null) => void;
}) {
  const parent = useContext(MutationContext);
  const location = useLocation();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<ClientState>("editing");
  const [secret, setSecret] = useState<Readonly<{ actorKey: string; value: OneTimeApiKeySecret }> | null>(null);
  const [secretLost, setSecretLost] = useState(false);
  const [suggestion, setSuggestion] = useState<Readonly<{ actorKey: string; value: ShippingAddressSnapshot }> | null>(
    null,
  );
  const [activeForm, setActiveForm] = useState<HTMLFormElement | null>(null);
  const status = useRef<HTMLDivElement>(null);
  const descriptor = useRef<MutationDescriptor | null>(null);
  const held = useRef(new Map<string, MutationDescriptor>());
  const [heldPairs, setHeldPairs] = useState<readonly string[]>([]);
  const [callerPresented, setCallerPresented] = useState(false);
  const busy = useRef(false);
  const generation = useRef(0);
  const actorKey = `${actor.tenantId}:${actor.userId}:${actor.accountId}`;
  const descriptorObserver = useRef(onRecoveryDescriptor);
  descriptorObserver.current = onRecoveryDescriptor;
  const visibleSecret = secret?.actorKey === actorKey ? secret.value : null;

  function remember(value: MutationDescriptor | null) {
    descriptor.current = value ? Object.freeze({ ...value }) : null;
    descriptorObserver.current?.(descriptor.current ?? [...held.current.values()].at(-1) ?? null);
  }

  function pair(form: HTMLFormElement): string {
    function field(name: string) {
      const control = form.elements.namedItem(name);
      return control instanceof HTMLInputElement || control instanceof HTMLSelectElement ? control.value : "";
    }
    const action = field("intent");
    const targetField = Object.hasOwn(actionTargetField, action) ? actionTargetField[action as MutationAction] : null;
    const target =
      action === "update-profile"
        ? actor.accountId
        : action === "update-user"
          ? actor.userId
          : targetField
            ? field(targetField) || null
            : null;
    return JSON.stringify([action, target]);
  }

  function hold(form: HTMLFormElement) {
    if (descriptor.current) {
      held.current.set(pair(form), descriptor.current);
      setHeldPairs([...held.current.keys()]);
    }
    busy.current = false;
  }

  useEffect(() => {
    generation.current += 1;
    held.current.clear();
    setHeldPairs([]);
    remember(null);
    busy.current = false;
    setSecret(null);
    setSecretLost(false);
    setState("editing");
    setActiveForm(null);
    setSuggestion(null);
    setCallerPresented(false);
    setReady(!parent);
    return () => {
      generation.current += 1;
      held.current.clear();
      remember(null);
      busy.current = false;
    };
  }, [actorKey, parent !== null]);

  const activeNotification = useRef<MutationNotificationHandler | undefined>(undefined);

  function submit(event: FormEvent<HTMLFormElement>, onMutation?: MutationNotificationHandler) {
    event.preventDefault();
    const native = event.nativeEvent as SubmitEvent;
    submitForm(
      event.currentTarget,
      native.submitter as HTMLButtonElement | HTMLInputElement | null,
      undefined,
      onMutation,
    );
  }

  function submitForm(
    form: HTMLFormElement,
    submitter: HTMLButtonElement | HTMLInputElement | null,
    choice?: "accept-suggested" | "keep-original",
    onMutation?: MutationNotificationHandler,
  ) {
    if (!ready || busy.current || parent || held.current.has(pair(form))) return;
    busy.current = true;
    const data = new FormData(form);
    if (submitter?.name) data.set(submitter.name, submitter.value);
    if (choice) data.set("addressVerificationDecision", choice);
    const action = String(data.get("intent") ?? "");
    const target =
      action === "update-profile"
        ? actor.accountId
        : action === "update-user"
          ? actor.userId
          : String(
              data.get("shippingAddressId") ??
                data.get("consentId") ??
                data.get("apiKeyId") ??
                data.get("invitationId") ??
                data.get("membershipId") ??
                "",
            ) || null;
    setActiveForm(form);
    setSecret(null);
    setSecretLost(false);
    setSuggestion(null);
    setCallerPresented(false);
    if (onMutation !== undefined) activeNotification.current = onMutation;
    else if (!choice) activeNotification.current = undefined;
    const notify = (notification: MutationNotification) => {
      try {
        activeNotification.current?.(notification);
        return Boolean(activeNotification.current);
      } catch {
        return false;
      }
    };
    const currentGeneration = generation.current;
    void (async () => {
      let sent = false;
      try {
        if (!Object.hasOwn(actionFields, action) || new URL(form.action).origin !== window.location.origin)
          throw new Error("INDETERMINATE");
        const attempt = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        const hash = await formIntentDigest(data);
        if (generation.current !== currentGeneration) return;
        remember({
          version: 1,
          ...actor,
          route: location.pathname,
          action: action as MutationDescriptor["action"],
          target,
          attempt,
          hash,
          createdAt,
          sentAt: null,
          observedAt: createdAt,
        });
        const sentAt = new Date().toISOString();
        remember({ ...descriptor.current!, sentAt, observedAt: sentAt });
        sent = true;
        notify({ type: "accepted" });
        setState("submitting");
        const result = await sendMutation({
          route: location.pathname,
          action,
          target,
          key: attempt,
          form: data,
          binding: actor,
          onConfirming: () => {
            if (generation.current === currentGeneration) setState("confirming");
          },
        });
        if (generation.current !== currentGeneration) return;
        if (descriptor.current) remember({ ...descriptor.current, observedAt: new Date().toISOString() });
        setState(result.state);
        setSecretLost(result.secretState === "committed-secret-unrecoverable");
        if (result.suggestedAddress) setSuggestion({ actorKey, value: result.suggestedAddress });
        if (result.secret && result.id && result.action)
          setSecret({
            actorKey,
            value: {
              apiKeyId: result.id,
              keyPrefix: result.secret.slice(0, 12),
              secret: result.secret,
              action: result.action,
            },
          });
        const delivered =
          result.state === "failed-safe" &&
          !result.suggestedAddress &&
          form.isConnected &&
          Boolean(activeNotification.current);
        const failure: MutationFailure = result.failure ?? {
          intent: action as MutationAction,
          target,
          message: t("identity.accountManagement.state.failed-safe"),
          errors: null,
        };
        const handedOff = delivered && notify({ type: "failure", failure });
        if (handedOff) setCallerPresented(true);
        if (descriptor.current && descriptorDisposition(descriptor.current, result.state, actor) === "discard")
          remember(null);
        if (result.state === "ambiguous") hold(form);
        else busy.current = ["reauth-required", "route-denied"].includes(result.state);
        if (!handedOff) status.current?.focus();
        if (result.state === "succeeded") {
          if (result.destination && result.destination !== location.pathname)
            await navigate(result.destination, { replace: true });
          else void revalidator.revalidate();
        }
      } catch {
        if (generation.current !== currentGeneration) return;
        setState(sent ? "ambiguous" : "failed-safe");
        if (sent) hold(form);
        if (!sent) {
          remember(null);
          busy.current = false;
        }
        status.current?.focus();
      }
    })();
  }

  return (
    <MutationContext.Provider
      value={{ ready: ready && !parent, state, activeForm, submit, isHeld: (form) => heldPairs.includes(pair(form)) }}
    >
      <Stack gap={3}>
        <Stack ref={status} tabIndex={-1} role="status" aria-live="polite">
          {state !== "editing" && !(state === "failed-safe" && callerPresented) ? (
            <Banner
              tone={
                ["ambiguous", "conflict"].includes(state)
                  ? "warning"
                  : state === "failed-safe" || state === "route-denied"
                    ? "danger"
                    : "info"
              }
              title={t(`identity.accountManagement.state.${state}`)}
            />
          ) : null}
          {heldPairs.length > 0 && state !== "ambiguous" ? (
            <Banner tone="warning" title={t("identity.accountManagement.state.ambiguous")} />
          ) : null}
          {secretLost ? <Text>{t("identity.accountManagement.secretUnrecoverable")}</Text> : null}
          {suggestion?.actorKey === actorKey && activeForm?.isConnected ? (
            <Stack gap={2}>
              <Text>{t("identity.accountManagement.addressChoice")}</Text>
              <Text>
                {[
                  suggestion.value.line1,
                  suggestion.value.line2,
                  suggestion.value.city,
                  suggestion.value.state,
                  suggestion.value.postalCode,
                  suggestion.value.country,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </Text>
              <Button type="button" onClick={() => submitForm(activeForm, null, "accept-suggested")}>
                {t("identity.accountManagement.acceptSuggested")}
              </Button>
              <Button type="button" tone="secondary" onClick={() => submitForm(activeForm, null, "keep-original")}>
                {t("identity.accountManagement.keepOriginal")}
              </Button>
            </Stack>
          ) : null}
        </Stack>
        {typeof children === "function" ? children(visibleSecret) : children}
        {visibleSecret ? (
          <Button type="button" tone="secondary" onClick={() => setSecret(null)}>
            {t("identity.accountManagement.acknowledgeSecret")}
          </Button>
        ) : null}
      </Stack>
    </MutationContext.Provider>
  );
}
