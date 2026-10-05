import base from "./vitest.config.ts";
import { defineDbTestConfig } from "../../vitest.shared.mjs";

export default defineDbTestConfig(
  base,
  ["__tests__/db/unit-2/**/*.db.test.ts", "__tests__/db/unit-2/**/*.db.test.tsx"],
  {
    maxWorkers: 3,
    globalSetup: ["./scripts/bootstrap-db-enrollment-setup.mjs"],
  },
);
