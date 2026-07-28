import { fileURLToPath } from "node:url";
import { acquireHeavySlot } from "./heavy-slot.mjs";

export const heavySlotScriptBatteryGlobalSetupPath = fileURLToPath(import.meta.url);

export default function setupScriptBatteryHeavySlot(_project, options = {}) {
  acquireHeavySlot("script-battery", options);
}
