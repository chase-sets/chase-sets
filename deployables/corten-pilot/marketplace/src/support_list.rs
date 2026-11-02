//! The account's support page (Platform Operations' marketplace `account-support` route and its
//! `SupportRequestListPage`): the cases on the account's purchases and on its sales, each with its
//! next deadline, its checklist and its resolution's progress; the flows a case can be opened in;
//! and Report a problem for an order (`?orderId=`), in three steps: the affected items, the issue,
//! and the outcome with the photos the issue needs.
//!
//! The steps are the page's address (`?orderId=&line=&flow=&step=`): each step is a GET form, so Back,
//! a reload and a shared link keep what was chosen, and no script runs. The last step posts its
//! address with the photos (multipart) and, as marketplace's action does, stages the photos as one
//! batch under the open's participant attempt (`sao_` and a ULID,
//! `x-support-attachment-operation-id`), then opens the case with their references
//! (`open-support-request` with `intakePhotoReferences`), so the case and its photos are one write,
//! and goes to the case. The API refuses an issue that needs photos without them. What is done is
//! carried in the form when a later part fails: the attempt, the batch, its references, and whether
//! the upload's outcome is unknown, so a retry never stages a second batch. An open that loses its
//! answer is looked up once by its attempt; one still unknown turns the form off and offers Check
//! status, which looks it up again and never resends it.
//!
//! The list reads give each case its customer remedy status (`customerRemedyStatus`) and its next
//! deadline (`nextDeadline`); the page shows them as given. Whether the photo input is shown
//! (`photos_required`) is the page's, as marketplace's form decides it from the flow.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/support?<ask>` | the page |
//! | `POST /account/support?<ask>` | `open` (with the photos), `new-batch`, `check-status` |
use corten::{
    Upload, UploadError,
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::chrome::Chrome;
use crate::{
    api::{
        ApiError, Caller as Api, CaseSide, ParticipantLookup, Photo, SupportCaseRow, SupportFlowSummary, SupportListCalls as _,
        SupportOrderLookup,
    },
    app::{Shared, read_failed, sign_in, url},
    auth::{SupportMember, Viewer},
    cart_attempt::attempt_id,
    items::Raw,
    listing_new::first,
    support::{self, Recovery},
    text::{Pilot, SupportMsg},
    uploads::{self, Limits, Over},
    views::{self, Layout},
};

/// The picture types a case's photo may be (`SUPPORT_EVIDENCE_ATTACHMENT_CONTENT_TYPES`).
pub const PICTURES: &str = "image/jpeg,image/png,image/webp";
/// How many photos a batch may have (`SUPPORT_EVIDENCE_ATTACHMENT_MAX_COUNT`).
pub const MAX_PHOTOS: usize = 5;
/// At most five photos of 10 MB each, and 64 KB for the rest of the form
/// (`SUPPORT_ATTACHMENT_INTAKE_MAX_BYTES`).
const LIMITS: Limits = Limits { file: 10 * 1024 * 1024, files: MAX_PHOTOS, whole: MAX_PHOTOS * 10 * 1024 * 1024 + 64 * 1024 };
const OPEN: &str = "open-support-request";

/// What the page's address asks for: an order to open a case for (marketplace's `orderId` and `flow`),
/// the intake's step and the items chosen, and a case just opened (`opened`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, Route)]
#[route(query)]
pub struct Ask {
    #[serde(rename = "orderId")]
    pub order_id: Option<String>,
    pub flow: Option<String>,
    pub step: Option<String>,
    #[serde(default)]
    pub line: Vec<String>,
    pub opened: Option<String>,
}

impl Ask {
    /// The order the address names, if any.
    pub fn order(&self) -> Option<&str> {
        self.order_id.as_deref().map(str::trim).filter(|o| !o.is_empty())
    }

    /// The same order and choices at another step.
    pub fn at(&self, step: Step) -> Ask {
        Ask { step: Some(step.as_str().to_owned()), opened: None, ..self.clone() }
    }
}

/// The intake's steps (marketplace's `IntakeStep`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Step {
    Items,
    Issue,
    Review,
}

impl Step {
    pub const ALL: [Step; 3] = [Step::Items, Step::Issue, Step::Review];

    fn of(step: Option<&str>) -> Step {
        match step {
            Some("issue") => Step::Issue,
            Some("review") => Step::Review,
            _ => Step::Items,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Step::Items => "items",
            Step::Issue => "issue",
            Step::Review => "review",
        }
    }
}

/// The last step's form: what it does (`intent`), the account it was drawn for, the open's
/// attempt, the photo batch and what is already done, Check status's attempt, and the photos.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct OpenInput {
    pub intent: String,
    pub account: String,
    pub attempt: String,
    pub operation: String,
    pub refs: Vec<String>,
    pub uncertain: String,
    pub check_attempt: String,
    pub check_hash: String,
    pub attachments: String,
}

/// The open's attempt and its photo batch, and what of it is done (marketplace's
/// `participantAttemptId`, `attachmentOperationId`, `uploadedAttachmentReferences` and
/// `uploadUncertain`). The photos are staged under the attempt, so the two stay together until the
/// case is open: a new batch is a new attempt.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Batch {
    pub attempt: String,
    pub operation: String,
    /// The photos' references once staged.
    pub refs: Vec<String>,
    /// The upload's outcome is not known: it is not sent again.
    pub uncertain: bool,
}

impl Batch {
    pub fn new() -> Batch {
        Batch {
            attempt: uuid::Uuid::new_v4().to_string(),
            operation: format!("sao_{}", ulid::Ulid::new()),
            refs: Vec::new(),
            uncertain: false,
        }
    }

    /// Whether the form carries a batch to recover (Start a new photo batch is offered).
    pub fn recovered(&self) -> bool {
        !self.refs.is_empty() || self.uncertain
    }
}

/// A batch id the API takes (`validateSupportAttachmentOperationId`): `sao_` and a ULID.
fn operation_ok(operation: &str) -> bool {
    operation.strip_prefix("sao_").is_some_and(|id| {
        id.len() == 26 && id.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_uppercase()) && ulid::Ulid::from_string(id).is_ok()
    })
}

/// The flows the order's party may open (`openedBy`).
pub fn open_flows<'a>(flows: &'a [SupportFlowSummary], role: &'a str) -> impl Iterator<Item = &'a SupportFlowSummary> {
    flows.iter().filter(move |flow| flow.opened_by.iter().any(|r| r == role))
}

/// Whether the photo input is shown: a required checklist item the opener owns that takes a photo
/// (marketplace's `photoRequired`). The API holds the rule itself and refuses an open without them.
pub fn photos_required(flow: &SupportFlowSummary, role: &str) -> bool {
    flow.checklist.iter().any(|item| item.required && item.owner_role == role && item.evidence_types.iter().any(|t| t == "photo"))
}

/// A case's required checklist items: how many are done, of how many.
pub fn checklist(row: &SupportCaseRow) -> (usize, usize) {
    let required = row.checklist.iter().filter(|i| i.required);
    let done = required.clone().filter(|i| i.satisfied_at.is_some()).count();
    (done, required.count())
}

/// Report a problem for one order: the order, the step, the flows its party may open and the one
/// chosen, the items chosen, whether the issue needs photos, the case already open for it, and the
/// photo batch.
#[derive(Clone, Debug, Serialize)]
pub struct Intake {
    pub order: SupportOrderLookup,
    pub step: Step,
    pub flows: Vec<SupportFlowSummary>,
    pub flow: Option<SupportFlowSummary>,
    pub lines: Vec<String>,
    pub photos: bool,
    /// Another case is open for the order (marketplace's duplicate banner).
    pub duplicate: bool,
    /// Continue was chosen with no item.
    pub choose_items: bool,
    pub batch: Batch,
}

/// The intake for `order` as the address asks: a step needing items with none chosen is the
/// items step again; the only line of an order is chosen until the buyer moves on.
pub fn intake(order: SupportOrderLookup, flows: &[SupportFlowSummary], ask: &Ask, batch: Batch) -> Intake {
    let open: Vec<SupportFlowSummary> = open_flows(flows, &order.opened_by_role).cloned().collect();
    let flow = ask.flow.as_deref().and_then(|f| open.iter().find(|o| o.flow_type == f)).or(open.first()).cloned();
    let asked = Step::of(ask.step.as_deref());
    let mut lines: Vec<String> =
        order.lines.iter().filter(|l| ask.line.contains(&l.line_id)).map(|l| l.line_id.clone()).collect();
    if lines.is_empty() && order.lines.len() == 1 && asked == Step::Items {
        lines.push(order.lines[0].line_id.clone());
    }
    let choose_items = asked != Step::Items && !order.lines.is_empty() && lines.is_empty();
    let step = match asked {
        _ if choose_items => Step::Items,
        Step::Review if flow.is_none() => Step::Issue,
        step => step,
    };
    let photos = flow.as_ref().is_some_and(|f| photos_required(f, &order.opened_by_role));
    let duplicate = order.existing_open_request.is_some();
    Intake { order, step, flows: open, flow, lines, photos, duplicate, choose_items, batch }
}

/// What the last post said: why it was refused, or an open whose outcome is not known (Check status).
#[derive(Clone, Debug, Default, Serialize)]
pub struct Said {
    pub error: Option<String>,
    pub open: Option<Recovery>,
}

impl Said {
    fn error(message: &str) -> Said {
        Said { error: Some(message.to_owned()), ..Said::default() }
    }

    /// Whether the intake's form is on: off while an attempt's outcome is not known.
    pub fn writes(&self) -> bool {
        self.open.is_none()
    }
}

/// The page.
#[derive(Serialize, ToJson)]
pub struct SupportListScreen {
    /// The account the form is drawn for.
    pub account: String,
    pub buyer: Vec<SupportCaseRow>,
    pub seller: Vec<SupportCaseRow>,
    pub flows: Vec<SupportFlowSummary>,
    pub ask: Ask,
    pub intake: Option<Intake>,
    pub lookup_error: Option<String>,
    pub said: Said,
}

pub(crate) async fn page(
    req: Req,
    chrome: Chrome,
    Caller(SupportMember(viewer)): Caller<SupportMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::support::SupportList>,
) -> HtmlResult {
    let ask = route.ask;
    let t: SupportMsg = req.t();
    let api = config.platform.caller(&headers, config.proto, None);
    let order = async {
        match ask.order() {
            Some(id) => Some(api.support_order(id).await),
            None => None,
        }
    };
    let (flows, buyer, seller, order) =
        tokio::join!(api.support_flows(), api.support_cases(CaseSide::Purchases), api.support_cases(CaseSide::Sales), order);
    let (flows, buyer, seller) = match (flows, buyer, seller) {
        (Ok(flows), Ok(buyer), Ok(seller)) => (flows, buyer, seller),
        (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => {
            return read_failed(&req, Some(&viewer), error, None, chrome.cart().await);
        }
    };
    let (intake, lookup_error) = match order {
        None => (None, None),
        Some(Ok(order)) => (Some(intake(order, &flows, &ask, Batch::new())), None),
        Some(Err(error)) if error.status() == Some(StatusCode::UNAUTHORIZED) => return sign_in(&req),
        Some(Err(error)) => {
            tracing::warn!("support order lookup failed: {error}");
            (None, Some(error.refusal().unwrap_or(t.list_route_lookup_failed()).to_owned()))
        }
    };
    let account = viewer.actor.account_id.clone();
    let screen = SupportListScreen { account, buyer, seller, flows, ask, intake, lookup_error, said: Said::default() };
    draw(&req, &viewer, screen, StatusCode::OK, chrome.cart().await)
}

fn draw(req: &Req, viewer: &Viewer, screen: SupportListScreen, status: StatusCode, cart: Option<u64>) -> HtmlResult {
    let t: SupportMsg = req.t();
    let view = html! { <views::SupportListPage t={t} screen={&screen} /> };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} cart={cart} title={t.list_route_support_marketplace()} head={()}>{view}</Layout>
    };
    if status == StatusCode::OK { req.screen(&screen, page) } else { req.page_with_status(status, page) }
}

/// What a post draws the page with again: the reads it made, and what it did.
struct Again {
    flows: Vec<SupportFlowSummary>,
    order: SupportOrderLookup,
    batch: Batch,
    said: Said,
}

/// The page again after a post, with its lists read now (empty when a read fails: the form and
/// what it carries matter more).
async fn again(
    req: &Req,
    viewer: &Viewer,
    api: &Api<'_>,
    ask: &Ask,
    again: Again,
    status: StatusCode,
    chrome: &Chrome,
) -> HtmlResult {
    let (buyer, seller) = tokio::join!(api.support_cases(CaseSide::Purchases), api.support_cases(CaseSide::Sales));
    let list = |read: Result<Vec<SupportCaseRow>, ApiError>| {
        read.unwrap_or_else(|error| {
            tracing::warn!("support list read failed: {error}");
            Vec::new()
        })
    };
    let Again { flows, order, batch, said } = again;
    let screen = SupportListScreen {
        account: viewer.actor.account_id.clone(),
        buyer: list(buyer),
        seller: list(seller),
        intake: Some(intake(order, &flows, ask, batch)),
        flows,
        ask: ask.clone(),
        lookup_error: None,
        said,
    };
    draw(req, viewer, screen, status, chrome.cart().await)
}

/// An open's body as sent (`affectedLineIds` left out when none; the staged photos'
/// `intakePhotoReferences`, with their batch when there are any) and its canonical request
/// (`canonicalParticipantRequest`): none is `null`, and an open without photos is the payload it
/// was before photos joined it.
fn open_request(order: &str, flow: &str, lines: &[String], refs: &[String], operation: &str) -> (serde_json::Value, String) {
    let mut body = json!({ "orderId": order, "flowType": flow, "intakePhotoReferences": refs });
    if !lines.is_empty() {
        body["affectedLineIds"] = json!(lines);
    }
    let mut payload = vec![
        ("orderId", json!(order)),
        ("flowType", json!(flow)),
        ("affectedLineIds", if lines.is_empty() { json!(null) } else { json!(lines) }),
    ];
    if !refs.is_empty() {
        body["attachmentOperationId"] = json!(operation);
        payload.push(("intakePhotoReferences", json!(refs)));
        payload.push(("attachmentOperationId", json!(operation)));
    }
    (body, support::canonical(OPEN, &payload))
}

/// Whether a lookup proves the attempt committed as `action_kind`, on `case` when one is named.
fn committed(lookup: &ParticipantLookup, action_kind: &str, case: Option<&str>) -> bool {
    matches!(lookup.outcome.as_str(), "committed" | "confirming")
        && lookup.action_kind.as_deref() == Some(action_kind)
        && lookup.result.as_ref().is_some_and(|r| case.is_none_or(|case| r.id == case))
}

/// Whether Check status's attempt is one this page could have drawn.
fn checkable(recovery: &Recovery) -> bool {
    attempt_id(&recovery.attempt) == recovery.attempt
        && recovery.hash.len() == 64
        && recovery.hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The case's page after a write, with its receipt.
fn to_case(req: &Req, case: &str, receipt: Option<Receipt>) -> HtmlResult {
    let place = support::Place { action: None, after_write: receipt.as_ref().map(Receipt::param) };
    req.redirect(&url::SupportCase { id: case, place })
}

/// The last step's post (marketplace's action), Start a new photo batch, and Check status.
pub(crate) async fn write(
    req: Req,
    chrome: Chrome,
    Caller(SupportMember(viewer)): Caller<SupportMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::support::SupportList>,
    upload: Upload<Raw>,
) -> HtmlResult {
    let ask = route.ask;
    let (t, p): (SupportMsg, Pilot) = (req.t(), req.t());
    let api = config.platform.caller(&headers, config.proto, None);
    let Some(order_id) = ask.order().map(str::to_owned) else {
        return Err(corten::Error::status(StatusCode::BAD_REQUEST));
    };
    let posted = uploads::read(upload, LIMITS).await;
    let (flows, order) = tokio::join!(api.support_flows(), api.support_order(&order_id));
    let flows = match flows {
        Ok(flows) => flows,
        Err(error) => return read_failed(&req, Some(&viewer), error, None, chrome.cart().await),
    };
    let order = match order {
        Ok(order) => order,
        Err(error) => return read_failed(&req, Some(&viewer), error, None, chrome.cart().await),
    };
    let posted = match posted {
        Ok(posted) => posted,
        // Nothing the form sent is kept, as marketplace's `photos.intakeRejected`.
        Err(UploadError::TooLarge { .. }) => {
            let again_ = Again { flows, order, batch: Batch::new(), said: Said::error(t.list_route_photos_intake_rejected()) };
            return again(&req, &viewer, &api, &ask, again_, StatusCode::PAYLOAD_TOO_LARGE, &chrome).await;
        }
        Err(other) => return Err(other.into()),
    };
    let f = OpenInput::FIELDS;
    let raw = &posted.fields;
    let get = |name: FieldName<String>| first(raw, name.as_str());
    let mut batch = Batch {
        attempt: attempt_id(&get(f.attempt)),
        operation: get(f.operation),
        refs: raw
            .get(f.refs.as_str())
            .map(|v| v.all().iter().map(|r| r.trim().to_owned()).filter(|r| !r.is_empty()).collect())
            .unwrap_or_default(),
        uncertain: get(f.uncertain) == "true",
    };
    let account = viewer.actor.account_id.as_str();
    let presented = get(f.account);
    macro_rules! again {
        ($batch:expr, $said:expr, $status:expr) => {
            return again(&req, &viewer, &api, &ask, Again { flows, order, batch: $batch, said: $said }, $status, &chrome).await
        };
    }
    // A form drawn for another account (`participantActorMatches`): nothing is sent.
    if !presented.is_empty() && presented != account {
        again!(batch, Said::error(t.attempt_account_changed()), StatusCode::CONFLICT);
    }
    match get(f.intent).as_str() {
        "new-batch" => again!(Batch::new(), Said::default(), StatusCode::OK),
        "check-status" => {
            let recovery = Recovery { action_kind: OPEN.to_owned(), attempt: get(f.check_attempt), hash: get(f.check_hash) };
            if !checkable(&recovery) {
                again!(batch, Said::error(t.attempt_status_unavailable()), StatusCode::BAD_REQUEST);
            }
            match api.open_attempt(&recovery.attempt, &recovery.hash).await {
                Ok((lookup, receipt)) if committed(&lookup, OPEN, None) => {
                    let case = lookup.result.map(|r| r.id).unwrap_or_default();
                    return to_case(&req, &case, receipt);
                }
                Ok(_) => again!(batch, Said { open: Some(recovery), ..Said::default() }, StatusCode::CONFLICT),
                Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => return sign_in(&req),
                Err(error) => {
                    tracing::warn!("support open check failed: {error}");
                    let said = Said { error: Some(t.attempt_status_unavailable().to_owned()), open: Some(recovery) };
                    again!(batch, said, StatusCode::CONFLICT);
                }
            }
        }
        _ => {}
    }
    let chosen = intake(order.clone(), &flows, &ask, batch.clone());
    let Some(flow) = chosen.flow.as_ref().filter(|_| chosen.step == Step::Review) else {
        again!(batch, Said::error(p.support_choice_invalid()), StatusCode::BAD_REQUEST);
    };
    if chosen.duplicate {
        again!(batch, Said::default(), StatusCode::CONFLICT);
    }
    let files: Vec<_> = posted.files.into_iter().filter(|u| u.field == f.attachments.as_str() && !u.bytes.is_empty()).collect();
    let refusal = match posted.over {
        Some(Over::FileTooLarge) => Some(t.attachments_too_large()),
        Some(Over::TooManyFiles) => Some(t.attachments_over_count()),
        None if files.iter().any(|u| !uploads::is_picture(&u.content_type, &u.bytes)) => Some(t.attachments_invalid_type()),
        None => None,
    };
    if let Some(message) = refusal {
        again!(batch, Said::error(message), StatusCode::UNPROCESSABLE_ENTITY);
    }
    if (!files.is_empty() || !batch.refs.is_empty() || batch.uncertain) && !operation_ok(&batch.operation) {
        again!(batch, Said::error(t.list_route_photos_operation_required()), StatusCode::BAD_REQUEST);
    }
    if batch.uncertain && batch.refs.is_empty() {
        again!(batch, Said::error(t.list_route_photos_uncertain()), StatusCode::CONFLICT);
    }
    // The photos: staged once per batch, under the open's attempt, before the case exists. An
    // upload whose outcome is not known is not sent again.
    if !files.is_empty() && batch.refs.is_empty() {
        let photos: Vec<Photo> =
            files.into_iter().map(|u| Photo { filename: u.filename, content_type: u.content_type, bytes: u.bytes }).collect();
        let staged = api
            .stage_intake_photos(&batch.attempt, &batch.operation, &order.order_id, &flow.flow_type, &chosen.lines, &photos)
            .await;
        match staged {
            Ok(refs) => batch.refs = refs,
            Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => return sign_in(&req),
            Err(error) => {
                tracing::warn!("support photo staging failed: {error}");
                let refused = error.status().is_some_and(|s| s.is_client_error());
                batch.uncertain = !refused;
                let message = error.refusal().unwrap_or(t.list_route_open_failed());
                let status = if refused { StatusCode::UNPROCESSABLE_ENTITY } else { StatusCode::BAD_GATEWAY };
                again!(batch, Said::error(message), status);
            }
        }
    }
    // The case, with its photos: opened once. A lost answer is looked up once by its attempt.
    let (body, canonical) = open_request(&order.order_id, &flow.flow_type, &chosen.lines, &batch.refs, &batch.operation);
    let hash = support::hash(&canonical);
    let attempt = batch.attempt.clone();
    match api.open_case(&body, &attempt, &hash).await {
        Ok((case, receipt)) => to_case(&req, &case, receipt),
        Err(error) => match error.status().map(|s| s.as_u16()) {
            Some(401) => sign_in(&req),
            // Refused before anything was applied (the API's photos rule among them).
            Some(status @ (400 | 403)) => {
                let message = error.refusal().unwrap_or(p.support_not_sent());
                let status = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
                again!(batch, Said::error(message), status);
            }
            // No answer that says what happened: one lookup; absence is never permission for a
            // second open.
            _ => {
                tracing::warn!("support open failed: {error}");
                match api.open_attempt(&attempt, &hash).await {
                    Ok((lookup, receipt)) if committed(&lookup, OPEN, None) => {
                        to_case(&req, &lookup.result.map(|r| r.id).unwrap_or_default(), receipt)
                    }
                    _ => {
                        let recovery = Recovery { action_kind: OPEN.to_owned(), attempt, hash };
                        again!(batch, Said { open: Some(recovery), ..Said::default() }, StatusCode::CONFLICT);
                    }
                }
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{SupportChecklistItem, SupportOrderLine};

    // Each hash is the web host's `hashParticipantRequest` of the same request, run through tsx.
    #[test]
    fn an_open_with_and_without_photos_hashes_as_the_web_host_hashes_it() {
        let (body, canonical) = open_request("ord_two", "product-damaged", &["ln_1".to_owned()], &[], "sao_unused");
        assert_eq!(
            body,
            json!({ "orderId": "ord_two", "flowType": "product-damaged", "affectedLineIds": ["ln_1"], "intakePhotoReferences": [] })
        );
        assert_eq!(support::hash(&canonical), "3de86eae95a471e276c0708f516b0d3e6f13023bf083f7fba1fb3b90bd5c00c4");
        let (body, canonical) = open_request("ord_one", "product-not-received", &[], &[], "sao_unused");
        assert_eq!(
            body,
            json!({ "orderId": "ord_one", "flowType": "product-not-received", "intakePhotoReferences": [] }),
            "no lines, none sent"
        );
        assert_eq!(
            canonical,
            r#"{"version":1,"actionKind":"open-support-request","payload":{"orderId":"ord_one","flowType":"product-not-received","affectedLineIds":null}}"#
        );
        assert_eq!(support::hash(&canonical), "3d6e904d0e7851214ec6299e26f18df6a73b034608d01e7ded004f4125c9d013");
        let reference = format!("support-attachment:v1:sea_01J9Z0000000000000000000A1:{}:png", "b".repeat(64));
        let operation = "sao_01J9Z00000000000000000000B";
        let (body, canonical) =
            open_request("ord_two", "product-damaged", &["ln_1".to_owned()], std::slice::from_ref(&reference), operation);
        assert_eq!(body["intakePhotoReferences"], json!([reference]));
        assert_eq!(body["attachmentOperationId"], operation, "the photos' batch, with them");
        assert_eq!(support::hash(&canonical), "99ed710d60bf138365e09ae3d962dd4f8ff63d4e28b42f9041248f18c437a1d0");
    }

    #[test]
    fn a_batch_id_is_sao_and_a_ulid() {
        assert!(operation_ok(&Batch::new().operation));
        assert!(operation_ok("sao_01J9Z00000000000000000000B"));
        assert!(!operation_ok("sao_01j9z00000000000000000000b"), "upper case, as the API writes it");
        assert!(!operation_ok("sao_short") && !operation_ok("01J9Z00000000000000000000B") && !operation_ok(""));
    }

    fn flow(kind: &str, opened_by: &str, photo_owner: Option<&str>) -> SupportFlowSummary {
        let checklist = photo_owner
            .map(|owner| SupportChecklistItem {
                key: "photo".to_owned(),
                owner_role: owner.to_owned(),
                evidence_types: vec!["photo".to_owned()],
                required: true,
                ..SupportChecklistItem::default()
            })
            .into_iter()
            .collect();
        SupportFlowSummary {
            flow_type: kind.to_owned(),
            opened_by: vec![opened_by.to_owned()],
            checklist,
            ..SupportFlowSummary::default()
        }
    }

    fn order(lines: &[&str]) -> SupportOrderLookup {
        SupportOrderLookup {
            order_id: "ord_1".to_owned(),
            opened_by_role: "buyer".to_owned(),
            lines: lines.iter().map(|id| SupportOrderLine { line_id: (*id).to_owned(), ..SupportOrderLine::default() }).collect(),
            ..SupportOrderLookup::default()
        }
    }

    #[test]
    fn the_intake_keeps_to_the_order_and_its_partys_flows() {
        let flows = [flow("damaged", "buyer", Some("buyer")), flow("late", "buyer", None), flow("cannot", "seller", None)];
        let ask = |step: &str, lines: &[&str], flow: Option<&str>| Ask {
            order_id: Some("ord_1".to_owned()),
            step: Some(step.to_owned()),
            line: lines.iter().map(|l| (*l).to_owned()).collect(),
            flow: flow.map(str::to_owned),
            opened: None,
        };
        let one = intake(order(&["ln_1"]), &flows, &ask("items", &[], None), Batch::new());
        assert_eq!(one.lines, ["ln_1"], "an order's only line is chosen");
        assert_eq!(one.flows.iter().map(|f| f.flow_type.as_str()).collect::<Vec<_>>(), ["damaged", "late"]);
        let none = intake(order(&["ln_1", "ln_2"]), &flows, &ask("review", &["ln_9"], Some("late")), Batch::new());
        assert!(none.choose_items && none.step == Step::Items, "a line not on the order is no line");
        let review = intake(order(&["ln_1", "ln_2"]), &flows, &ask("review", &["ln_2"], Some("damaged")), Batch::new());
        assert_eq!((review.step, review.lines.as_slice(), review.photos), (Step::Review, &["ln_2".to_owned()][..], true));
        let other = intake(order(&[]), &flows, &ask("review", &[], Some("cannot")), Batch::new());
        assert_eq!(other.step, Step::Review, "a whole-order case needs no line");
        assert_eq!(
            other.flow.map(|f| f.flow_type),
            Some("damaged".to_owned()),
            "a flow the party cannot open is the first it can"
        );
        let mut dup = order(&["ln_1"]);
        dup.existing_open_request =
            Some(crate::api::ExistingCase { support_request_id: "sup_dup".to_owned(), ..Default::default() });
        assert!(intake(dup, &flows, &ask("items", &[], None), Batch::new()).duplicate);
    }

    #[test]
    fn photos_are_required_when_the_opener_owns_a_required_photo() {
        assert!(photos_required(&flow("damaged", "buyer", Some("buyer")), "buyer"));
        assert!(!photos_required(&flow("damaged", "buyer", Some("seller")), "buyer"));
        assert!(!photos_required(&flow("late", "buyer", None), "buyer"));
    }
}
