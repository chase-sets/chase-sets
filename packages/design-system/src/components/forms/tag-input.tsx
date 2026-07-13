import { forwardRef, useId, useState, type KeyboardEvent } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { FieldChrome, compoundControlClass, controlErrorClass, fieldDescribedBy, type BaseInputProps } from "./shared";

export interface TagInputProps extends BaseInputProps {
  name?: string;
  form?: string;
  values: string[];
  onValuesChange?: (values: string[]) => void;
  placeholder?: string;
  maxTags?: number;
}

export const TagInput = forwardRef<HTMLInputElement, TagInputProps>(function TagInput(
  {
    id,
    name,
    form,
    label,
    description,
    error,
    status,
    counter,
    required,
    hideLabel,
    values,
    onValuesChange,
    placeholder = "Add a tag\u2026",
    maxTags,
  },
  ref,
) {
  const [input, setInput] = useState("");
  const fallbackId = useId();
  const inputId = id ?? fallbackId;

  function addTag(raw: string) {
    const tag = raw.trim();
    if (!tag) return;
    if (values.includes(tag)) return;
    if (maxTags !== undefined && values.length >= maxTags) return;
    onValuesChange?.([...values, tag]);
    setInput("");
  }

  function removeTag(tag: string) {
    onValuesChange?.(values.filter((v) => v !== tag));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTag(input);
    } else if (event.key === "Backspace" && input === "" && values.length > 0) {
      removeTag(values[values.length - 1]);
    }
  }

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
      {name ? values.map((tag) => <input key={tag} type="hidden" name={name} form={form} value={tag} />) : null}
      <div className={cx(compoundControlClass, !!error && controlErrorClass, "flex flex-wrap items-center gap-2")}>
        {values.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1.5 rounded-tokenFull border border-muted bg-background px-2.5 py-0.5 text-xs font-semibold text-foreground"
          >
            <span>{tag}</span>
            <button
              type="button"
              className="focus-ring rounded-tokenFull"
              onClick={() => removeTag(tag)}
              aria-label={`Remove ${tag}`}
            >
              <Icon name="close" size="sm" tone="secondary" />
            </button>
          </span>
        ))}
        <input
          id={inputId}
          ref={ref}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => addTag(input)}
          placeholder={values.length === 0 ? placeholder : undefined}
          aria-describedby={fieldDescribedBy({ inputId, description, error, status, counter })}
          aria-invalid={!!error || undefined}
          className="min-w-20 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-secondary"
        />
      </div>
    </FieldChrome>
  );
});
TagInput.displayName = "TagInput";
