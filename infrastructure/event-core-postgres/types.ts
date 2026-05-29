export type PgQueryResult<Row> = Readonly<{
  rows: Row[];
  rowCount?: number | null;
}>;

export interface PgQueryFunction {
  <Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>>;
  (text: string, values?: readonly unknown[]): Promise<PgQueryResult<Record<string, unknown>>>;
}

export type PgQueryable = Readonly<{
  query: PgQueryFunction;
}>;

export type PgPoolClient = PgQueryable &
  Readonly<{
    release: () => void;
  }>;

export type PgTransactionalPool = PgQueryable &
  Readonly<{
    connect: () => Promise<PgPoolClient>;
  }>;

export async function withPgTransaction<T>(
  pool: PgTransactionalPool,
  work: (client: PgPoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
