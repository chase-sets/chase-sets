# Pressure Test — adversarial plan review

Run in a FRESH context (independent agent, different exact model instance than
the planner — see model-routing). Input: the drafted milestone/epic/issues.
Never transfer evidence or a veto from a predecessor model version.

Return `PASS`, `BLOCK_FIXABLE`, or `BLOCK_REPLAN`. Plain `BLOCK` is invalid.
`BLOCK_FIXABLE` means the draft can be repaired without changing the intended
outcome or authority assumptions. `BLOCK_REPLAN` means feasibility, sequencing,
or a required decision/probe must change before drafting can continue. The
planner fixes repairable findings before registration.

Perform one complete sweep; do not stop after the first finding. Give every
finding a stable ID, repo/authority evidence, the exact draft section affected,
a minimal prescribed repair, and the acceptance evidence that distinguishes the
repair. A finding without a bounded remedy is `BLOCK_REPLAN`, not an
aspirational suggestion.

## Rubric

1. **Zero-context implementability** (the real bar). For each issue: could a
   worker with no conversation context implement this correctly from the issue
   text plus its evidence pointers alone? Name the first question such a worker
   would be forced to ask — if one exists, the issue fails.
2. **AC verifiability.** Every AC has an evidence method that actually
   discriminates success from failure. Reject vibes-ACs ("works correctly").
3. **Footprint honesty.** Do the declared footprints match where the change
   must actually land? Missed shared files = rebase collisions; check the
   parallel-wave claims especially.
4. **Decision completeness.** Walk each slice asking "what will the worker have
   to choose?" Any choice not settled in the issue or queued as a decision is a
   finding.
5. **Don't-rebuild.** Does any slice reimplement a shipped surface? Point to
   the prior art the plan missed.
6. **Glossary conformance.** Terms match the owning context's ubiquitous
   language; new terms are flagged for registration.
7. **Scope fences.** Are the non-goals real fences (things a worker might
   plausibly do) or filler?
8. **Chain integrity.** Blocked-by links form a DAG (no cycles), gates are
   checkable, and nothing parked is silently load-bearing.
9. **Day-after steady state.** Any slice introducing or altering a state
   machine or lifecycle: the plan must enumerate the states and name the
   steady one. Ask what routine operation does the day after each transition —
   a machine with only transition states is a finding. (This class escaped two
   full-path code reviews; plan time is the cheapest place to catch an
   omission that is invisible in a diff.)
10. **Authority-timing.** For every external-authority dependency (GitHub API
    shapes, provider payloads, queue/webhook associations, cloud-API state):
    was the authority probed at the exact moment the implementation will need
    it — not just shown to exist? An unprobed timing assumption is a finding,
    ranked with missed decisions (PR #5883: the merge-queue run's PR
    association is empty until after merge; no implementation could have
    fixed a defect that only a pre-merge probe would have surfaced).
11. **Simplest correct solution.** Construct the strictly smaller plan (fewer
    new modules, abstractions, and evidence artifacts). If it still satisfies
    the outcome and ledger defect constraints, report the plan as too large
    and prescribe that smaller plan as the shrink remedy; the pressure test has
    explicit authority to make this finding.
12. **Evidence proportionality.** An AC that mandates a test architecture or
    artifact rather than an observable property, or an evidence artifact with
    no named ledger defect class justifying it, is a finding. The registered
    prediction is that median mandated-evidence lines per slice will fall while
    ledger defect classes remain covered; review this rule by 2026-09-01.

Report findings ranked by rework-risk: a missed decision, false parallel
claim, or unprobed authority-timing assumption outranks a fuzzy AC.

## Quality-v2 balance verdict

The rubric above is the review method, not a second contract. Start with G0:
construct a strictly smaller shape that meets every AC. If the chosen shape is
not the smallest and the brief neither builds nor rejects the smaller one with
a reason, return `BLOCK_REPLAN`. Verify the brief's not-built/reason rows.

Read exactly one declared `QUALITY_PROFILE`; never negotiate, infer, or detect
one from domain vocabulary. Apply its fixed weights. High blocks on either
side's stated sub-case, Med blocks only on too little, and Low makes both sides
notes. Confirmed incorrect behavior under SCOPE and confirmed exposure under
SECURITY always block.

| Key | prototype | product-feature | core-library | hot-path | migration | contract |
|---|---|---|---|---|---|---|
| SCOPE | Med | High | High | High | High | High |
| ROBUSTNESS | Low | Med | High | Med | High | High |
| DEPTH | Med | Med | High | Med | Low | High |
| READABILITY | Low | Med | High | Med | Med | Med |
| TESTS | Low | Med | High | High | High | High |
| OBSERVABILITY | Low | Med | Med | High | High | High |
| SECURITY | Med | High | Med | Med | High | High |
| PERFORMANCE | Low | Low | Med | High | Med | Low |
| ROLLOUT | Low | Med | High | Med | High | High |
| CONSISTENCY | Low | Med | High | Med | Med | High |
| EXPERIENCE | Low | High | Low | Low | Low | Low |
| LANGUAGE | Med | High | High | Med | Med | High |

Return every pair below once, in this order, scoring both sides against its
reproducible sub-case and the selected weight:

| Key | Pair | Too little blocks when | Too much blocks when | Evidence |
|---|---|---|---|---|
| SCOPE | Correctness vs scope | A named state or acceptance criterion behaves incorrectly or has no executed probe | A behavior ships that no acceptance criterion asked for | Criteria mapped to executed probes; diff against the brief's footprint |
| ROBUSTNESS | Simplicity vs robustness | A changed lifecycle has an unhandled state or transition | A guard, retry, or fallback names no concrete failure it prevents | State and failure-mode table; every guard annotated with its failure |
| DEPTH | Depth vs flexibility | An internal is exposed across a bounded-context boundary, or the public interface is wider than the behavior it hides | A new abstraction has one caller and no second real caller named | Interface added versus behavior hidden; caller count per abstraction |
| READABILITY | Readability vs brevity | Following one changed behavior from its entry point to its effect opens more than three non-test files, or a changed exported symbol states its behavior in none of its name, signature, types, or doc comment | A comment restates the adjacent code token for token, or a new identifier is an abbreviation found in neither the owning glossary nor the repo's convention list | Trace per changed behavior listing the files opened; exported-symbol table naming where each behavior is stated; comment diff; identifier list checked against the glossary |
| TESTS | Coverage vs test weight | A changed public surface has no test that exercises it | A test asserts only implementation details and would break on a correct refactor | Surface-to-test table; each new test named with the behavior it pins |
| OBSERVABILITY | Observability vs noise | A failure on a changed path produces no visible signal | Success on a changed path logs or alerts | Failure-signal table; log and alert diff |
| SECURITY | Boundary security vs friction | Input, authorization, secrets, or personal data cross a boundary unhandled | Defensive checks sit deep inside trusted code | Boundary inventory; checks placed at the boundary only |
| PERFORMANCE | Performance vs clarity | An unbounded query or per-item I/O on a measured hot path | An optimisation with no measurement on a path that is not hot | Bounds and indexes per query; measurement attached to each optimisation |
| ROLLOUT | Rollout safety vs cleanup | A schema, event, or contract change is not backward-safe or reversible where it matters | A dead path, flag, or legacy branch remains once safe to remove | Compatibility note per changed contract; removed-paths list |
| CONSISTENCY | Consistency vs improvement | A departure from local convention is unstated | A convention is followed where the brief called for a stated improvement | Departures listed with reasons |
| EXPERIENCE | Design-system fidelity vs local override | A changed UI surface misses a state (loading, empty, error, success) or uses the wrong design-system pattern | A local override or new component where the design system already has one | State inventory; component sources |
| LANGUAGE | Ubiquitous language vs convenience | A public name contradicts the owning glossary or a contract's published name | A new term is coined where the glossary already has one, or two names mean one thing | Public-name to glossary map; synonym check |

Use the contract field names `QUALITY_PROFILE` and `QUALITY_VERDICT`, with a
leading `G0: PASS <not-built list verified> | BLOCK_REPLAN <simpler shape>`
line. Each key line includes `[High|Med|Low]`, `little=...`, and `much=...`.
`PASS` names evidence, `BLOCK` names blocking IDs, `NOTE` names non-blocking
IDs, and `N/A` names the absent surface. Taste, preference, and unrelated debt
never block; ready-10 shape never substitutes for semantic judgment.
