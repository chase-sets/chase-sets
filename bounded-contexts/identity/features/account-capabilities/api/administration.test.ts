import { createInMemoryEventStore } from "../../../tests/in-memory-event-store";
import { defineAssignmentContract } from "./assignment-contract.test-support";

defineAssignmentContract(async () => createInMemoryEventStore());
