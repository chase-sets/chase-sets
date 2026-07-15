import { defineBoundedContextTestConfig } from "../../../vitest.shared.mjs";

// Uses the canonical bounded-context include (features/routes/support/tests,
// both .ts and .tsx), so the import-batches and inventory-items UI suites run
// alongside the domain/read-model suites.
export default defineBoundedContextTestConfig();
