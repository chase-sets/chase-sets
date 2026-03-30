import { type HTMLAttributes, type ReactNode } from "react";

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
