import {
  closed,
  isCommand,
  isGrant,
  operatorEnvironments,
  operatorOrigins,
  type OperatorCommand,
  type OperatorEnvironment,
  type OperatorObservationRequest,
  type OperatorStatus,
} from "./protocol";
import { emptyOperatorRecord, isOperatorRecord, operatorRecordKey, type OperatorRecord } from "./record";
import { createOperatorTransport } from "./transport";
import { isSetNamesRequestResult, type SetNamesRequestResult } from "./set-names/probe";
import type { SealedFetch } from "./sealed-products/collector";
import { createSealedObservationDispatcher } from "./sealed-products/request";

export type OperatorAdapters = {
  storage: {
    trust(): Promise<void>;
    read(key: string): Promise<unknown>;
    write(key: string, value: OperatorRecord): Promise<void>;
  };
  badge(required: boolean): Promise<void>;
  fetch: typeof fetch;
  dispatchObservationRequest?: (
    environment: OperatorEnvironment,
    request: OperatorObservationRequest,
    postSetNameAnswer: (body: string) => Promise<void>,
  ) => Promise<void>;
  setNames?: (productLineId: string) => Promise<SetNamesRequestResult>;
  sealedProducts?: SealedFetch;
};

type Slot = { record: OperatorRecord; blocked: boolean; polling: boolean; queue: Promise<unknown> };

export function createOperatorBackground(adapters: OperatorAdapters) {
  const transport = createOperatorTransport(adapters.fetch);
  const dispatchSealed = adapters.sealedProducts && createSealedObservationDispatcher(adapters.sealedProducts);
  const slots = new Map<OperatorEnvironment, Slot>(
    operatorEnvironments.map((environment) => [
      environment,
      { record: emptyOperatorRecord(environment), blocked: false, polling: false, queue: Promise.resolve() },
    ]),
  );
  const slot = (environment: OperatorEnvironment) => slots.get(environment)!;
  const status = (environment: OperatorEnvironment): OperatorStatus => {
    const current = slot(environment);
    return {
      paired: !current.blocked && current.record.grant !== null,
      state: current.blocked ? "upgrade-required" : current.record.state,
      lastOutcome: current.record.lastOutcome,
      lastPushedAt: current.record.lastPushedAt,
      serverRevision: current.record.lastRevision,
    };
  };
  const ready = adapters.storage
    .trust()
    .then(async () => {
      await Promise.all(
        operatorEnvironments.map(async (environment) => {
          const current = slot(environment);
          try {
            const stored = await adapters.storage.read(operatorRecordKey(environment));
            if (stored !== undefined) {
              if (!isOperatorRecord(stored, environment)) current.blocked = true;
              else current.record = stored;
            }
          } catch {
            current.blocked = true;
          }
        }),
      );
    })
    .catch(() => {
      for (const current of slots.values()) current.blocked = true;
    });
  function serial<T>(environment: OperatorEnvironment, work: (current: Slot) => Promise<T>): Promise<T> {
    const current = slot(environment);
    const result = current.queue.then(() => ready).then(() => work(current));
    current.queue = result.catch(() => {
      current.blocked = true;
    });
    return result;
  }
  async function write(current: Slot, record: OperatorRecord) {
    if (current.blocked) return;
    await adapters.storage.write(operatorRecordKey(record.environment), record);
    current.record = record;
  }
  async function badge() {
    await adapters.badge([...slots.values()].some((current) => current.record.state === "re-pair-required"));
  }
  async function poll(environment: OperatorEnvironment) {
    const current = slot(environment);
    if (current.polling) return;
    current.polling = true;
    try {
      const pairing = await serial(environment, async ({ record, blocked }) =>
        blocked || !record.grant || Date.now() < record.nextAttemptAt
          ? null
          : { grant: record.grant, profileRevision: record.profileRevision },
      );
      if (!pairing) return;
      const result = await transport.poll(environment, pairing.grant);
      const matches = ({ blocked, record }: Slot) =>
        !blocked && record.profileRevision === pairing.profileRevision && record.grant === pairing.grant;
      const clearGrant = async (current: Slot) => {
        await write(current, {
          ...current.record,
          grant: null,
          state: "re-pair-required",
          dirty: false,
          nextAttemptAt: 0,
          lastOutcome: "grant-invalid",
        });
        await badge();
      };
      const postAnswer = async (body: string, partIndex?: number): Promise<boolean> => {
        if (result.outcome !== "polled" || !result.request || result.request.kind === "market-observations")
          return false;
        const { requestId, expiresAt, kind } = result.request;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const flight = await serial(environment, async (current) => {
            if (!matches(current) || Date.parse(expiresAt) <= Date.now()) return undefined;
            return { answer: transport.postAnswer(environment, pairing.grant, kind, requestId, body, partIndex) };
          });
          if (!flight) return false;
          const answer = await flight.answer;
          if (answer.outcome === "grant-invalid") {
            await serial(environment, async (current) => {
              if (matches(current)) await clearGrant(current);
            });
            return false;
          }
          if (answer.outcome !== "unavailable") {
            if (answer.outcome === "recorded" && kind === "sealed-products" && partIndex === undefined)
              await serial(environment, async (current) => {
                if (matches(current))
                  await write(current, { ...current.record, lastPushedAt: new Date().toISOString() });
              });
            return answer.outcome === "recorded";
          }
          const delay = Math.max(250, answer.retryAt - Date.now());
          if (attempt > 0 || delay > 2_000 || Date.now() + delay >= Date.parse(expiresAt)) {
            if (answer.retryAt > Date.now())
              await serial(environment, async (current) => {
                if (matches(current)) await write(current, { ...current.record, nextAttemptAt: answer.retryAt });
              });
            return false;
          }
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        return false;
      };
      const dispatch = await serial(environment, async (current) => {
        const record = current.record;
        if (!matches(current)) return;
        if (result.outcome === "grant-invalid") {
          await clearGrant(current);
        } else if (result.outcome === "unavailable" && result.retryAt > Date.now()) {
          await write(current, { ...record, nextAttemptAt: result.retryAt });
        } else if (result.outcome === "polled" && result.request && Date.parse(result.request.expiresAt) > Date.now()) {
          const request = result.request;
          return {
            finished:
              request.kind === "sealed-products" && dispatchSealed
                ? dispatchSealed(request, postAnswer, () => matches(current))
                : adapters.dispatchObservationRequest?.(environment, request, async (body) => {
                    await postAnswer(body);
                  }),
          };
        }
      });
      await dispatch?.finished;
    } finally {
      current.polling = false;
    }
  }
  async function command(command: OperatorCommand): Promise<OperatorStatus> {
    const environment = command.environment;
    if (command.action === "poll-now") {
      void poll(environment).catch(() => undefined);
      await ready;
      return status(environment);
    }
    if (command.action === "status" || command.action === "recover") {
      await serial(environment, async () => undefined);
      return status(environment);
    }
    if (command.action === "pair") {
      await serial(environment, async (current) => {
        if (current.blocked || current.record.profileRevision === Number.MAX_SAFE_INTEGER) return;
        await write(current, {
          ...emptyOperatorRecord(environment),
          profileRevision: current.record.profileRevision + 1,
          grant: command.grant,
          state: "idle",
          dirty: false,
        });
        await badge();
      });
      return status(environment);
    }
    const revoke = await serial(environment, async (current) => {
      if (current.blocked || !current.record.grant) return null;
      const prior = current.record;
      await write(current, { ...emptyOperatorRecord(environment), profileRevision: prior.profileRevision + 1 });
      await badge();
      return prior.grant;
    });
    if (revoke) await transport.revoke(environment, revoke);
    return status(environment);
  }
  return {
    async pollObservations() {
      await Promise.allSettled(operatorEnvironments.map(poll));
    },
    async receiveSetNames(
      value: unknown,
      sender: { id?: string; url?: string; origin?: string; hasTab: boolean },
      extensionId: string,
    ) {
      const setNames = adapters.setNames;
      if (typeof setNames !== "function") return null;
      const message = value as { action: unknown; productLineId: unknown };
      const origin = `chrome-extension://${extensionId}`;
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        Object.keys(value).length !== 2 ||
        !Object.hasOwn(value, "action") ||
        !Object.hasOwn(value, "productLineId") ||
        message.action !== "probe-set-names" ||
        typeof message.productLineId !== "string" ||
        !/^\d+$/.test(message.productLineId) ||
        sender.id !== extensionId ||
        sender.url !== `${origin}/popup.html` ||
        sender.origin !== origin ||
        sender.hasTab
      )
        return null;
      try {
        const result = await setNames(message.productLineId);
        return isSetNamesRequestResult(result) ? result : null;
      } catch {
        return null;
      }
    },
    async receiveHandoff(
      value: unknown,
      sender: { id?: string; url?: string; origin?: string; frameId?: number; hasTab: boolean },
      extensionId: string,
    ) {
      const refused = { outcome: "refused" as const };
      if (
        !closed(value, ["action", "grant"]) ||
        value.action !== "pair-handoff" ||
        (sender.id !== undefined && sender.id !== extensionId) ||
        sender.frameId !== 0 ||
        sender.hasTab !== true
      )
        return refused;
      const grant = value.grant;
      if (!isGrant(grant)) return refused;
      const environment = operatorEnvironments.find((candidate) => operatorOrigins[candidate] === sender.origin);
      if (!environment || typeof sender.url !== "string") return refused;
      try {
        const url = new URL(sender.url);
        if (url.origin !== sender.origin || url.pathname !== "/catalog/providers/tcgplayer") return refused;
      } catch {
        return refused;
      }
      try {
        const result = await serial(environment, async (current) => {
          if (current.blocked) return "refused";
          if (current.record.grant === grant) return "unchanged";
          if (current.record.profileRevision === Number.MAX_SAFE_INTEGER) return "refused";
          await write(current, {
            ...emptyOperatorRecord(environment),
            profileRevision: current.record.profileRevision + 1,
            grant,
            state: "idle",
            dirty: false,
          });
          await badge();
          return "committed";
        });
        return result === "refused" ? refused : { outcome: "paired" as const };
      } catch {
        return refused;
      }
    },
    async receive(
      value: unknown,
      sender: { id?: string; url?: string; origin?: string; hasTab: boolean },
      extensionId: string,
    ) {
      const origin = `chrome-extension://${extensionId}`;
      if (
        sender.id !== extensionId ||
        sender.url !== `${origin}/popup.html` ||
        sender.origin !== origin ||
        sender.hasTab ||
        !isCommand(value)
      )
        return null;
      try {
        return await command(value);
      } catch {
        return status(value.environment);
      }
    },
  };
}
