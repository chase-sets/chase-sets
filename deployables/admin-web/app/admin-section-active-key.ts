export type ActiveKeyConfig = Readonly<{
  defaultActiveKey: string;
  // Maps a section-relative path (one or more segments joined by "/") to the nav
  // key it should activate. Nested surfaces register their joined sub-path (e.g.
  // "integrations/providers") so the side nav highlights the exact nested child.
  activeKeys?: Readonly<Record<string, string>>;
}>;

// Resolve the active nav key from an admin section pathname. The first path
// segment is the section (e.g. "catalog"); the remaining segments identify the
// surface within it. Nested surfaces map their joined sub-path to a child nav key,
// checked most-specific first, so the design-system SideNav highlights and expands
// the exact nested child (e.g. /catalog/integrations/providers -> the Provider
// setup child under Integrations). Falls back to the first sub-segment, then the
// section default.
export function resolveActiveKey(pathname: string, config: ActiveKeyConfig): string {
  const subSegments = pathname.split("/").filter(Boolean).slice(1);

  for (let depth = subSegments.length; depth >= 1; depth -= 1) {
    const mappedKey = config.activeKeys?.[subSegments.slice(0, depth).join("/")];
    if (mappedKey) {
      return mappedKey;
    }
  }

  return subSegments[0] ?? config.defaultActiveKey;
}
