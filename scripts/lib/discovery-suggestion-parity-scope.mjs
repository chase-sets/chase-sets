import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const search = "bounded-contexts/discovery/features/search/";
const patterns = [
  /^suggestion-backend\/(?!.*\.md$)/,
  /^api\/(?:route(?:\.test)?|runtime)\.ts$/,
  /^domain\/(?:normalization|protected-search-tokens|query-vocabulary-policy|search-synonyms)\.ts$/,
  /^read-model\/(?:queries(?:\.db\.test)?|schema|suggestions(?:\.test)?)\.ts$/,
  /^read-model\/suggestion-parity\.fixture\.json$/,
];
const support =
  /^bounded-contexts\/discovery\/support\/(?:client-support\/contracts|item-support\/route|runtime-support\/services)\.ts$/;
const cargoConfiguration =
  /^(?:bounded-contexts\/(?:discovery\/(?:features\/(?:search\/)?)?)?)?(?:rust-toolchain(?:\.toml)?|\.cargo\/config(?:\.toml)?)$/;

export function touchesDiscoverySuggestionParity(files) {
  return files.some(
    (file) =>
      file === ".github/workflows/platform-pr.yml" ||
      file === "scripts/lib/discovery-suggestion-parity-scope.mjs" ||
      support.test(file) ||
      cargoConfiguration.test(file) ||
      (file.startsWith(search) && patterns.some((pattern) => pattern.test(file.slice(search.length)))),
  );
}

export function shouldRunDiscoverySuggestionParity(changedFilesJson) {
  let files;
  try {
    files = JSON.parse(changedFilesJson);
  } catch {
    return true;
  }
  // The existing scope producer sends an empty list when derivation was unavailable.
  return (
    !Array.isArray(files) ||
    files.length === 0 ||
    files.some((file) => typeof file !== "string" || !file) ||
    touchesDiscoverySuggestionParity(files)
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(shouldRunDiscoverySuggestionParity(process.env.CHANGED_FILES_JSON));
}
