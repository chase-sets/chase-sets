import { type HTMLAttributes, type ReactNode } from "react";
import { Fieldset as BaseFieldset } from "@base-ui/react/fieldset";
import { Stack, Surface } from "../../primitives/layout";

export interface FieldsetProps extends Omit<HTMLAttributes<HTMLFieldSetElement>, "className" | "style"> {
  legend: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}

export function Fieldset({ legend, description, children, ...rest }: FieldsetProps) {
  return (
    <Surface as={BaseFieldset.Root} tone="subtle" {...rest}>
      <Stack gap={4}>
        <Stack gap={1}>
          <BaseFieldset.Legend className="text-sm font-semibold text-foreground">{legend}</BaseFieldset.Legend>
          {description ? <div className="text-xs text-secondary">{description}</div> : null}
        </Stack>
        {children}
      </Stack>
    </Surface>
  );
}

export interface FormSectionProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "title"> {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}

export function FormSection({ title, description, children, ...rest }: FormSectionProps) {
  return (
    <Surface as="section" {...rest}>
      <Stack gap={4}>
        <Stack gap={1}>
          <h3 className="font-heading text-lg font-semibold text-foreground">{title}</h3>
          {description ? <div className="text-sm text-secondary">{description}</div> : null}
        </Stack>
        {children}
      </Stack>
    </Surface>
  );
}
