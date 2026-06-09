# Section Navigation

`SectionNavigation` is the canonical design-system pattern for dense admin surfaces that need grouped local navigation inside one product area. Use it when a screen family has one primary workflow plus supporting detours that should stay visible without becoming equal peers.

## When To Use It

Use section navigation for admin control planes, operational workbenches, and configuration areas where operators need to move between cohesive screens that share context.

Do not use it to preserve a god page. If one page contains unrelated jobs, decompose the work into screens with clear responsibilities, put the primary job first, and make supporting jobs subordinate through group order and return context.

## Desktop Pattern

Desktop renders as a left-side grouped menu:

- Group headings name the job family, not the implementation module.
- The first group should contain the main workflow and the default destination.
- Supporting groups are ordered by how they unblock, govern, or verify the main workflow.
- Items can show active, pending, warning, blocked, disabled, and count states.
- Disabled or blocked states must explain what is unavailable or needs attention without sending the operator into a dead end.

The active destination uses `aria-current="page"`. Links and buttons remain in DOM order so keyboard traversal follows the same order as the visible groups.

## Mobile Pattern

Mobile translates the same groups into one grouped selector with `optgroup` labels. This is the approved mobile behavior for section navigation because it:

- preserves group headings and ordering;
- avoids tiny sidebar targets, horizontal tab overflow, and mystery menus;
- keeps the current section visible in a compact control;
- relies on native keyboard, touch, and screen-reader behavior.

Applications should pass `onSelect` to route through the app router while preserving the current workflow context.

## State Semantics

Use states to describe workflow readiness, not decorative severity:

| State | Meaning |
| --- | --- |
| `default` | Available section without special readiness state. |
| `pending` | Work is ready, queued, or awaiting operator review. |
| `warning` | The section is available but needs attention before the primary workflow is safe. |
| `blocked` | The section exposes a blocker that must be resolved before the affected workflow can continue. |
| `disabled` | The section cannot be entered from the current context. |

Use `count` for actionable quantities such as pending observations, failed jobs, or active blockers. Do not use counts for decorative totals that do not change the operator's next decision.

## Catalog Control Plane Application

The Catalog Control Plane uses `SectionNavigation` to keep provider import, Source Observation review, and promotion as the first and default workflow. Health, profile authoring, validation, lifecycle, governance, and audit screens are supporting detours that must preserve return context back to the primary path.

Retiring the current catalog integrations or source-observations surfaces means complete deletion of old code, patterns, tests, fixtures, screenshots, docs, runbooks, release notes, and operator instructions. Do not keep hidden flags, fallback branches, redirects, aliases, shims, or support-only routes to preserve retired screens.

## Example

```tsx
import { SectionNavigation } from "@chase-sets/design-system";

<SectionNavigation
  label="Catalog control plane sections"
  mobileLabel="Catalog section"
  activeKey="import-promotion"
  onSelect={(key) => navigateToCatalogSection(key)}
  groups={[
    {
      key: "primary",
      label: "Primary workflow",
      items: [
        {
          key: "import-promotion",
          label: "Import to promotion",
          href: "/admin/catalog/integrations",
          description: "Pull, review, and promote provider data",
          count: 24,
        },
      ],
    },
    {
      key: "unblock",
      label: "Unblock provider data",
      items: [
        {
          key: "health",
          label: "Health triage",
          href: "/admin/catalog/integrations/health",
          state: "warning",
          statusLabel: "Needs evidence",
        },
      ],
    },
  ]}
/>
```
