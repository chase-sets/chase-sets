export function toMotionDomProps<Props extends object>(props: Props): Record<string, unknown> {
  return props as unknown as Record<string, unknown>;
}
