import {
  forwardRef,
  type AnchorHTMLAttributes,
  type ElementType,
  type HTMLAttributes,
  type ImgHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import { Icon, type IconName } from "../icons";
import type { ResponsiveValue } from "../theme/tokens";
import { cx } from "../utils/cx";
import {
  resolveResponsiveClass,
  resolveTextAlignClass,
  resolveTruncateClass,
  type TextAlignValue,
} from "../utils/system";
import { AspectRatio, Center, Surface } from "./layout";
import type { PolymorphicPrimitive, PolymorphicProps } from "./polymorphic";
import type { Tone } from "../components/feedback/shared";

type TextElement = "p" | "span" | "strong" | "em" | "div";

type FrameProps = Omit<HTMLAttributes<HTMLElement>, "className" | "style">;
type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

const textSizeClasses = {
  "3xs": "text-3xs",
  "2xs": "text-2xs",
  xs: "text-xs",
  sm: "text-sm",
  md: "text-base",
  lg: "text-lg",
} as const;

type TextSize = keyof typeof textSizeClasses;

const responsiveTextSizeClasses: Record<TextSize, Record<"base" | "sm" | "md" | "lg" | "xl" | "2xl", string>> = {
  "3xs": {
    base: "text-3xs",
    sm: "sm:text-3xs",
    md: "md:text-3xs",
    lg: "lg:text-3xs",
    xl: "xl:text-3xs",
    "2xl": "2xl:text-3xs",
  },
  "2xs": {
    base: "text-2xs",
    sm: "sm:text-2xs",
    md: "md:text-2xs",
    lg: "lg:text-2xs",
    xl: "xl:text-2xs",
    "2xl": "2xl:text-2xs",
  },
  xs: {
    base: "text-xs",
    sm: "sm:text-xs",
    md: "md:text-xs",
    lg: "lg:text-xs",
    xl: "xl:text-xs",
    "2xl": "2xl:text-xs",
  },
  sm: {
    base: "text-sm",
    sm: "sm:text-sm",
    md: "md:text-sm",
    lg: "lg:text-sm",
    xl: "xl:text-sm",
    "2xl": "2xl:text-sm",
  },
  md: {
    base: "text-base",
    sm: "sm:text-base",
    md: "md:text-base",
    lg: "lg:text-base",
    xl: "xl:text-base",
    "2xl": "2xl:text-base",
  },
  lg: {
    base: "text-lg",
    sm: "sm:text-lg",
    md: "md:text-lg",
    lg: "lg:text-lg",
    xl: "xl:text-lg",
    "2xl": "2xl:text-lg",
  },
};

function resolveTextSizeClass(value: ResponsiveValue<TextSize>): string {
  return resolveResponsiveClass(value, responsiveTextSizeClasses);
}

const textWeightClasses = {
  regular: "font-normal",
  medium: "font-medium",
  semibold: "font-semibold",
  bold: "font-bold",
} as const;

const textToneClasses = {
  primary: "text-foreground",
  secondary: "text-secondary",
  tertiary: "text-tertiary",
  inverse: "text-inverse",
  accent: "text-accent",
  danger: "text-danger",
  /** Inherit the surrounding color (e.g. a tonal `Surface`) instead of forcing one. */
  inherit: "text-current",
} as const;

const lineClampClasses = {
  1: "line-clamp-1",
  2: "line-clamp-2",
  3: "line-clamp-3",
  4: "line-clamp-4",
  5: "line-clamp-5",
  6: "line-clamp-6",
} as const;

export interface TextOwnProps {
  children?: ReactNode;
  element?: TextElement;
  size?: ResponsiveValue<TextSize>;
  tone?: keyof typeof textToneClasses;
  weight?: keyof typeof textWeightClasses;
  align?: TextAlignValue;
  /** Truncate to a single line with an ellipsis. Accepts a per-breakpoint object (e.g. `{ base: true, md: false }`) to scope truncation to narrow viewports and preserve wrapping above a breakpoint. */
  truncate?: ResponsiveValue<boolean>;
  wrap?: "normal" | "break" | "anywhere";
  /** Clamp to a fixed number of lines, adding an ellipsis when content overflows. */
  lineClamp?: keyof typeof lineClampClasses;
}

export type TextProps<TTarget extends ElementType = "p"> = PolymorphicProps<TTarget, TextOwnProps>;

export const Text = forwardRef(function Text(
  {
    children,
    as,
    render,
    element = "p",
    size = "md",
    tone = "primary",
    weight = "regular",
    align,
    truncate = false,
    wrap = "normal",
    lineClamp,
    ...rest
  }: TextProps<ElementType>,
  ref: Ref<unknown>,
) {
  const Component = (as ?? render ?? element) as ElementType;

  return (
    <Component
      {...rest}
      ref={ref}
      className={cx(
        "leading-relaxed",
        resolveTextSizeClass(size),
        textToneClasses[tone],
        textWeightClasses[weight],
        resolveTextAlignClass(align),
        resolveTruncateClass(truncate),
        wrap === "break" && "break-words",
        wrap === "anywhere" && "break-words [overflow-wrap:anywhere]",
        lineClamp && lineClampClasses[lineClamp],
      )}
    >
      {children}
    </Component>
  );
}) as PolymorphicPrimitive<TextOwnProps, "p">;

export interface HeadingProps extends FrameProps {
  children?: ReactNode;
  level?: HeadingLevel;
  visualSize?: HeadingLevel;
  align?: TextAlignValue;
  visuallyHidden?: boolean;
  /** Balance line lengths (`text-wrap: balance`) so short multi-line headings break evenly. */
  balance?: boolean;
}

const headingClasses: Record<HeadingLevel, string> = {
  1: "font-display text-4xl font-semibold leading-tight tracking-label md:text-5xl md:leading-display",
  2: "font-heading text-3xl font-semibold leading-tight md:text-4xl md:leading-tight",
  3: "font-heading text-2xl font-semibold leading-snug md:text-3xl md:leading-tight",
  4: "font-heading text-xl font-semibold leading-snug md:text-2xl md:leading-snug",
  5: "font-heading text-lg font-semibold leading-snug",
  6: "font-heading text-base font-semibold leading-snug",
};

export function Heading({
  children,
  level = 2,
  visualSize = level,
  align,
  balance = false,
  visuallyHidden = false,
  ...rest
}: HeadingProps) {
  const Component = `h${level}` as const;

  return (
    <Component
      {...rest}
      className={cx(
        headingClasses[visualSize],
        resolveTextAlignClass(align),
        balance && "text-balance",
        visuallyHidden && "sr-only",
      )}
    >
      {children}
    </Component>
  );
}

export interface SubheadingProps extends FrameProps {
  children?: ReactNode;
  level?: 2 | 3 | 4 | 5 | 6;
  align?: TextAlignValue;
}

export function Subheading({ children, level = 3, align, ...rest }: SubheadingProps) {
  const Component = `h${level}` as const;

  return (
    <Component
      {...rest}
      className={cx("text-sm font-semibold leading-snug text-foreground", resolveTextAlignClass(align))}
    >
      {children}
    </Component>
  );
}

export interface EyebrowProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
  variant?: "accent" | "primary";
}

const eyebrowVariantClasses: Record<NonNullable<EyebrowProps["variant"]>, string> = {
  accent: "text-xs font-semibold uppercase text-accent",
  primary: "text-xs font-semibold uppercase tracking-wide text-primary",
};

export function Eyebrow({ children, variant = "accent", ...rest }: EyebrowProps) {
  return (
    <div {...rest} className={eyebrowVariantClasses[variant]}>
      {children}
    </div>
  );
}

export interface LabelProps extends Omit<LabelHTMLAttributes<HTMLLabelElement>, "className" | "style"> {
  muted?: boolean;
  size?: "2xs" | "xs" | "sm";
}

const labelSizeClasses: Record<NonNullable<LabelProps["size"]>, string> = {
  "2xs": "text-2xs",
  xs: "text-xs",
  sm: "text-sm",
};

export function Label({ muted = false, size = "sm", ...rest }: LabelProps) {
  return (
    <label
      {...rest}
      className={cx("font-medium tracking-label", labelSizeClasses[size], muted ? "text-secondary" : "text-foreground")}
    />
  );
}

export type CaptionProps<TTarget extends ElementType = "p"> = TextProps<TTarget>;

export function Caption<TTarget extends ElementType = "p">(props: CaptionProps<TTarget>) {
  return <Text {...props} size={props.size ?? "2xs"} tone={props.tone ?? "secondary"} />;
}

export interface DiscountValueProps extends Omit<HTMLAttributes<HTMLSpanElement>, "className" | "style"> {
  original: ReactNode;
  current: ReactNode;
}

export function DiscountValue({ original, current, ...rest }: DiscountValueProps) {
  return (
    <span {...rest} className="inline-flex flex-wrap justify-end gap-x-1">
      <s className="text-danger decoration-danger">{original}</s>
      <span className="text-trust">{current}</span>
    </span>
  );
}

export interface InlineTextGroupProps extends Omit<HTMLAttributes<HTMLSpanElement>, "className" | "style"> {
  children?: ReactNode;
  gap?: 1 | 2 | 3;
  align?: "start" | "center" | "end";
}

const inlineTextGroupGapClasses: Record<NonNullable<InlineTextGroupProps["gap"]>, string> = {
  1: "gap-1",
  2: "gap-2",
  3: "gap-3",
};

const inlineTextGroupAlignClasses: Record<NonNullable<InlineTextGroupProps["align"]>, string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
};

export function InlineTextGroup({ children, gap = 2, align = "center", ...rest }: InlineTextGroupProps) {
  return (
    <span
      {...rest}
      className={cx("inline-flex flex-wrap", inlineTextGroupGapClasses[gap], inlineTextGroupAlignClasses[align])}
    >
      {children}
    </span>
  );
}

type LinkTextTone = Extract<Tone, "accent" | "neutral">;

export interface LinkTextProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "style"> {
  tone?: LinkTextTone;
  trailingIcon?: IconName;
  /**
   * Grow the hit area to the 44px touch-target guideline on coarse pointers
   * (touchscreens) via the `pointer-coarse` media variant, without affecting
   * mouse/trackpad sizing or requiring a JS media-query check.
   */
  touchTarget?: boolean;
}

export function LinkText({ children, tone = "accent", trailingIcon, touchTarget = false, ...rest }: LinkTextProps) {
  return (
    <a
      {...rest}
      className={cx(
        "focus-ring inline-flex items-center gap-2 rounded-tokenSm font-medium underline-offset-4",
        touchTarget &&
          "pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center pointer-coarse:px-2 pointer-coarse:py-2",
        tone === "accent"
          ? "text-accent hover:text-foreground hover:underline"
          : "text-secondary hover:text-foreground hover:underline",
      )}
    >
      <span>{children}</span>
      {trailingIcon ? <Icon name={trailingIcon} size="sm" /> : null}
    </a>
  );
}

export interface ListProps extends FrameProps {
  items: ReactNode[];
  ordered?: boolean;
}

export function List({ items, ordered = false, ...rest }: ListProps) {
  const Component = ordered ? "ol" : "ul";

  return (
    <Component
      {...rest}
      className={cx("space-y-2 pl-5 text-sm leading-relaxed text-secondary", ordered ? "list-decimal" : "list-disc")}
    >
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </Component>
  );
}

export interface QuoteProps extends FrameProps {
  children?: ReactNode;
  cite?: ReactNode;
}

export function Quote({ children, cite, ...rest }: QuoteProps) {
  return (
    <blockquote {...rest} className="modern-surface rounded-tokenLg border-l-tokenLg border-accent px-5 py-4">
      <Text size="md" weight="medium">
        {children}
      </Text>
      {cite ? (
        <Text element="div" size="xs" tone="secondary">
          {cite}
        </Text>
      ) : null}
    </blockquote>
  );
}

export interface AvatarProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "className" | "style"> {
  name: string;
  size?: "sm" | "md" | "lg";
  src?: string;
}

const avatarSizeClasses: Record<NonNullable<AvatarProps["size"]>, string> = {
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-14 w-14 text-base",
};

function initials(value: string): string {
  return value
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function Avatar({ name, size = "md", src, alt, ...rest }: AvatarProps) {
  if (src) {
    return (
      <img
        {...rest}
        alt={alt ?? name}
        src={src}
        className={cx("rounded-tokenFull border border-muted object-cover shadow-tokenSm", avatarSizeClasses[size])}
      />
    );
  }

  return (
    <div aria-label={alt ?? name}>
      <div
        className={cx(
          "inline-flex items-center justify-center rounded-tokenFull border border-muted bg-background font-semibold text-secondary shadow-tokenSm",
          avatarSizeClasses[size],
        )}
      >
        {initials(name)}
      </div>
    </div>
  );
}

export interface ThumbnailProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "className" | "style"> {
  src?: string;
  alt: string;
  ratio?: number;
  icon?: IconName;
}

export function Thumbnail({ src, alt, ratio = 1, icon = "package", ...rest }: ThumbnailProps) {
  return (
    <Surface padding={0} elevated>
      <AspectRatio ratio={ratio}>
        {src ? (
          <img {...rest} alt={alt} src={src} className="h-full w-full rounded-tokenLg object-cover" />
        ) : (
          <Center>
            <div className="flex h-full w-full items-center justify-center bg-background">
              <Icon name={icon} size="lg" tone="secondary" />
            </div>
          </Center>
        )}
      </AspectRatio>
    </Surface>
  );
}

export interface EmptyStateIllustrationProps extends FrameProps {
  title?: string;
}

export function EmptyStateIllustration({ title = "No results yet", ...rest }: EmptyStateIllustrationProps) {
  return (
    <div {...rest} className="w-full">
      <AspectRatio ratio={16 / 9}>
        <div className="flex h-full w-full items-center justify-center rounded-tokenLg border border-dashed border-muted bg-background">
          <div className="space-y-3 text-center">
            <Center>
              <Icon name="spark" size="lg" tone="accent" />
            </Center>
            <Caption>{title}</Caption>
          </div>
        </div>
      </AspectRatio>
    </div>
  );
}
