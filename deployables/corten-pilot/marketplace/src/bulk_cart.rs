//! Add matching products to Buy Cart, from a search (discovery's search action, `preview-bulk-add`
//! and `commit-bulk-add`). The search's results bar offers it once the search asks for something
//! and has results: a GET form to `/search/cart` with the search's parameters, whose answer is the
//! sheet (`views::BulkCartSheet`) saying what the add would put in the cart (Discovery's preview of
//! every match: the products it names in full, and the results that need their options chosen). With
//! JavaScript the sheet is patched into the page, which has it empty; without, it is the search's
//! page with the sheet open.
//!
//! The sheet's Add eligible products posts the same parameters with an attempt (`SubmitKey`). The
//! add reads the preview again, as marketplace's action does, and sends its lines as one Checkout
//! cart attempt (`cart.add-lines`, to the account's cart or the guest cart, `cart_attempt`), so a
//! form sent twice adds once. Then:
//!
//! | The attempt | The answer |
//! |---|---|
//! | every line added or merged | the search again, after the write, saying how many (`after_write`, so the shell's cart count has them) |
//! | some lines added, others not | the sheet with the counts and each line that was not added, and Review Buy Cart |
//! | nothing added | the sheet saying so, with the API's reason |
//! | not known | the sheet saying so, with Send the same add again (the same attempt) and Review Buy Cart |
//! | over the preview's limit, or no line to add | the preview again, adding nothing |
//!
//! marketplace keeps the sheet open after a whole add, saying "Buy Cart updated"; the pilot sends
//! the search page again, as a write's answer does, so the shell's count is drawn after the write
//! with or without JavaScript, and says the counts in the page's notice. A partial add keeps its
//! sheet, so each line's reason stays on screen: without JavaScript the page gives the count it read
//! after the write; with JavaScript the patch cannot reach the shell's count, which shows the add at
//! the next page (corten-run/corten#1370).
use corten::{
    http::{HeaderMap, StatusCode},
    prelude::*,
};
use serde_json::{Value, json};

use crate::{
    api::{BulkCartLine, BulkCartPreview, Caller, CartWrite, Search as _},
    app::{Shared, sign_in_at},
    auth::Session,
    buying::{guest_cart, guest_cart_cookie},
    cart_attempt::{self, State as Attempted},
    chrome::{CartCount, count_of},
    items::Raw,
    search::{Place, Terms},
    text::SearchMsg,
    views,
};

/// The bulk add's own fields, for their names: the form is read as `Raw`, since it also sends the
/// search's parameters.
#[derive(Fields)]
#[allow(dead_code)]
pub struct BulkFields {
    attempt: Option<SubmitKey>,
    /// The category page the search is on (its slug), or none for `/search`.
    category: String,
}

/// The names as text.
pub mod field {
    use super::BulkFields;
    pub const ATTEMPT: &str = BulkFields::FIELDS.attempt.as_str();
    pub const CATEGORY: &str = BulkFields::FIELDS.category.as_str();
}

/// The sheet: what an add would put in the cart, or what one came to.
#[derive(Clone, Debug)]
pub enum Sheet {
    /// What the add would do.
    Preview(BulkCartPreview),
    /// The preview's read failed (marketplace's `bulk-error`).
    Failed,
    /// Some lines were added and others not (marketplace's `bulk-added` with failed lines).
    Partial { preview: BulkCartPreview, added: usize, merged: usize, not_added: Vec<NotAdded> },
    /// Nothing was added (`bulk-not-applied`), with the API's reason when it gave one.
    NotApplied { preview: BulkCartPreview, message: Option<String> },
    /// Whether it applied is not known (`bulk-ambiguous`): sending the same attempt again settles it.
    Ambiguous { preview: BulkCartPreview, attempt: String },
}

/// A line the add did not put in the cart: its title, and the reason when the API gave one.
#[derive(Clone, Debug)]
pub struct NotAdded {
    pub title: String,
    pub message: Option<String>,
}

impl Sheet {
    /// The preview it shows, if it has one.
    pub fn preview(&self) -> Option<&BulkCartPreview> {
        match self {
            Sheet::Preview(preview)
            | Sheet::Partial { preview, .. }
            | Sheet::NotApplied { preview, .. }
            | Sheet::Ambiguous { preview, .. } => Some(preview),
            Sheet::Failed => None,
        }
    }

    /// Whether its Add eligible products may be sent (`bulkCanCommit`).
    pub fn can_add(&self) -> bool {
        match self {
            Sheet::Preview(p) | Sheet::NotApplied { preview: p, .. } => !p.over_limit && p.eligible_count > 0,
            _ => false,
        }
    }
}

/// The search the form names: its parameters and its category page's slug.
pub struct Asked {
    pub terms: Terms,
    pub category: String,
}

impl Asked {
    fn read(raw: &Raw) -> Self {
        let category = raw.get(field::CATEGORY).and_then(|v| v.all().first()).cloned().unwrap_or_default();
        // A Load more's extra rows are not part of the search the add reads.
        Asked { terms: Terms { more: 0, category: String::new(), ..Terms::read(raw) }, category }
    }

    /// The search's own address.
    pub fn href(&self) -> String {
        let place = if self.category.is_empty() { Place::Search } else { Place::Category(&self.category) };
        place.href(&self.terms)
    }

    /// The parameters the sheet's forms send again: the search's, and its category.
    pub fn pairs(&self) -> Vec<(String, String)> {
        let mut pairs = self.terms.pairs();
        if !self.category.is_empty() {
            pairs.push((field::CATEGORY.to_owned(), self.category.clone()));
        }
        pairs
    }
}

/// The preview: the sheet, patched in with JavaScript, or the search with it open.
pub(crate) async fn preview(
    req: Req,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    let asked = Asked::read(&raw);
    let caller = config.platform.caller(&headers, config.proto, None);
    let (sheet, status) = match caller.bulk_cart_preview(&asked.terms.bulk_query(&asked.category)).await {
        Ok(preview) => (Sheet::Preview(preview), StatusCode::OK),
        Err(error) => {
            tracing::warn!("the bulk add's preview failed: {error}");
            (Sheet::Failed, StatusCode::BAD_GATEWAY)
        }
    };
    answer(&req, session.as_deref(), &caller, asked, sheet, status).await
}

/// The add: the preview read again, its lines sent as one cart attempt, and what that came to.
pub(crate) async fn commit(
    req: Req,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    let session = session.as_deref();
    let t: SearchMsg = req.t();
    let asked = Asked::read(&raw);
    let presented = raw.get(field::ATTEMPT).and_then(|v| v.all().first()).map_or("", String::as_str);
    let attempt = cart_attempt::attempt_id(presented);
    let caller = config.platform.caller(&headers, config.proto, None);
    let preview = match caller.bulk_cart_preview(&asked.terms.bulk_query(&asked.category)).await {
        Ok(preview) => preview,
        Err(error) => {
            tracing::warn!("the bulk add's preview failed: {error}");
            return answer(&req, session, &caller, asked, Sheet::Failed, StatusCode::BAD_GATEWAY).await;
        }
    };
    if preview.over_limit || preview.lines.is_empty() {
        return answer(&req, session, &caller, asked, Sheet::Preview(preview), StatusCode::OK).await;
    }
    let guest = guest_cart(session, &headers)?;
    let lines: Vec<Value> = preview.lines.iter().map(line).collect();
    let write = CartWrite::add_lines(&lines, guest.clone());
    let outcome = match cart_attempt::submit(&caller, &attempt, &write).await {
        Ok(outcome) => outcome,
        Err(StatusCode::UNAUTHORIZED) => {
            return match sign_in_at(&asked.href()) {
                Some(to) => req.redirect(&to),
                None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
            };
        }
        Err(status) => return Err(corten::Error::status(status)),
    };
    let count = |status: &str| outcome.vector.iter().filter(|c| c.status.as_deref() == Some(status)).count();
    let (added, merged) = (count("added"), count("merged"));
    let res = match outcome.state {
        Attempted::Succeeded => {
            let said = t.page_bulk_added_summary(crate::text::search_msg::PageBulkAddedSummary { added, merged }).to_string();
            let mut to = asked.href();
            if let Some(receipt) = &outcome.receipt {
                to.push(if to.contains('?') { '&' } else { '?' });
                to.push_str(&format!("after_write={}", crate::api::segment(&receipt.param())));
            }
            let Some(to) = corten::Local::parse(&to) else {
                return Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR));
            };
            req.redirect_with_notice(&to, said)?
        }
        Attempted::Partial => {
            let not_added = outcome
                .vector
                .iter()
                .filter(|c| c.outcome != "succeeded")
                .map(|c| NotAdded {
                    title: preview.lines.get(c.index).map(|l| l.title.clone()).unwrap_or_default(),
                    message: c.message.clone(),
                })
                .collect();
            let sheet = Sheet::Partial { preview, added, merged, not_added };
            if req.mode == corten::Mode::Action {
                // The patch cannot reach the shell's count, which shows the add at the next page
                // (corten-run/corten#1370).
                answer(&req, session, &caller, asked, sheet, StatusCode::OK).await?
            } else {
                // The page draws the shell's count as it read it after the write, for the cart written.
                let n = count_of(&config, &headers, guest.is_none(), guest.as_deref(), outcome.receipt.as_ref()).await;
                answer(&req, session, &caller, asked, sheet, StatusCode::OK).await?.give::<CartCount>(Some(n))
            }
        }
        Attempted::FailedSafe => {
            let message = outcome.message.or_else(|| outcome.not_applied.into_iter().flatten().next());
            answer(&req, session, &caller, asked, Sheet::NotApplied { preview, message }, StatusCode::UNPROCESSABLE_ENTITY)
                .await?
        }
        Attempted::Ambiguous => {
            answer(&req, session, &caller, asked, Sheet::Ambiguous { preview, attempt }, StatusCode::CONFLICT).await?
        }
    };
    Ok(match guest {
        Some(id) => res.with_cookie(guest_cart_cookie(&id, config.proto)),
        None => res,
    })
}

/// The sheet: patched in with JavaScript, else the search's page with it open.
async fn answer(
    req: &Req,
    session: Option<&Session>,
    caller: &Caller<'_>,
    asked: Asked,
    sheet: Sheet,
    status: StatusCode,
) -> HtmlResult {
    if req.mode == corten::Mode::Action {
        let (t, pairs) = (req.t(), asked.pairs());
        return req.patch_with_status(status, views::BulkCartSheet { t, sheet: Some(&sheet), pairs: &pairs });
    }
    crate::search::with_sheet(req, session, caller, asked.terms, asked.category, sheet, status).await
}

/// A preview's line as the add sends it (`AddCheckoutCartLineRequest`), for Smart Match to fill.
fn line(line: &BulkCartLine) -> Value {
    json!({
        "catalogItemId": line.catalog_item_id,
        "productId": line.product_id,
        "itemTitle": line.title,
        "itemSubtitle": line.subtitle,
        "itemImageUrl": line.image_url,
        "itemImageSrcSet": line.image_srcset,
        "itemImageLoadingUrl": line.image_loading_url,
        "itemImageLoadingAlt": line.image_loading_alt,
        "itemImageLoadingSrcSet": line.image_loading_srcset,
        "selectedOptions": line.selected_options,
        "productSummary": line.product_summary,
        "quantity": line.quantity,
        "fulfillmentMode": "optimize",
        "lockedListingId": null,
    })
}
