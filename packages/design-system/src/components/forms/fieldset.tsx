import { type HTMLAttributes, type ReactNode } from "react";
import { Fieldset as BaseFieldset } from "@base-ui/react/fieldset";

export interface FieldsetProps extends Omit<HTMLAttributes<HTMLFieldSetElement>, "className" | "style"> {
  legend: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}

export function Fieldset({ legend, description, children, ...rest }: FieldsetProps) {
  return (
    <BaseFieldset.Root {...rest} className="modern-surface space-y-4 rounded-tokenLg border border-muted p-4">
      <div className="space-y-1">
        <BaseFieldset.Legend className="text-sm font-semibold text-foreground">{legend}</BaseFieldset.Legend>
        {description ? <div className="text-xs text-secondary">{description}</div> : null}
      </div>
      {children}
    </BaseFieldset.Root>
  );
}

export interface FormSectionProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "title"> {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}

export function FormSection({ title, description, children, ...rest }: FormSectionProps) {
  return (
    <section {...rest} className="modern-surface space-y-4 rounded-tokenLg border border-muted p-4 shadow-tokenSm">
      <div className="space-y-1">
        <h3 className="font-heading text-lg font-semibold text-foreground">{title}</h3>
        {description ? <div className="text-sm text-secondary">{description}</div> : null}
      </div>
      {children}
    </section>
  );
}
