import {
  useId,
  useState,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes
} from "react";
import type { CheckedState } from "@radix-ui/react-checkbox";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as SliderPrimitive from "@radix-ui/react-slider";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { Icon } from "../icons";
import { usePortalRoots } from "../theme/provider";
import { cx } from "../utils/cx";

export interface FieldChromeProps {
  label?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  hideLabel?: boolean;
}

interface FieldFrameProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style">,
    FieldChromeProps {
  htmlFor?: string;
  children?: ReactNode;
}

const controlClass =
  "focus-ring touch-target w-full rounded-tokenMd border border-border bg-elevated px-4 py-3 text-sm text-foreground shadow-tokenSm placeholder:text-secondary transition disabled:cursor-not-allowed disabled:opacity-60";

function FieldChrome({
  label,
  description,
  error,
  required = false,
  hideLabel = false,
  htmlFor,
  children,
  ...rest
}: FieldFrameProps) {
  return (
    <div {...rest} className="space-y-2">
      {label ? (
        <label
          htmlFor={htmlFor}
          className={cx(
            "block text-sm font-medium text-foreground",
            hideLabel && "sr-only"
          )}
        >
          {label}
          {required ? <span className="ml-1 text-accent">*</span> : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <div className="text-xs font-medium text-danger">{error}</div>
      ) : description ? (
        <div className="text-xs text-secondary">{description}</div>
      ) : null}
    </div>
  );
}

export interface FieldProps extends FieldFrameProps {}

export function Field(props: FieldProps) {
  return <FieldChrome {...props} />;
}

export interface HelperTextProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
  tone?: "default" | "danger" | "success";
}

export function HelperText({
  children,
  tone = "default",
  ...rest
}: HelperTextProps) {
  return (
    <div
      {...rest}
      className={cx(
        "text-xs",
        tone === "default" && "text-secondary",
        tone === "danger" && "text-danger",
        tone === "success" && "text-success"
      )}
    >
      {children}
    </div>
  );
}

export interface InlineMessageProps extends HelperTextProps {
  icon?: "info" | "warning" | "check";
}

export function InlineMessage({
  children,
  icon = "info",
  tone = "default",
  ...rest
}: InlineMessageProps) {
  return (
    <div
      {...rest}
      className={cx(
        "flex items-start gap-2 rounded-tokenMd border px-3 py-2 text-sm",
        tone === "default" && "border-info bg-background text-info",
        tone === "danger" && "border-danger bg-background text-danger",
        tone === "success" && "border-success bg-background text-success"
      )}
    >
      <Icon name={icon} size="sm" tone={tone === "default" ? "info" : tone} />
      <span>{children}</span>
    </div>
  );
}

export interface FieldsetProps
  extends Omit<HTMLAttributes<HTMLFieldSetElement>, "className" | "style"> {
  legend: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}

export function Fieldset({
  legend,
  description,
  children,
  ...rest
}: FieldsetProps) {
  return (
    <fieldset {...rest} className="modern-surface space-y-4 rounded-tokenLg border border-muted p-4">
      <div className="space-y-1">
        <legend className="text-sm font-semibold text-foreground">{legend}</legend>
        {description ? (
          <div className="text-xs text-secondary">{description}</div>
        ) : null}
      </div>
      {children}
    </fieldset>
  );
}

export interface FormSectionProps
  extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "title"> {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}

export function FormSection({
  title,
  description,
  children,
  ...rest
}: FormSectionProps) {
  return (
    <section {...rest} className="modern-surface space-y-4 rounded-tokenLg border border-muted p-4 shadow-tokenSm">
      <div className="space-y-1">
        <h3 className="font-heading text-lg font-semibold text-foreground">{title}</h3>
        {description ? (
          <div className="text-sm text-secondary">{description}</div>
        ) : null}
      </div>
      {children}
    </section>
  );
}

interface BaseInputProps extends FieldChromeProps {
  id?: string;
}

export interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "style" | "size">,
    BaseInputProps {}

export function TextInput({
  id,
  label,
  description,
  error,
  required,
  hideLabel,
  type = "text",
  ...rest
}: TextInputProps) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;

  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      required={required}
      hideLabel={hideLabel}
      htmlFor={inputId}
    >
      <input {...rest} id={inputId} required={required} type={type} className={controlClass} />
    </FieldChrome>
  );
}

export interface NumberInputProps extends TextInputProps {}

export function NumberInput(props: NumberInputProps) {
  return <TextInput {...props} type="number" inputMode="numeric" />;
}

export interface CurrencyInputProps extends TextInputProps {
  currencySymbol?: string;
}

export function CurrencyInput({
  id,
  label,
  description,
  error,
  required,
  hideLabel,
  currencySymbol = "$",
  ...rest
}: CurrencyInputProps) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;

  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      required={required}
      hideLabel={hideLabel}
      htmlFor={inputId}
    >
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-4 flex items-center text-secondary">
          {currencySymbol}
        </span>
        <input
          {...rest}
          id={inputId}
          required={required}
          type="number"
          inputMode="decimal"
          className={cx(controlClass, "pl-8")}
        />
      </div>
    </FieldChrome>
  );
}

export interface SearchInputProps extends TextInputProps {}

export function SearchInput({
  id,
  label = "Search",
  description,
  error,
  required,
  hideLabel,
  ...rest
}: SearchInputProps) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;

  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      required={required}
      hideLabel={hideLabel}
      htmlFor={inputId}
    >
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-4 flex items-center">
          <Icon name="search" size="sm" tone="secondary" />
        </span>
        <input
          {...rest}
          id={inputId}
          required={required}
          type="search"
          className={cx(controlClass, "pl-10")}
        />
      </div>
    </FieldChrome>
  );
}

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className" | "style">,
    BaseInputProps {}

export function Textarea({
  id,
  label,
  description,
  error,
  required,
  hideLabel,
  rows = 4,
  ...rest
}: TextareaProps) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;

  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      required={required}
      hideLabel={hideLabel}
      htmlFor={inputId}
    >
      <textarea
        {...rest}
        id={inputId}
        required={required}
        rows={rows}
        className={cx(controlClass, "min-h-28 resize-y")}
      />
    </FieldChrome>
  );
}

export interface DateInputProps extends TextInputProps {}

export function DateInput(props: DateInputProps) {
  return <TextInput {...props} type="date" />;
}

export interface SelectItem {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface SelectProps extends BaseInputProps {
  id?: string;
  items: SelectItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function Select({
  label,
  description,
  error,
  required,
  hideLabel,
  items,
  value,
  defaultValue,
  onValueChange,
  placeholder = "Choose an option",
  disabled = false
}: SelectProps) {
  const fallbackId = useId();
  const { overlayNode } = usePortalRoots();

  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      required={required}
      hideLabel={hideLabel}
      htmlFor={fallbackId}
    >
      <SelectPrimitive.Root
        value={value}
        defaultValue={defaultValue}
        onValueChange={onValueChange}
        disabled={disabled}
      >
        <SelectPrimitive.Trigger
          id={fallbackId}
          className={cx(
            controlClass,
            "inline-flex items-center justify-between gap-2 text-left"
          )}
        >
          <SelectPrimitive.Value placeholder={placeholder} />
          <SelectPrimitive.Icon>
            <Icon name="chevronDown" size="sm" tone="secondary" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal container={overlayNode ?? undefined}>
          <SelectPrimitive.Content
            position="popper"
            className="modern-surface z-popover min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-tokenLg border border-muted shadow-overlay"
          >
            <SelectPrimitive.Viewport className="p-2">
              {items.map((item) => (
                <SelectPrimitive.Item
                  key={item.value}
                  value={item.value}
                  disabled={item.disabled}
                  className="focus-ring relative flex cursor-pointer select-none items-center rounded-tokenMd px-3 py-2 text-sm text-foreground outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-background"
                >
                  <SelectPrimitive.ItemText>
                    <div className="space-y-0.5">
                      <div>{item.label}</div>
                      {item.description ? (
                        <div className="text-xs text-secondary">
                          {item.description}
                        </div>
                      ) : null}
                    </div>
                  </SelectPrimitive.ItemText>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </FieldChrome>
  );
}

export interface ComboboxProps extends BaseInputProps {
  items: SelectItem[];
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
}

export function Combobox({
  label,
  description,
  error,
  required,
  hideLabel,
  items,
  value,
  onValueChange,
  placeholder = "Search options"
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerId = useId();
  const listboxId = useId();
  const searchId = useId();
  const selected = items.find((item) => item.value === value);
  const filtered = items.filter((item) =>
    item.label.toLowerCase().includes(query.toLowerCase())
  );
  const { overlayNode } = usePortalRoots();

  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      required={required}
      hideLabel={hideLabel}
      htmlFor={triggerId}
    >
      <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
        <PopoverPrimitive.Trigger
          id={triggerId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-haspopup="listbox"
          className={cx(
            controlClass,
            "inline-flex items-center justify-between gap-2 text-left"
          )}
        >
          <span>{selected?.label ?? placeholder}</span>
          <Icon name="chevronDown" size="sm" tone="secondary" />
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal container={overlayNode ?? undefined}>
          <PopoverPrimitive.Content
            sideOffset={8}
            className="modern-surface z-popover w-[var(--radix-popover-trigger-width)] rounded-tokenLg border border-muted p-3 shadow-overlay"
          >
            <div className="space-y-3">
              <input
                id={searchId}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={placeholder}
                aria-label="Filter options"
                aria-autocomplete="list"
                aria-controls={listboxId}
                className={controlClass}
              />
              <div
                id={listboxId}
                role="listbox"
                aria-label={typeof label === "string" ? label : "Options"}
                className="max-h-60 space-y-1 overflow-y-auto"
              >
                {filtered.length === 0 ? (
                  <div className="rounded-tokenMd bg-background px-3 py-2 text-sm text-secondary">
                    No matches
                  </div>
                ) : (
                  filtered.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      role="option"
                      aria-selected={item.value === value}
                      className="focus-ring flex w-full items-center justify-between rounded-tokenMd px-3 py-2 text-left text-sm text-foreground hover:bg-background"
                      onClick={() => {
                        onValueChange?.(item.value);
                        setOpen(false);
                        setQuery("");
                      }}
                    >
                      <span>{item.label}</span>
                      {item.value === value ? (
                        <Icon name="check" size="sm" tone="accent" />
                      ) : null}
                    </button>
                  ))
                )}
              </div>
            </div>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </FieldChrome>
  );
}

export interface CheckboxProps extends BaseInputProps {
  checked?: CheckedState;
  defaultChecked?: CheckedState;
  onCheckedChange?: (checked: CheckedState) => void;
  disabled?: boolean;
}

export function Checkbox({
  label,
  description,
  error,
  required,
  hideLabel,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled = false
}: CheckboxProps) {
  const inputId = useId();

  return (
    <FieldChrome
      label={undefined}
      description={error ? undefined : description}
      error={error}
      required={required}
      hideLabel={hideLabel}
    >
      <label
        htmlFor={inputId}
        className="modern-surface flex cursor-pointer items-start gap-3 rounded-tokenMd border border-muted p-3"
      >
        <CheckboxPrimitive.Root
          id={inputId}
          checked={checked}
          defaultChecked={defaultChecked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          className="focus-ring mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-elevated data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[disabled]:opacity-60"
        >
          <CheckboxPrimitive.Indicator>
            <Icon name="check" size="sm" tone="inverse" />
          </CheckboxPrimitive.Indicator>
        </CheckboxPrimitive.Root>
        <div className="space-y-1">
          {label ? (
            <div className="text-sm font-medium text-foreground">
              {label}
              {required ? <span className="ml-1 text-accent">*</span> : null}
            </div>
          ) : null}
          {description ? <div className="text-xs text-secondary">{description}</div> : null}
        </div>
      </label>
    </FieldChrome>
  );
}

export interface CheckboxGroupProps extends BaseInputProps {
  items: SelectItem[];
  values: string[];
  onValuesChange?: (values: string[]) => void;
}

export function CheckboxGroup({
  label,
  description,
  error,
  required,
  hideLabel,
  items,
  values,
  onValuesChange
}: CheckboxGroupProps) {
  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      required={required}
      hideLabel={hideLabel}
    >
      <div className="space-y-2">
        {items.map((item) => {
          const checked = values.includes(item.value);

          return (
            <Checkbox
              key={item.value}
              label={item.label}
              description={item.description}
              checked={checked}
              onCheckedChange={(state) => {
                const next = state
                  ? [...values, item.value]
                  : values.filter((entry) => entry !== item.value);
                onValuesChange?.(Array.from(new Set(next)));
              }}
            />
          );
        })}
      </div>
    </FieldChrome>
  );
}

export interface RadioGroupProps extends BaseInputProps {
  items: SelectItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

export function RadioGroup({
  label,
  description,
  error,
  required,
  hideLabel,
  items,
  value,
  defaultValue,
  onValueChange
}: RadioGroupProps) {
  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      required={required}
      hideLabel={hideLabel}
    >
      <RadioGroupPrimitive.Root
        value={value}
        defaultValue={defaultValue}
        onValueChange={onValueChange}
        className="space-y-2"
      >
        {items.map((item) => (
          <label
            key={item.value}
            className="modern-surface flex cursor-pointer items-start gap-3 rounded-tokenMd border border-muted p-3"
          >
            <RadioGroupPrimitive.Item
              value={item.value}
              className="focus-ring mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border bg-background"
            >
              <RadioGroupPrimitive.Indicator className="h-2.5 w-2.5 rounded-full bg-accent" />
            </RadioGroupPrimitive.Item>
            <div className="space-y-1">
              <div className="text-sm font-medium text-foreground">{item.label}</div>
              {item.description ? (
                <div className="text-xs text-secondary">{item.description}</div>
              ) : null}
            </div>
          </label>
        ))}
      </RadioGroupPrimitive.Root>
    </FieldChrome>
  );
}

export interface SwitchProps extends BaseInputProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
}

export function Switch({
  label,
  description,
  error,
  required,
  hideLabel,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled = false
}: SwitchProps) {
  const inputId = useId();

  return (
    <FieldChrome
      label={undefined}
      description={error ? undefined : description}
      error={error}
      required={required}
      hideLabel={hideLabel}
    >
      <label
        htmlFor={inputId}
        className="modern-surface flex cursor-pointer items-center justify-between gap-4 rounded-tokenMd border border-muted p-3"
      >
        <div className="space-y-1">
          {label ? (
            <div className="text-sm font-medium text-foreground">
              {label}
              {required ? <span className="ml-1 text-accent">*</span> : null}
            </div>
          ) : null}
          {description ? <div className="text-xs text-secondary">{description}</div> : null}
        </div>
        <SwitchPrimitive.Root
          id={inputId}
          checked={checked}
          defaultChecked={defaultChecked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          className="focus-ring relative inline-flex h-7 w-12 items-center rounded-full bg-muted transition data-[state=checked]:bg-accent data-[disabled]:opacity-60"
        >
          <SwitchPrimitive.Thumb className="block h-5 w-5 translate-x-1 rounded-full bg-elevated shadow-tokenSm transition data-[state=checked]:translate-x-6" />
        </SwitchPrimitive.Root>
      </label>
    </FieldChrome>
  );
}

export interface SliderProps extends BaseInputProps {
  value?: number;
  defaultValue?: number;
  onValueChange?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

export function Slider({
  label,
  description,
  error,
  required,
  hideLabel,
  value,
  defaultValue,
  onValueChange,
  min = 0,
  max = 100,
  step = 1
}: SliderProps) {
  const resolvedValue = value === undefined ? undefined : [value];
  const resolvedDefault = defaultValue === undefined ? undefined : [defaultValue];

  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      required={required}
      hideLabel={hideLabel}
    >
      <div className="modern-surface space-y-2 rounded-tokenMd border border-muted p-4">
        <SliderPrimitive.Root
          min={min}
          max={max}
          step={step}
          value={resolvedValue}
          defaultValue={resolvedDefault}
          onValueChange={(values) => onValueChange?.(values[0] ?? min)}
          className="relative flex h-6 w-full items-center"
        >
          <SliderPrimitive.Track className="relative h-2 w-full rounded-full bg-muted">
            <SliderPrimitive.Range className="absolute h-full rounded-full bg-accent" />
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb className="focus-ring block h-5 w-5 rounded-full border border-accent bg-elevated shadow-tokenSm" />
        </SliderPrimitive.Root>
        <div className="flex justify-between text-xs text-secondary">
          <span>{min}</span>
          <span>{value ?? defaultValue ?? min}</span>
          <span>{max}</span>
        </div>
      </div>
    </FieldChrome>
  );
}

export interface FileDropzoneProps extends BaseInputProps {
  id?: string;
  accept?: string;
  multiple?: boolean;
  onFilesChange?: (files: FileList | null) => void;
}

export function FileDropzone({
  id,
  label,
  description,
  error,
  required,
  hideLabel,
  accept,
  multiple = false,
  onFilesChange
}: FileDropzoneProps) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const [dragging, setDragging] = useState(false);

  function handleDragOver(event: React.DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDragging(true);
  }

  function handleDragLeave(event: React.DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    onFilesChange?.(event.dataTransfer.files);
  }

  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      required={required}
      hideLabel={hideLabel}
      htmlFor={inputId}
    >
      <label
        htmlFor={inputId}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cx(
          "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-tokenLg border border-dashed bg-background px-4 py-8 text-center transition",
          dragging ? "border-accent bg-elevated" : "border-muted"
        )}
      >
        <Icon name="package" size="lg" tone="accent" />
        <div className="space-y-1">
          <div className="text-sm font-semibold text-foreground">Drop files here</div>
          <div className="text-xs text-secondary">or choose from your device</div>
        </div>
        <input
          id={inputId}
          accept={accept}
          multiple={multiple}
          required={required}
          type="file"
          className="sr-only"
          onChange={(event) => onFilesChange?.(event.target.files)}
        />
      </label>
    </FieldChrome>
  );
}
