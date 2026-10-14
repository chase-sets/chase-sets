export type { UserPreferences } from "../domain/domain";
export type { PreferenceChanges } from "../domain/domain";
export type { PreferenceWriteReceipt } from "../domain/write-attempt";

import type { UserPreferences } from "../domain/domain";
import type { PreferenceWriteReceipt } from "../domain/write-attempt";

export type PreferenceWriteResponse = Readonly<{
  id: string;
  version: number;
  status: "updated" | "unchanged";
  receipt: PreferenceWriteReceipt;
  replayed: boolean;
  preferences: UserPreferences;
}>;
