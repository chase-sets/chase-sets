import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectStructuralRedeclarations,
  listTrackedProductionSources,
  publicationContractsPath,
  repoRoot,
} from "./source-evidence";

describe("channel-publication-no-redeclaration", () => {
  it("scans every production source and kills a differently named, differently written sibling shape", () => {
    const files = listTrackedProductionSources();
    const contractsSource = readFileSync(path.join(repoRoot, publicationContractsPath), "utf8");
    expect(files.size).toBeGreaterThan(0);
    expect(files.has("bounded-contexts/channels/index.ts")).toBe(true);
    expect(collectStructuralRedeclarations(files, contractsSource)).toEqual([]);

    const siblingMutant = new Map(files);
    siblingMutant.set(
      "bounded-contexts/neutral/features/alpha/domain/payload.ts",
      [
        'import type { ChannelPublicationAttribute, ChannelPublicationPrice } from "@chase-sets/channels";',
        "export interface OutboundSnapshot {",
        "  readonly attributes: readonly ChannelPublicationAttribute[];",
        "  readonly quantity: number;",
        "  readonly price: ChannelPublicationPrice;",
        "  readonly conditionKey: string;",
        "  readonly categoryKey: string;",
        "  readonly description: string;",
        "  readonly title: string;",
        "  readonly listingRevision: number;",
        "  readonly channelListingId: string;",
        "}",
      ].join("\n"),
    );
    expect(collectStructuralRedeclarations(siblingMutant, contractsSource)).toContain(
      "bounded-contexts/neutral/features/alpha/domain/payload.ts:OutboundSnapshot->ChannelPublicationDraft",
    );
  });
});
