import { vi } from "vitest";

export const reserveOrderInventoryRequest: typeof import("../../reservations/api/order-reservation-workflow").reserveOrderInventoryRequest =
  async (...args) =>
    (await import("../../reservations/api/order-reservation-workflow")).reserveOrderInventoryRequest(...args);

const control = vi.hoisted(() => ({ omit: (): boolean => false }));
export const inventoryWriterProbe = control;

vi.mock("../api/stock-reservations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/stock-reservations")>();
  const create: typeof actual.createInventoryStockReservations = (...args) => {
    const enrolled = actual.createInventoryStockReservations(...args);
    const raw = args[1];
    return {
      ...enrolled,
      persistence: {
        ...enrolled.persistence,
        appendToStream: (input) =>
          control.omit() ? raw.appendToStream(input) : enrolled.persistence.appendToStream(input),
        appendToStreams: (inputs) =>
          control.omit() ? raw.appendToStreams!(inputs) : enrolled.persistence.appendToStreams!(inputs),
      },
      appendInTransaction: (db, inputs) =>
        control.omit() ? raw.appendToStreamsInTransaction(db, inputs) : enrolled.appendInTransaction(db, inputs),
      appendSingleInTransaction: (db, input) =>
        control.omit() ? raw.appendToStreamInTransaction(db, input) : enrolled.appendSingleInTransaction(db, input),
    };
  };
  return {
    ...actual,
    createInventoryStockReservations: create,
    enrollInventoryStockStreamsInTransaction: (
      ...args: Parameters<typeof actual.enrollInventoryStockStreamsInTransaction>
    ) => (control.omit() ? Promise.resolve() : actual.enrollInventoryStockStreamsInTransaction(...args)),
  };
});
