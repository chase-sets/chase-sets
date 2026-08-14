import type { HTMLAttributes, ReactNode } from "react";
import { ButtonGroup } from "../../components/actions";
import { layoutWidthClasses, type LayoutWidth, type SidebarWidth } from "../../primitives/layout";
import { Eyebrow } from "../../primitives/typography";
import { cx } from "../../utils/cx";

export interface PageProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
  width?: LayoutWidth;
}

export function Page({ children, width = "full", ...rest }: PageProps) {
  return (
    <div
      {...rest}
      className={cx(
        "mx-auto flex w-full min-w-0 max-w-full flex-col gap-6 overflow-x-clip px-4 py-6 pb-24 md:px-6 md:pb-8",
        layoutWidthClasses[width],
      )}
    >
      {children}
    </div>
  );
}

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "title"> {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ eyebrow, title, description, actions, ...rest }: PageHeaderProps) {
  return (
    <div {...rest} className="flex min-w-0 max-w-full flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0 space-y-2">
        {eyebrow ? <Eyebrow variant="accent">{eyebrow}</Eyebrow> : null}
        <h1 className="font-display text-4xl font-semibold text-foreground md:text-5xl">{title}</h1>
        {description ? <div className="max-w-full text-base text-secondary md:max-w-3xl">{description}</div> : null}
      </div>
      {actions ? <ButtonGroup>{actions}</ButtonGroup> : null}
    </div>
  );
}

interface PageSectionBaseProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "title"> {
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}

// The actions-present branch requires the `title` prop to be present, so an
// action-only section header is unrepresentable in ordinary typed use.
// `ReactNode` still admits every explicitly supplied falsy title; the runtime
// `title ?` guard below then withholds the header row and its actions.
export type PageSectionProps =
  | (PageSectionBaseProps & { actions?: never })
  | (PageSectionBaseProps & { title: ReactNode; actions: ReactNode });

export function PageSection({ title, description, actions, children, ...rest }: PageSectionProps) {
  const header = title ? (
    <div className="max-w-4xl space-y-2">
      <h2 className="font-heading text-2xl font-semibold leading-tight text-foreground md:text-3xl">{title}</h2>
      {description ? <div className="max-w-3xl text-base leading-7 text-secondary">{description}</div> : null}
    </div>
  ) : null;

  return (
    <section {...rest} className="space-y-4">
      {title ? (
        actions ? (
          <div className="flex min-w-0 max-w-full flex-col gap-4 md:flex-row md:items-end md:justify-between">
            {header}
            <ButtonGroup>{actions}</ButtonGroup>
          </div>
        ) : (
          header
        )
      ) : null}
      {children}
    </section>
  );
}

export interface SplitPaneProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  primary: ReactNode;
  secondary: ReactNode;
  secondaryWidth?: SidebarWidth;
  secondarySticky?: boolean;
}

const splitPaneWidthClasses: Record<SidebarWidth, string> = {
  nav: "lg:grid-cols-[minmax(0,1fr)_16rem]",
  filter: "lg:grid-cols-[minmax(0,1fr)_18rem]",
  detail: "lg:grid-cols-[minmax(0,1fr)_22rem]",
  summary: "lg:grid-cols-[minmax(0,1fr)_24rem]",
};

export function SplitPane({
  primary,
  secondary,
  secondaryWidth = "detail",
  secondarySticky = false,
  ...rest
}: SplitPaneProps) {
  return (
    <div {...rest} className={cx("grid gap-6", splitPaneWidthClasses[secondaryWidth])}>
      <div>{primary}</div>
      <div className={cx(secondarySticky && "lg:sticky lg:top-24 lg:self-start")}>{secondary}</div>
    </div>
  );
}

export interface RecordPageProps {
  header: ReactNode;
  summary: ReactNode;
  details: ReactNode;
  width?: LayoutWidth;
}

export function RecordPage({ header, summary, details, width = "full" }: RecordPageProps) {
  return (
    <Page width={width}>
      {header}
      <SplitPane primary={summary} secondary={details} />
    </Page>
  );
}
