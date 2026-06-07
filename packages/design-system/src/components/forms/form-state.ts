import { useMemo, useRef, useState, type ChangeEvent } from "react";

export type FormValues = Record<string, string>;
export type FormFieldErrors<TValues extends FormValues> = Partial<Record<keyof TValues, readonly string[]>>;

export interface NormalizedFormErrors<TValues extends FormValues> {
  fieldErrors: FormFieldErrors<TValues>;
  formErrors: readonly string[];
}

export type FormValidationResult<TValues extends FormValues> =
  | NormalizedFormErrors<TValues>
  | Partial<Record<keyof TValues | "_form", string | readonly string[] | undefined>>
  | null
  | undefined;

type MaybePromise<TValue> = TValue | Promise<TValue>;

export interface FormFieldMeta {
  dirty: boolean;
  touched: boolean;
  error?: string;
}

export type FormFieldMetaMap<TValues extends FormValues> = Record<keyof TValues, FormFieldMeta>;

export interface UseFormStateOptions<TValues extends FormValues> {
  validate?: (values: TValues) => MaybePromise<FormValidationResult<TValues>>;
}

export interface UseFormStateResult<TValues extends FormValues> {
  values: TValues;
  initialValues: TValues;
  errors: NormalizedFormErrors<TValues>;
  fieldMeta: FormFieldMetaMap<TValues>;
  dirty: boolean;
  valid: boolean;
  validating: boolean;
  submitting: boolean;
  submitCount: number;
  setFieldValue: <TField extends keyof TValues>(name: TField, value: TValues[TField]) => void;
  setFieldTouched: <TField extends keyof TValues>(name: TField, touched?: boolean) => void;
  setErrors: (errors: FormValidationResult<TValues>) => void;
  setSubmitting: (submitting: boolean) => void;
  reset: (nextValues?: TValues) => void;
  validate: () => boolean;
  validateAsync: () => Promise<boolean>;
  submitAttempted: () => boolean;
  submitAttemptedAsync: () => Promise<boolean>;
  fieldProps: <TField extends keyof TValues>(
    name: TField,
  ) => {
    name: string;
    value: TValues[TField];
    error?: string;
    onBlur: () => void;
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => void;
  };
}

function entriesOf<TValues extends FormValues>(values: TValues): [keyof TValues, string][] {
  return Object.entries(values) as [keyof TValues, string][];
}

function toErrorList(value: string | readonly string[] | undefined): readonly string[] {
  if (!value) {
    return [];
  }
  if (typeof value === "string") {
    return value ? [value] : [];
  }
  return value.filter((error) => error.length > 0);
}

function isNormalizedFormErrors<TValues extends FormValues>(
  errors: Exclude<FormValidationResult<TValues>, null | undefined>,
): errors is NormalizedFormErrors<TValues> {
  return "fieldErrors" in errors || "formErrors" in errors;
}

function isPromiseLike<TValue>(value: MaybePromise<TValue>): value is Promise<TValue> {
  return typeof (value as Promise<TValue> | undefined)?.then === "function";
}

function rejectedValidationErrors<TValues extends FormValues>(error: unknown): NormalizedFormErrors<TValues> {
  if (error instanceof Error && error.message) {
    return { fieldErrors: {}, formErrors: [error.message] };
  }
  return { fieldErrors: {}, formErrors: ["Validation could not be completed."] };
}

export function normalizeFormErrors<TValues extends FormValues>(
  errors: FormValidationResult<TValues>,
): NormalizedFormErrors<TValues> {
  if (!errors) {
    return { fieldErrors: {}, formErrors: [] };
  }

  if (isNormalizedFormErrors(errors)) {
    return {
      fieldErrors: errors.fieldErrors ?? {},
      formErrors: errors.formErrors ?? [],
    };
  }

  const fieldErrors: Partial<Record<keyof TValues, readonly string[]>> = {};
  const formErrors = toErrorList(errors._form);

  for (const [name, value] of Object.entries(errors)) {
    if (name === "_form") {
      continue;
    }
    const list = toErrorList(value);
    if (list.length > 0) {
      fieldErrors[name as keyof TValues] = list;
    }
  }

  return { fieldErrors, formErrors };
}

export function firstFieldError<TValues extends FormValues>(
  errors: NormalizedFormErrors<TValues>,
  name: keyof TValues,
): string | undefined {
  return errors.fieldErrors[name]?.[0];
}

export function hasFormErrors<TValues extends FormValues>(errors: NormalizedFormErrors<TValues>): boolean {
  return errors.formErrors.length > 0 || Object.values(errors.fieldErrors).some((list) => (list?.length ?? 0) > 0);
}

export function clearFieldError<TValues extends FormValues>(
  errors: NormalizedFormErrors<TValues>,
  name: keyof TValues,
): NormalizedFormErrors<TValues> {
  const remainingFieldErrors = { ...errors.fieldErrors };
  delete remainingFieldErrors[name];
  return {
    fieldErrors: remainingFieldErrors as FormFieldErrors<TValues>,
    formErrors: errors.formErrors,
  };
}

export function useFormState<TValues extends FormValues>(
  initialValues: TValues,
  options: UseFormStateOptions<TValues> = {},
): UseFormStateResult<TValues> {
  const [values, setValues] = useState<TValues>(initialValues);
  const [baseline, setBaseline] = useState<TValues>(initialValues);
  const [touched, setTouched] = useState<Partial<Record<keyof TValues, boolean>>>({});
  const [errors, setNormalizedErrors] = useState<NormalizedFormErrors<TValues>>({ fieldErrors: {}, formErrors: [] });
  const [submitCount, setSubmitCount] = useState(0);
  const [validating, setValidating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const validationRequestRef = useRef(0);

  const fieldMeta = useMemo(() => {
    return Object.fromEntries(
      entriesOf(values).map(([name, value]) => [
        name,
        {
          dirty: value !== baseline[name],
          touched: Boolean(touched[name]),
          error: firstFieldError(errors, name),
        },
      ]),
    ) as FormFieldMetaMap<TValues>;
  }, [baseline, errors, touched, values]);

  function setFieldValue<TField extends keyof TValues>(name: TField, value: TValues[TField]) {
    validationRequestRef.current += 1;
    setValues((current) => ({ ...current, [name]: value }));
    setNormalizedErrors((current) => ({ ...clearFieldError(current, name), formErrors: [] }));
    setValidating(false);
  }

  function setFieldTouched<TField extends keyof TValues>(name: TField, nextTouched = true) {
    setTouched((current) => ({ ...current, [name]: nextTouched }));
  }

  function setErrors(nextErrors: FormValidationResult<TValues>) {
    validationRequestRef.current += 1;
    setNormalizedErrors(normalizeFormErrors(nextErrors));
    setValidating(false);
  }

  function validate() {
    let result: MaybePromise<FormValidationResult<TValues>>;
    try {
      result = options.validate?.(values);
    } catch (error) {
      const nextErrors = rejectedValidationErrors<TValues>(error);
      validationRequestRef.current += 1;
      setNormalizedErrors(nextErrors);
      setValidating(false);
      return false;
    }
    if (isPromiseLike(result)) {
      void runAsyncValidation(result);
      return false;
    }
    validationRequestRef.current += 1;
    const nextErrors = normalizeFormErrors(result);
    setNormalizedErrors(nextErrors);
    setValidating(false);
    return !hasFormErrors(nextErrors);
  }

  async function runAsyncValidation(validation: Promise<FormValidationResult<TValues>>) {
    const requestId = validationRequestRef.current + 1;
    validationRequestRef.current = requestId;
    setValidating(true);

    try {
      const nextErrors = normalizeFormErrors(await validation);
      if (validationRequestRef.current !== requestId) {
        return false;
      }
      setNormalizedErrors(nextErrors);
      return !hasFormErrors(nextErrors);
    } catch (error) {
      if (validationRequestRef.current !== requestId) {
        return false;
      }
      const nextErrors = rejectedValidationErrors<TValues>(error);
      setNormalizedErrors(nextErrors);
      return false;
    } finally {
      if (validationRequestRef.current === requestId) {
        setValidating(false);
      }
    }
  }

  function validateAsync() {
    try {
      return runAsyncValidation(Promise.resolve(options.validate?.(values)));
    } catch (error) {
      validationRequestRef.current += 1;
      const nextErrors = rejectedValidationErrors<TValues>(error);
      setNormalizedErrors(nextErrors);
      setValidating(false);
      return Promise.resolve(false);
    }
  }

  function submitAttempted() {
    setSubmitCount((current) => current + 1);
    return validate();
  }

  async function submitAttemptedAsync() {
    setSubmitCount((current) => current + 1);
    return validateAsync();
  }

  function reset(nextValues = initialValues) {
    validationRequestRef.current += 1;
    setValues(nextValues);
    setBaseline(nextValues);
    setTouched({});
    setNormalizedErrors({ fieldErrors: {}, formErrors: [] });
    setSubmitCount(0);
    setValidating(false);
    setSubmitting(false);
  }

  return {
    values,
    initialValues: baseline,
    errors,
    fieldMeta,
    dirty: Object.values(fieldMeta).some((field) => field.dirty),
    valid: !hasFormErrors(errors),
    validating,
    submitting,
    submitCount,
    setFieldValue,
    setFieldTouched,
    setErrors,
    setSubmitting,
    reset,
    validate,
    validateAsync,
    submitAttempted,
    submitAttemptedAsync,
    fieldProps: (name) => ({
      name: String(name),
      value: values[name],
      error: firstFieldError(errors, name),
      onBlur: () => setFieldTouched(name),
      onChange: (event) => setFieldValue(name, event.currentTarget.value as TValues[typeof name]),
    }),
  };
}
