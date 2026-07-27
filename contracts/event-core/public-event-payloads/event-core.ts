// Event-core-owned payload primitive shared across context shards (auth and
// marketplace register events with it). It belongs to no single context, so it stays
// with the aggregate rather than moving into a context module.

export type EmptyEventPayload = Readonly<Record<string, never>>;
