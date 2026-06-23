import type { HTMLAttributes, ReactNode } from "react";
import { motion } from "motion/react";
import { useChaseMotion } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { toMotionDomProps } from "../../utils/motion-props";

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
  media?: ReactNode;
  interactive?: boolean;
  variant?: "default" | "product" | "feature" | "stat";
  glow?: boolean;
  overflow?: "hidden" | "visible";
}

function CardSurface({
  children,
  media,
  interactive = false,
  variant = "default",
  glow = false,
  overflow = "hidden",
  ...rest
}: CardProps) {
  const motionSettings = useChaseMotion();
  const interactiveMotion =
    interactive && !motionSettings.reducedMotion
      ? {
          whileHover: { y: motionSettings.interactiveLift, scale: motionSettings.interactiveScale },
          whileTap: { y: 0, scale: 0.99 },
          transition: { duration: motionSettings.durations.base, ease: motionSettings.easing },
        }
      : undefined;
  const nativeProps = toMotionDomProps(rest);

  return (
    <motion.div
      {...nativeProps}
      {...interactiveMotion}
      className={cx(
        "glass-surface rounded-tokenLg border border-muted shadow-tokenSm",
        overflow === "visible" ? "overflow-visible" : "overflow-hidden",
        variant === "product" && "bg-surface",
        variant === "feature" && "bg-surface-2",
        variant === "stat" && "bg-surface-2",
        interactive && "cursor-pointer transition hover:border-accent hover:shadow-tokenMd",
        glow && "glow-accent",
        !media && "p-4",
      )}
    >
      {media ? (
        <>
          <div>{media}</div>
          <div className="p-4">{children}</div>
        </>
      ) : (
        children
      )}
    </motion.div>
  );
}

export interface CardHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
}

function CardHeader({ children, ...rest }: CardHeaderProps) {
  return (
    <div {...rest} className="mb-4 grid gap-1.5">
      {children}
    </div>
  );
}

export interface CardTitleProps extends Omit<HTMLAttributes<HTMLHeadingElement>, "className" | "style"> {
  children?: ReactNode;
}

function CardTitle({ children, ...rest }: CardTitleProps) {
  return (
    <h3 {...rest} className="font-heading text-balance text-xl font-semibold leading-tight text-foreground">
      {children}
    </h3>
  );
}

export interface CardDescriptionProps extends Omit<HTMLAttributes<HTMLParagraphElement>, "className" | "style"> {
  children?: ReactNode;
}

function CardDescription({ children, ...rest }: CardDescriptionProps) {
  return (
    <p {...rest} className="text-sm leading-6 text-secondary">
      {children}
    </p>
  );
}

export interface CardBodyProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
}

function CardBody({ children, ...rest }: CardBodyProps) {
  return (
    <div {...rest} className="grid gap-4">
      {children}
    </div>
  );
}

export interface CardFooterProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
}

function CardFooter({ children, ...rest }: CardFooterProps) {
  return (
    <div {...rest} className="mt-6 flex flex-wrap items-center gap-2">
      {children}
    </div>
  );
}

/**
 * Canonical card surface with a compound slot API.
 *
 * Use the `media`/`children` props for the closed media-over-body layout, or
 * compose `Card.Header`, `Card.Title`, `Card.Description`, `Card.Body`, and
 * `Card.Footer` for header/body/footer structure. The compound slots mirror the
 * compat `Card`/`CardHeader`/`CardTitle`/`CardContent`/`CardFooter` ergonomics so
 * commerce surfaces can migrate off the compat dialect with a mechanical swap.
 */
export const Card = Object.assign(CardSurface, {
  Header: CardHeader,
  Title: CardTitle,
  Description: CardDescription,
  Body: CardBody,
  Footer: CardFooter,
});

export interface DetailPanelProps extends Omit<CardProps, "title"> {
  title: ReactNode;
  actions?: ReactNode;
}

export function DetailPanel({ title, actions, children, ...rest }: DetailPanelProps) {
  return (
    <Card {...rest}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="font-heading text-lg font-semibold text-foreground">{title}</div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children != null ? <div className="space-y-4">{children}</div> : null}
    </Card>
  );
}
