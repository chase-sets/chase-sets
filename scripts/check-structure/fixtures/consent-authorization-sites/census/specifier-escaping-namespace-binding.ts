import * as censusEscapingNamespace from "../../bounded-contexts/identity/features/consents/domain/consent-recording-authorization";

export function censusEscapingNamespaceProbe(sink: (value: unknown) => void) {
  sink(censusEscapingNamespace);
}
