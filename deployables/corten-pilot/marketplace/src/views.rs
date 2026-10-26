//! The screen's views. Each component's stylesheet (and the recovery script) is next to it in
//! `views/`; `static/style.css` has the element defaults and the shell's frame.
use corten::{
    Component,
    axum::http::{StatusCode, Uri},
    prelude::*,
};
use platform::{
    section::{PageHeader, Section},
    theme,
};

use crate::{
    app::url,
    auth::Viewer,
    cart::CartScreen,
    form::LocationInput,
    locations::Screen,
    recovery::{Check, Status},
    restock::RestockScreen,
    text::{CartMsg, Msg, Pilot, Restock},
};

mod cart_item;
mod decision_card;
mod item_detail;
mod location_card;
mod market_nav;
mod page_actions;
mod recovery;
mod search_page;
mod set_page;

pub use cart_item::{
    AttemptBanner, CartHeading, CartIssue, CartItem, CartList, CartNotice, CartStack, CartTotals, CheckoutBar, CheckoutForm,
    CheckoutLink, EmptyCart, Reputation,
};
pub use decision_card::{Decided, DecisionCard, DecisionDraft, DecisionList, NoDecisions, RestockForm, WriteOffForm};
pub use item_detail::{ItemDetail, breadcrumb_json_ld, item_image, item_live_parts, item_page, product_json_ld};
pub use location_card::{ArchiveForm, CardList, CreateForm, LocationCard, UpdateForm};
pub use market_nav::MarketNav;
pub use page_actions::PageActions;
pub use recovery::{Notice, Recovery, WriteForm, handlers};
pub use search_page::SearchPage;
pub use set_page::SetPage;

/// Every component with a stylesheet or a script that pages in both areas render, tokens first.
pub const COMPONENTS: &[Component] = &[theme::TOKENS, MarketNav, Section];

/// The inventory screens' components (`/account/inventory`).
pub const INVENTORY: &[Component] = &[PageActions, Recovery, handlers::COMPONENT, LocationCard, DecisionCard];

/// The cart's components (`/account/cart`).
pub const CART: &[Component] = &[CartItem];

/// The item page's components (`/items`): its stylesheet, and corten-ui's handler that makes Add to
/// List's dialog modal when the server draws it open.
pub const ITEM: &[Component] = &[ItemDetail, corten_ui::dialog::COMPONENT];

/// Search's components (`/search`, `/categories`): its stylesheet and the script that applies a
/// filter as it changes.
pub const SEARCH: &[Component] = &[SearchPage, search_page::handlers::COMPONENT];

/// A set's page (`/sets`). Its cards are search's (`ItemCards`), whose stylesheet every page has
/// (`SEARCH`, todd-skelton/corten#93).
pub const SET: &[Component] = &[SetPage];

/// A form's values and what is wrong with them.
#[derive(Clone, Debug)]
pub struct Draft {
    pub input: LocationInput,
    pub errors: Errors,
}

impl Draft {
    pub fn new(input: LocationInput) -> Self {
        Draft { input, errors: Errors::new() }
    }
}

/// Which form a refused write posted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Which {
    Create,
    Update(String),
    Archive(String),
}

/// What a refused write puts in place of the page's defaults: its form and its status.
#[derive(Default)]
pub struct Forms {
    pub status: Option<Status>,
    pub draft: Option<(Which, Draft)>,
}

/// A link to a marketplace page outside the pilot.
pub fn marketplace(path: &str) -> Option<Uri> {
    format!("{}{path}", crate::app::marketplace_origin()).parse().ok()
}

/// A site-relative address the API returns (a picture, a page) on marketplace's origin, where it
/// resolves; an absolute one as it is.
pub fn on_marketplace(path: &str) -> String {
    if path.starts_with('/') { marketplace(path).map(|u| u.to_string()).unwrap_or_default() } else { path.to_owned() }
}

/// A `srcset` whose addresses are each put on marketplace's origin (`on_marketplace`).
pub fn srcset_on_marketplace(srcset: &str) -> String {
    srcset
        .split(',')
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(|candidate| match candidate.split_once(char::is_whitespace) {
            Some((url, descriptor)) => format!("{} {}", on_marketplace(url), descriptor.trim()),
            None => on_marketplace(candidate),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// The document around every page: marketplace's top bar and the user's color mode, `title`, the
/// page's own `head` tags (description, canonical, social, JSON-LD, `ReadAgain`) and the page
/// (`children`). A client navigation gets only the title, the head tags and `<main>`'s children.
/// `viewer` is the handler's `Caller` (none for a visitor, and on the error page, which Corten
/// gives no caller).
#[component]
pub fn Layout<'a, H: Render, C: Render>(
    req: &'a Req,
    viewer: Option<&'a Viewer>,
    title: &'a str,
    head: H,
    children: C,
) -> impl Document + 'a {
    let p: Pilot = req.t();
    let theme = viewer.and_then(|v| v.color_mode.theme());
    html! {
        <!DOCTYPE html>
        <html lang={req.lang()} data-theme={theme}>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <link
                    rel="preload"
                    as="font"
                    type="font/woff2"
                    crossorigin
                    href={req.asset("fonts/ibm-plex-sans-latin-400-normal.woff2")}
                >
                <link rel="stylesheet" href={req.asset("style.css")}>
                <title>{title}</title>
                {head}
                <Corten />
                <script type="module" src={req.asset("app.js")}></script>
            </head>
            <body>
                if let Some(viewer) = viewer {
                    <MarketNav p={p} viewer={viewer} path={req.path()} />
                }
                <main>{children}</main>
            </body>
        </html>
    }
}

/// The page for a failed request, in the layout (`App::error_page`). Under `corten dev` it shows
/// the error; Corten sends it with `X-Robots-Tag: noindex`.
pub fn error_page(req: &Req, failure: Failure) -> impl Document + '_ {
    let p: Pilot = req.t();
    // Each case is named, so a case Corten adds stops this compiling.
    let (title, text) = match &failure {
        Failure::NotFound => (p.error_not_found_title(), p.error_not_found()),
        Failure::Refused { .. } | Failure::CrossSite => (p.error_forbidden_title(), p.error_forbidden()),
        Failure::Failed { status, .. } if *status == StatusCode::FORBIDDEN => (p.error_forbidden_title(), p.error_forbidden()),
        Failure::WrongMethod
        | Failure::Rejected { .. }
        | Failure::Failed { .. }
        | Failure::Panicked { .. }
        | Failure::TimedOut
        | Failure::Offline => (p.error_failed_title(), p.error_failed()),
    };
    let detail = failure.detail().map(str::to_owned);
    // Corten gives the error page no caller, so it is drawn without the nav and the user's theme
    // (todd-skelton/corten#88).
    html! {
        <Layout req={req} viewer={None} title={title} head="">
            <h1>{title}</h1>
            <p>{text}</p>
            if let Some(detail) = &detail {
                <pre>{detail}</pre>
            }
        </Layout>
    }
}

/// A page that could not be drawn: its title and what to do.
pub fn failed<'a>(title: &'a str, text: &'a str) -> impl Render + 'a {
    html! {
        <h1>{title}</h1>
        <p>{text}</p>
    }
}

/// The page: what the last write did, the create form and every location.
pub fn page<'a>(
    t: Msg,
    p: Pilot,
    viewer: &'a Viewer,
    screen: &'a Screen,
    again: &'a url::Locations,
    forms: Forms,
) -> impl Render + 'a {
    let enabled = screen.status.writes();
    let (which, posted) = match forms.draft {
        Some((which, draft)) => (Some(which), Some(draft)),
        None => (None, None),
    };
    let draft_for = |form: Which, fresh: &dyn Fn() -> LocationInput| match (&which, &posted) {
        (Some(w), Some(d)) if *w == form => d.clone(),
        _ => Draft::new(fresh()),
    };
    let create = draft_for(Which::Create, &LocationInput::blank);
    let cards: Vec<_> = screen
        .locations
        .iter()
        .map(|location| {
            let id = &location.storage_location_id;
            let update = draft_for(Which::Update(id.clone()), &|| LocationInput::of(location));
            let archive = draft_for(Which::Archive(id.clone()), &|| LocationInput::of(location));
            (location, update, archive)
        })
        .collect();
    html! {
        <PageHeader
            eyebrow={t.page_seller()}
            title={t.page_storage_locations()}
            description={t.page_map_seller_defined_storage_areas_to()}
        />
        <PageActions label={t.page_back_to_inventory()} />
        <Recovery
            t={t}
            viewer={viewer}
            status={&screen.status}
            check={&again.check}
            again={&again.href()}
            list={&url::Locations::default().href()}
        />
        if screen.pending {
            <Notice text={p.load_pending()} />
        }
        <Section title={t.page_create_location()}>
            <CreateForm t={t} viewer={viewer} draft={&create} enabled={enabled} />
        </Section>
        <Section title={t.page_current_locations()}>
            <CardList>
                for (location, update, archive) in &cards {
                    <LocationCard
                        t={t}
                        viewer={viewer}
                        location={*location}
                        update={update}
                        archive={archive}
                        enabled={enabled}
                    />
                }
            </CardList>
        </Section>
    }
}

/// A refused write's patch: its form again, and a status that settles the posted attempt.
#[component]
pub fn Refused<'a>(t: Msg, viewer: &'a Viewer, write: &'a Which, draft: &'a Draft, status: &'a Status) -> impl Patch {
    let (list, check) = (url::Locations::default().href(), Check::default());
    html! {
        <Recovery t={t} viewer={viewer} status={status} check={&check} again={&list} list={&list} />
        match write {
            Which::Create => { <CreateForm t={t} viewer={viewer} draft={draft} enabled /> }
            Which::Update(id) => { <UpdateForm t={t} viewer={viewer} id={id.as_str()} draft={draft} enabled /> }
            Which::Archive(id) => { <ArchiveForm t={t} viewer={viewer} id={id.as_str()} draft={draft} enabled /> }
        }
    }
}

/// A refused restock decision: its form, drawn again with a new attempt, and the status that
/// settles the posted one.
#[derive(Clone)]
pub struct Posted {
    pub status: Status,
    pub which: Decided,
    pub draft: DecisionDraft,
}

/// The restock decisions page: what the last write did, and every pending decision.
pub fn restock_page<'a>(
    t: Restock,
    m: Msg,
    p: Pilot,
    viewer: &'a Viewer,
    screen: &'a RestockScreen,
    again: &'a url::Restock,
    posted: Option<Posted>,
) -> impl Render + 'a {
    let enabled = screen.status.writes();
    let draft_for = |form: Decided, version: u64| match &posted {
        Some(posted) if posted.which == form => posted.draft.clone(),
        _ => DecisionDraft::new(version),
    };
    let cards: Vec<_> = screen
        .decisions
        .iter()
        .map(|decision| {
            let id = &decision.decision_id;
            let restock = draft_for(Decided::Restock(id.clone()), decision.version);
            let write_off = draft_for(Decided::WriteOff(id.clone()), decision.version);
            (decision, restock, write_off)
        })
        .collect();
    html! {
        <PageHeader eyebrow={t.queue_seller()} title={t.queue_title()} description={t.queue_description()} />
        <PageActions label={t.queue_back_to_inventory()} />
        <Recovery
            t={m}
            viewer={viewer}
            status={&screen.status}
            check={&again.check}
            again={&again.href()}
            list={&url::Restock::default().href()}
        />
        if screen.pending {
            <Notice text={p.load_restock_pending()} />
        }
        <Section title={t.queue_pending()}>
            if cards.is_empty() && !screen.pending {
                <NoDecisions t={t} />
            } else {
                <DecisionList>
                    for (decision, restock, write_off) in &cards {
                        <DecisionCard
                            t={t}
                            m={m}
                            viewer={viewer}
                            decision={*decision}
                            restock={restock}
                            write_off={write_off}
                            enabled={enabled}
                        />
                    }
                </DecisionList>
            }
        </Section>
    }
}

/// A refused restock decision's patch: its form again, and a status that settles the attempt.
#[component]
pub fn RefusedDecision<'a>(
    t: Restock,
    m: Msg,
    viewer: &'a Viewer,
    which: &'a Decided,
    draft: &'a DecisionDraft,
    status: &'a Status,
) -> impl Patch {
    let (list, check) = (url::Restock::default().href(), Check::default());
    html! {
        <Recovery t={m} viewer={viewer} status={status} check={&check} again={&list} list={&list} />
        match which {
            Decided::Restock(id) => { <RestockForm t={t} m={m} viewer={viewer} id={id.as_str()} draft={draft} enabled /> }
            Decided::WriteOff(id) => { <WriteOffForm t={t} m={m} viewer={viewer} id={id.as_str()} draft={draft} enabled /> }
        }
    }
}

/// The cart page (marketplace's `CheckoutCartPage`): its one notice, the lines, the totals and
/// the checkout bar, or the empty cart.
pub fn cart_page<'a>(
    t: CartMsg,
    _viewer: &'a Viewer,
    screen: &'a CartScreen,
    notice: Option<&'a crate::cart::Notice>,
) -> impl Render + 'a {
    use crate::cart::Notice as Said;
    let paused = matches!(notice, Some(Said::Attempt(a)) if a.pauses());
    let readiness = screen.readiness.as_ref();
    let money = |m: Option<&crate::api::Money>| match m {
        Some(m) => cart_item::money(t, &m.amount, &m.currency),
        None => t.page_priced_at_checkout().to_owned(),
    };
    let total = money(readiness.and_then(|r| r.estimated_subtotal.as_ref()));
    let known = readiness.is_some_and(|r| r.estimated_subtotal.is_some());
    let savings = money(readiness.and_then(|r| r.savings.as_ref()));
    let needs_review = readiness.is_some() && !screen.lines.is_empty() && !screen.ready();
    let blocked = readiness.map_or(0, |r| r.blocked_line_count);
    let offered = screen.offered();
    let offered_seller = offered.and_then(|o| o.seller_display_name.as_deref().map(|name| crate::cart::Seller::of(name, o)));
    let offer_title = match &offered_seller {
        Some(seller) => t.page_optimization_switch_to_seller_title(&savings, seller.name).to_string(),
        None => t.page_optimization_available_title(&savings).to_string(),
    };
    let context = if screen.ready() || readiness.is_none() {
        t.page_taxes_and_shipping_calculated()
    } else {
        t.page_resolve_before_payment()
    };
    // Check out a ready cart as it is; a cart that is not ready continues to checkout to resolve it.
    let check_out = readiness.map(|r| &r.declined).filter(|s| s.status == "ready");
    let lower_price = readiness.and_then(|r| r.accepted.as_ref()).filter(|_| screen.offer());
    let (search, resolve) = (cart_item::link("/search"), cart_item::link("/checkout/buy/readiness"));
    html! {
        <PageHeader eyebrow={t.page_buy_cart()} title={t.page_your_cart()} description={t.page_simple_cart_description()} />
        <CartHeading title={t.page_items()} description={t.page_review_items_before_checkout()} />
        match notice {
            Some(Said::Checkout(issue)) => { <CartIssue title={t.page_checkout_issue()} text={issue} /> }
            Some(Said::Attempt(attempt)) => { <AttemptBanner t={t} notice={attempt} /> }
            None => {}
        }
        if screen.pending {
            <CartNotice title={t.page_cart_update_refreshing()} warning={false}>
                <p role="status">{t.route_cart_pending_fresh_write()}</p>
                <p><CheckoutLink href={&url::Cart::default().href()} label={t.page_refresh_cart()} primary={false} /></p>
            </CartNotice>
        } else if screen.lines.is_empty() {
            <EmptyCart t={t} />
        } else {
            <CartStack>
                if needs_review {
                    <CartNotice title={t.page_fulfillment_needs_review()} warning>
                        if blocked == 1 {
                            <p>{t.page_fulfillment_needs_review_description_one()}</p>
                        } else {
                            <p>{t.page_fulfillment_needs_review_description_many(blocked)}</p>
                        }
                    </CartNotice>
                } else if screen.offer() {
                    <CartNotice title={&offer_title} warning={false}>
                        <p>{t.page_optimization_available_description()}</p>
                        if let Some(seller) = &offered_seller {
                            <Reputation t={t} seller={seller} />
                        }
                    </CartNotice>
                }
                <CartList>
                    for line in &screen.lines {
                        <CartItem t={t} line={line} paused={paused} />
                    }
                </CartList>
                <CartTotals t={t} items={screen.item_count()} total={&total} known={known} />
                <CheckoutBar
                    t={t}
                    total={&total}
                    context={context}
                    primary={html! {
                        if let Some(snapshot) = check_out {
                            <CheckoutForm snapshot={snapshot} label={t.page_check_out()} primary />
                        } else {
                            <CheckoutLink href={&resolve} label={t.page_resolve_fulfillment()} primary />
                        }
                    }}
                    secondary={html! {
                        if let Some(snapshot) = lower_price {
                            <CheckoutForm snapshot={snapshot} label={t.page_use_lower_fulfillment()} primary={false} />
                        }
                        <CheckoutLink href={&search} label={t.page_keep_shopping()} primary={false} />
                    }}
                />
            </CartStack>
        }
    }
}
