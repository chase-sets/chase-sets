import assert from "node:assert";
import { deriveTypeScriptOwnerContexts } from "../../typescript-owner-context-derivation.mjs";

const derived = deriveTypeScriptOwnerContexts({ resolutionRoot, lockfilePath });
expect(actual).toContain(derived.runtimeKinds);
assert.deepStrictEqual(actual, derived.runtimeKinds);
