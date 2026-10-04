import base from "./tests/vitest.config.mjs";
import db from "./vitest.db.config.mjs";
import { defineUnitTestConfig } from "../../vitest.shared.mjs";

export default defineUnitTestConfig(base, db);
