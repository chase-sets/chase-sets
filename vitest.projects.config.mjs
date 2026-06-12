import { defineConfig } from "vitest/config";
import { buildVitestProjects } from "./scripts/lib/vitest-projects.mjs";

// One projects-mode run for the whole non-DB test tier (issue #1419): a single
// process pool and shared transform cache replace 57 cold per-workspace vitest
// spawns. Run it through `pnpm run verify:test`, which loads the test
// environment first; per-workspace test scripts remain for targeted runs.
export default defineConfig({
  test: {
    projects: buildVitestProjects(),
  },
});
