import { deriveTypeScriptOwnerContexts } from "../../typescript-owner-context-derivation.mjs";

const derived = deriveTypeScriptOwnerContexts({ resolutionRoot, lockfilePath });
expect(actual).toEqual(derived.runtimeKinds);
