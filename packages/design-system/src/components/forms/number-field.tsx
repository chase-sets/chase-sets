import { forwardRef, useId, type ComponentProps, type ReactNode, type Ref } from "react";
import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field";
import {
  centsToMoneyAmount,
  centsToSignedMoneyAmount,
  MONEY_AMOUNT_MAX_CENTS,
  tryMoneyToCents,
  trySignedMoneyToCents,
} from "@chase-sets/primitives/money";
import { Icon } from "../../icons";
import { VisuallyHidden } from "../../primitives/layout";
import { cx } from "../../utils/cx";
import { controlSquareSizeClasses } from "../control-sizing";
import { FieldChrome, compoundControlClass, controlErrorClass, fieldDescribedBy, type BaseInputProps } from "./shared";

/**
 * Shared visual chrome for every Base UI Number Field built in this slice
 * (`NumberField`, `CurrencyInput`): a bordered group with flanking
 * decrement/increment icon buttons around a centered text input. Colocating
 * this here keeps the three numeric controls (this pair, plus
 * `QuantityStepper` in its own file for the cart/order-entry density variant)
 * from re-deriving the same grid/icon-button markup.
 */
function NumberFieldControlGroup({
  error,
  disabledChrome = false,
  decrementLabel,
  incrementLabel,
  inputProps,
  inputRef,
  prefixAdornment,
  suffixAdornment,
}: {
  error?: unknown;
  disabledChrome?: boolean;
  decrementLabel: string;
  incrementLabel: string;
  inputProps: Omit<ComponentProps<typeof NumberFieldPrimitive.Input>, "className">;
  inputRef?: Ref<HTMLInputElement>;
  /**
   * Decorative content flowed in-line before/after the input, inside the same
   * middle grid cell as the input itself (for example a currency symbol). Kept
   * in normal flex flow rather than absolutely positioned, so no fixed-width
   * padding assumption is ever needed regardless of the adornment's width.
   */
  prefixAdornment?: ReactNode;
  suffixAdornment?: ReactNode;
}) {
  const iconButtonClass = cx(
    "focus-ring inline-flex items-center justify-center rounded-tokenSm text-secondary hover:bg-background disabled:pointer-events-none",
    controlSquareSizeClasses.sm,
  );

  return (
    <NumberFieldPrimitive.Group
      className={cx(
        compoundControlClass,
        !!error && controlErrorClass,
        disabledChrome && "cursor-not-allowed opacity-60",
        "grid grid-cols-[var(--control-sm-height)_minmax(0,1fr)_var(--control-sm-height)] items-center gap-1",
      )}
    >
      <NumberFieldPrimitive.Decrement aria-label={decrementLabel} className={iconButtonClass}>
        <Icon name="minus" size="sm" />
      </NumberFieldPrimitive.Decrement>
      <span className="flex min-w-0 items-center justify-center gap-1 px-2">
        {prefixAdornment ? (
          <span aria-hidden="true" className="text-secondary">
            {prefixAdornment}
          </span>
        ) : null}
        <NumberFieldPrimitive.Input
          role="spinbutton"
          {...inputProps}
          ref={inputRef}
          className="min-w-0 flex-1 bg-transparent py-[var(--control-sm-py)] text-center outline-none"
        />
        {suffixAdornment ? (
          <span aria-hidden="true" className="text-secondary">
            {suffixAdornment}
          </span>
        ) : null}
      </span>
      <NumberFieldPrimitive.Increment aria-label={incrementLabel} className={iconButtonClass}>
        <Icon name="plus" size="sm" />
      </NumberFieldPrimitive.Increment>
    </NumberFieldPrimitive.Group>
  );
}

export interface NumberFieldProps extends BaseInputProps {
  name?: string;
  form?: string;
  value?: number | null;
  defaultValue?: number;
  onValueChange?: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number | "any";
  disabled?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  decrementLabel?: string;
  incrementLabel?: string;
}

export const NumberField = forwardRef<HTMLInputElement, NumberFieldProps>(function NumberField(
  {
    id,
    label,
    description,
    error,
    status,
    counter,
    required,
    hideLabel,
    name,
    form,
    value,
    defaultValue,
    onValueChange,
    min,
    max,
    step = 1,
    disabled = false,
    readOnly = false,
    placeholder,
    decrementLabel = "Decrease value",
    incrementLabel = "Increase value",
  },
  ref,
) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;

  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      status={status}
      counter={counter}
      required={required}
      hideLabel={hideLabel}
      htmlFor={inputId}
    >
      <NumberFieldPrimitive.Root
        id={inputId}
        name={name}
        form={form}
        value={value}
        defaultValue={defaultValue}
        onValueChange={(nextValue) => onValueChange?.(nextValue)}
        min={min}
        max={max}
        step={step}
        required={required}
        disabled={disabled}
        readOnly={readOnly}
      >
        <NumberFieldControlGroup
          error={error}
          disabledChrome={disabled}
          decrementLabel={decrementLabel}
          incrementLabel={incrementLabel}
          inputRef={ref}
          inputProps={{
            placeholder,
            "aria-describedby": fieldDescribedBy({ inputId, description, error, status, counter }),
            "aria-invalid": !!error || undefined,
          }}
        />
      </NumberFieldPrimitive.Root>
    </FieldChrome>
  );
});
NumberField.displayName = "NumberField";

// ─── CurrencyInput ───────────────────────────────────────────────────────────
//
// Rebuilt on the same Base UI Number Field primitive as `NumberField` so the
// design system ships a single numeric-input engine (issue #3846). The old
// `type="number"` implementation had three separate bugs: the browser scrolls
// the value on wheel-over, the native parser rejects locale decimal separators
// ("24,99" in most of the EU), and stray characters ("e", "+") are accepted by
// the underlying <input type=number> grammar. Base UI's Number Field renders a
// text input (no wheel-scrub unless explicitly opted in, which we don't) and
// parses/formats through `Intl.NumberFormat`, which fixes all three for free.
//
// The public value contract is a canonical decimal-string amount (e.g.
// "24.99"), matching `@chase-sets/primitives/money` and the `formatMoney`
// display convention — never a bare `number`, so no consumer ever derives a
// stored amount by float arithmetic. Base UI's internal value is a `number`
// (required by its keyboard/stepper interactions); the boundary conversions
// below always go through the BigInt cent parsers, never `parseFloat`.
//
// The currency symbol and its placement (prefix or suffix — most locales lead
// with the symbol, several European locales trail it) are derived from
// `currencyCode`/`locale` via `Intl.NumberFormat(...).formatToParts`, and
// rendered as normal in-flow flex content next to the input (see
// `NumberFieldControlGroup`'s `prefixAdornment`/`suffixAdornment`) rather than
// an absolutely-positioned overlay with a padding class sized for one
// character — so there is no hardcoded "$" and no symbol-width assumption to
// keep in sync with the currency. Decimal-separator parsing goes through the
// same `locale` prop on the Number Field root.

function parseAmountCents(amount: string, allowNegative: boolean): bigint | null {
  return allowNegative ? trySignedMoneyToCents(amount) : tryMoneyToCents(amount);
}

function amountToFieldNumber(amount: string | null | undefined, allowNegative: boolean): number | null | undefined {
  if (amount === undefined) {
    return undefined;
  }
  if (amount === null || amount.trim() === "") {
    return null;
  }
  const cents = parseAmountCents(amount, allowNegative);
  return cents === null ? null : Number(cents) / 100;
}

function fieldNumberToAmount(value: number | null, allowNegative: boolean): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  const cents = BigInt(Math.round(value * 100));
  try {
    return allowNegative ? centsToSignedMoneyAmount(cents) : centsToMoneyAmount(cents);
  } catch {
    // Out-of-bounds cent value (beyond MONEY_AMOUNT_MAX) — treat as unparseable
    // rather than emit a value the money primitive would reject downstream.
    return null;
  }
}

function stepToFieldNumber(step: string): number {
  const cents = tryMoneyToCents(step);
  return cents === null ? 1 : Number(cents) / 100;
}

const MONEY_AMOUNT_MAX_MAJOR_UNITS = Number(MONEY_AMOUNT_MAX_CENTS) / 100;

type CurrencyAffix = Readonly<{ symbol: string; position: "prefix" | "suffix" }>;

function currencyAffix(currencyCode: string, locale: string | undefined): CurrencyAffix {
  const code = currencyCode.toUpperCase();
  try {
    const parts = new Intl.NumberFormat(locale, { style: "currency", currency: code }).formatToParts(0);
    const currencyIndex = parts.findIndex((part) => part.type === "currency");
    const firstDigitIndex = parts.findIndex((part) => part.type === "integer");
    const symbol = parts[currencyIndex]?.value ?? code;

    if (currencyIndex === -1 || firstDigitIndex === -1) {
      return { symbol, position: "prefix" };
    }

    return { symbol, position: currencyIndex < firstDigitIndex ? "prefix" : "suffix" };
  } catch {
    return { symbol: code, position: "prefix" };
  }
}

export interface CurrencyInputProps extends BaseInputProps {
  name?: string;
  form?: string;
  /**
   * ISO 4217 currency code (for example "USD", "eur"). Drives the displayed
   * symbol, decimal separator, and accessible currency name — every currency
   * this renders is derived from this code, never hardcoded.
   */
  currencyCode: string;
  /** Controlled canonical decimal-string amount (for example "24.99"). Pass `null` for an empty field. */
  value?: string | null;
  /** Uncontrolled initial canonical decimal-string amount. */
  defaultValue?: string;
  /**
   * Canonical decimal-string amount, or `null` when the field is empty or
   * unparseable. Always derived from the `@chase-sets/primitives/money`
   * BigInt-cent parsers — never a float round-trip of the displayed value.
   */
  onValueChange?: (value: string | null) => void;
  /** Minimum amount as a canonical decimal string. Defaults to `"0"` unless `allowNegative` is set. */
  min?: string;
  /** Maximum amount as a canonical decimal string. Defaults to the money primitive's max. */
  max?: string;
  /** Increment/decrement step as a decimal string. @default "0.01" */
  step?: string;
  /** Allow negative amounts (credits, adjustments). @default false */
  allowNegative?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  /** BCP 47 locale for symbol placement and decimal-separator parsing. Defaults to the runtime locale. */
  locale?: string;
  /** Fully localized accessible description for the currency amount. */
  currencyAccessibleDescription?: ReactNode;
  decrementLabel?: string;
  incrementLabel?: string;
  "aria-label"?: string;
}

export const CurrencyInput = forwardRef<HTMLInputElement, CurrencyInputProps>(function CurrencyInput(
  {
    id,
    label,
    description,
    error,
    status,
    counter,
    required,
    hideLabel,
    name,
    form,
    currencyCode,
    value,
    defaultValue,
    onValueChange,
    min,
    max,
    step = "0.01",
    allowNegative = false,
    disabled = false,
    readOnly = false,
    placeholder,
    locale,
    currencyAccessibleDescription,
    decrementLabel = "Decrease amount",
    incrementLabel = "Increase amount",
    "aria-label": ariaLabel,
  },
  ref,
) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const resolvedCurrencyDescription = (
    <>
      {description}
      {currencyAccessibleDescription ? <VisuallyHidden>{currencyAccessibleDescription}</VisuallyHidden> : null}
    </>
  );
  const minNumber =
    min !== undefined ? (amountToFieldNumber(min, allowNegative) ?? undefined) : allowNegative ? undefined : 0;
  const maxNumber =
    max !== undefined ? (amountToFieldNumber(max, allowNegative) ?? undefined) : MONEY_AMOUNT_MAX_MAJOR_UNITS;
  const affix = currencyAffix(currencyCode, locale);

  return (
    <FieldChrome
      label={label}
      description={resolvedCurrencyDescription}
      error={error}
      status={status}
      counter={counter}
      required={required}
      hideLabel={hideLabel}
      htmlFor={inputId}
    >
      <NumberFieldPrimitive.Root
        id={inputId}
        name={name}
        form={form}
        locale={locale}
        format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }}
        value={amountToFieldNumber(value, allowNegative)}
        defaultValue={
          defaultValue !== undefined ? (amountToFieldNumber(defaultValue, allowNegative) ?? undefined) : undefined
        }
        onValueChange={(nextValue) => onValueChange?.(fieldNumberToAmount(nextValue, allowNegative))}
        min={minNumber}
        max={maxNumber}
        step={stepToFieldNumber(step)}
        required={required}
        disabled={disabled}
        readOnly={readOnly}
      >
        <NumberFieldControlGroup
          error={error}
          disabledChrome={disabled}
          decrementLabel={decrementLabel}
          incrementLabel={incrementLabel}
          prefixAdornment={affix.position === "prefix" ? affix.symbol : undefined}
          suffixAdornment={affix.position === "suffix" ? affix.symbol : undefined}
          inputRef={ref}
          inputProps={{
            placeholder,
            inputMode: "decimal",
            "aria-label": ariaLabel,
            "aria-describedby": fieldDescribedBy({
              inputId,
              description: resolvedCurrencyDescription,
              error,
              status,
              counter,
            }),
            "aria-invalid": !!error || undefined,
          }}
        />
      </NumberFieldPrimitive.Root>
    </FieldChrome>
  );
});
CurrencyInput.displayName = "CurrencyInput";
