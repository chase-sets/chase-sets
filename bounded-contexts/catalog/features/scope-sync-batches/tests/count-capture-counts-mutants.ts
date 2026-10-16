import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withPgTransaction } from "@chase-sets/event-core-postgres";
import * as http from "@chase-sets/platform-runtime/http";
import * as transport from "../../source-observations/api/providers/count-capture-transport";
import * as adapter from "../../source-observations/api/providers/scrydex/adapter";
import * as acquisition from "../domain/count-acquisition";
import * as plan from "../domain/count-capture-plan";
import * as receipt from "../domain/count-lifecycle-receipt";
import { normalizeScopeSyncBatchBudget } from "../domain/batch";
import * as store from "../read-model/count-capture-store";
import { createCountCaptureLifecycle } from "../api/count-capture-lifecycle";
import { collectCountCapturePlannerRead } from "../api/count-capture-context";
import { decodedReceiptText } from "../domain/preview-probe-receipt";
import { guardDisabledMutant } from "./count-capture-mutants";

type Replacements = readonly (readonly [string, string])[];

export const captureStoreMutant = (replacements: Replacements) =>
  guardDisabledMutant<typeof store.createCountCaptureStore>(
    "../read-model/count-capture-store.ts",
    replacements,
    "createCountCaptureStore",
    {
      randomUUID,
      z,
      withPgTransaction,
      ...transport,
      ...acquisition,
      ...plan,
      countCaptureAuthoritySchema: receipt.countCaptureAuthoritySchema,
      countLifecycleReceiptSchema: receipt.countLifecycleReceiptSchema,
      countLifecycleStopReceiptSchema: receipt.countLifecycleStopReceiptSchema,
      SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY:
        adapter.SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY: adapter.SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
      SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY:
        adapter.SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    },
  );

export const captureLifecycleMutant = (replacements: Replacements, overrides: Readonly<Record<string, unknown>> = {}) =>
  guardDisabledMutant<typeof createCountCaptureLifecycle>(
    "../api/count-capture-lifecycle.ts",
    replacements,
    "createCountCaptureLifecycle",
    {
      randomUUID,
      z,
      ...http,
      ...transport,
      ...acquisition,
      ...plan,
      ...receipt,
      countCaptureSendCap: store.countCaptureSendCap,
      countCapturePhaseCaps: store.countCapturePhaseCaps,
      normalizeScopeSyncBatchBudget,
      collectCountCapturePlannerRead,
      ...overrides,
    },
  );

export const captureEffectsMutant = () =>
  guardDisabledMutant<Pick<typeof receipt, "classifyCountLifecycleReceipt" | "validateCountLifecycleReceipt">>(
    "../domain/count-lifecycle-receipt.ts",
    [
      ["if (evidence.effects && !effectsUnchanged(evidence.effects))", "if (false)"],
      ['else if (!effectsUnchanged(effects)) fail("unexpected-effects");', ""],
    ],
    "({ classifyCountLifecycleReceipt, validateCountLifecycleReceipt })",
    { z, ...acquisition, ...plan, decodedReceiptText },
  );
