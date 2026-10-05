import base from "./vitest.config.ts";
import { defineDbTestConfig } from "../../vitest.shared.mjs";

export default defineDbTestConfig(base, ["**/*.db.test.ts", "**/*.db.test.tsx"], {
  maxWorkers: 3,
  globalSetup: ["./scripts/bootstrap-db-enrollment-setup.mjs"],
});
