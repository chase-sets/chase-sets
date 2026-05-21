import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={cn("ds-panel rounded-[var(--radius-lg)] border border-[var(--muted)] p-6", className)} />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("mb-4 grid gap-1.5", className)} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 {...props} className={cn("ds-display text-balance text-xl leading-tight", className)} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p {...props} className={cn("text-sm leading-6 text-[var(--muted-foreground)]", className)} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("grid gap-4", className)} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("mt-6 flex flex-wrap items-center gap-2", className)} />;
}
