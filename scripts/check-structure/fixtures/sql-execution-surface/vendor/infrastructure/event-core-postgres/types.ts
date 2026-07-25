export type PgQueryable = Readonly<{
  query: (text: string) => Promise<unknown>;
}>;
