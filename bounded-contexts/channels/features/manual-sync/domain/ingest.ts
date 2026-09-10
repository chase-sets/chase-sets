import { createHash } from "node:crypto";
import { ManualSyncError, manualSyncIngestContract, type FounderExportIngestProbe } from "./contracts";

export type InspectedTcgplayerExport = Readonly<{
  csv: string;
  byteSize: number;
  logicalRows: number;
  headerText: string;
}>;

export function inspectTcgplayerExportBytes(bytes: Uint8Array): InspectedTcgplayerExport {
  if (bytes.byteLength > manualSyncIngestContract.maxBytes) throw new ManualSyncError("export-too-large");
  let csv: string;
  try {
    csv = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ManualSyncError("invalid-input", "TCGplayer export must be UTF-8.");
  }
  let quoted = false;
  let headerEnd = -1;
  let records = 0;
  let hasRecordContent = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
      hasRecordContent = true;
      continue;
    }
    if (!quoted && (character === "\r" || character === "\n")) {
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      if (headerEnd < 0) headerEnd = index - (character === "\r" && csv[index] === "\n" ? 1 : 0);
      records += 1;
      hasRecordContent = false;
    } else {
      hasRecordContent = true;
    }
    if (records > manualSyncIngestContract.maxRecords + 1) {
      throw new ManualSyncError("export-record-limit-exceeded");
    }
  }
  if (quoted) throw new ManualSyncError("invalid-input", "TCGplayer export contains an unterminated quoted field.");
  if (hasRecordContent) records += 1;
  const logicalRows = Math.max(0, records - 1);
  if (logicalRows > manualSyncIngestContract.maxRecords) {
    throw new ManualSyncError("export-record-limit-exceeded");
  }
  const resolvedHeaderEnd = headerEnd < 0 ? csv.length : headerEnd;
  return { csv, byteSize: bytes.byteLength, logicalRows, headerText: csv.slice(0, resolvedHeaderEnd) };
}

export function founderExportIngestProbe(
  inspected: InspectedTcgplayerExport,
  input: Readonly<{ fileName: string; observedAt: string }>,
): FounderExportIngestProbe {
  if (inspected.byteSize > manualSyncIngestContract.founderProbeMaxBytes) {
    throw new ManualSyncError("export-too-large", "Founder export probe exceeds 16777216 bytes.");
  }
  if (inspected.logicalRows > manualSyncIngestContract.maxRecords) {
    throw new ManualSyncError("export-record-limit-exceeded");
  }
  if (!input.fileName || input.fileName.length > 256 || Number.isNaN(Date.parse(input.observedAt))) {
    throw new ManualSyncError("invalid-input");
  }
  return {
    fileName: input.fileName,
    byteSize: inspected.byteSize,
    logicalRows: inspected.logicalRows,
    headerSha256: createHash("sha256").update(inspected.headerText, "utf8").digest("hex"),
    observedAt: input.observedAt,
  };
}
