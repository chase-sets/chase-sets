import type { HTMLAttributes, PropsWithChildren, ReactNode } from "react";
import * as AspectRatioPrimitive from "@radix-ui/react-aspect-ratio";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import * as VisuallyHiddenPrimitive from "@radix-ui/react-visually-hidden";
import type { ResponsiveValue } from "../theme/tokens";
import { cx } from "../utils/cx";
import {
  resolveAlignClass,
  resolveColumnsClass,
  resolveDirectionClass,
  resolveJustifyClass,
  resolveSpaceClass,
  resolveSystemProps,
  type AlignValue,
  type DirectionValue,
  type JustifyValue,
  type SpaceToken,
  type SystemProps
} from "../utils/system";

type BoxElement =
  | "div"
  | "section"
  | "article"
  | "aside"
  | "header"
  | "footer"
  | "main"
  | "nav"
  | "span";

type FrameProps = Omit<HTMLAttributes<HTMLElement>, "className" | "style">;

export interface BoxProps extends PropsWithChildren, FrameProps, SystemProps {
  element?: BoxElement;
}

export function Box({
  element = "div",
  children,
  padding,
  paddingX,
  paddingY,
  gap,
  textAlign,
  ...rest
}: BoxProps) {
  const Component = element;

  return (
    <Component
      {...rest}
      className={resolveSystemProps({
        padding,
        paddingX,
        paddingY,
        gap,
        textAlign
      })}
    >
      {children}
    </Component>
  );
}

export interface ContainerProps
  extends Omit<BoxProps, "element"> {
  width?: LayoutWidth;
}

export type LayoutWidth = "narrow" | "content" | "wide" | "full";

export const layoutWidthClasses: Record<LayoutWidth, string> = {
  narrow: "max-w-3xl",
  content: "max-w-5xl",
  wide: "max-w-7xl",
  full: "max-w-none"
};

export function Container({
  children,
  width = "full",
  paddingX = 4,
  ...rest
}: ContainerProps) {
  return (
    <div
      {...rest}
      className={cx("w-full", resolveSystemProps({ paddingX }))}
    >
      <div className={cx("mx-auto w-full", layoutWidthClasses[width])}>
        {children}
      </div>
    </div>
  );
}

export interface StackProps
  extends PropsWithChildren,
    Omit<FrameProps, "children"> {
  element?: BoxElement;
  direction?: ResponsiveValue<DirectionValue>;
  align?: ResponsiveValue<AlignValue>;
  justify?: ResponsiveValue<JustifyValue>;
  gap?: SpaceToken;
}

export function Stack({
  children,
  element = "div",
  direction = "column",
  align,
  justify,
  gap = 4,
  ...rest
}: StackProps) {
  const Component = element;

  return (
    <Component
      {...rest}
      className={cx(
        "flex",
        resolveDirectionClass(direction),
        resolveAlignClass(align),
        resolveJustifyClass(justify),
        resolveSpaceClass("gap", gap)
      )}
    >
      {children}
    </Component>
  );
}

export interface InlineProps
  extends PropsWithChildren,
    Omit<FrameProps, "children"> {
  gap?: SpaceToken;
  align?: ResponsiveValue<AlignValue>;
  wrap?: boolean;
}

export function Inline({
  children,
  gap = 3,
  align = "center",
  wrap = true,
  ...rest
}: InlineProps) {
  return (
    <div
      {...rest}
      className={cx(
        "flex",
        wrap && "flex-wrap",
        resolveAlignClass(align),
        resolveSpaceClass("gap", gap)
      )}
    >
      {children}
    </div>
  );
}

export interface ClusterProps extends InlineProps {
  justify?: ResponsiveValue<JustifyValue>;
}

export function Cluster({
  children,
  justify = "between",
  gap = 3,
  align = "center",
  ...rest
}: ClusterProps) {
  return (
    <div
      {...rest}
      className={cx(
        "flex w-full flex-wrap",
        resolveAlignClass(align),
        resolveJustifyClass(justify),
        resolveSpaceClass("gap", gap)
      )}
    >
      {children}
    </div>
  );
}

export interface GridProps
  extends PropsWithChildren,
    Omit<FrameProps, "children"> {
  columns?: ResponsiveValue<1 | 2 | 3 | 4>;
  gap?: SpaceToken;
}

export function Grid({
  children,
  columns = { base: 1, md: 2, xl: 3 },
  gap = 4,
  ...rest
}: GridProps) {
  return (
    <div
      {...rest}
      className={cx(
        "grid",
        resolveColumnsClass(columns),
        resolveSpaceClass("gap", gap)
      )}
    >
      {children}
    </div>
  );
}

export interface SpacerProps extends Omit<FrameProps, "children"> {
  axis?: "vertical" | "horizontal";
  size?: SpaceToken;
  flexible?: boolean;
}

export function Spacer({
  axis = "vertical",
  size = 4,
  flexible = false,
  ...rest
}: SpacerProps) {
  return (
    <div
      {...rest}
      aria-hidden="true"
      className={cx(
        flexible && "flex-1",
        axis === "vertical"
          ? resolveSpaceClass("my", size)
          : resolveSpaceClass("mx", size)
      )}
    />
  );
}

export interface InsetProps extends BoxProps {}

export function Inset({
  children,
  padding = 4,
  ...rest
}: InsetProps) {
  return (
    <Box {...rest} padding={padding}>
      {children}
    </Box>
  );
}

export interface CenterProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  inline?: boolean;
}

export function Center({
  children,
  inline = false,
  ...rest
}: CenterProps) {
  return (
    <div
      {...rest}
      className={cx(
        inline ? "inline-flex" : "flex",
        "items-center justify-center"
      )}
    >
      {children}
    </div>
  );
}

export interface AspectRatioProps
  extends PropsWithChildren,
    Omit<FrameProps, "children"> {
  ratio?: number;
}

export function AspectRatio({
  children,
  ratio = 1,
  ...rest
}: AspectRatioProps) {
  return (
    <AspectRatioPrimitive.Root {...rest} ratio={ratio}>
      {children}
    </AspectRatioPrimitive.Root>
  );
}

export interface SurfaceProps
  extends PropsWithChildren,
    Omit<FrameProps, "children">,
    SystemProps {
  element?: BoxElement;
  tone?: "default" | "muted" | "accent";
  elevated?: boolean;
}

const surfaceToneClasses: Record<NonNullable<SurfaceProps["tone"]>, string> = {
  default: "modern-surface bg-elevated",
  muted: "bg-background",
  accent: "bg-accent text-accent-contrast"
};

export function Surface({
  children,
  element = "div",
  tone = "default",
  elevated = false,
  padding = 4,
  paddingX,
  paddingY,
  gap,
  textAlign,
  ...rest
}: SurfaceProps) {
  const Component = element;

  return (
    <Component
      {...rest}
      className={cx(
        "surface-border rounded-tokenLg",
        surfaceToneClasses[tone],
        resolveSystemProps({
          padding,
          paddingX,
          paddingY,
          gap,
          textAlign
        }),
        elevated ? "shadow-tokenLg" : "shadow-tokenSm"
      )}
    >
      {children}
    </Component>
  );
}

export interface DividerProps
  extends Omit<SeparatorPrimitive.SeparatorProps, "className" | "style"> {}

export function Divider({
  orientation = "horizontal",
  decorative = true,
  ...rest
}: DividerProps) {
  return (
    <SeparatorPrimitive.Root
      {...rest}
      decorative={decorative}
      orientation={orientation}
      className={cx(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px"
      )}
    />
  );
}

export interface ScrollAreaProps
  extends PropsWithChildren,
    Omit<ScrollAreaPrimitive.ScrollAreaProps, "className" | "style" | "children"> {
  height?: "auto" | "sm" | "md" | "lg" | "full";
}

const scrollHeights: Record<NonNullable<ScrollAreaProps["height"]>, string> = {
  auto: "",
  sm: "max-h-48",
  md: "max-h-72",
  lg: "max-h-96",
  full: "h-full"
};

export function ScrollArea({
  children,
  height = "auto",
  ...rest
}: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      {...rest}
      className={cx(
        "modern-surface overflow-hidden rounded-tokenLg border border-muted",
        scrollHeights[height]
      )}
    >
      <ScrollAreaPrimitive.Viewport className="h-full w-full">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        orientation="vertical"
        className="flex w-2.5 touch-none select-none bg-transparent p-0.5"
      >
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-muted" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Scrollbar
        orientation="horizontal"
        className="flex h-2.5 touch-none select-none bg-transparent p-0.5"
      >
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-muted" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner className="bg-muted" />
    </ScrollAreaPrimitive.Root>
  );
}

export interface VisuallyHiddenProps
  extends PropsWithChildren,
    Omit<FrameProps, "children"> {}

export function VisuallyHidden({
  children,
  ...rest
}: VisuallyHiddenProps) {
  return (
    <VisuallyHiddenPrimitive.Root {...rest}>
      {children}
    </VisuallyHiddenPrimitive.Root>
  );
}

export function renderOptionalNode(
  node?: ReactNode
): ReactNode {
  return node ?? null;
}

export interface SkipLinkProps {
  targetId?: string;
  label?: string;
}

export function SkipLink({
  targetId = "main-content",
  label = "Skip to main content"
}: SkipLinkProps) {
  return (
    <a
      href={`#${targetId}`}
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-tokenMd focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-accent-contrast focus:shadow-overlay"
    >
      {label}
    </a>
  );
}
