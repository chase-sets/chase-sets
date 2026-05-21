import type { AnchorHTMLAttributes, HTMLAttributes, ImgHTMLAttributes, LabelHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "../icons";
import { cx } from "../utils/cx";
import { resolveTextAlignClass, type TextAlignValue } from "../utils/system";
import { AspectRatio, Center, Surface } from "./layout";

type TextElement = "p" | "span" | "strong" | "em" | "div";

type FrameProps = Omit<HTMLAttributes<HTMLElement>, "className" | "style">;

const textSizeClasses = {
  xs: "text-xs",
  sm: "text-sm",
  md: "text-base",
  lg: "text-lg",
} as const;

const textWeightClasses = {
  regular: "font-normal",
  medium: "font-medium",
  semibold: "font-semibold",
  bold: "font-bold",
} as const;

const textToneClasses = {
  primary: "text-foreground",
  secondary: "text-secondary",
  inverse: "text-inverse",
  accent: "text-accent",
} as const;

export interface TextProps extends FrameProps {
  children?: ReactNode;
  element?: TextElement;
  size?: keyof typeof textSizeClasses;
  tone?: keyof typeof textToneClasses;
  weight?: keyof typeof textWeightClasses;
  align?: TextAlignValue;
}

export function Text({
  children,
  element = "p",
  size = "md",
  tone = "primary",
  weight = "regular",
  align,
  ...rest
}: TextProps) {
  const Component = element;

  return (
    <Component
      {...rest}
      className={cx(
        "leading-relaxed",
        textSizeClasses[size],
        textToneClasses[tone],
        textWeightClasses[weight],
        resolveTextAlignClass(align),
      )}
    >
      {children}
    </Component>
  );
}

export interface HeadingProps extends FrameProps {
  children?: ReactNode;
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  align?: TextAlignValue;
}

const headingClasses: Record<NonNullable<HeadingProps["level"]>, string> = {
  1: "font-display text-4xl font-semibold leading-tight md:text-5xl md:leading-[1.15]",
  2: "font-heading text-3xl font-semibold leading-tight md:text-4xl md:leading-tight",
  3: "font-heading text-2xl font-semibold leading-snug md:text-3xl md:leading-tight",
  4: "font-heading text-xl font-semibold leading-snug md:text-2xl md:leading-snug",
  5: "font-heading text-lg font-semibold leading-snug",
  6: "font-heading text-base font-semibold leading-snug",
};

export function Heading({ children, level = 2, align, ...rest }: HeadingProps) {
  const Component = `h${level}` as const;

  return (
    <Component {...rest} className={cx(headingClasses[level], resolveTextAlignClass(align))}>
      {children}
    </Component>
  );
}

export interface LabelProps extends Omit<LabelHTMLAttributes<HTMLLabelElement>, "className" | "style"> {
  muted?: boolean;
}

export function Label({ muted = false, ...rest }: LabelProps) {
  return <label {...rest} className={cx("text-sm font-medium", muted ? "text-secondary" : "text-foreground")} />;
}

export interface CaptionProps extends TextProps {}

export function Caption(props: CaptionProps) {
  return <Text {...props} size={props.size ?? "xs"} tone={props.tone ?? "secondary"} />;
}

export interface CodeTextProps extends FrameProps {
  children?: ReactNode;
}

export function CodeText({ children, ...rest }: CodeTextProps) {
  return (
    <code {...rest} className="rounded-tokenSm bg-background px-1.5 py-1 font-mono text-xs text-accent">
      {children}
    </code>
  );
}

export interface LinkTextProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "style"> {
  tone?: "accent" | "subtle";
  trailingIcon?: IconName;
}

export function LinkText({ children, tone = "accent", trailingIcon, ...rest }: LinkTextProps) {
  return (
    <a
      {...rest}
      className={cx(
        "focus-ring inline-flex items-center gap-2 rounded-tokenSm font-medium underline-offset-4",
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
    <blockquote {...rest} className="modern-surface rounded-tokenLg border-l-4 border-accent px-5 py-4">
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
        className={cx("rounded-full border border-muted object-cover shadow-tokenSm", avatarSizeClasses[size])}
      />
    );
  }

  return (
    <div aria-label={alt ?? name}>
      <div
        className={cx(
          "inline-flex items-center justify-center rounded-full border border-muted bg-background font-semibold text-secondary shadow-tokenSm",
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
