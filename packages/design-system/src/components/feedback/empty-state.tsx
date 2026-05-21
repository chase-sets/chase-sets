import type { HTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "../../icons";

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "title"> {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: IconName;
}

export function EmptyState({ title, description, actions, icon = "spark", ...rest }: EmptyStateProps) {
  return (
    <div {...rest} className="rounded-tokenLg border border-dashed border-muted bg-background p-6 text-center">
      <div className="mx-auto flex max-w-sm flex-col items-center gap-4">
        <div className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-elevated shadow-tokenSm">
          <Icon name={icon} size="lg" tone="accent" />
        </div>
        <div className="space-y-2">
          <div className="font-heading text-xl font-semibold text-foreground">{title}</div>
          {description ? <div className="text-sm text-secondary">{description}</div> : null}
        </div>
        {actions ? <div className="flex flex-wrap justify-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
