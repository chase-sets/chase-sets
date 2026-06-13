import {
  forwardRef,
  type ComponentProps,
  type ElementType,
  type HTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
  type Ref,
} from "react";
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";
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
  type ColumnCount,
  type DirectionValue,
  type JustifyValue,
  type SpaceToken,
  type SystemProps,
} from "../utils/system";
import type { PolymorphicPrimitive, PolymorphicProps } from "./polymorphic";

type BoxElement = "div" | "section" | "article" | "aside" | "header" | "footer" | "main" | "nav" | "span";

type FrameProps = Omit<HTMLAttributes<HTMLElement>, "className" | "style">;

export interface BoxOwnProps extends PropsWithChildren, SystemProps {
  element?: BoxElement;
}

export type BoxProps<TTarget extends ElementType = "div"> = PolymorphicProps<TTarget, BoxOwnProps>;

export const Box = forwardRef(function Box(
  {
    as,
    render,
    element = "div",
    children,
    padding,
    paddingX,
    paddingY,
    gap,
    textAlign,
    ...rest
  }: BoxProps<ElementType>,
  ref: Ref<unknown>,
) {
  const Component = (as ?? render ?? element) as ElementType;

  return (
    <Component
      {...rest}
      ref={ref}
      className={resolveSystemProps({
        padding,
        paddingX,
        paddingY,
        gap,
        textAlign,
      })}
    >
      {children}
    </Component>
  );
}) as PolymorphicPrimitive<BoxOwnProps, "div">;

export interface ContainerProps extends PropsWithChildren, FrameProps, SystemProps {
  width?: LayoutWidth;
}

export type LayoutWidth = "narrow" | "content" | "wide" | "expanded" | "full";

export const layoutWidthClasses: Record<LayoutWidth, string> = {
  narrow: "max-w-3xl",
  content: "max-w-5xl",
  wide: "max-w-7xl",
  expanded: "max-w-screen-2xl",
  full: "max-w-none",
};

/**
 * Named sidebar widths for use in grid layouts.
 * - nav: primary navigation sidebar (admin side nav)
 * - filter: secondary filter/browse sidebar (marketplace)
 * - detail: auxiliary detail/info panel
 * - summary: checkout order summary panel
 */
export const sidebarWidthClasses = {
  nav: "16rem",
  filter: "18rem",
  detail: "22rem",
  summary: "24rem",
} as const;

export type SidebarWidth = keyof typeof sidebarWidthClasses;

export function Container({ children, width = "full", paddingX = 4, ...rest }: ContainerProps) {
  return (
    <div {...rest} className={cx("w-full", resolveSystemProps({ paddingX }))}>
      <div className={cx("mx-auto w-full", layoutWidthClasses[width])}>{children}</div>
    </div>
  );
}

export interface StackOwnProps extends PropsWithChildren {
  element?: BoxElement;
  direction?: ResponsiveValue<DirectionValue>;
  align?: ResponsiveValue<AlignValue>;
  justify?: ResponsiveValue<JustifyValue>;
  gap?: SpaceToken;
}

export type StackProps<TTarget extends ElementType = "div"> = PolymorphicProps<TTarget, StackOwnProps>;

export const Stack = forwardRef(function Stack(
  {
    children,
    as,
    render,
    element = "div",
    direction = "column",
    align,
    justify,
    gap = 4,
    ...rest
  }: StackProps<ElementType>,
  ref: Ref<unknown>,
) {
  const Component = (as ?? render ?? element) as ElementType;

  return (
    <Component
      {...rest}
      ref={ref}
      className={cx(
        "flex",
        resolveDirectionClass(direction),
        resolveAlignClass(align),
        resolveJustifyClass(justify),
        resolveSpaceClass("gap", gap),
      )}
    >
      {children}
    </Component>
  );
}) as PolymorphicPrimitive<StackOwnProps, "div">;

export interface InlineProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  gap?: SpaceToken;
  align?: ResponsiveValue<AlignValue>;
  wrap?: boolean;
}

export function Inline({ children, gap = 3, align = "center", wrap = true, ...rest }: InlineProps) {
  return (
    <div {...rest} className={cx("flex", wrap && "flex-wrap", resolveAlignClass(align), resolveSpaceClass("gap", gap))}>
      {children}
    </div>
  );
}

export interface ClusterProps extends InlineProps {
  justify?: ResponsiveValue<JustifyValue>;
}

export function Cluster({ children, justify = "between", gap = 3, align = "center", ...rest }: ClusterProps) {
  return (
    <div
      {...rest}
      className={cx(
        "flex w-full flex-wrap",
        resolveAlignClass(align),
        resolveJustifyClass(justify),
        resolveSpaceClass("gap", gap),
      )}
    >
      {children}
    </div>
  );
}

export interface GridProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  columns?: ResponsiveValue<ColumnCount>;
  gap?: SpaceToken;
  align?: ResponsiveValue<AlignValue>;
  justify?: ResponsiveValue<JustifyValue>;
}

export function Grid({ children, columns = { base: 1, md: 2, xl: 3 }, gap = 4, align, justify, ...rest }: GridProps) {
  return (
    <div
      {...rest}
      className={cx(
        "grid",
        resolveColumnsClass(columns),
        resolveAlignClass(align),
        resolveJustifyClass(justify),
        resolveSpaceClass("gap", gap),
      )}
    >
      {children}
    </div>
  );
}

export interface AutoGridProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  minItemWidth?: "sm" | "md" | "lg";
  gap?: SpaceToken;
}

const autoGridWidthClasses: Record<NonNullable<AutoGridProps["minItemWidth"]>, string> = {
  sm: "grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]",
  md: "grid-cols-[repeat(auto-fit,minmax(18rem,1fr))]",
  lg: "grid-cols-[repeat(auto-fit,minmax(22rem,1fr))]",
};

export function AutoGrid({ children, minItemWidth = "md", gap = 4, ...rest }: AutoGridProps) {
  return (
    <div {...rest} className={cx("grid", autoGridWidthClasses[minItemWidth], resolveSpaceClass("gap", gap))}>
      {children}
    </div>
  );
}

export interface FlexItemProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  minWidth?: "control" | "none";
  grow?: boolean;
}

export function FlexItem({ children, minWidth = "none", grow = false, ...rest }: FlexItemProps) {
  return (
    <div {...rest} className={cx("max-w-full", grow && "flex-1", minWidth === "control" && "min-w-[14rem]")}>
      {children}
    </div>
  );
}

export interface SpacerProps extends Omit<FrameProps, "children"> {
  axis?: "vertical" | "horizontal";
  size?: SpaceToken;
  flexible?: boolean;
}

export function Spacer({ axis = "vertical", size = 4, flexible = false, ...rest }: SpacerProps) {
  return (
    <div
      {...rest}
      aria-hidden="true"
      className={cx(
        flexible && "flex-1",
        axis === "vertical" ? resolveSpaceClass("my", size) : resolveSpaceClass("mx", size),
      )}
    />
  );
}

export type InsetProps<TTarget extends ElementType = "div"> = BoxProps<TTarget>;

export const Inset = forwardRef(function Inset(
  {
    children,
    as,
    render,
    element = "div",
    padding = 4,
    paddingX,
    paddingY,
    gap,
    textAlign,
    ...rest
  }: InsetProps<ElementType>,
  ref: Ref<unknown>,
) {
  const Component = (as ?? render ?? element) as ElementType;

  return (
    <Component
      {...rest}
      ref={ref}
      className={cx(
        "inset-surface min-w-0 max-w-full rounded-tokenMd border",
        resolveSystemProps({ padding, paddingX, paddingY, gap, textAlign }),
      )}
    >
      {children}
    </Component>
  );
}) as PolymorphicPrimitive<BoxOwnProps, "div">;

export interface CenterProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  inline?: boolean;
}

export function Center({ children, inline = false, ...rest }: CenterProps) {
  return (
    <div {...rest} className={cx(inline ? "inline-flex" : "flex", "items-center justify-center")}>
      {children}
    </div>
  );
}

export interface MobileStickyBarProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  visibleFrom?: "mobile" | "all";
}

export function MobileStickyBar({ children, visibleFrom = "mobile", ...rest }: MobileStickyBarProps) {
  return (
    <div
      {...rest}
      className={cx(
        "fixed inset-x-0 bottom-0 z-sticky border-t border-muted bg-background/88 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-tokenLg backdrop-blur-xl",
        visibleFrom === "mobile" && "md:hidden",
      )}
    >
      {children}
    </div>
  );
}

export interface MobileStickyInsetProps extends PropsWithChildren, Omit<FrameProps, "children"> {}

export function MobileStickyInset({ children, ...rest }: MobileStickyInsetProps) {
  return (
    <div {...rest} className="pb-24 md:pb-0">
      {children}
    </div>
  );
}

export interface AspectRatioProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  ratio?: number;
}

export function AspectRatio({ children, ratio = 1, ...rest }: AspectRatioProps) {
  return (
    <div {...rest} style={{ aspectRatio: ratio }}>
      {children}
    </div>
  );
}

type SurfaceTone = "default" | "muted" | "accent" | "subtle";

export interface SurfaceOwnProps extends PropsWithChildren, SystemProps {
  element?: BoxElement;
  tone?: SurfaceTone;
  elevated?: boolean;
  glow?: boolean;
}

export type SurfaceProps<TTarget extends ElementType = "div"> = PolymorphicProps<TTarget, SurfaceOwnProps>;

const surfaceToneClasses: Record<SurfaceTone, string> = {
  default: "glass-surface bg-elevated",
  muted: "bg-surface-2",
  accent: "brand-gradient text-accent-contrast",
  subtle: "bg-surface border-muted",
};

export const Surface = forwardRef(function Surface(
  {
    children,
    as,
    render,
    element = "div",
    tone = "default",
    elevated = false,
    glow = false,
    padding = 4,
    paddingX,
    paddingY,
    gap,
    textAlign,
    ...rest
  }: SurfaceProps<ElementType>,
  ref: Ref<unknown>,
) {
  const Component = (as ?? render ?? element) as ElementType;

  return (
    <Component
      {...rest}
      ref={ref}
      className={cx(
        "surface-border min-w-0 max-w-full rounded-tokenLg",
        surfaceToneClasses[tone],
        resolveSystemProps({
          padding,
          paddingX,
          paddingY,
          gap,
          textAlign,
        }),
        elevated ? "shadow-tokenLg" : "shadow-tokenSm",
        glow && "glow-accent",
      )}
    >
      {children}
    </Component>
  );
}) as PolymorphicPrimitive<SurfaceOwnProps, "div">;

export interface DividerProps extends Omit<ComponentProps<typeof SeparatorPrimitive>, "className" | "style"> {
  decorative?: boolean;
}

export function Divider({ orientation = "horizontal", decorative = true, ...rest }: DividerProps) {
  return (
    <SeparatorPrimitive
      {...rest}
      aria-hidden={decorative || undefined}
      orientation={orientation}
      className={cx("shrink-0 bg-border", orientation === "horizontal" ? "h-px w-full" : "h-full w-px")}
    />
  );
}

export interface ScrollAreaProps
  extends PropsWithChildren, Omit<ComponentProps<typeof ScrollAreaPrimitive.Root>, "className" | "style" | "children"> {
  height?: "auto" | "sm" | "md" | "lg" | "full";
}

const scrollHeights: Record<NonNullable<ScrollAreaProps["height"]>, string> = {
  auto: "",
  sm: "max-h-48",
  md: "max-h-72",
  lg: "max-h-96",
  full: "h-full",
};

export function ScrollArea({ children, height = "auto", ...rest }: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      {...rest}
      className={cx("modern-surface overflow-hidden rounded-tokenLg border border-muted", scrollHeights[height])}
    >
      <ScrollAreaPrimitive.Viewport className="h-full w-full">{children}</ScrollAreaPrimitive.Viewport>
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

export interface VisuallyHiddenProps extends PropsWithChildren, Omit<FrameProps, "children"> {}

export function VisuallyHidden({ children, ...rest }: VisuallyHiddenProps) {
  return (
    <span {...rest} className="sr-only">
      {children}
    </span>
  );
}

export function renderOptionalNode(node?: ReactNode): ReactNode {
  return node ?? null;
}

export interface SkipLinkProps {
  targetId?: string;
  label?: string;
}

export function SkipLink({ targetId = "main-content", label = "Skip to main content" }: SkipLinkProps) {
  return (
    <a
      href={`#${targetId}`}
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-tokenMd focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-accent-contrast focus:shadow-overlay"
    >
      {label}
    </a>
  );
}
