import type { PgPoolClient, PgQueryResult, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { OperatorSessionRequestError } from "./request";

const lockId = "84518450";
const unavailable = () => new OperatorSessionRequestError("custody-unavailable", 503);

export async function withOperatorSessionBackend<T>(
  pool: PgTransactionalPool,
  work: (bound: PgTransactionalPool) => Promise<T>,
): Promise<T> {
  let client: PgPoolClient | undefined;
  let poisoned = false;
  let locked = false;
  let released = false;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = poisoned = true;
      if (client && !released) {
        released = true;
        client.release(unavailable());
      }
      reject(unavailable());
    }, 5000);
  });
  try {
    await Promise.race([
      pool.connect().then((value) => {
        if (expired) {
          value.release(unavailable());
          throw unavailable();
        }
        client = value;
      }),
      deadline,
    ]);
    const boundClient: PgPoolClient = {
      async query<Row>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>> {
        if (poisoned || released || !client) throw unavailable();
        try {
          return await client.query<Row>(text, values);
        } catch {
          // Includes lost COMMIT acknowledgement. ROLLBACK cannot establish its outcome.
          poisoned = true;
          throw unavailable();
        }
      },
      release(error) {
        if (error !== undefined) poisoned = true;
      },
    };
    const bound: PgTransactionalPool = {
      query: boundClient.query,
      async connect() {
        if (poisoned || released) throw unavailable();
        return boundClient;
      },
      idleInTransactionSessionTimeoutMillis: pool.idleInTransactionSessionTimeoutMillis,
    };
    while (!locked) {
      const result = await Promise.race([
        bound.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS locked", [lockId]),
        deadline,
      ]);
      locked = result.rows[0]?.locked === true;
      if (!locked) await Promise.race([new Promise((resolve) => setTimeout(resolve, 20)), deadline]);
    }
    clearTimeout(timer);
    return await work(bound);
  } finally {
    clearTimeout(timer);
    if (client && !released) {
      if (locked && !poisoned) {
        try {
          const result = await client.query<{ unlocked: boolean }>(
            "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
            [lockId],
          );
          if (result.rows[0]?.unlocked !== true) poisoned = true;
        } catch {
          poisoned = true;
        }
      }
      released = true;
      client.release(poisoned ? unavailable() : undefined);
    }
    if (poisoned) throw unavailable();
  }
}
