import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

export function Page({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("grid gap-6 md:gap-8", className)} />;
}

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ eyebrow, title, description, actions, className, ...props }: PageHeaderProps) {
  return (
    <header {...props} className={cn("grid gap-4 md:grid-cols-[1fr_auto] md:items-end", className)}>
      <div className="grid max-w-3xl gap-3">
        {eyebrow ? <div className="text-xs font-semibold uppercase text-[var(--primary)]">{eyebrow}</div> : null}
        <h1 className="ds-display m-0 text-balance text-3xl leading-tight md:text-4xl">{title}</h1>
        {description ? (
          <p className="m-0 text-base leading-7 text-[var(--muted-foreground)] md:text-lg">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export interface PageSectionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function PageSection({ title, description, actions, children, className, ...props }: PageSectionProps) {
  return (
    <section {...props} className={cn("grid gap-4", className)}>
      {title || description || actions ? (
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div className="grid gap-1">
            {title ? <h2 className="ds-display m-0 text-xl md:text-2xl">{title}</h2> : null}
            {description ? <p className="m-0 text-sm leading-6 text-[var(--muted-foreground)]">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Stack({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("grid gap-4", className)} />;
}

export function Inline({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("flex flex-wrap items-center gap-2", className)} />;
}

export function Grid({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("grid gap-4", className)} />;
}

export function Surface({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={cn("ds-panel rounded-[var(--radius)] border border-[var(--border)] p-5", className)} />
  );
}

export function Divider({ className, ...props }: HTMLAttributes<HTMLHRElement>) {
  return <hr {...props} className={cn("border-[var(--muted)]", className)} />;
}

export type { PageStepperItem as StepperItem } from "../actions/page-stepper";
export { PageStepper } from "../actions/page-stepper";

export function EmptyState({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Surface className="place-items-center py-10 text-center">
      <div className="grid max-w-md gap-3">
        <h3 className="m-0 text-xl font-semibold">{title}</h3>
        {description ? <p className="m-0 text-sm text-[var(--muted-foreground)]">{description}</p> : null}
        {action ?? <Button variant="secondary">Review next step</Button>}
      </div>
    </Surface>
  );
}
