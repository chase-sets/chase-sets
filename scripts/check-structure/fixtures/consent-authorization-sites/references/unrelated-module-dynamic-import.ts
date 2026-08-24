export const unrelatedTemplateImport = import(
  `../../bounded-contexts/identity/features/consents/domain/unrelated-module`
);
export const unrelatedConstantImport = import(unrelatedDynamicSpecifier);
export const unrelatedConcatenatedImport = import(unrelatedDynamicRoot + "unrelated-module");

const unrelatedDynamicSpecifier = "../../bounded-contexts/identity/features/consents/domain/unrelated-module";
const unrelatedDynamicRoot = "../../bounded-contexts/identity/features/consents/domain/";
