import {
  AppliedFilterChips,
  Button,
  FilterArea,
  Form,
  Inline,
  LinkButton,
  NativeSelect,
  Stack,
  TextInput,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { ProjectionOperationsFilters, ProjectionOperationsSnapshot } from "../read-model/contracts";

const routeKey = "platformOperations.projectionOperations";

export function ProjectionOperationsFiltersForm({
  filters,
  data,
  clearHref,
}: Readonly<{
  filters: ProjectionOperationsFilters;
  data: ProjectionOperationsSnapshot;
  clearHref: string;
}>) {
  const contexts = [...new Set(data.projectionGroups.map((group) => group.targetContextName).filter(Boolean))].sort();
  const projections = [...new Set(data.projectionGroups.map((group) => group.projectionName).filter(Boolean))].sort();
  const activeFilterCount = [filters.search, filters.state, filters.contextName, filters.projectionName].filter(
    Boolean,
  ).length;
  const appliedFilters = buildAppliedFilters(filters);

  return (
    <Stack gap={2}>
      <Form spacing="none" method="get">
        <FilterArea
          activeFilterCount={activeFilterCount}
          overflowTriggerLabel={t(`${routeKey}.moreFilters`)}
          panelTitle={t(`${routeKey}.filters`)}
          filters={[
            <TextInput
              key="search"
              label={t(`${routeKey}.search`)}
              name="search"
              defaultValue={filters.search}
              placeholder={t(`${routeKey}.searchPlaceholder`)}
            />,
            <NativeSelect
              key="state"
              label={t(`${routeKey}.state`)}
              name="state"
              defaultValue={filters.state}
              items={[
                { value: "", label: t(`${routeKey}.allStates`) },
                ...[
                  "failed",
                  "error",
                  "degraded",
                  "cancel_requested",
                  "blocked",
                  "poison",
                  "behind",
                  "queued",
                  "running",
                  "caught-up",
                  "succeeded",
                ].map((state) => ({ value: state, label: state })),
              ]}
            />,
            <NativeSelect
              key="context"
              label={t(`${routeKey}.context`)}
              name="contextName"
              defaultValue={filters.contextName}
              items={[
                { value: "", label: t(`${routeKey}.allContexts`) },
                ...contexts.map((value) => ({ value, label: value })),
              ]}
            />,
            <NativeSelect
              key="projection"
              label={t(`${routeKey}.projection`)}
              name="projectionName"
              defaultValue={filters.projectionName}
              items={[
                { value: "", label: t(`${routeKey}.allProjections`) },
                ...projections.map((value) => ({ value, label: value })),
              ]}
            />,
          ]}
          actions={
            <Inline>
              <Button type="submit" leadingIcon="filter">
                {t(`${routeKey}.applyFilters`)}
              </Button>
              <LinkButton href={clearHref} tone="secondary">
                {t(`${routeKey}.clearFilters`)}
              </LinkButton>
            </Inline>
          }
        />
      </Form>
      <AppliedFilterChips
        filters={appliedFilters}
        clearAction={
          appliedFilters.length > 0 ? (
            <LinkButton href={clearHref} size="sm" tone="secondary">
              {t(`${routeKey}.clearFilters`)}
            </LinkButton>
          ) : null
        }
      />
    </Stack>
  );
}

export function matchesProjectionFilters(
  values: Readonly<{
    search: string;
    state?: string;
    contextName?: string;
    projectionName?: string;
  }>,
  filters: ProjectionOperationsFilters,
) {
  return (
    (!filters.search || values.search.toLowerCase().includes(filters.search.toLowerCase())) &&
    (!filters.state || values.state === filters.state) &&
    (!filters.contextName || values.contextName === filters.contextName) &&
    (!filters.projectionName || values.projectionName === filters.projectionName)
  );
}

export function projectionSelectionHref(baseHref: string, filters: ProjectionOperationsFilters, selected?: string) {
  const search = new URLSearchParams();
  if (filters.search) search.set("search", filters.search);
  if (filters.state) search.set("state", filters.state);
  if (filters.contextName) search.set("contextName", filters.contextName);
  if (filters.projectionName) search.set("projectionName", filters.projectionName);
  if (selected) search.set("selected", selected);
  const query = search.toString();
  return query ? `${baseHref}?${query}` : baseHref;
}

function buildAppliedFilters(filters: ProjectionOperationsFilters) {
  return [
    filters.search ? { id: "search", label: t(`${routeKey}.filterSearch`, { value: filters.search }) } : null,
    filters.state ? { id: "state", label: t(`${routeKey}.filterState`, { value: filters.state }) } : null,
    filters.contextName
      ? { id: "context", label: t(`${routeKey}.filterContext`, { value: filters.contextName }) }
      : null,
    filters.projectionName
      ? { id: "projection", label: t(`${routeKey}.filterProjection`, { value: filters.projectionName }) }
      : null,
  ].filter((entry): entry is { id: string; label: string } => Boolean(entry));
}
