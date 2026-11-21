//! Post-write consistency as marketplace-web reports it: what a page read after a write found,
//! counted as `chase_sets_post_write_consistency_events_total` with the labels
//! `postWriteConsistencyEventAttributes` gives it (docs/architecture/post-write-consistency.md).
//! A page builds an [`Event`] and [`record`]s it. With the `otlp` feature the event is counted, and
//! without it nothing happens. The page also reads the address's semantic handoff here
//! ([`HandoffState`], `readPostWriteHandoffState`), since the handoff decides many of the outcomes.
use std::cell::RefCell;

use serde::Deserialize;

use crate::receipt::{Freshness, Receipt};

/// What a semantic handoff expects the page to show after its write (`PostWriteHandoff`).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Handoff {
    pub kind: String,
    pub expectation: String,
    #[serde(default)]
    pub surface: Option<String>,
}

const EXPECTATIONS: [&str; 4] = ["resource-present", "resource-updated", "resource-absent", "collection-non-empty"];

/// `isPortableHandoffText`: a letter or digit, then up to 127 of letters, digits and `._:-`.
fn portable(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && text.len() <= 128
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

impl Handoff {
    /// A `postWriteHandoff` parameter's handoff, when it is one (`isPostWriteHandoff`).
    fn parse(param: &str) -> Option<Self> {
        let handoff: Handoff = serde_json::from_str(param).ok()?;
        let valid = portable(&handoff.kind)
            && EXPECTATIONS.contains(&handoff.expectation.as_str())
            && handoff.surface.as_deref().is_none_or(portable);
        valid.then_some(handoff)
    }
}

/// An address's handoff and its write's receipt together (`PostWriteHandoffState`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HandoffState {
    Missing(Freshness),
    Malformed(Freshness),
    /// A handoff whose receipt is not fresh: missing, malformed, from the future or expired.
    NotFreshWrite(Handoff, Freshness),
    Valid(Handoff),
}

impl HandoffState {
    /// The state of an address's `postWriteHandoff` and `afterWrite` parameters.
    pub fn of(handoff: Option<&str>, after_write: Option<&str>) -> Self {
        let freshness = Receipt::freshness(after_write);
        match handoff.filter(|h| !h.is_empty()) {
            None => HandoffState::Missing(freshness),
            Some(text) => match Handoff::parse(text) {
                None => HandoffState::Malformed(freshness),
                Some(handoff) if freshness == Freshness::Valid => HandoffState::Valid(handoff),
                Some(handoff) => HandoffState::NotFreshWrite(handoff, freshness),
            },
        }
    }

    /// The receipt's freshness, whatever the handoff.
    pub fn freshness(&self) -> Freshness {
        match self {
            HandoffState::Missing(f) | HandoffState::Malformed(f) | HandoffState::NotFreshWrite(_, f) => *f,
            HandoffState::Valid(_) => Freshness::Valid,
        }
    }

    /// The handoff, when the address carries one that parses.
    pub fn handoff(&self) -> Option<&Handoff> {
        match self {
            HandoffState::NotFreshWrite(h, _) | HandoffState::Valid(h) => Some(h),
            HandoffState::Missing(_) | HandoffState::Malformed(_) => None,
        }
    }
}

/// One post-write outcome, with `PostWriteConsistencyEventSignal`'s fields. A field left `None`
/// is the label `none`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Event {
    pub context: &'static str,
    pub surface: &'static str,
    pub strategy: &'static str,
    pub outcome: &'static str,
    pub route_id: &'static str,
    pub route_template: &'static str,
    pub correction_source: Option<String>,
    pub actor_mode: Option<&'static str>,
    pub recovery_action: Option<&'static str>,
    pub freshness_outcome: Option<&'static str>,
    pub source_context: Option<&'static str>,
    pub projection: Option<&'static str>,
    pub read_model_table: Option<&'static str>,
}

/// `boundedMetricLabel`: `none` for nothing, else each run of characters other than ASCII
/// letters, digits, `_`, `.` and `-` as one `_`, 80 at most.
pub fn label(value: Option<&str>) -> String {
    bounded(value, |c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'), 80)
}

/// `boundedRouteTemplateLabel` for the templates a page names itself: as [`label`], keeping `/`
/// and `:`, 160 at most.
fn route_template_label(value: &str) -> String {
    bounded(Some(value), |c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '/' | ':'), 160)
}

fn bounded(value: Option<&str>, keep: impl Fn(char) -> bool, max: usize) -> String {
    let Some(text) = value.map(str::trim).filter(|t| !t.is_empty()) else { return "none".to_owned() };
    let mut out = String::new();
    let mut run = false;
    for c in text.chars() {
        if keep(c) {
            out.push(c);
            run = false;
        } else if !run {
            out.push('_');
            run = true;
        }
    }
    out.chars().take(max).collect()
}

impl Event {
    /// Its labels, as `postWriteConsistencyEventAttributes` writes them.
    pub fn labels(&self) -> Vec<(&'static str, String)> {
        vec![
            ("type", "post-write.consistency".to_owned()),
            ("context", label(Some(self.context))),
            ("surface", label(Some(self.surface))),
            ("strategy", label(Some(self.strategy))),
            ("outcome", self.outcome.to_owned()),
            ("route_id", label(Some(self.route_id))),
            ("route_template", route_template_label(self.route_template)),
            ("correction_source", label(self.correction_source.as_deref())),
            ("actor_mode", label(self.actor_mode)),
            ("recovery_action", label(self.recovery_action)),
            ("freshness_outcome", label(self.freshness_outcome)),
            ("source_context", label(self.source_context)),
            ("projection", label(self.projection)),
            ("read_model_table", label(self.read_model_table)),
            ("fallback_id", label(None)),
            ("fallback_category", label(None)),
        ]
    }
}

thread_local! {
    static RECORDED: RefCell<Option<Vec<Event>>> = const { RefCell::new(None) };
}

/// Counts `event` (with the `otlp` feature), and keeps it for [`recorded`] on this thread.
pub fn record(event: Event) {
    #[cfg(feature = "otlp")]
    crate::telemetry::post_write(&event);
    RECORDED.with(|kept| {
        if let Some(events) = kept.borrow_mut().as_mut() {
            events.push(event);
        }
    });
}

/// Starts keeping what this thread [`record`]s, and returns what it kept since the last call. A
/// test on a single-threaded runtime calls it before and after the request it checks, the way
/// marketplace-web's tests register a recorder.
pub fn recorded() -> Vec<Event> {
    RECORDED.with(|kept| kept.borrow_mut().replace(Vec::new()).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADD: &str =
        r#"{"kind":"checkout.sell-list.add-line","expectation":"collection-non-empty","surface":"account-sell-list"}"#;

    #[test]
    fn a_handoff_is_read_as_read_post_write_handoff_state_reads_it() {
        assert_eq!(HandoffState::of(None, None), HandoffState::Missing(Freshness::Missing));
        assert_eq!(HandoffState::of(Some("{"), None), HandoffState::Malformed(Freshness::Missing));
        let extra = r#"{"kind":"a","expectation":"resource-present","order":"ord_1"}"#;
        assert_eq!(HandoffState::of(Some(extra), None), HandoffState::Malformed(Freshness::Missing), "safe fields only");
        let unknown = r#"{"kind":"a","expectation":"soon"}"#;
        assert_eq!(HandoffState::of(Some(unknown), None), HandoffState::Malformed(Freshness::Missing));
        let state = HandoffState::of(Some(ADD), Some("{not json"));
        assert_eq!(state.freshness(), Freshness::Malformed);
        assert_eq!(state.handoff().map(|h| h.kind.as_str()), Some("checkout.sell-list.add-line"));
        assert!(matches!(state, HandoffState::NotFreshWrite(..)));
    }

    #[test]
    fn an_event_s_labels_are_bounded_as_marketplace_web_bounds_them() {
        let event = Event {
            context: "checkout",
            surface: "account-sell-list",
            strategy: "fresh-read",
            outcome: "handoff_pending",
            route_id: "account-sell-list",
            route_template: "/account/sell-list",
            correction_source: Some("semantic-handoff:checkout.sell-list.add-line".into()),
            actor_mode: Some("account"),
            ..Event::default()
        };
        let labels = event.labels();
        let get = |name| labels.iter().find(|(n, _)| *n == name).map(|(_, v)| v.as_str()).unwrap();
        assert_eq!(get("route_template"), "/account/sell-list");
        assert_eq!(get("correction_source"), "semantic-handoff_checkout.sell-list.add-line");
        assert_eq!((get("recovery_action"), get("fallback_id")), ("none", "none"));
        assert_eq!(labels.len(), 16);
    }

    #[test]
    fn a_thread_keeps_what_it_records_once_asked() {
        record(Event { outcome: "read_data", ..Event::default() });
        assert!(recorded().is_empty(), "nothing is kept before the first call");
        record(Event { outcome: "read_data", ..Event::default() });
        assert_eq!(recorded().len(), 1);
    }
}
