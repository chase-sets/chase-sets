import { useContext, useEffect, useRef, useState, type ComponentProps } from "react";
import { UNSAFE_DataRouterContext, useActionData, useNavigation, useSubmit } from "react-router";
import { Form, HiddenInput, MarketplaceNotice, Stack } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { marketplaceAttemptIdSchema } from "../../mutation-recovery/domain/contracts";

export type ReviewMutationPhase =
  | "editing"
  | "submitting"
  | "confirming"
  | "succeeded"
  | "failed-safe"
  | "ambiguous"
  | "conflict";
export type ReviewMutationActionState = Readonly<{
  mutationPhase: ReviewMutationPhase;
  attemptId: string;
  error?: string;
}>;

export function ReviewMutationForm(props: ComponentProps<typeof Form>) {
  const router = useContext(UNSAFE_DataRouterContext);
  const [attemptId] = useState(() => crypto.randomUUID());
  if (router) return <RoutedReviewMutationForm {...props} />;
  return (
    <Form {...props}>
      <HiddenInput type="hidden" name="attemptId" value={attemptId} readOnly />
      {props.children}
    </Form>
  );
}

function RoutedReviewMutationForm({ children, onSubmit, onChange, ...props }: ComponentProps<typeof Form>) {
  const submit = useSubmit();
  const navigation = useNavigation();
  const actionData = useActionData() as ReviewMutationActionState | undefined;
  const [attemptId, setAttemptId] = useState(() => actionData?.attemptId ?? crypto.randomUUID());
  const [localPhase, setLocalPhase] = useState<ReviewMutationPhase>("editing");
  const retained = useRef<FormData | null>(null);
  const confirmed = useRef(new Set<string>());
  const notice = useRef<HTMLDivElement>(null);
  const state = actionData?.attemptId === attemptId ? actionData : undefined;
  const recoveredPhase =
    state?.mutationPhase === "confirming" && !retained.current ? "ambiguous" : state?.mutationPhase;
  const phase = navigation.state !== "idle" && retained.current ? localPhase : (recoveredPhase ?? localPhase);
  const locked = ["submitting", "confirming", "ambiguous", "conflict", "succeeded"].includes(phase);

  useEffect(() => {
    if (
      navigation.state !== "idle" ||
      state?.mutationPhase !== "confirming" ||
      !retained.current ||
      confirmed.current.has(attemptId)
    )
      return;
    confirmed.current.add(attemptId);
    const form = new FormData();
    retained.current.forEach((value, key) => form.append(key, value));
    form.set("intent", `confirm:${String(form.get("intent") ?? "submit-review")}`);
    setLocalPhase("confirming");
    void submit(form, { method: "post", action: props.action });
  }, [state, attemptId, navigation.state, submit, props.action]);

  useEffect(() => {
    if (phase === "ambiguous" || phase === "conflict") notice.current?.focus();
  }, [phase]);

  return (
    <Stack gap={3}>
      {phase !== "editing" ? (
        <div ref={notice} tabIndex={-1} role="status" aria-live="polite" aria-atomic="true">
          <MarketplaceNotice
            tone={phase === "succeeded" ? "success" : phase === "ambiguous" || phase === "conflict" ? "danger" : "info"}
            title={
              phase === "confirming"
                ? t("marketplace.reviewRecovery.confirming")
                : phase === "submitting"
                  ? t("marketplace.reviewRecovery.submitting")
                  : phase === "succeeded"
                    ? t("marketplace.reviewRecovery.succeeded")
                    : phase === "ambiguous"
                      ? t("marketplace.reviewRecovery.ambiguous")
                      : phase === "conflict"
                        ? t("marketplace.reviewRecovery.conflict")
                        : t("marketplace.reviewRecovery.failedSafe")
            }
            description={state?.error}
          />
        </div>
      ) : null}
      <Form
        {...props}
        disabled={props.disabled || locked}
        onChange={(event) => {
          onChange?.(event);
          if (locked) return;
          setAttemptId(crypto.randomUUID());
          setLocalPhase("editing");
        }}
        onSubmit={(event) => {
          onSubmit?.(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          if (locked) return;
          const form = new FormData(event.currentTarget);
          const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
          if (submitter?.name) form.set(submitter.name, submitter.value);
          form.set("attemptId", attemptId);
          retained.current = form;
          if (!marketplaceAttemptIdSchema.safeParse(attemptId).success) {
            setLocalPhase("failed-safe");
            return;
          }
          setLocalPhase("submitting");
          void submit(form, { method: "post", action: props.action });
        }}
      >
        <HiddenInput type="hidden" name="attemptId" value={attemptId} readOnly />
        {children}
      </Form>
    </Stack>
  );
}
