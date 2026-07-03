import type { ChangeEvent, HTMLAttributes, MouseEvent, ReactNode } from "react";
import { useId } from "react";
import type { IconName } from "../../icons";
import { Icon } from "../../icons";
import { Show, Stack } from "../../primitives/layout";
import { cx } from "../../utils/cx";

export type SectionNavigationItemState = "default" | "pending" | "warning" | "blocked" | "disabled";

export interface SectionNavigationItem {
  key: string;
  label: string;
  href?: string;
  icon?: IconName;
  description?: string;
  count?: number | string;
  state?: SectionNavigationItemState;
  statusLabel?: string;
  disabled?: boolean;
}

export interface SectionNavigationGroup {
  key: string;
  label: string;
  items: SectionNavigationItem[];
}

export interface SectionNavigationProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "onSelect"> {
  groups: SectionNavigationGroup[];
  activeKey: string;
  label?: string;
  mobileLabel?: string;
  variant?: "desktop" | "mobile" | "responsive";
  onSelect?: (key: string) => void;
}

const stateLabel: Record<SectionNavigationItemState, string> = {
  default: "",
  pending: "Pending",
  warning: "Needs attention",
  blocked: "Blocked",
  disabled: "Unavailable",
};

const stateClasses: Record<SectionNavigationItemState, string> = {
  default: "border-transparent text-tertiary",
  pending: "border-info-soft bg-info-soft text-info",
  warning: "border-warning-soft bg-warning-soft text-warning",
  blocked: "border-danger-soft bg-danger-soft text-danger",
  disabled: "border-border bg-surface-2 text-tertiary",
};

const dotClasses: Record<SectionNavigationItemState, string> = {
  default: "bg-tertiary",
  pending: "bg-info",
  warning: "bg-warning",
  blocked: "bg-danger",
  disabled: "bg-tertiary",
};

function getItemState(item: SectionNavigationItem): SectionNavigationItemState {
  return item.state ?? (item.disabled ? "disabled" : "default");
}

function isItemDisabled(item: SectionNavigationItem): boolean {
  return item.disabled === true || item.state === "disabled";
}

function getStatusLabel(item: SectionNavigationItem): string {
  const state = getItemState(item);

  return item.statusLabel ?? stateLabel[state];
}

function renderStatus(item: SectionNavigationItem) {
  const state = getItemState(item);
  const status = getStatusLabel(item);

  if (!status && item.count === undefined) {
    return null;
  }

  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5">
      {status ? (
        <span
          className={cx(
            "inline-flex max-w-[8rem] items-center gap-1 truncate rounded-tokenFull border px-2 py-0.5 text-2xs font-semibold leading-badge",
            stateClasses[state],
          )}
        >
          <span aria-hidden="true" className={cx("h-1.5 w-1.5 rounded-tokenFull", dotClasses[state])} />
          <span className="truncate">{status}</span>
        </span>
      ) : null}
      {item.count === undefined ? null : (
        <span className="rounded-tokenFull border border-border bg-surface px-2 py-0.5 text-2xs font-semibold leading-badge text-secondary">
          {item.count}
        </span>
      )}
    </span>
  );
}

function renderDesktopItem(item: SectionNavigationItem, activeKey: string, onSelect?: (key: string) => void) {
  const active = item.key === activeKey;
  const state = getItemState(item);
  const disabled = isItemDisabled(item);
  const content = (
    <>
      {item.icon ? <Icon name={item.icon} size="sm" tone={active ? "accent" : "secondary"} /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{item.label}</span>
        {item.description ? <span className="block truncate text-xs text-tertiary">{item.description}</span> : null}
      </span>
      {renderStatus(item)}
    </>
  );
  const className = cx(
    "focus-ring flex min-h-11 w-full items-center gap-2 rounded-tokenMd border px-3 py-2 text-left transition-colors",
    active
      ? "border-accent-soft bg-accent-soft text-foreground shadow-tokenSm"
      : "border-transparent text-secondary hover:border-border hover:bg-surface-2 hover:text-foreground",
    disabled && "cursor-not-allowed opacity-60 hover:border-transparent hover:bg-transparent hover:text-secondary",
  );
  const handleClick = (event: MouseEvent<HTMLElement>) => {
    if (disabled) {
      event.preventDefault();
      return;
    }

    onSelect?.(item.key);
  };

  if (item.href) {
    return (
      <a
        key={item.key}
        href={item.href}
        aria-current={active ? "page" : undefined}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : undefined}
        className={className}
        onClick={handleClick}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      key={item.key}
      type="button"
      disabled={disabled}
      aria-current={active ? "page" : undefined}
      className={className}
      onClick={handleClick}
    >
      {content}
    </button>
  );
}

function renderDesktop(
  groups: SectionNavigationGroup[],
  activeKey: string,
  headingIdBase: string,
  onSelect?: (key: string) => void,
) {
  return (
    <Stack gap={5}>
      {groups.map((group) => {
        const headingId = `${headingIdBase}-${group.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

        return (
          <Stack key={group.key} role="group" aria-labelledby={headingId} gap={2}>
            <h2 id={headingId} className="px-3 text-xs font-semibold uppercase tracking-normal text-tertiary">
              {group.label}
            </h2>
            <Stack gap={1}>{group.items.map((item) => renderDesktopItem(item, activeKey, onSelect))}</Stack>
          </Stack>
        );
      })}
    </Stack>
  );
}

function renderMobile(
  groups: SectionNavigationGroup[],
  activeKey: string,
  mobileLabel: string,
  onSelect?: (key: string) => void,
) {
  const itemsByKey = new Map(groups.flatMap((group) => group.items.map((item) => [item.key, item])));
  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const item = itemsByKey.get(event.target.value);

    if (!item || isItemDisabled(item)) {
      return;
    }

    onSelect?.(item.key);
  };

  return (
    <div className="rounded-tokenMd border border-border bg-surface p-2 shadow-tokenSm">
      <select
        value={activeKey}
        aria-label={mobileLabel}
        className="focus-ring min-h-11 w-full rounded-tokenSm border border-border bg-background px-3 py-2 text-sm font-semibold text-foreground"
        onChange={handleChange}
      >
        {groups.map((group) => (
          <optgroup key={group.key} label={group.label}>
            {group.items.map((item) => {
              const status = getStatusLabel(item);
              const suffix = [status, item.count === undefined ? undefined : item.count].filter(Boolean).join(" · ");
              const optionLabel = suffix ? `${item.label} (${suffix})` : item.label;

              return (
                <option key={item.key} value={item.key} disabled={isItemDisabled(item)}>
                  {optionLabel}
                </option>
              );
            })}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

export function SectionNavigation({
  groups,
  activeKey,
  label = "Section navigation",
  mobileLabel = "Choose section",
  variant = "responsive",
  onSelect,
  ...rest
}: SectionNavigationProps) {
  const showDesktop = variant === "desktop" || variant === "responsive";
  const showMobile = variant === "mobile" || variant === "responsive";
  const responsive = variant === "responsive";
  const headingIdBase = useId();

  return (
    <nav {...rest} aria-label={label}>
      {showDesktop ? (
        <ResponsiveRegion responsive={responsive} at="desktop">
          {renderDesktop(groups, activeKey, headingIdBase, onSelect)}
        </ResponsiveRegion>
      ) : null}
      {showMobile ? (
        <ResponsiveRegion responsive={responsive} at="mobile">
          {renderMobile(groups, activeKey, mobileLabel, onSelect)}
        </ResponsiveRegion>
      ) : null}
    </nav>
  );
}

/**
 * Reveals a section-navigation region at the matching breakpoint. In the
 * `responsive` variant the desktop grouped list shows from `md` up and the mobile
 * selector shows below it; the single-mode variants render their region at every
 * width. Generalizes the old hand-rolled `hidden md:block` / `md:hidden` split
 * onto the {@link Show} primitive.
 */
function ResponsiveRegion({
  responsive,
  at,
  children,
}: {
  responsive: boolean;
  at: "desktop" | "mobile";
  children: ReactNode;
}) {
  if (!responsive) {
    return <>{children}</>;
  }

  return at === "desktop" ? <Show above="md">{children}</Show> : <Show below="md">{children}</Show>;
}
