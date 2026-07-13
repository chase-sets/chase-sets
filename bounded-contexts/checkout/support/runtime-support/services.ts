import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { PostageLabelProvider } from "@chase-sets/postage-labels";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { RateLimitRuleResolver } from "@chase-sets/http/rate-limit";
import { createCheckoutCommercialTermsResolver } from "../../api";
import { createCheckoutCartRuntime } from "../../features/cart/api/runtime";
import { createCheckoutSellListRuntime } from "../../features/sell-list/api/runtime";
import type { CheckoutCommercialTermsResolver } from "../../features/sell-list/read-model/queries";
import type { CheckoutObservabilityTelemetry } from "../../features/sessions/api/checkout-observability-telemetry";
import { createCheckoutSessionRuntime } from "../../features/sessions/api/runtime";
import { createCheckoutSupportLookupRuntime } from "../../features/support-lookup/api/runtime";

export type CheckoutHostPorts = Readonly<{
  checkoutObservabilityTelemetry?: CheckoutObservabilityTelemetry;
  commercialTermsResolver?: CheckoutCommercialTermsResolver;
  addressVerificationProvider?: PostageLabelProvider | null;
  rateLimitPolicyResolver?: RateLimitRuleResolver;
  paymentProcessorPublicConfiguration?: Readonly<{ publishableKey: string | null }>;
}>;

export type CheckoutServices = Readonly<{
  cart: ReturnType<typeof createCheckoutCartRuntime>;
  sellList: ReturnType<typeof createCheckoutSellListRuntime>;
  sessions: ReturnType<typeof createCheckoutSessionRuntime>;
  supportLookup: ReturnType<typeof createCheckoutSupportLookupRuntime>;
  checkoutObservabilityTelemetry?: CheckoutObservabilityTelemetry;
  rateLimitPolicyResolver?: RateLimitRuleResolver;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createCheckoutServices(pool: PgTransactionalPool, ports: CheckoutHostPorts = {}): CheckoutServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "checkout" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const commercialTermsResolver = ports.commercialTermsResolver ?? createCheckoutCommercialTermsResolver(db);
  const cart = createCheckoutCartRuntime({ eventStore, checkpointStore, db });
  const sellList = createCheckoutSellListRuntime({ eventStore, checkpointStore, db, commercialTermsResolver });
  const sessions = createCheckoutSessionRuntime({
    eventStore,
    checkpointStore,
    db,
    cart,
    addressVerificationProvider: ports.addressVerificationProvider,
    paymentProcessorPublicConfiguration: ports.paymentProcessorPublicConfiguration,
  });
  const supportLookup = createCheckoutSupportLookupRuntime({ db });

  return {
    cart,
    sellList,
    sessions,
    supportLookup,
    checkoutObservabilityTelemetry: ports.checkoutObservabilityTelemetry,
    rateLimitPolicyResolver: ports.rateLimitPolicyResolver,
    projectors: [...cart.projectors, ...sellList.projectors, ...sessions.projectors],
    pool,
    db,
  };
}
