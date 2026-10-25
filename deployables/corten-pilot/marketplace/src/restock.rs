//! Inventory > Restock decisions (marketplace's `/account/inventory/restock-decisions`): the
//! returned stock that needs a decision, and each one's two writes, Restock and Write off. Both are
//! the `restock-record` family on the decision, sent with the version the page read, and confirmed
//! by the list they redirect to (see `recovery`), as the storage locations' are.
use corten::{axum::http::HeaderMap, prelude::*};
use platform::receipt::Receipt;
use serde::Serialize;

use crate::{
    api::{Decision, Inventory as _, Outcome},
    app::{Config, Shared, read_failed, sign_in, url, viewer},
    form::DecisionInput,
    recovery::{self, Check, Failed, Family, Status, failed},
    text::{Msg, Pilot, Restock},
    views::{self, Decided, DecisionDraft, Posted},
};

pub fn routes(router: Router<Shared>, _shared: Shared) -> Router<Shared> {
    router
        .route(url::Restock::PATH, get(list))
        .route(url::Restocked::PATH, post(restock))
        .route(url::WrittenOff::PATH, post(write_off))
}

/// The screen's view model: what the page shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct RestockScreen {
    pub decisions: Vec<Decision>,
    /// The decisions are not readable yet after a write (marketplace's `onPending`).
    pub pending: bool,
    pub status: Status,
}

/// The page for `query`, with a refused write's form in place of its default.
async fn render(req: &Req, config: &Config, headers: &HeaderMap, query: &Check, posted: Option<Posted>) -> corten::Result {
    let viewer = viewer(req)?;
    let receipt = Receipt::from_param(query.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let status = async {
        if let Some(posted) = &posted {
            return posted.status.clone();
        }
        match &query.attempt {
            // The attempt's result is read as it is now, without waiting for a projection.
            Some(attempt) => {
                let caller = config.platform.caller(headers, config.proto, None);
                let (family, target, user) = (query.family, query.target.as_deref(), query.user.as_deref());
                recovery::check(&caller, &viewer.actor, attempt, family, target, user).await
            }
            None => Status::Ready,
        }
    };
    let (decisions, status) = tokio::join!(caller.restock_decisions(), status);
    let (decisions, pending) = match decisions {
        Ok(list) => (list.items, false),
        // marketplace's `onPending`: the page with a message and no decisions.
        Err(error) if receipt.is_some() && error.catching_up() => (Vec::new(), true),
        Err(error) => return read_failed(req, error, receipt.is_some().then(|| req.t::<Restock>().unverified())),
    };
    let screen = RestockScreen { decisions, pending, status };
    let t: Restock = req.t();
    let meta = Meta::new(t.route_title()).description(t.route_description());
    let again = url::Restock { check: query.again() };
    let view = views::restock_page(t, req.t(), req.t(), viewer, &screen, &again, posted);
    req.screen(meta, &screen, view)
}

async fn list(req: Req, State(config): State<Shared>, headers: HeaderMap, Query(query): Query<Check>) -> corten::Result {
    render(&req, &config, &headers, &query, None).await
}

async fn restock(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Form(input): Form<DecisionInput>,
) -> corten::Result {
    decide(&req, &config, &headers, Decided::Restock(id), input).await
}

async fn write_off(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Form(input): Form<DecisionInput>,
) -> corten::Result {
    decide(&req, &config, &headers, Decided::WriteOff(id), input).await
}

/// Records `which`: the list confirms an applied attempt; a refused one is its form again.
async fn decide(req: &Req, config: &Config, headers: &HeaderMap, which: Decided, input: DecisionInput) -> corten::Result {
    let p: Pilot = req.t();
    let outcome = match which {
        Decided::Restock(_) => Outcome::Restocked,
        Decided::WriteOff(_) => Outcome::WrittenOff,
    };
    let id = which.id();
    let caller = config.platform.caller(headers, config.proto, None);
    let errors = match input.command(p, outcome) {
        Ok(command) => {
            let attempt = input.attempt.as_str();
            match caller.record_decision(attempt, id, &command).await {
                Ok(written) => {
                    let check = Check::applied(Family::Restock, id, attempt, written.receipt.map(|r| r.param()));
                    return req.redirect(&url::Restock { check });
                }
                Err(error) => match failed(&caller, Family::Restock, id, attempt, error).await {
                    Failed::Refused(errors) => errors,
                    Failed::AppliedBefore => {
                        return req.redirect(&url::Restock { check: Check::applied(Family::Restock, id, attempt, None) });
                    }
                    Failed::SignIn => return sign_in(req),
                    Failed::Unknown(error) => return Err(error),
                },
            }
        }
        Err(errors) => errors,
    };
    // Nothing was applied: the form again, drawn with a new attempt, and a status that settles
    // the posted one. Marketplace reads the list again after a refusal, so the form takes the
    // decision's version as it is now (a refusal for a stale version is then sent fresh).
    let viewer = viewer(req)?;
    let status = Status::Refused(input.attempt.clone());
    let mut input = input;
    if let Ok(list) = caller.restock_decisions().await
        && let Some(decision) = list.items.iter().find(|d| d.decision_id == id)
    {
        input.expected_version = decision.version.to_string();
    }
    let draft = DecisionDraft { input, errors };
    let (t, m): (Restock, Msg) = (req.t(), req.t());
    let patch = views::RefusedDecision { t, m, viewer, which: &which, draft: &draft, status: &status };
    let posted = Posted { status: status.clone(), which: which.clone(), draft: draft.clone() };
    let page = Check::default();
    req.invalid(&draft.errors, patch, || render(req, config, headers, &page, Some(posted))).await
}
