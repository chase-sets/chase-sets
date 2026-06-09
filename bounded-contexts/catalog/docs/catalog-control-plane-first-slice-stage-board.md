# Catalog Control Plane First-Slice Stage Board

This board operationalizes the first-slice delivery sequence for the Catalog Control Plane UX rebuild. It turns the milestone stage labels into entry gates, exit evidence, owner records, and follow-up rules so implementation can proceed without preserving the current two-page Catalog integrations surface as a migration target.

The rebuild continues to use the clean launch contracts from [Catalog Control Plane Clean Contract Handoff](./catalog-control-plane-clean-contract-handoff.md): the primary operator path is provider import -> Source Observation review -> promotion into Catalog Items or Catalog-owned references, and retired behavior must be completely deleted from code, product patterns, tests, fixtures, screenshots, docs, runbooks, release notes, and operator instructions. The product framing for that default operator path is documented in [Catalog Control Plane Primary Path](./catalog-control-plane-primary-path.md), and the rebuilt route/workspace IA is documented in [Catalog Control Plane Information Architecture](./catalog-control-plane-information-architecture.md).

## Stage Status

| Stage | Issues | Current status | Exit evidence |
| --- | --- | --- | --- |
| Stage 0 cleanup | #1050-#1055 | Complete | #1050 and #1055 closed; PRs #1091, #1125, #1094, #1138, and #1143 provide cleanup evidence. |
| Stage 1 contracts and IA | #1060, #1031, #1048, #1046, #1049 | Ready for implementation | API/read-model contracts, rebuilt IA, grouped navigation/mobile pattern, dense-workbench primitive proof, and primary-path framing accepted. |
| Stage 2 primary workbench | #1056, #1038, #1039, #1040, #1057, #1058 | Waiting on Stage 1 exit | Provider/scope selection through import, Source Observation review, promotion preview, promotion/recovery, route context, and operator copy accepted together as one workbench. |
| Stage 3 hardening and proof | #1063, #1065, #1059, #1062, #1064, #1047 | Waiting on relevant Stage 1/2 contracts | Durable-job edge cases, provider transport budgets, instrumentation, real-provider proof, security/privacy, and no-confusion acceptance accepted. |
| Stage 4 rollout and retirement | #1061, #1088, #1090 | Blocked by accepted first slice | Decision/risk register, production rollout, smoke/signoff, and complete old-surface deletion accepted. |

## Cross-Stage Coordination

#1087 is the cross-stage coordinator. It intentionally does not carry a `stage:*` label because it owns stage-board hygiene, owner records, and exit comments across Stage 1 through Stage 4. All other open `phase:first-slice` issues must carry exactly one stage label unless this board is updated with a specific cross-stage reason.

#1030 remains the parent epic and should link this board for high-level orientation. #1061 owns final production rollout/signoff evidence and must link this board, #1088, and #1090 before the MVP slice is considered launch-ready.

## Stage 1 Entry Gate

Stage 1 can begin because Stage 0 is complete and no open milestone issue carries `status:blocked-by-phase-0`. Stage 1 work must target clean contracts and must not:

- migrate the current two-page Catalog integrations route layout or module boundaries;
- reintroduce legacy provider selectors, scripted import endpoints, raw JSON broad patches, transitional profile mode, or silent active-profile fallback;
- treat supporting workspaces as peers that bury the primary import-to-promotion path;
- leave retired behavior in tests, fixtures, screenshots, docs, runbooks, release notes, or operator instructions.

## Stage 1 Exit Gate

Stage 2 may become implementation-ready only after all Stage 1 issues have accepted evidence:

| Issue | Exit requirement | Downstream unblock |
| --- | --- | --- |
| #1060 | Shared admin API/read-model contract types, endpoint docs, blocker categories, deploy-skew/fail-closed behavior, and contract verification for the primary workbench. | #1056, #1038, #1039, #1040, #1057, #1058, #1063, #1059 |
| #1031 | Rebuilt IA and workflow map showing each operator job start, completion point, evidence scope, and deleted/rebuilt current-page concepts, with a tested TypeScript manifest for grouped navigation and keyboard order. | #1048, #1056, #1057 |
| #1048 | Grouped section navigation/submenu pattern, desktop left groups, mobile translation, context-preserving links, and responsibility boundaries. | #1046, #1056, #1057, #1047 |
| #1046 | Dense-workbench primitive proof artifact covering grouped navigation, tables, action bars, drawers, blocked/denied/degraded states, focus, and responsive behavior. | #1056, #1038, #1039, #1040, #1047 |
| #1049 | Primary import-to-promotion framing accepted as the default operator path with supporting workflows linked as unblock/recovery branches. | #1056, #1038, #1039, #1040, #1059, #1062 |

## Owner Evidence Model

Before implementation begins on any first-slice issue, one of these owner records must exist:

- GitHub assignee on the issue;
- issue comment naming the implementation owner for the shippable segment;
- release checklist owner recorded in #1061 for rollout/signoff-only work.

Until a specific assignee is added, first-slice implementation comments should name the bounded-context delivery PR owner for that issue and the product/release signoff owner. Do not use this owner model to weaken acceptance; it is a routing aid, not a substitute for issue evidence or PR verification.

## Issue Board

| Issue | Stage | Owner record | Current readiness |
| --- | --- | --- | --- |
| #1087 | Cross-stage coordination | #1087 comment and this board | Complete when this board ships and evidence comments are linked. |
| #1060 | Stage 1 | Issue comment required before implementation PR | Ready to start; blocks Stage 2 API/read-model consumers. |
| #1031 | Stage 1 | Issue comment required before implementation PR | Ready to start; blocks IA-dependent navigation and route work. |
| #1048 | Stage 1 | Issue comment required before implementation PR | Ready to start after or alongside #1031 IA decisions. |
| #1046 | Stage 1 | Issue comment required before implementation PR | Ready to start after #1048 chooses the grouped navigation pattern. |
| #1049 | Stage 1 | Issue comment required before implementation PR | Ready to start; primary-path framing should guide every Stage 1 artifact. |
| #1056 | Stage 2 | Issue comment required before implementation PR | Waiting on Stage 1 exit. |
| #1038 | Stage 2 | Issue comment required before implementation PR | Waiting on #1060 and #1049. |
| #1039 | Stage 2 | Issue comment required before implementation PR | Waiting on #1060, #1046, and #1049. |
| #1040 | Stage 2 | Issue comment required before implementation PR | Waiting on #1060 and #1049. |
| #1057 | Stage 2 | Issue comment required before implementation PR | Waiting on #1031, #1048, and #1060. |
| #1058 | Stage 2 | Issue comment required before implementation PR | Waiting on #1031, #1049, and #1060 blocker categories. |
| #1063 | Stage 3 | Issue comment required before implementation PR | Waiting on #1060 durable-job fields and Stage 2 workflow behavior. |
| #1065 | Stage 3 | Issue comment required before implementation PR | Waiting on #1060 provider transport categories and Stage 2 import behavior. |
| #1059 | Stage 3 | Issue comment required before implementation PR | Waiting on #1049 path framing and Stage 2 event points. |
| #1062 | Stage 3 | Issue comment required before implementation PR | Waiting on accepted Stage 2 primary path. |
| #1064 | Stage 3 | Issue comment required before implementation PR | Waiting on #1060 security/privacy fields and Stage 2 action surfaces. |
| #1047 | Stage 3 | Issue comment required before implementation PR | Waiting on #1046 proof artifact and accepted Stage 2 workbench. |
| #1088 | Stage 4 | Release checklist owner in #1061 or issue comment | Can track risks now; final acceptance waits on first-slice evidence. |
| #1061 | Stage 4 | Release checklist owner in #1061 | Blocked by first-slice completion. |
| #1090 | Stage 4 | Release checklist owner in #1061 or issue comment | Blocked by accepted rebuilt workbench; owns complete old-surface deletion. |

## Stage Exit Comment Template

Each stage exit comment should include:

- stage name and date;
- issue list and evidence links;
- accepted owner/signoff;
- explicit statement that the next stage is ready or still blocked;
- any P3+ follow-up with owner and reason;
- confirmation that no retired behavior remains usable through hidden flags, fallbacks, redirects, aliases, old tests, fixtures, screenshots, docs, runbooks, release notes, or operator instructions.

## Related References

- [Catalog Control Plane Clean Contract Handoff](./catalog-control-plane-clean-contract-handoff.md)
- [Catalog Control Plane Primary Path](./catalog-control-plane-primary-path.md)
- [Catalog Control Plane Information Architecture](./catalog-control-plane-information-architecture.md)
- [Catalog Integration Control Plane](./catalog-integration-control-plane.md)
- [Catalog Integration Admin UX And Accessibility Acceptance](./catalog-integration-admin-ux-accessibility.md)
- [Catalog Integration Operator Acceptance Journeys](./catalog-integration-operator-acceptance-journeys.md)
- [Admin Control Plane Query Contracts](./admin-control-plane-query-contracts.md)
- [Admin Control Plane Read-Model SLOs](./admin-control-plane-read-model-slos.md)
