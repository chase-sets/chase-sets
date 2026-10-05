import base from "./vitest.config.mjs";
import { defineDbTestConfig } from "../../../vitest.shared.mjs";

export default defineDbTestConfig(base, ["**/*.db.test.ts", "**/*.db.test.tsx"]);
