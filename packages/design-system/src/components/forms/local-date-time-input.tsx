import { forwardRef, useEffect, useRef, useState, type ChangeEvent } from "react";
import { HiddenInput } from "./hidden-input";
import { TextInput, type TextInputProps } from "./text-input";

/**
 * Reads a `datetime-local` value (a wall-clock time with no zone, such as
 * `2026-11-10T09:00`) in this runtime's time zone and returns the instant as
 * ISO-8601 UTC, or "" when it is empty or not a time. Only meaningful in the
 * browser, where the runtime's zone is the operator's.
 */
export function localDateTimeToInstant(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) {
    return "";
  }
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const local = new Date(year, month - 1, day, hour, minute, second);
  // A date that rolled over (February 30) or a wall-clock time a clock change skips is not the time typed.
  if (
    local.getFullYear() !== year ||
    local.getMonth() !== month - 1 ||
    local.getDate() !== day ||
    local.getHours() !== hour ||
    local.getMinutes() !== minute
  ) {
    return "";
  }
  return local.toISOString();
}

/**
 * The `datetime-local` value showing `instant` in this runtime's time zone, or
 * "" when it is not a time.
 */
export function instantToLocalDateTime(instant: string): string {
  const date = new Date(instant);
  if (!instant || Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function isoInstant(value: string | null): string {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
}

export interface LocalDateTimeInputProps extends Omit<
  TextInputProps,
  "type" | "name" | "value" | "defaultValue" | "onChange"
> {
  /** The form field that carries the instant (ISO-8601 UTC) the operator meant. */
  name: string;
  /** The instant to show, in the operator's zone. */
  defaultInstant?: string | null;
}

/**
 * A date and time the operator enters in their own time zone. The visible
 * `datetime-local` control holds a wall-clock time with no zone; the browser
 * reads it in its own zone and the form sends the instant in `name`, so a
 * server never guesses a zone (the shown value is `${name}Local`). The server
 * draws the control empty: the browser's zone is known only once it hydrates,
 * when the control shows `defaultInstant`. Until then `name` keeps
 * `defaultInstant`, so a form saved unchanged keeps the time it had.
 */
export const LocalDateTimeInput = forwardRef<HTMLInputElement, LocalDateTimeInputProps>(function LocalDateTimeInput(
  { name, defaultInstant = null, ...rest },
  ref,
) {
  const [local, setLocal] = useState("");
  // A saved time may come as database text ("2026-11-10 09:00:00+00"); it is sent back as ISO UTC.
  const [instant, setInstant] = useState(() => isoInstant(defaultInstant));
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current) {
      return;
    }
    hydrated.current = true;
    setLocal(defaultInstant ? instantToLocalDateTime(defaultInstant) : "");
  }, [defaultInstant]);

  function change(event: ChangeEvent<HTMLInputElement>) {
    setLocal(event.target.value);
    setInstant(localDateTimeToInstant(event.target.value));
  }

  return (
    <>
      <TextInput {...rest} ref={ref} type="datetime-local" name={`${name}Local`} value={local} onChange={change} />
      <HiddenInput name={name} value={instant} />
    </>
  );
});
LocalDateTimeInput.displayName = "LocalDateTimeInput";
