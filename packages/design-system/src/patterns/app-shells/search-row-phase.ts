// Slice-internal search-row collapse state for MarketplaceShell. This module is
// deliberately absent from the patterns/app-shells barrel: exporting any symbol
// from shells.tsx publishes it at the package root through the wildcard chain, so
// the reducer and hook live here and are imported privately by shells.tsx and by
// their own tests only (see theme/internal-token-values.ts for the precedent).
import { useCallback, useEffect, useRef, useState } from "react";

export type SearchRowPhase = "inert" | "expanded" | "collapsed";
export type SearchRowPolicy = "always-expanded" | "collapsible";
export type SearchRowEventType = "mount" | "scroll" | "focuschange" | "viewportchange" | "routechange";

export interface SearchRowEnvironment {
  readonly enabled: boolean;
  readonly hasSearch: boolean;
  readonly belowMd: boolean;
  readonly scrollY: number;
  readonly focusInHeader: boolean;
  readonly routeIdentity: string;
}

export interface SearchRowEvent {
  readonly type: SearchRowEventType;
  readonly environment: SearchRowEnvironment;
}

export interface SearchRowState {
  readonly phase: SearchRowPhase;
  readonly travel: number;
  readonly lastScrollY: number;
  readonly routeIdentity: string;
}

export const COLLAPSE_FLOOR = 96;
export const DIRECTION_DELTA = 24;
export const SEED_PHASE: SearchRowPhase = "collapsed";

// The complete event alphabet: exactly five events, each carrying a full
// environment recomputed from live observation at dispatch time.
export const SEARCH_ROW_EVENT_TYPES = ["mount", "scroll", "focuschange", "viewportchange", "routechange"] as const;

const MD_MIN_WIDTH_PX = 768;
const INIT_EVENT_TYPES: ReadonlySet<SearchRowEventType> = new Set(["mount", "routechange", "viewportchange"]);

// #6771 Option A is an equality, not a family: the registered result route is
// always-expanded and every other pathname — including /search/<anything>, which
// is not a registered result route — is collapsible. Alias tolerance is resolved
// upstream by the canonical matched-route identity, so this compares one string
// once; no prefix, glob, or route-family widening is permitted.
export function searchRowPolicy(routeIdentity: string): SearchRowPolicy {
  return routeIdentity === "/search" ? "always-expanded" : "collapsible";
}

export function createInitialSearchRowState(routeIdentity: string): SearchRowState {
  return { phase: "inert", travel: 0, lastScrollY: 0, routeIdentity };
}

function clampTravel(travel: number): number {
  return Math.max(-DIRECTION_DELTA, Math.min(DIRECTION_DELTA, travel));
}

export function searchRowReducer(state: SearchRowState, event: SearchRowEvent): SearchRowState {
  const environment = event.environment;

  // Stage 1, accumulator fold.
  let phase: SearchRowPhase;
  let travel: number;
  let routeIdentity: string;
  const lastScrollY = environment.scrollY;
  if (INIT_EVENT_TYPES.has(event.type)) {
    phase = SEED_PHASE;
    travel = 0;
    routeIdentity = environment.routeIdentity;
  } else {
    // A non-init event never carries `inert` forward, so no armed environment
    // can resolve to `inert`.
    phase = state.phase === "inert" ? SEED_PHASE : state.phase;
    routeIdentity = state.routeIdentity;
    if (event.type === "focuschange") {
      travel = 0;
    } else {
      const step = state.lastScrollY - environment.scrollY;
      if (step === 0) {
        travel = state.travel;
      } else if (state.travel === 0 || state.travel > 0 === step > 0) {
        travel = clampTravel(state.travel + step);
      } else {
        // A direction reversal discards the old accumulator and seeds the new
        // one with the current step.
        travel = clampTravel(step);
      }
    }
  }

  // Stage 2, resolution: first match wins; total because phase is always
  // defined before this stage runs.
  const armed = environment.enabled && environment.hasSearch && environment.belowMd;
  if (!armed) {
    return { phase: "inert", travel: 0, lastScrollY, routeIdentity }; // R1
  }
  if (searchRowPolicy(routeIdentity) === "always-expanded") {
    return { phase: "expanded", travel, lastScrollY, routeIdentity }; // R2
  }
  if (environment.focusInHeader) {
    return { phase: "expanded", travel, lastScrollY, routeIdentity }; // R3
  }
  if (environment.scrollY < COLLAPSE_FLOOR) {
    return { phase: "expanded", travel, lastScrollY, routeIdentity }; // R4
  }
  if (travel >= DIRECTION_DELTA) {
    return { phase: "expanded", travel: 0, lastScrollY, routeIdentity }; // R5
  }
  if (travel <= -DIRECTION_DELTA) {
    return { phase: "collapsed", travel: 0, lastScrollY, routeIdentity }; // R6
  }
  return { phase, travel, lastScrollY, routeIdentity }; // R7
}

export interface SearchRowObservation {
  readonly event: SearchRowEvent;
  readonly state: SearchRowState;
}

type SearchRowObserver = (observation: SearchRowObservation) => void;

const searchRowObservers = new Set<SearchRowObserver>();

// Slice-internal test instrumentation: the acceptance criteria read event counts
// from an instrumented event log, never inferred from the rendered phase.
// Production registers no observer, so emission is a no-op outside tests.
export function observeSearchRowEvents(observer: SearchRowObserver): () => void {
  searchRowObservers.add(observer);
  return () => {
    searchRowObservers.delete(observer);
  };
}

export interface UseSearchRowPhaseOptions {
  readonly enabled: boolean;
  readonly hasSearch: boolean;
  readonly routeIdentity: string;
}

export interface UseSearchRowPhaseResult {
  readonly phase: SearchRowPhase;
  readonly headerRef: (node: HTMLElement | null) => void;
}

export function useSearchRowPhase(options: UseSearchRowPhaseOptions): UseSearchRowPhaseResult {
  const { enabled, routeIdentity } = options;
  const headerElementRef = useRef<HTMLElement | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const stateRef = useRef<SearchRowState>(createInitialSearchRowState(routeIdentity));
  const [phase, setPhase] = useState<SearchRowPhase>(stateRef.current.phase);

  const dispatch = useCallback((type: SearchRowEventType) => {
    const current = optionsRef.current;
    const header = headerElementRef.current;
    const active = document.activeElement;
    const event: SearchRowEvent = {
      type,
      environment: {
        enabled: current.enabled,
        hasSearch: current.hasSearch,
        belowMd: window.innerWidth < MD_MIN_WIDTH_PX,
        scrollY: window.scrollY,
        // Live containment recomputed at every event; no focusin/focusout flag
        // and no event-derived latch is kept.
        focusInHeader: header !== null && active !== null && header.contains(active),
        routeIdentity: current.routeIdentity,
      },
    };
    const next = searchRowReducer(stateRef.current, event);
    stateRef.current = next;
    for (const observer of searchRowObservers) {
      observer({ event, state: next });
    }
    setPhase(next.phase);
  }, []);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    let belowMd = window.innerWidth < MD_MIN_WIDTH_PX;
    dispatch("mount");
    const handleScroll = () => dispatch("scroll");
    const handleFocusChange = () => dispatch("focuschange");
    const handleResize = () => {
      const nextBelowMd = window.innerWidth < MD_MIN_WIDTH_PX;
      // `viewportchange` is the md crossing, not every resize: a phone URL-bar
      // resize must not re-seed the phase under the reader.
      if (nextBelowMd !== belowMd) {
        belowMd = nextBelowMd;
        dispatch("viewportchange");
      }
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleResize);
    document.addEventListener("focusin", handleFocusChange);
    document.addEventListener("focusout", handleFocusChange);
    return () => {
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("focusin", handleFocusChange);
      document.removeEventListener("focusout", handleFocusChange);
    };
  }, [enabled, dispatch]);

  const previousRouteIdentityRef = useRef(routeIdentity);
  useEffect(() => {
    if (previousRouteIdentityRef.current === routeIdentity) {
      return;
    }
    previousRouteIdentityRef.current = routeIdentity;
    if (optionsRef.current.enabled) {
      dispatch("routechange");
    }
  }, [routeIdentity, dispatch]);

  const headerRef = useCallback((node: HTMLElement | null) => {
    headerElementRef.current = node;
  }, []);

  return { phase, headerRef };
}
