import { uniqueStrings } from "./unique-strings";

export function uniqueDisplayValues(values: readonly string[]): string[] {
  return uniqueStrings(
    values
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}
