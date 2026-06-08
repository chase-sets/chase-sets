# Operational Workflow Patterns

Operational workflows are focused task surfaces for completing real work with low error tolerance: packing shipments, reconciling records, reviewing exceptions, and similar account operations.

## Workstation Layout

Use `WorkstationLayout` when one primary checklist or work surface needs supporting details nearby.

- Keep the active task in `primary`.
- Put reference-only information in `secondary`.
- On mobile, supporting details collapse below the primary task so the work stays first.
- Do not nest cards inside the workstation primary area. Use `ChecklistCard`, `TaskLineItem`, and flat supporting rows.

## Workflow Modules

Use `WorkflowModule` for dense admin workbench sections that combine a title, status, summary facts, tables, and scoped actions.

- Keep the `title` short and specific to the operator task.
- Put workflow state in `status`; pass an existing status pill or badge instead of inventing new chrome.
- Put only scoped module actions in `actions`.
- Use `WorkflowActionBar` for action rows inside a module when the controls depend on the module content.
- Use `headingLevel={3}` when modules sit under a page or workbench summary heading.

## Readiness Checklists

Use `WorkflowReadinessChecklist` for activation gates, fixture coverage, diagnostics, and other pass/block/pending checks.

- Each row should describe one actionable gate.
- Use `statusLabel` for the visible operator state, such as Passed, Blocked, Warning, or Pending.
- Put identifiers, paths, and compact evidence chips in `meta`.
- Put one row-specific remediation action in `action` when it is available.
- Keep the underlying diagnostic or evidence tables nearby when operators need sortable or comparable detail.

## Task Progress

Use `TaskProgress` for visible completion state in a checklist header or sticky footer.

- The label should use the domain unit being completed, such as items packed or orders reviewed.
- Use `valueLabel` for a compact percentage or count fact.
- Use `success` only when the task is genuinely complete.
- Use `blocked` for a state that prevents completion and needs user attention.

## Task Line Items

Use `TaskLineItem` for one operational unit in a checklist.

- Put product, record, or entity identity in `title` and `subtitle`.
- Put reusable badges or option chips in `meta`.
- Put copyable identifiers in `TaskReference`.
- Use `status` and `statusLabel` for row-level save, matched, saved, and error states.
- Use `QuantityChecklistControl` when a line can be partially complete.

## Scan-First Inputs

Use `TaskScanInput` when the fastest path is scanning or pasting an identifier.

- Match exact identifiers before fuzzy text matches.
- Ambiguous scans should ask for a more specific identifier instead of choosing a row.
- Successful scans should update one operational unit and clear the input.
- Keep scan feedback short and visible near the field.

## Operational Locks

Use `OperationalLockBanner` when entering a workflow changes what other users or systems can change.

- State what is locked.
- State when the lock started or why it exists.
- State how the lock ends.
- Do not use marketplace trust banners for operational locks; trust banners explain confidence, while lock banners explain workflow control.

## Sticky Task Footers

Use `StickyTaskFooter` for the final action in a task workflow.

- Keep the summary factual and short.
- Put completion blockers in `detail`.
- The default mobile offset is app-shell aware and sits above marketplace bottom navigation plus safe-area insets.
- Use `mobileOffset="in-flow"` when a mobile sticky footer would cover scan inputs or checklist rows.
- Use `mobileOffset="none"` only in surfaces without bottom navigation.

## References

Use `TaskReference` for short operational identifiers that users may need to compare or copy.

- Show a short display value when full ids are long.
- Copy the full id.
- Keep labels short: Order, Product, Line, Shipment.
