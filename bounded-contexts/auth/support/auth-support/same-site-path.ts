const PATH_VALIDATION_ORIGIN = "https://auth.chasesets.invalid";

export function getSafeSameSitePath(value: unknown, options: Readonly<{ trim?: boolean }> = {}): string | null {
  if (
    typeof value !== "string" ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return character === "\\" || code <= 0x1f || code === 0x7f;
    })
  ) {
    return null;
  }

  const path = options.trim ? value.trim() : value;
  if (!path.startsWith("/") || path.startsWith("//")) {
    return null;
  }

  return new URL(path, PATH_VALIDATION_ORIGIN).origin === PATH_VALIDATION_ORIGIN ? path : null;
}
