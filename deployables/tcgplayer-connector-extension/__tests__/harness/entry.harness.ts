import { observation } from "./observation";
import * as product from "../../src/background";

export { background, retentionStore, boot } from "../../src/background";
export const harness = { observation, product };
Reflect.set(globalThis, "__connectorHarness", harness);
