import { hashMarketplaceRequest } from "../../mutation-recovery/api/attempt";
import type { MarketplaceReporterKind } from "../domain/domain";

export function marketplaceReporterFingerprint(kind: MarketplaceReporterKind, key: string): string {
  return `${kind}:${hashMarketplaceRequest([kind, key.trim()])}`;
}
