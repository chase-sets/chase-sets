import type { module as authModule } from "@chase-sets/auth";
import type { module as identityModule } from "@chase-sets/identity";
import type { module as inventoryModule } from "@chase-sets/inventory";
import type { module as termsModule } from "@chase-sets/commercial-terms";
import type { CatalogServices } from "@chase-sets/catalog/server";
import type { ChannelsServices } from "@chase-sets/channels/server";
import type { MarketplaceServices } from "@chase-sets/marketplace/server";
import type { PlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import {
  createListingAuthorityRecoveryCursorStore,
  type ListingAuthorityRecoveryCursor,
} from "@chase-sets/platform-runtime/listing-authority-recovery-cursor";
import type { WorkerRunner } from "@chase-sets/platform-runtime/worker";
import { createScheduledJobRunner } from "./scheduled-runners";

export function createListingAuthorityRecoveryRunners(
  services: Readonly<Record<string, unknown>>,
  controlPlane: PlatformControlPlane,
): readonly WorkerRunner[] {
  const runners: WorkerRunner[] = [];
  function register(
    owner: Parameters<typeof createListingAuthorityRecoveryCursorStore>[1],
    db: Parameters<typeof createListingAuthorityRecoveryCursorStore>[0],
    page: (
      cursor: ListingAuthorityRecoveryCursor,
    ) => Promise<{ cursor: ListingAuthorityRecoveryCursor; processed: number }>,
  ) {
    const cursors = createListingAuthorityRecoveryCursorStore(db, owner);
    runners.push(
      createScheduledJobRunner(`${owner}.listing-authority-recovery`, 1_000, controlPlane, async () => {
        const retained = await cursors.load();
        const result = await page(retained.cursor);
        await cursors.save(retained.revision, result.cursor);
        return result.processed;
      }),
    );
  }
  const auth = services.auth as ReturnType<typeof authModule.createServices> | undefined;
  const identity = services.identity as ReturnType<typeof identityModule.createServices> | undefined;
  const catalog = services.catalog as CatalogServices | undefined;
  const inventory = services.inventory as ReturnType<typeof inventoryModule.createServices> | undefined;
  const marketplace = services.marketplace as MarketplaceServices | undefined;
  const terms = services["commercial-terms"] as ReturnType<typeof termsModule.createServices> | undefined;
  const channels = services.channels as ChannelsServices | undefined;
  if (auth)
    register("auth", auth.db, async (cursor) => {
      const page = await auth.sessions.listingAuthority.recoverPage({
        after: cursor.eventAfter,
        tokenAfter: cursor.sqlAfter,
        limit: 100,
      });
      return { cursor: { eventAfter: page.after, sqlAfter: page.tokenAfter }, processed: page.outcomes.length };
    });
  if (identity)
    register("identity", identity.db, async (cursor) => {
      const page = await identity.listingAuthority.recoverPage({
        after: cursor.eventAfter,
        credentialAfter: cursor.sqlAfter,
        limit: 100,
      });
      return { cursor: { eventAfter: page.after, sqlAfter: page.credentialAfter }, processed: page.outcomes.length };
    });
  for (const [owner, service] of [
    ["catalog", catalog],
    ["inventory", inventory],
    ["marketplace", marketplace],
    ["commercial-terms", terms],
  ] as const) {
    if (!service) continue;
    register(owner, service.db, async (cursor) => {
      const page = await service.listingAuthority.recover({ after: cursor.eventAfter, limit: 100 });
      return { cursor: { eventAfter: page.nextCursor ?? "0", sqlAfter: "" }, processed: page.outcomes.length };
    });
  }
  if (channels)
    register("channels", channels.db, async (cursor) => {
      const afterGlobalPosition = cursor.eventAfter as NonNullable<
        Parameters<ChannelsServices["connections"]["recoverAuthorityPage"]>[0]["afterGlobalPosition"]
      >;
      const page = await channels.connections.recoverAuthorityPage({ afterGlobalPosition });
      return { cursor: { eventAfter: page.nextCursor ?? "0", sqlAfter: "" }, processed: page.processed };
    });
  if (catalog)
    runners.push(
      createScheduledJobRunner("catalog.product-measure-authority-reconciliation", 1_000, controlPlane, () =>
        catalog.productMeasures.reconcileProfileAuthority(),
      ),
    );
  return runners;
}
