import { canonicalJson } from "../../outbound-sync/domain/validation";
import { openConnectorDatabase } from "./connector-indexeddb";
import {
  OperationProtocolError,
  assertTotalResult,
  journalLimit,
  parseOperationAttempt,
  parseOperationReservation,
  parseExecutorResult,
  type OperationAttempt,
  type OperationReservation,
} from "../domain/operation-protocol";

export type OperationJournal = Readonly<{
  members: readonly OperationAttempt[];
  reservations: readonly OperationReservation[];
}>;
export function assertCompleteJournal(journal: OperationJournal): void {
  const members = new Map(journal.members.map((member) => [member.operationId, member]));
  const reservations = new Map(journal.reservations.map((reservation) => [reservation.reservationId, reservation]));
  if (members.size !== journal.members.length || reservations.size !== journal.reservations.length)
    throw new OperationProtocolError("incomplete-authority");
  for (const member of members.values()) {
    const reservation = reservations.get(member.reservationId);
    if (
      !reservation ||
      !reservation.memberOperationIds.includes(member.operationId) ||
      reservation.connectionId !== member.connectionId ||
      reservation.leaseExpiresAt !== member.leaseExpiresAt
    )
      throw new OperationProtocolError("incomplete-authority");
    if (member.receipt) assertTotalResult(member.receipt, [member]);
    if (["reported", "acked"].includes(member.state) && member.state !== reservation.phase)
      throw new OperationProtocolError("incomplete-authority");
  }
  for (const reservation of reservations.values()) {
    const exact: OperationAttempt[] = [];
    for (const id of reservation.memberOperationIds) {
      const member = members.get(id);
      if (!member || member.reservationId !== reservation.reservationId)
        throw new OperationProtocolError("incomplete-authority");
      if (["reported", "acked"].includes(reservation.phase) && member.state !== reservation.phase)
        throw new OperationProtocolError("incomplete-authority");
      exact.push(member);
    }
    if (reservation.phase === "prepared" && exact.some((member) => member.state !== "prepared"))
      throw new OperationProtocolError("incomplete-authority");
    if (reservation.reportEnvelope) {
      const { outcomes, runSettlement } = reservation.reportEnvelope;
      assertTotalResult(parseExecutorResult({ outcomes, ...(runSettlement ? { runSettlement } : {}) }), exact);
      const ids = reservation.reportEnvelope.outcomes.map((outcome) => outcome.operationId);
      if (canonicalJson(ids) !== canonicalJson([...ids].sort()))
        throw new OperationProtocolError("incomplete-authority");
    }
  }
}

export function createOperationJournal(indexedDB: IDBFactory, ranges: typeof IDBKeyRange) {
  async function transaction(
    connectionId: string,
    expected?: OperationJournal,
    replacement?: OperationJournal,
  ): Promise<OperationJournal> {
    const db = await openConnectorDatabase(indexedDB);
    try {
      return await new Promise<OperationJournal>((resolve, reject) => {
        const tx = db.transaction(["operation-attempts", "reservations"], expected ? "readwrite" : "readonly");
        let failure: unknown;
        let result: OperationJournal;
        const abort = (error: unknown) => {
          failure = error;
          tx.abort();
        };
        tx.onabort = tx.onerror = () => reject(failure ?? new OperationProtocolError("incomplete-authority"));
        tx.oncomplete = () => resolve(result);
        const rows: unknown[][] = [[], []];
        const counts: number[] = [];
        let finished = 0;
        const complete = () => {
          if (++finished !== 4) return;
          try {
            if (rows.some((values, index) => counts[index] !== values.length))
              throw new OperationProtocolError("incomplete-authority");
            try {
              result = {
                members: rows[0].map(parseOperationAttempt),
                reservations: rows[1].map(parseOperationReservation),
              };
            } catch (error) {
              if (error instanceof OperationProtocolError && error.code === "upgrade-required") throw error;
              throw new OperationProtocolError("incomplete-authority");
            }
            assertCompleteJournal(result);
            if (!expected || !replacement) return;
            if (canonicalJson(expected) !== canonicalJson(result)) throw new OperationProtocolError("stale-fence");
            if (replacement.members.length > journalLimit || replacement.reservations.length > journalLimit)
              throw new OperationProtocolError("incomplete-authority");
            replacement.members.forEach(parseOperationAttempt);
            replacement.reservations.forEach(parseOperationReservation);
            assertCompleteJournal(replacement);
            for (const [index, name] of ["operation-attempts", "reservations"].entries()) {
              const store = tx.objectStore(name);
              const before = index === 0 ? result.members : result.reservations;
              const after = index === 0 ? replacement.members : replacement.reservations;
              const id = (row: OperationAttempt | OperationReservation) =>
                "operationId" in row ? row.operationId : row.reservationId;
              const old = new Map(before.map((row) => [id(row), row]));
              for (const row of after) {
                if (row.connectionId !== connectionId) throw new OperationProtocolError("incomplete-authority");
                const prior = old.get(id(row));
                if (prior && canonicalJson(prior) === canonicalJson(row)) {
                  old.delete(id(row));
                  continue;
                }
                if (prior ? row.revision !== prior.revision + 1 : row.revision !== 0)
                  throw new OperationProtocolError("stale-fence");
                store.put(row);
                old.delete(id(row));
              }
              for (const key of old.keys()) store.delete([connectionId, key]);
            }
            result = replacement;
          } catch (error) {
            abort(error);
          }
        };
        for (const [index, name] of ["operation-attempts", "reservations"].entries()) {
          const store = tx.objectStore(name);
          const range = ranges.bound([connectionId], [connectionId, []]);
          const count = store.count(range);
          count.onsuccess = () => {
            if (!Number.isSafeInteger(count.result) || count.result > journalLimit) {
              abort(new OperationProtocolError("incomplete-authority"));
              return;
            }
            counts[index] = count.result;
            complete();
          };
          let previous: IDBValidKey | undefined;
          const request = store.openCursor(range);
          request.onsuccess = () => {
            try {
              const cursor = request.result;
              if (!cursor) {
                complete();
                return;
              }
              const value = cursor.value as Record<string, unknown>;
              const identity = [connectionId, value[index === 0 ? "operationId" : "reservationId"]];
              if (
                rows[index].length >= journalLimit ||
                (previous !== undefined && indexedDB.cmp(previous, cursor.key) >= 0) ||
                canonicalJson(cursor.key) !== canonicalJson(identity)
              )
                throw new OperationProtocolError("incomplete-authority");
              rows[index].push(value);
              previous = cursor.key;
              cursor.continue();
            } catch (error) {
              abort(error);
            }
          };
        }
      });
    } finally {
      db.close();
    }
  }
  return {
    read: (connectionId: string) => transaction(connectionId),
    change: (connectionId: string, expected: OperationJournal, replacement: OperationJournal) =>
      transaction(connectionId, expected, replacement),
  };
}
