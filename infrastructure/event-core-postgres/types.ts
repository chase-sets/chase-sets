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
    release: (error?: unknown) => void;
  }>;

export type PgTransactionalPool = PgQueryable &
  Readonly<{
    connect: () => Promise<PgPoolClient>;
  }>;

export async function withPgTransaction<T>(
  pool: PgTransactionalPool,
  work: (client: PgPoolClient) => Promise<T>,
  options: Readonly<{
    afterCommit?: (client: PgPoolClient, result: T) => Promise<void>;
  }> = {},
): Promise<T> {
  const client = await pool.connect();
  let committed = false;
  let releaseError: unknown;

  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    committed = true;
    await options.afterCommit?.(client, result);
    return result;
  } catch (error) {
    releaseError = error;
    if (!committed) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}
