import base from "./vitest.config.ts";
import { defineDbTestConfig } from "../../vitest.shared.mjs";

export default defineDbTestConfig(base, ["**/*.db.test.ts"]);
