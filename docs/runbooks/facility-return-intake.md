# Facility Return Intake

## Purpose

Use this procedure when a package physically arrives at a platform return facility. Carrier delivery and facility intake are separate: never complete intake from a tracking scan alone.

## Before scanning

1. Confirm the workstation is scoped to the physical facility shown at the station.
2. Confirm the connection indicator is online. During an outage, keep the package in the controlled holding area and use the outage log; do not create a second intake from another device.
3. Keep buyer and seller personal information out of filenames, notes, custody identifiers, and evidence metadata.

## Expected package

1. Scan the tracking identifier or enter the Return Shipment identifier.
2. Confirm exactly one expected package resolves for this facility.
3. Compare the package summary and safe-handling instructions before opening or moving the package.
4. Record the actual receipt time, station, package condition, seal condition, measured weight when available, and the internal custody identifier.
5. Capture at least one clear custody image. Evidence must be JPEG, PNG, or WebP, no larger than 10 MB, and must pass the security scan.
6. Record the observed state, owner, and next action. Complete intake only when the evidence and physical package agree.

## Damaged package

- Photograph every damaged face, the shipping label, seal, internal packing, and affected items.
- Select `damaged`, assign the manual-review owner, and state the next inspection action.
- Route the package to quarantine or manual review. Do not choose normal completion.

## Empty package

- Photograph the unopened exterior when possible, the label, broken or missing seal, and the entire empty interior.
- Select `empty-package`, assign the exception owner, and route to quarantine.
- Preserve all packaging as evidence.

## Unidentified package

- Use the unidentified-package flow only when the scan resolves no package or more than one package.
- Record the same receipt, station, condition, weight, evidence, and custody identifier required for expected packages.
- Store the package in the unidentified holding area.
- When a unique Return Shipment is confirmed, reconcile it with a reason. Reconciliation links the histories and never replaces the original evidence.

## Wrong facility

- Do not complete intake. The system rejects a Return Shipment assigned to a different facility.
- Photograph the label and package condition, retain the package under controlled custody, and contact the owning facility using restricted routing information.
- Follow the approved transfer procedure; do not alter the destination snapshot.

## Duplicate scan or two-operator race

- If the existing intake result appears, use its custody identifier and do not create another receipt.
- If a stale-state message appears, reload the package. The accepted completion is authoritative.
- Duplicate-scan metrics are operational signals, not a reason to change physical history.

## System outage and retry

- Keep the package at the scanned station or controlled holding area.
- Record the temporary outage-log entry and retain the package evidence locally under the facility's approved outage procedure.
- When service returns, reload first and scan once. If an intake already exists, use it; otherwise enter the original physical receipt timestamp and complete intake.

## Correction

- Corrections require return-intake manage permission and a specific reason.
- Correct only the owner, next action, or custody identifier fields supported by the correction form.
- Never delete or replace the original intake, discrepancy, or evidence. Escalate any evidence-retention or access problem to Security and Fulfillment Operations.

## Evidence privacy and retention

- Evidence objects are written privately and read only through the permission- and facility-scoped API.
- Responses use `private, no-store`, content sniffing is disabled, and expired evidence is no longer served.
- The `return-intake/` object-storage prefix must have a 365-day lifecycle deletion rule. Changing the retention window requires Privacy and Security approval.
