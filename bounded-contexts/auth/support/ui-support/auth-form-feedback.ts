import { normalizeFormErrors, type ValidationSummaryError } from "@chase-sets/design-system";
import { useEffect, useId, useRef, useState, type FormEventHandler } from "react";
import { useNavigation, useSubmit } from "react-router";
import type { AuthActionError, AuthActionIntent } from "../route-support/auth-action-errors";
import type { AuthActionNotice } from "../route-support/auth-host";

export type AuthFormFeedbackProps = Readonly<{
  actionError?: AuthActionError | null;
  notice?: AuthActionNotice | null;
  socialError?: string | null;
  socialOccurrence?: string;
  submissionPending?: boolean;
  onSubmit?: FormEventHandler<HTMLFormElement>;
}>;

export function useAuthFormSubmission() {
  const navigation = useNavigation();
  const submit = useSubmit();
  const onSubmit: FormEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault();
    void submit(event.currentTarget);
  };
  return {
    onSubmit,
    submissionPending: navigation.state !== "idle" && navigation.formMethod?.toLowerCase() === "post",
  };
}

export function useAuthFormFeedback(props: AuthFormFeedbackProps, successTargetId?: string) {
  const summaryRef = useRef<HTMLElement>(null);
  const socialId = useId();
  const successId = useId();
  const focusedResult = useRef<AuthActionError | AuthActionNotice | null>(null);
  const focusedSocial = useRef<string | null>(null);
  const wasPending = useRef(false);
  const [invalidatedSubmission, setInvalidatedSubmission] = useState(false);
  const [dismissed, setDismissed] = useState<
    Pick<AuthFormFeedbackProps, "actionError" | "notice" | "socialOccurrence">
  >({});
  const error =
    !props.submissionPending && !invalidatedSubmission && props.actionError !== dismissed.actionError
      ? props.actionError
      : null;
  const notice =
    !props.submissionPending && !invalidatedSubmission && props.notice !== dismissed.notice ? props.notice : null;
  const socialError =
    !props.submissionPending && props.socialOccurrence !== dismissed.socialOccurrence ? props.socialError : null;

  function dismiss() {
    setDismissed({ actionError: props.actionError, notice: props.notice, socialOccurrence: props.socialOccurrence });
  }

  function clear() {
    dismiss();
    if (props.submissionPending) setInvalidatedSubmission(true);
  }

  function begin() {
    dismiss();
    setInvalidatedSubmission(false);
  }

  useEffect(() => {
    if (props.submissionPending && !wasPending.current) begin();
    wasPending.current = Boolean(props.submissionPending);
  }, [props.submissionPending]);

  useEffect(() => {
    if (props.submissionPending) return;
    const result = error ?? notice;
    if (result && focusedResult.current !== result) {
      const target = error
        ? summaryRef.current
        : (document.getElementById(successTargetId ?? successId) ?? document.getElementById(successId));
      if (target) {
        focusedResult.current = result;
        target.focus();
      }
    } else if (!result && socialError && focusedSocial.current !== props.socialOccurrence) {
      const banner = document.getElementById(socialId);
      if (banner) {
        focusedSocial.current = props.socialOccurrence ?? null;
        banner.focus();
      }
    }
  }, [
    error,
    notice,
    props.submissionPending,
    props.socialOccurrence,
    socialError,
    successId,
    socialId,
    successTargetId,
  ]);

  return { error, notice, socialError, summaryRef, socialId, successId, clear, begin };
}

export function authFormErrors(
  error: AuthActionError | null | undefined,
  phoneTarget?: Readonly<{ intent: AuthActionIntent; id: string; label: string }>,
) {
  const normalized = normalizeFormErrors(error?.errors);
  const phoneEligible = error?.classification === "FIELD" && error.intent === phoneTarget?.intent;
  const phoneErrors = normalized.fieldErrors.phone ?? [];
  const errors = normalizeFormErrors<{ phone: string }>({
    fieldErrors: phoneEligible ? { phone: phoneErrors } : {},
    formErrors: [...normalized.formErrors, ...(!phoneEligible ? phoneErrors : [])],
  });
  const summary: ValidationSummaryError[] = [
    ...errors.formErrors.map((message) => ({ message })),
    ...phoneErrors
      .filter(() => phoneEligible)
      .map((message) => ({ message, fieldId: phoneTarget?.id, fieldName: phoneTarget?.label })),
  ];
  return { errors, summary };
}
