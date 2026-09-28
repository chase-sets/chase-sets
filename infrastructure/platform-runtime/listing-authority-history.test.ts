import { describe, it } from "vitest";
import { listingAuthorityHistoryConformance } from "./listing-authority-history-conformance";
import { historyFixture } from "./listing-authority-history-test-support";

describe("owner-neutral retained history class sweep", () => listingAuthorityHistoryConformance(it, historyFixture));
