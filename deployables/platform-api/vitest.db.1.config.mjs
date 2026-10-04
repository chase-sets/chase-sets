import base from "./vitest.config.ts";
import { defineDbTestConfig } from "../../vitest.shared.mjs";

export default defineDbTestConfig(base, ["__tests__/db/unit-1/**/*.db.test.ts"], {
  maxWorkers: 3,
  globalSetup: ["./scripts/bootstrap-db-enrollment-setup.mjs"],
});
