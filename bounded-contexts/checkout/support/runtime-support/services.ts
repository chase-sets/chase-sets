import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import { createCheckoutCartRuntime } from "../../features/cart/api/runtime";
import { createCheckoutSessionRuntime } from "../../features/sessions/api/runtime";

export type CheckoutServiceOptions = Readonly<Record<string, never>>;

export type CheckoutServices = Readonly<{
  cart: ReturnType<typeof createCheckoutCartRuntime>;
  sessions: ReturnType<typeof createCheckoutSessionRuntime>;
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createCheckoutServices(
  pool: PgTransactionalPool,
  _options: CheckoutServiceOptions = {},
): CheckoutServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const cart = createCheckoutCartRuntime({ eventStore, checkpointStore, db });
  const sessions = createCheckoutSessionRuntime({
    eventStore,
    checkpointStore,
    db,
    cart,
  });

  return {
    cart,
    sessions,
    projectors: [...cart.projectors, ...sessions.projectors],
    pool,
    db,
  };
}
