export const unrelatedTemplateRequire = require(
  `../../bounded-contexts/identity/features/consents/domain/unrelated-module`,
);
export const unrelatedConstantRequire = require(unrelatedRequireSpecifier);
export const unrelatedConcatenatedRequire = require(unrelatedRequireRoot + "unrelated-module");

const unrelatedRequireSpecifier = "../../bounded-contexts/identity/features/consents/domain/unrelated-module";
const unrelatedRequireRoot = "../../bounded-contexts/identity/features/consents/domain/";
