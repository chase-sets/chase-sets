import * as crypto from "node:crypto";
import * as postgres from "@chase-sets/event-core-postgres";
import * as projector from "@chase-sets/event-core/projector";
import * as listingCompositionQueries from "../../listing-composition/read-model/queries";
import * as tcgplayerCsvRuntime from "../../tcgplayer-csv/api/runtime";
import * as composition from "../../tcgplayer-csv/domain/composition";
import * as csv from "../../tcgplayer-csv/domain/csv";
import * as contracts from "../../tcgplayer-csv/domain/contracts";
import * as codec from "../../tcgplayer-csv/domain/codec";
import * as derivedSnapshot from "../../tcgplayer-csv/domain/derived-snapshot";
import * as lifecycle from "../../tcgplayer-csv/domain/lifecycle";
import * as validation from "../../tcgplayer-csv/domain/validation";
import * as snapshotQueries from "../../tcgplayer-csv/read-model/queries";
import * as projection from "../../tcgplayer-csv/read-model/projection";
import type { createTcgplayerLiveExportSnapshotRuntime } from "../api/runtime";
import type { persistTcgplayerExportSnapshot } from "../../tcgplayer-csv/api/runtime";
import type { evaluateSnapshotAge } from "../../reconciliation/domain/snapshot-age";
import { loadMutant } from "./mutant-loader";

/** The consumer with one control rewritten; every other import is the real owner. */
export function consumerMutant(anchor: string, replacement: string): typeof createTcgplayerLiveExportSnapshotRuntime {
  return loadMutant<{ createTcgplayerLiveExportSnapshotRuntime: typeof createTcgplayerLiveExportSnapshotRuntime }>(
    new URL("../api/runtime.ts", import.meta.url),
    anchor,
    replacement,
    {
      "node:crypto": crypto,
      "@chase-sets/event-core-postgres": postgres,
      "../../tcgplayer-csv/api/runtime": tcgplayerCsvRuntime,
      "../../tcgplayer-csv/domain/derived-snapshot": derivedSnapshot,
    },
  ).createTcgplayerLiveExportSnapshotRuntime;
}

/** The #7029 persistence half with one control rewritten. */
export function persistMutant(anchor: string, replacement: string): typeof persistTcgplayerExportSnapshot {
  return loadMutant<{ persistTcgplayerExportSnapshot: typeof persistTcgplayerExportSnapshot }>(
    new URL("../../tcgplayer-csv/api/runtime.ts", import.meta.url),
    anchor,
    replacement,
    {
      "@chase-sets/event-core-postgres": postgres,
      "@chase-sets/event-core/projector": projector,
      "../../listing-composition/read-model/queries": listingCompositionQueries,
      "../domain/composition": composition,
      "../domain/csv": csv,
      "../domain/contracts": contracts,
      "../domain/codec": codec,
      "../domain/lifecycle": lifecycle,
      "../domain/validation": validation,
      "../read-model/queries": snapshotQueries,
      "../read-model/projection": projection,
    },
  ).persistTcgplayerExportSnapshot;
}

/** The reconciliation age reader with one control rewritten. */
export function ageReaderMutant(anchor: string, replacement: string): typeof evaluateSnapshotAge {
  return loadMutant<{ evaluateSnapshotAge: typeof evaluateSnapshotAge }>(
    new URL("../../reconciliation/domain/snapshot-age.ts", import.meta.url),
    anchor,
    replacement,
    {},
  ).evaluateSnapshotAge;
}
