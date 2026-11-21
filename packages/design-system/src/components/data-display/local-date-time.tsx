import { useEffect, useState, type ReactNode } from "react";

const DISPLAY: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
};

export interface LocalDateTimeProps {
  /** An ISO-8601 instant. */
  value: string;
  /** BCP 47 locale for the text. Defaults to "en". */
  locale?: string;
  /** Text for a value that is not an instant. Defaults to the value itself. */
  fallback?: string;
  /** Places the time's text in a sentence, such as a translated "Scheduled for {time}". */
  children?: (text: string) => ReactNode;
}

/**
 * An instant shown in the reader's time zone. The server does not know that
 * zone, so it writes the time in UTC and says so ("Nov 10, 2026, 3:00 PM UTC",
 * as `formatDateTime` does); once the page hydrates the browser writes it in
 * its own zone with the zone's name ("Nov 10, 2026, 9:00 AM CST"). Pairs with
 * `LocalDateTimeInput`, so a time an operator entered reads back as entered.
 */
export function LocalDateTime({ value, locale = "en", fallback, children }: LocalDateTimeProps) {
  const [inBrowser, setInBrowser] = useState(false);
  useEffect(() => setInBrowser(true), []);

  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    const text = fallback ?? value;
    return <>{children ? children(text) : text}</>;
  }
  const text = inBrowser
    ? new Intl.DateTimeFormat(locale, { ...DISPLAY, timeZoneName: "short" }).format(date)
    : `${new Intl.DateTimeFormat(locale, { ...DISPLAY, timeZone: "UTC" }).format(date)} UTC`;
  return <time dateTime={date.toISOString()}>{children ? children(text) : text}</time>;
}
