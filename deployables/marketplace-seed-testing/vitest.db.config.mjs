import base from "./tests/vitest.config.mjs";
import { defineDbTestConfig } from "../../vitest.shared.mjs";

export default defineDbTestConfig(base, ["tests/**/*.test.ts"]);
