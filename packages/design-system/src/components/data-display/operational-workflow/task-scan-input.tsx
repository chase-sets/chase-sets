import { type FormEvent, type ReactNode } from "react";
import { cx } from "../../../utils/cx";
import { Grid } from "../../../primitives/layout";
import { Button } from "../../actions/button";
import { Form, type FormProps } from "../../forms/form";
import { SearchInput } from "../../forms/text-input";
import type { Tone } from "../../feedback/shared";

type TaskScanInputFeedbackTone = Exclude<Tone, "neutral" | "accent">;

export interface TaskScanInputProps extends Omit<
  FormProps,
  "autoFocus" | "children" | "className" | "onSubmit" | "style"
> {
  label: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  buttonLabel: ReactNode;
  description?: ReactNode;
  feedback?: ReactNode;
  feedbackTone?: TaskScanInputFeedbackTone;
  disabled?: boolean;
  autoFocus?: boolean;
}

const feedbackToneClass: Record<NonNullable<TaskScanInputProps["feedbackTone"]>, string> = {
  info: "text-secondary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

/**
 * Task scan input: a search field paired with a confirm action that lets an
 * operator scan or look up a line item by code, order line, product, or title,
 * with inline feedback on the match result.
 */
export function TaskScanInput({
  label,
  value,
  onValueChange,
  onSubmit,
  placeholder,
  buttonLabel,
  description,
  feedback,
  feedbackTone = "info",
  disabled = false,
  autoFocus = false,
  ...rest
}: TaskScanInputProps) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(value);
  }

  return (
    <Form
      {...rest}
      disabled={disabled}
      spacing="sm"
      className="rounded-tokenMd border border-muted bg-elevated p-3"
      onSubmit={handleSubmit}
    >
      <Grid templateColumns="minmax(0,1fr) auto" stackUntil="md" gap={2} align="end">
        <SearchInput
          label={label}
          description={description}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          placeholder={placeholder}
          onChange={(event) => onValueChange(event.currentTarget.value)}
        />
        <Button type="submit" tone="secondary" leadingIcon="check" disabled={disabled || value.trim().length === 0}>
          {buttonLabel}
        </Button>
      </Grid>
      {feedback ? <p className={cx("text-xs leading-5", feedbackToneClass[feedbackTone])}>{feedback}</p> : null}
    </Form>
  );
}
