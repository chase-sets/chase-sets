import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Icon } from "../../icons";
import { useChaseMotion, usePortalRoots } from "../../theme/provider";
import { renderMotionDiv } from "../../utils/base-ui";
import { cx } from "../../utils/cx";
import { useControllableValue } from "../controllable";
import { controlSquareSizeClasses } from "../control-sizing";
import { resolveOverlayMotion } from "../feedback/motion-overlay";
import { FieldChrome, controlClass, controlErrorClass, fieldDescribedBy, type BaseInputProps } from "./shared";

// A calendar day expressed as an ISO `YYYY-MM-DD` string so values stay free of
// timezone drift. This matches native `<input type="date">` semantics.
export type CalendarDate = string;

const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

interface YearMonthDay {
  year: number;
  month: number; // 0-indexed
  day: number;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function toIsoDate({ year, month, day }: YearMonthDay): CalendarDate {
  return `${String(year).padStart(4, "0")}-${pad(month + 1)}-${pad(day)}`;
}

function parseIsoDate(value: string | undefined | null): YearMonthDay | null {
  if (!value) {
    return null;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const probe = new Date(year, month, day);

  if (probe.getFullYear() !== year || probe.getMonth() !== month || probe.getDate() !== day) {
    return null;
  }

  return { year, month, day };
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function firstWeekdayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

function addMonths({ year, month, day }: YearMonthDay, delta: number): YearMonthDay {
  const base = new Date(year, month + delta, 1);
  const nextYear = base.getFullYear();
  const nextMonth = base.getMonth();
  const clampedDay = Math.min(day, daysInMonth(nextYear, nextMonth));
  return { year: nextYear, month: nextMonth, day: clampedDay };
}

function addDays({ year, month, day }: YearMonthDay, delta: number): YearMonthDay {
  const base = new Date(year, month, day + delta);
  return { year: base.getFullYear(), month: base.getMonth(), day: base.getDate() };
}

function today(): YearMonthDay {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };
}

function formatDayLabel({ year, month, day }: YearMonthDay): string {
  const weekday = WEEKDAY_LABELS[new Date(year, month, day).getDay()];
  return `${weekday}, ${MONTH_LABELS[month]} ${day}, ${year}`;
}

function sameDay(a: YearMonthDay, b: YearMonthDay): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

export interface CalendarProps {
  id?: string;
  /** Selected day as an ISO `YYYY-MM-DD` string. */
  value?: CalendarDate | null;
  /** Day to focus when no value is set, also ISO `YYYY-MM-DD`. */
  defaultFocusedDate?: CalendarDate | null;
  onValueChange?: (value: CalendarDate) => void;
  /** Invoked after a day is selected (used by DatePicker to close the popover). */
  onDaySelect?: (value: CalendarDate) => void;
  /** Accessible label for the calendar grid. */
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

/**
 * An accessible month-grid calendar with full keyboard navigation. Use the
 * `DatePicker` for a popover-backed form field; reach for `Calendar` directly
 * only when embedding a grid inline.
 */
export const Calendar = forwardRef<HTMLButtonElement, CalendarProps>(function Calendar(
  {
    value,
    defaultFocusedDate,
    onValueChange,
    onDaySelect,
    id,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
    "aria-describedby": ariaDescribedBy,
  },
  ref,
) {
  const fallbackId = useId();
  const gridId = id ?? fallbackId;
  const selected = useMemo(() => parseIsoDate(value), [value]);
  const initialFocus = selected ?? parseIsoDate(defaultFocusedDate) ?? today();
  const [focused, setFocused] = useState<YearMonthDay>(initialFocus);
  const focusedDayRef = useRef<HTMLButtonElement | null>(null);
  // When true, the focused day button claims DOM focus after its next render.
  // This keeps keyboard navigation deterministic across month changes without
  // stealing focus on the initial mount.
  const shouldFocusRef = useRef(false);
  const todayDate = useMemo(() => today(), []);

  useEffect(() => {
    if (shouldFocusRef.current) {
      shouldFocusRef.current = false;
      focusedDayRef.current?.focus();
    }
  }, [focused]);

  const moveFocus = useCallback((next: YearMonthDay) => {
    shouldFocusRef.current = true;
    setFocused(next);
  }, []);

  const selectDay = useCallback(
    (day: YearMonthDay) => {
      const iso = toIsoDate(day);
      setFocused(day);
      onValueChange?.(iso);
      onDaySelect?.(iso);
    },
    [onValueChange, onDaySelect],
  );

  const onGridKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          moveFocus(addDays(focused, -1));
          break;
        case "ArrowRight":
          event.preventDefault();
          moveFocus(addDays(focused, 1));
          break;
        case "ArrowUp":
          event.preventDefault();
          moveFocus(addDays(focused, -7));
          break;
        case "ArrowDown":
          event.preventDefault();
          moveFocus(addDays(focused, 7));
          break;
        case "Home":
          event.preventDefault();
          moveFocus(addDays(focused, -new Date(focused.year, focused.month, focused.day).getDay()));
          break;
        case "End": {
          event.preventDefault();
          const weekday = new Date(focused.year, focused.month, focused.day).getDay();
          moveFocus(addDays(focused, 6 - weekday));
          break;
        }
        case "PageUp":
          event.preventDefault();
          moveFocus(addMonths(focused, event.shiftKey ? -12 : -1));
          break;
        case "PageDown":
          event.preventDefault();
          moveFocus(addMonths(focused, event.shiftKey ? 12 : 1));
          break;
        case "Enter":
        case " ":
          event.preventDefault();
          selectDay(focused);
          break;
        default:
          break;
      }
    },
    [focused, moveFocus, selectDay],
  );

  const monthLabel = `${MONTH_LABELS[focused.month]} ${focused.year}`;
  const totalDays = daysInMonth(focused.year, focused.month);
  const leadingBlanks = firstWeekdayOfMonth(focused.year, focused.month);
  const weeks: (YearMonthDay | null)[][] = [];
  let currentWeek: (YearMonthDay | null)[] = Array.from({ length: leadingBlanks }, () => null);

  for (let dayNumber = 1; dayNumber <= totalDays; dayNumber += 1) {
    currentWeek.push({ year: focused.year, month: focused.month, day: dayNumber });
    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }
  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) {
      currentWeek.push(null);
    }
    weeks.push(currentWeek);
  }

  return (
    <div
      className="grid w-[min(20rem,100%)] gap-3"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
    >
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => moveFocus(addMonths(focused, -1))}
          className={cx(
            "focus-ring inline-flex items-center justify-center rounded-tokenMd text-secondary hover:bg-background",
            controlSquareSizeClasses.md,
          )}
        >
          <Icon name="chevronLeft" size="sm" />
        </button>
        <div aria-live="polite" className="text-sm font-semibold text-foreground">
          {monthLabel}
        </div>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => moveFocus(addMonths(focused, 1))}
          className={cx(
            "focus-ring inline-flex items-center justify-center rounded-tokenMd text-secondary hover:bg-background",
            controlSquareSizeClasses.md,
          )}
        >
          <Icon name="chevronRight" size="sm" />
        </button>
      </div>
      <div
        role="grid"
        id={gridId}
        aria-label={ariaLabel ?? monthLabel}
        className="grid gap-1"
        onKeyDown={onGridKeyDown}
      >
        <div role="row" className="grid grid-cols-7">
          {WEEKDAY_SHORT.map((short, index) => (
            <div
              key={short}
              role="columnheader"
              aria-label={WEEKDAY_LABELS[index]}
              className="flex h-8 items-center justify-center text-xs font-medium text-tertiary"
            >
              {short}
            </div>
          ))}
        </div>
        {weeks.map((week, weekIndex) => (
          <div role="row" key={weekIndex} className="grid grid-cols-7">
            {week.map((day, dayIndex) => {
              if (!day) {
                return <div role="gridcell" key={dayIndex} aria-hidden="true" className="h-8 w-full" />;
              }

              const isSelected = selected ? sameDay(selected, day) : false;
              const isFocused = sameDay(focused, day);
              const isToday = sameDay(todayDate, day);

              return (
                <div role="gridcell" key={dayIndex} aria-selected={isSelected}>
                  <button
                    ref={
                      isFocused
                        ? (node) => {
                            focusedDayRef.current = node;
                            if (typeof ref === "function") {
                              ref(node);
                            } else if (ref) {
                              ref.current = node;
                            }
                          }
                        : undefined
                    }
                    type="button"
                    tabIndex={isFocused ? 0 : -1}
                    aria-label={formatDayLabel(day)}
                    aria-current={isToday ? "date" : undefined}
                    aria-pressed={isSelected}
                    onClick={() => selectDay(day)}
                    onFocus={() => setFocused(day)}
                    className={cx(
                      "focus-ring flex w-full items-center justify-center rounded-tokenMd text-sm tabular-nums outline-none transition",
                      controlSquareSizeClasses.md,
                      isSelected ? "bg-accent font-semibold text-inverse" : "text-foreground hover:bg-background",
                      !isSelected && isToday && "font-semibold text-accent",
                    )}
                  >
                    {day.day}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
});
Calendar.displayName = "Calendar";

export interface DatePickerProps extends BaseInputProps {
  name?: string;
  form?: string;
  /** Selected date as an ISO `YYYY-MM-DD` string. */
  value?: CalendarDate;
  defaultValue?: CalendarDate;
  onValueChange?: (value: CalendarDate) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Override how the selected date is rendered in the trigger. */
  formatValue?: (value: CalendarDate) => ReactNode;
}

function defaultFormatValue(value: CalendarDate): ReactNode {
  const parsed = parseIsoDate(value);
  return parsed ? formatDayLabel(parsed) : value;
}

/**
 * A date field rendered as a popover-backed calendar. Integrates with the form
 * chrome (label, description, error) and emits ISO `YYYY-MM-DD` values.
 */
export const DatePicker = forwardRef<HTMLButtonElement, DatePickerProps>(function DatePicker(
  {
    id,
    name,
    form,
    label,
    description,
    error,
    status,
    counter,
    required,
    hideLabel,
    value,
    defaultValue,
    onValueChange,
    placeholder = "Select a date",
    disabled = false,
    formatValue = defaultFormatValue,
  },
  ref,
) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const { overlayNode } = usePortalRoots();
  const motionSettings = useChaseMotion();
  const [open, setOpen] = useState(false);
  const [selectedValue, setSelectedValue] = useControllableValue(value, defaultValue ?? "", onValueChange);

  const motionProps = resolveOverlayMotion(
    motionSettings,
    open,
    { opacity: 1, y: 0, scale: 1 },
    { opacity: 0, y: 8, scale: 0.98 },
  );

  const describedBy = fieldDescribedBy({ inputId, description, error, status, counter });

  const handleSelect = useCallback(
    (nextValue: CalendarDate) => {
      setSelectedValue(nextValue);
      setOpen(false);
    },
    [setSelectedValue],
  );

  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      status={status}
      counter={counter}
      required={required}
      hideLabel={hideLabel}
      htmlFor={inputId}
    >
      {name ? <input type="hidden" name={name} form={form} value={selectedValue ?? ""} disabled={disabled} /> : null}
      <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
        <PopoverPrimitive.Trigger
          id={inputId}
          ref={ref}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={!!error || undefined}
          aria-required={required || undefined}
          className={cx(
            controlClass,
            !!error && controlErrorClass,
            "inline-flex items-center justify-between gap-2 text-left",
          )}
        >
          <span className={cx("min-w-0 truncate", !selectedValue && "text-tertiary")}>
            {selectedValue ? formatValue(selectedValue) : placeholder}
          </span>
          <Icon name="calendar" size="sm" tone="secondary" />
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal container={overlayNode ?? undefined}>
          <PopoverPrimitive.Positioner sideOffset={8} className="z-popover">
            <PopoverPrimitive.Popup
              aria-label={typeof label === "string" ? label : "Choose date"}
              render={renderMotionDiv({
                initial: motionProps.initial,
                animate: motionProps.animate,
                transition: motionProps.transition,
                className: "modern-surface rounded-tokenLg border border-muted p-3 shadow-overlay",
              })}
            >
              <Calendar
                value={selectedValue || undefined}
                defaultFocusedDate={selectedValue || undefined}
                onValueChange={handleSelect}
                aria-label={typeof label === "string" ? label : "Choose date"}
              />
            </PopoverPrimitive.Popup>
          </PopoverPrimitive.Positioner>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </FieldChrome>
  );
});
DatePicker.displayName = "DatePicker";
