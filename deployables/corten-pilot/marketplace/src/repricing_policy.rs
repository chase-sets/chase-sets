//! A repricing policy's page (marketplace's `account-desk-repricing-policy` route,
//! `/account/desk/repricing/{id}`): the policy's status, settings and rules, the account-wide halt,
//! and the policy's activity with its filters and next page; Pause or Resume, Delete (asked
//! first) and the halt.
//!
//! Reads, as marketplace's loader makes them: the policy, after the write whose receipt the address
//! carries (while that read catches up, or does not find a policy just written, the page says the
//! change is saved and reads itself again; without a receipt a missing policy is a 404). Only once
//! the policy is found, and without the receipt: the halt, the day's changes and the activity, each
//! best-effort (a failed halt reads as released with its switch off, failed changes as none, and
//! failed activity says so).
//!
//! Every write posts to the page and goes back to it, a policy's write with its receipt; Delete
//! goes to the list with the receipt. A refusal is drawn on the page (422).
//!
//! Not ported: revising the policy, whose structured and advanced editors are marketplace's; Edit
//! opens marketplace's page with its editor open (`?edit=1`).
use std::time::Duration;

use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::Deserialize;

use crate::{
    api::{ApiError, RepricingActivityPage, RepricingCalls as _, RepricingHalt, RepricingPolicy},
    app::{PRICING_MANAGE, Shared, read_failed, sign_in, url},
    auth::{PricingManager, Viewer},
    repricing::messages,
    text::RepricingMsg,
    views::{self, Layout},
};

/// The activity's filters in marketplace's strip order (`repricingActivityFilterOrder`): changed,
/// each skip reason, then the three that are not an outcome.
pub const FILTERS: [&str; 19] = [
    "changed",
    "within-tolerance",
    "anchor-chain-exhausted",
    "terminal-hold",
    "terminal-pause",
    "terminal-notify-only",
    "currency-input-incomplete-or-mismatched",
    "budget-exhausted",
    "manual-edit-conflict",
    "domain-no-op",
    "policy-precondition-failed",
    "spiral-breaker-frozen",
    "resume-hysteresis",
    "repause-cooldown",
    "command-error",
    "hopeless-forecast-hold",
    "paused-for-missing-input",
    "floor-binding",
    "spiral-breaker",
];

/// The three counts shown whatever the filter (`repricingAlwaysVisibleFilters`).
pub const ALWAYS_COUNTED: [&str; 3] = ["paused-for-missing-input", "floor-binding", "budget-exhausted"];

/// The page's address: the receipt of the write it follows, and the activity's filter and page.
#[derive(Clone, Debug, Default, Deserialize, Route)]
#[route(query)]
pub struct Place {
    pub after_write: Option<String>,
    pub filter: Option<String>,
    /// The activity after this listing (Show more activity).
    pub after: Option<String>,
}

impl Place {
    /// The filter the activity is read with; one the pilot does not know reads as all
    /// (`repricingActivityFilterFrom`).
    pub fn filter(&self) -> Option<&'static str> {
        self.filter.as_deref().and_then(|filter| FILTERS.into_iter().find(|known| *known == filter))
    }
}

/// A write: Pause, Resume, Delete and the halt.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct PolicyForm {
    pub intent: String,
}

/// What the page shows.
pub struct PolicyScreen {
    pub id: String,
    pub policy: RepricingPolicy,
    pub halt: RepricingHalt,
    /// The halt could not be read: it shows as released and its switch is off.
    pub halt_failed: bool,
    pub changes_used_today: u64,
    /// The activity, or none when it could not be read.
    pub activity: Option<RepricingActivityPage>,
    pub filter: Option<&'static str>,
    /// What a write was refused for.
    pub refusal: Option<Vec<String>>,
    /// The reader may change the policy and the halt (`pricing.manage`).
    pub manage: bool,
}

/// The page at `place`, with what a write was refused for.
#[allow(clippy::too_many_arguments)]
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    place: &Place,
    refusal: Option<Vec<String>>,
    status: StatusCode,
) -> HtmlResult {
    let t: RepricingMsg = req.t();
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let read = config.platform.caller(headers, config.proto, receipt.as_ref()).repricing_policy(id).await;
    let policy = match read {
        Ok(policy) => policy,
        // A write the read has not reached, or a policy just written that it does not have yet.
        Err(error) if receipt.is_some() && (error.catching_up() || error.status() == Some(StatusCode::NOT_FOUND)) => {
            let here = url::RepricingPolicy { id, place: Place { after_write: place.after_write.clone(), ..Place::default() } };
            let head = html! {
                <meta name="robots" content="noindex">
                <ReadAgain after={Duration::from_secs(2)} />
            };
            let page = html! {
                <Layout req={req} viewer={Some(viewer)} title={t.route_policy_meta_title()} head={head}>
                    <views::RepricingPolicyCatchingUp t={t} refresh={here.href()} />
                </Layout>
            };
            return req.page(page);
        }
        Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => {
            return Err(corten::Error::status(StatusCode::NOT_FOUND));
        }
        Err(error) => return read_failed(req, Some(viewer), error, None),
    };
    let caller = config.platform.caller(headers, config.proto, None);
    let filter = place.filter();
    let (halt, budget, activity) = tokio::join!(
        caller.repricing_halt(),
        caller.repricing_budget(),
        caller.repricing_activity(id, filter, place.after.as_deref().filter(|after| !after.is_empty())),
    );
    let ended = |error: &ApiError| error.status() == Some(StatusCode::UNAUTHORIZED);
    if [halt.as_ref().err(), budget.as_ref().err(), activity.as_ref().err()].into_iter().flatten().any(ended) {
        return sign_in(req);
    }
    if let Err(error) = &halt {
        tracing::warn!("the repricing halt could not be read: {error}");
    }
    if let Err(error) = &budget {
        tracing::warn!("the repricing budget could not be read: {error}");
    }
    let activity = activity.map_err(|error| tracing::warn!("a repricing policy's activity could not be read: {error}")).ok();
    let screen = PolicyScreen {
        id: id.to_owned(),
        policy,
        halt_failed: halt.is_err(),
        halt: halt.unwrap_or_default(),
        changes_used_today: budget.map(|budget| budget.changes_used).unwrap_or_default(),
        activity,
        filter,
        refusal,
        manage: viewer.actor.can(PRICING_MANAGE),
    };
    let head = html! {
        <meta name="description" content={t.route_meta_description()}>
        <meta name="robots" content="noindex">
    };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.route_policy_meta_title()} head={head}>
            <views::RepricingPolicyPage t={t} p={req.t()} screen={&screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// The page, read after the write its address names.
pub(crate) async fn page(
    req: Req,
    Caller(PricingManager(viewer)): Caller<PricingManager>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::repricing::RepricingPolicy<'_>>,
) -> HtmlResult {
    render(&req, &viewer, &config, &headers, &route.id, &route.place, None, StatusCode::OK).await
}

/// Pause, Resume, Delete and the halt (marketplace's action's intents but Revise). A policy's write
/// goes back to the page with its receipt and Delete to the list with it; the halt is its own
/// aggregate and goes back without one, as marketplace's does.
pub(crate) async fn write(
    req: Req,
    Caller(PricingManager(viewer)): Caller<PricingManager>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::repricing::RepricingPolicy<'_>>,
    Form(form): Form<PolicyForm>,
) -> HtmlResult {
    let t: RepricingMsg = req.t();
    let id = route.id.to_string();
    let caller = config.platform.caller(&headers, config.proto, None);
    let here = |receipt: Option<&Receipt>| url::RepricingPolicy {
        id: &id,
        place: Place { after_write: receipt.map(Receipt::param), ..Place::default() },
    };
    let refused = match form.intent.as_str() {
        intent @ ("pause-policy" | "resume-policy" | "delete-policy") => {
            let change = intent.trim_end_matches("-policy");
            match caller.repricing_lifecycle(&id, change).await {
                Ok(receipt) if change == "delete" => {
                    return req.redirect(&url::Repricing { place: crate::repricing::Place::list(receipt.as_ref()) });
                }
                Ok(receipt) => return req.redirect(&here(receipt.as_ref())),
                Err(refusal) => refusal,
            }
        }
        intent @ ("engage-halt" | "release-halt") => match caller.set_repricing_halt(intent == "engage-halt").await {
            Ok(_) => return req.redirect(&here(None)),
            Err(refusal) => refusal,
        },
        _ => {
            let refusal = Some(vec![t.route_unknown_action().to_owned()]);
            let place = Place::default();
            return render(&req, &viewer, &config, &headers, &id, &place, refusal, StatusCode::UNPROCESSABLE_ENTITY).await;
        }
    };
    match messages(&req, refused, t.route_action_failed()) {
        Ok(details) => {
            let place = Place::default();
            render(&req, &viewer, &config, &headers, &id, &place, Some(details), StatusCode::UNPROCESSABLE_ENTITY).await
        }
        Err(answer) => *answer,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_filter_the_pilot_does_not_know_reads_as_all() {
        let place = |filter: &str| Place { filter: Some(filter.into()), ..Place::default() };
        assert_eq!(place("floor-binding").filter(), Some("floor-binding"));
        assert_eq!(place("budget-exhausted").filter(), Some("budget-exhausted"));
        assert_eq!(place("everything").filter(), None);
        assert_eq!(Place::default().filter(), None);
    }

    #[test]
    fn the_always_counted_filters_are_filters() {
        assert!(ALWAYS_COUNTED.iter().all(|counted| FILTERS.contains(counted)));
    }
}
