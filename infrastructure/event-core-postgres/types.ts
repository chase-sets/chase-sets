export type PgQueryResult<Row> = Readonly<{
  rows: Row[];
  rowCount: number | null;
}>;

export type PgQueryable = Readonly<{
  query: <Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<PgQueryResult<Row>>;
}>;

export type PgPoolClient = PgQueryable &
  Readonly<{
    release: () => void;
  }>;

export type PgTransactionalPool = PgQueryable &
  Readonly<{
    connect: () => Promise<PgPoolClient>;
  }>;
