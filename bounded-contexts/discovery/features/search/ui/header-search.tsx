import { t } from "@chase-sets/localization";
import { Combobox, Form } from "@chase-sets/design-system";
import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { createDiscoveryApiClient, type DiscoverySearchSuggestion } from "../../../client";
import { truncateDiscoverySearchSuggestionQuery } from "../domain/normalization";

const SEARCH_SUGGESTION_DEBOUNCE_MS = 250;
const RECENT_SEARCH_LIMIT = 5;

export const MARKETPLACE_RECENT_SEARCHES_STORAGE_KEY = "chase-sets:marketplace:recent-searches";

export function MarketplaceHeaderSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<readonly DiscoverySearchSuggestion[]>([]);
  const [recentSearches, setRecentSearches] = useState<readonly string[]>([]);

  useEffect(() => {
    setRecentSearches(readRecentSearches());
  }, []);

  useEffect(() => {
    const normalizedQuery = boundedQuery(query).trim();
    if (!normalizedQuery) {
      setSuggestions([]);
      return undefined;
    }

    const controller = new AbortController();
    let active = true;
    const timer = window.setTimeout(() => {
      createDiscoveryApiClient()
        .suggestItems(normalizedQuery, { signal: controller.signal })
        .then((response) => {
          if (active) {
            setSuggestions(response.items);
          }
        })
        .catch((error: unknown) => {
          if (active && !(error instanceof DOMException && error.name === "AbortError")) {
            setSuggestions([]);
          }
        });
    }, SEARCH_SUGGESTION_DEBOUNCE_MS);

    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const items = useMemo(() => {
    if (query.trim()) {
      return suggestions.map((suggestion) => ({
        value: `suggestion:${suggestion.catalogItemId}`,
        label: suggestion.title,
        description: suggestion.category ?? t("discovery.features.search.ui.headerSearch.catalog.item"),
      }));
    }

    return [
      ...recentSearches.map((recentSearch) => ({
        value: `recent:${recentSearch}`,
        label: recentSearch,
        description: t("discovery.features.search.ui.headerSearch.recent.search"),
      })),
      ...(recentSearches.length > 0
        ? [
            {
              value: "action:clear-recent-searches",
              label: t("discovery.features.search.ui.headerSearch.clear.recent.searches"),
            },
          ]
        : []),
    ];
  }, [query, recentSearches, suggestions]);

  function submitSearch(value: string) {
    const normalizedQuery = boundedQuery(value).trim();
    if (!normalizedQuery) {
      return;
    }

    const nextRecentSearches = addRecentSearch(recentSearches, normalizedQuery);
    setRecentSearches(nextRecentSearches);
    writeRecentSearches(nextRecentSearches);
    navigate(`/search?q=${encodeURIComponent(normalizedQuery)}`);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitSearch(query);
  }

  function handleFormKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (
      event.key === "Enter" &&
      !event.nativeEvent.isComposing &&
      !event.defaultPrevented &&
      event.target instanceof HTMLInputElement
    ) {
      event.preventDefault();
      submitSearch(query);
    }
  }

  function handleValueChange(value: string) {
    if (value === "action:clear-recent-searches") {
      setRecentSearches([]);
      removeRecentSearches();
      setQuery("");
      return;
    }

    if (value.startsWith("recent:")) {
      submitSearch(value.slice("recent:".length));
      return;
    }

    const suggestion = suggestions.find((candidate) => `suggestion:${candidate.catalogItemId}` === value);
    if (suggestion) {
      submitSearch(suggestion.title);
    }
  }

  return (
    <Form role="search" spacing="none" onSubmit={handleSubmit} onKeyDown={handleFormKeyDown}>
      <Combobox
        label={t("discovery.features.search.ui.headerSearch.label")}
        hideLabel
        items={items}
        inputValue={query}
        onInputValueChange={(value) => setQuery(boundedQuery(value))}
        onValueChange={handleValueChange}
        filterItems={false}
        openOnInputClick
        placeholder={t("discovery.features.search.ui.headerSearch.placeholder")}
        noMatchesLabel={
          query.trim()
            ? t("discovery.features.search.ui.headerSearch.no.matches")
            : t("discovery.features.search.ui.headerSearch.no.recent.searches")
        }
      />
    </Form>
  );
}

function boundedQuery(value: string): string {
  return truncateDiscoverySearchSuggestionQuery(value);
}

function readRecentSearches(): string[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(MARKETPLACE_RECENT_SEARCHES_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((value): value is string => typeof value === "string")
      .map((value) => boundedQuery(value).trim())
      .filter(Boolean)
      .slice(0, RECENT_SEARCH_LIMIT);
  } catch {
    return [];
  }
}

function addRecentSearch(current: readonly string[], query: string): string[] {
  return [query, ...current.filter((value) => value.toLocaleLowerCase() !== query.toLocaleLowerCase())].slice(
    0,
    RECENT_SEARCH_LIMIT,
  );
}

function writeRecentSearches(searches: readonly string[]) {
  try {
    window.localStorage.setItem(MARKETPLACE_RECENT_SEARCHES_STORAGE_KEY, JSON.stringify(searches));
  } catch {
    return;
  }
}

function removeRecentSearches() {
  try {
    window.localStorage.removeItem(MARKETPLACE_RECENT_SEARCHES_STORAGE_KEY);
  } catch {
    return;
  }
}
