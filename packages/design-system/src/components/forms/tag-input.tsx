import { useId, useState, type KeyboardEvent } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { FieldChrome, controlClass, controlErrorClass, fieldHintId, type BaseInputProps } from "./shared";

export interface TagInputProps extends BaseInputProps {
  values: string[];
  onValuesChange?: (values: string[]) => void;
  placeholder?: string;
  maxTags?: number;
}

export function TagInput({
  label,
  description,
  error,
  required,
  hideLabel,
  values,
  onValuesChange,
  placeholder = "Add a tag\u2026",
  maxTags,
}: TagInputProps) {
  const [input, setInput] = useState("");
  const inputId = useId();

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
      required={required}
      hideLabel={hideLabel}
      htmlFor={inputId}
    >
      <div className={cx(controlClass, !!error && controlErrorClass, "flex flex-wrap gap-2 px-3 py-2")}>
        {values.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1.5 rounded-full border border-muted bg-background px-2.5 py-0.5 text-xs font-semibold text-foreground"
          >
            <span>{tag}</span>
            <button
              type="button"
              className="focus-ring rounded-full"
              onClick={() => removeTag(tag)}
              aria-label={`Remove ${tag}`}
            >
              <Icon name="close" size="sm" tone="secondary" />
            </button>
          </span>
        ))}
        <input
          id={inputId}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => addTag(input)}
          placeholder={values.length === 0 ? placeholder : undefined}
          aria-describedby={error || description ? fieldHintId(inputId) : undefined}
          aria-invalid={!!error || undefined}
          className="min-w-20 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-secondary"
        />
      </div>
    </FieldChrome>
  );
}
