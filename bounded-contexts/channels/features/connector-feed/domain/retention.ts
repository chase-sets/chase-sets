import { connectorInboundKinds, type ConnectorInboundKind } from "./transport";

const DAY_SECONDS = 86_400;

// Elapsed seconds after server admission. Never calendar days: a day-valued
// interval follows the session time zone across DST.
export const connectorInboundRetentionWindowSeconds = Object.freeze({
  "inventory-snapshot": 7 * DAY_SECONDS,
  "order-observation": 90 * DAY_SECONDS,
});
export type ConnectorInboundRetentionClass = keyof typeof connectorInboundRetentionWindowSeconds;
export type ConnectorInboundKindRetention = Readonly<{
  inboundKind: ConnectorInboundKind;
  retentionClass: ConnectorInboundRetentionClass;
}>;
export type ResolvedConnectorInboundRetentionClass = Readonly<{
  retentionClass: ConnectorInboundRetentionClass;
  windowSeconds: number;
  inboundKinds: readonly ConnectorInboundKind[];
}>;

export const connectorInboundKindRetention: readonly ConnectorInboundKindRetention[] = Object.freeze([
  Object.freeze({ inboundKind: "export", retentionClass: "inventory-snapshot" }),
  Object.freeze({ inboundKind: "order", retentionClass: "order-observation" }),
  Object.freeze({ inboundKind: "channel-order-fulfillment-observation/v1", retentionClass: "order-observation" }),
]);

export class ConnectorInboundRetentionRegistryError extends Error {
  constructor(
    readonly code: "invalid-registration" | "unknown-kind" | "unknown-class" | "duplicate-kind" | "missing-kind",
  ) {
    super(`connector-inbound-retention-${code}`);
  }
}

/** Exactly one known class for every admitted kind; anything else refuses before a sweep or write exists. */
export function resolveConnectorInboundRetentionClasses(
  registrations: readonly unknown[],
): readonly ResolvedConnectorInboundRetentionClass[] {
  const classByKind = new Map<ConnectorInboundKind, ConnectorInboundRetentionClass>();
  for (const registration of registrations) {
    if (!registration || typeof registration !== "object" || Array.isArray(registration))
      refuse("invalid-registration");
    const keys = Object.keys(registration).sort();
    if (keys.join(",") !== "inboundKind,retentionClass") refuse("invalid-registration");
    const { inboundKind, retentionClass } = registration as Record<string, unknown>;
    if (!connectorInboundKinds.some((kind) => kind === inboundKind)) refuse("unknown-kind");
    if (typeof retentionClass !== "string" || !Object.hasOwn(connectorInboundRetentionWindowSeconds, retentionClass))
      refuse("unknown-class");
    const kind = inboundKind as ConnectorInboundKind;
    if (classByKind.has(kind)) refuse("duplicate-kind");
    classByKind.set(kind, retentionClass as ConnectorInboundRetentionClass);
  }
  if (connectorInboundKinds.some((kind) => !classByKind.has(kind))) refuse("missing-kind");
  const classes = Object.keys(connectorInboundRetentionWindowSeconds) as ConnectorInboundRetentionClass[];
  return classes.flatMap((retentionClass) => {
    const inboundKinds = connectorInboundKinds.filter((kind) => classByKind.get(kind) === retentionClass);
    return inboundKinds.length === 0
      ? []
      : [{ retentionClass, windowSeconds: connectorInboundRetentionWindowSeconds[retentionClass], inboundKinds }];
  });
}

export const connectorInboundRetentionClasses = Object.freeze(
  Object.fromEntries(
    resolveConnectorInboundRetentionClasses(connectorInboundKindRetention).flatMap(
      ({ retentionClass, windowSeconds, inboundKinds }) =>
        inboundKinds.map((kind) => [kind, Object.freeze({ retentionClass, windowSeconds })]),
    ),
  ) as Record<
    ConnectorInboundKind,
    Readonly<{ retentionClass: ConnectorInboundRetentionClass; windowSeconds: number }>
  >,
);

function refuse(code: ConnectorInboundRetentionRegistryError["code"]): never {
  throw new ConnectorInboundRetentionRegistryError(code);
}
