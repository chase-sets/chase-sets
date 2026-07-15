import type { ProductionCatalogCompletionReport } from "./reconcile";
import type { RepeatRunReconciliation } from "./repeat-run";

// Render a support-safe, human-readable summary of a completion report. Uses
// only report fields (counts and Catalog identifiers), so it is safe to print
// to an operator terminal or paste into a closing issue.
export function renderCompletionSummary(
  report: ProductionCatalogCompletionReport,
  repeatRun?: RepeatRunReconciliation,
): string {
  const lines: string[] = [];
  lines.push(`Production Catalog Completion Report (${report.reportVersion})`);
  lines.push(`  batch: ${report.batch.batchId} (${report.batch.status})`);
  lines.push(`  launch cutoff: ${report.launchCutoff}`);
  lines.push(`  result: ${report.result.toUpperCase()}`);
  lines.push(
    `  provider-unit coverage: ${report.coverage.terminalProviderUnitCount}/${report.coverage.requiredProviderUnitCount} (${formatRatio(report.coverage.providerUnitCoverageRatio)})`,
  );
  lines.push(
    `  scope coverage: ${report.coverage.coveredScopeCount}/${report.coverage.eligibleScopeCount} eligible (${formatRatio(report.coverage.scopeCoverageRatio)})`,
  );
  lines.push(`  catalog items: ${report.catalogItems.published} published, ${report.catalogItems.draft} draft`);
  lines.push(
    `  merge candidates: ${report.mergeCandidates.disposed}/${report.mergeCandidates.total} disposed, ${report.mergeCandidates.unresolved} unresolved`,
  );

  if (report.exclusions.length > 0) {
    lines.push("  exclusions:");
    for (const exclusion of report.exclusions) {
      lines.push(`    - ${exclusion.reason}: ${exclusion.count}`);
    }
  }

  if (report.blockers.length === 0) {
    lines.push("  blockers: none");
  } else {
    lines.push(`  blockers (${report.blockers.length}):`);
    for (const blocker of report.blockers) {
      lines.push(`    - [${blocker.code}] ${blocker.message}`);
    }
  }

  if (repeatRun) {
    lines.push(`  repeat-run: ${repeatRun.convergent ? "CONVERGENT" : "NOT CONVERGENT"}`);
    for (const finding of repeatRun.findings) {
      lines.push(`    - [${finding.code}] ${finding.message}`);
    }
  }

  return lines.join("\n");
}

function formatRatio(ratio: number): string {
  return `${Math.round(ratio * 1000) / 10}%`;
}
