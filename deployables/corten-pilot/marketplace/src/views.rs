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
    auth::{Session, Viewer},
    cart::CartScreen,
    chrome::Chrome,
    form::LocationInput,
    locations::Screen,
    recovery::{Check, Status},
    restock::RestockScreen,
    text::{CartMsg, Msg, Pilot, Restock},
};

mod account_home_page;
mod account_page;
mod address_page;
mod agents_page;
mod bulk_reprice_page;
mod cart_item;
mod channels_page;
mod checkout_page;
mod checkout_start_page;
mod consents_page;
mod decision_card;
mod desk_page;
mod imports_page;
mod inventory_item_page;
mod inventory_page;
mod item_detail;
mod listing_new_page;
mod listing_page;
mod location_card;
mod market_nav;
mod money_page;
mod notification_page;
mod offer_matches_page;
mod offline_page;
mod order_page;
mod order_review_page;
mod packing_page;
mod packing_slips_page;
mod page_actions;
mod payment_methods_page;
mod payment_page;
mod payment_start_page;
mod payout_setup_page;
mod pricing_health_page;
mod recommendations_page;
mod recovery;
mod repricing_page;
mod reviews_page;
mod search_page;
mod security_page;
mod sell_checkout_page;
mod sell_list_page;
mod seller_listing_page;
mod seller_listings_page;
mod sessions_page;
mod set_page;
mod shipment_page;
mod sign_in_page;
mod submitted_offers_page;
mod support_list_page;
mod support_page;
mod team_page;

pub use account_home_page::AccountHomePage;
pub use account_page::{AccountPage, FeedbackId, ReviewId};
pub use address_page::AddressPage;
pub use agents_page::{AgentConsentPage, AgentPage, AgentsPage};
pub use bulk_reprice_page::{BulkRepricePage, bulk_reprice_part};
pub use cart_item::{
    AttemptBanner, CartHeading, CartIssue, CartItem, CartList, CartNotice, CartStack, CartTotals, CheckoutBar, CheckoutForm,
    CheckoutLink, EmptyCart, Reputation,
};
pub use channels_page::{ChannelConnectionPage, ChannelPublicationPage, ChannelPublicationsPage, ChannelsPage, ChannelsPending};
pub use checkout_page::{BuyConfirmationPage, CheckoutPage, CheckoutRecovery};
pub use checkout_start_page::CheckoutStartPage;
pub use consents_page::ConsentsPage;
pub use decision_card::{Decided, DecisionCard, DecisionDraft, DecisionList, NoDecisions, RestockForm, WriteOffForm};
pub use desk_page::DeskPage;
pub use imports_page::ImportsPage;
pub use inventory_item_page::{InventoryItemPage, refused_stock};
pub use inventory_page::{CreateItemForm, InventoryPage, SaleForm, refused_item};
pub use item_detail::{ItemDetail, breadcrumb_json_ld, item_image, item_live_parts, item_page, product_json_ld, purchase_limit};
pub use listing_new_page::{ListingAccessRequired, NewListingPage, NewListingParts};
pub use listing_page::{ListingNotice, ListingPage, fulfillment, grouped, listing_price, unbuyable};
pub use location_card::{ArchiveForm, CardList, CreateForm, LocationCard, UpdateForm};
pub use market_nav::MarketNav;
pub use money_page::{MoneyPage, PayoutPage, PayoutPreparing};
pub use notification_page::{AlertsSection, FeedSection, NotificationPage, PreferenceSwitch, ProductAlertsId};
pub use offer_matches_page::{OfferMatchPage, OfferMatchesPage, offer_matches_live_parts};
pub use offline_page::OfflinePage;
pub use order_page::{OrderList, OrderPage};
pub use order_review_page::OrderReviewPage;
pub use packing_page::{PackingLineId, PackingPage, PackingParts, ShipmentPending};
pub use packing_slips_page::PackingSlipsPage;
pub use page_actions::PageActions;
pub use payment_methods_page::PaymentMethodsPage;
pub use payment_page::{PaymentContent, PaymentNotice, PaymentPage, PaymentWatch};
pub use payment_start_page::{PaymentStartMissing, PaymentStartPage};
pub use payout_setup_page::{PayoutSetupAccessRequired, PayoutSetupPage};
pub use pricing_health_page::PricingHealthPage;
pub use recommendations_page::{RecommendationsPage, recommendations_notice, recommendations_part};
pub use recovery::{Notice, Recovery, WriteForm, handlers};
pub use repricing_page::{RepricingPage, RepricingPolicyCatchingUp, RepricingPolicyPage, repricing_dry_run_part};
pub use reviews_page::{ReviewAnchorId, ReviewPage, ReviewPreparing, ReviewsPage};
pub use search_page::{LoadMore, ResultCard, ResultRows, ResultsId, SearchPage};
pub use security_page::SecurityPage;
pub use sell_checkout_page::{SellCheckoutPage, SellConfirmationPage};
pub use sell_list_page::SellListPage;
pub(crate) use sell_list_page::status as sell_list_status;
pub use seller_listing_page::{ListingPreparing, SellerListingPage};
pub use seller_listings_page::{SellerListingsPage, seller_listings_live_parts};
pub use sessions_page::{SessionPage, SessionsPage};
pub use set_page::SetPage;
pub use shipment_page::{ShipmentList, ShipmentPage};
pub use sign_in_page::{AccountSelectPage, InvitePage, MagicLinkFailed, RegisterPage, SignInPage};
pub use submitted_offers_page::{SubmittedOfferPage, SubmittedOfferPreparing, SubmittedOffersPage, submitted_offers_live_parts};
pub use support_list_page::SupportListPage;
pub use support_page::SupportPage;
pub use team_page::TeamPage;

/// Every component with a stylesheet or a script that pages in both areas render, tokens first.
pub const COMPONENTS: &[Component] = &[theme::TOKENS, MarketNav, market_nav::badge::COMPONENT, Section];

/// The inventory screens' components (`/account/inventory`), the import page's too.
/// The inventory list uses Create listing's catalog picker script, and corten-ui's handler that
/// makes Record sale's dialog modal.
pub const INVENTORY: &[Component] = &[
    PageActions,
    Recovery,
    handlers::COMPONENT,
    LocationCard,
    DecisionCard,
    InventoryPage,
    InventoryItemPage,
    ImportsPage,
    listing_new_page::handlers::COMPONENT,
    corten_ui::dialog::COMPONENT,
];

/// The cart's components (`/account/cart`).
pub const CART: &[Component] = &[CartItem];

/// The offline page (`/offline`), which the service worker keeps for a navigation it cannot make.
pub const OFFLINE: &[Component] = &[OfflinePage];

/// The buy checkout page (`/checkout/buy/session/{id}`) and the script that says a changed field
/// needs its totals updated.
pub const CHECKOUT: &[Component] = &[CheckoutPage, checkout_page::handlers::COMPONENT];

/// Checkout start's components (`/checkout/buy/readiness`).
pub const CHECKOUT_START: &[Component] = &[CheckoutStartPage];

/// The item page's components (`/items`): its stylesheet, the Sales tab's chart, corten-ui's
/// handler that makes Add to List's dialog modal when the server draws it open, and the analytics.
pub const ITEM: &[Component] =
    &[ItemDetail, platform::chart::TimeSeries, corten_ui::dialog::COMPONENT, item_detail::analytics::COMPONENT];

/// Search's components (the home page, `/search`, `/categories`, and `/sets` for its cards): its
/// stylesheet, the script that applies a filter as it changes, and the analytics a result's click
/// sends. In `App::components`, since the home page is outside every area.
pub const SEARCH: &[Component] = &[SearchPage, search_page::handlers::COMPONENT, item_detail::analytics::COMPONENT];

/// A set's page (`/sets`). Its cards are search's (`ItemCards`), in `App::components`.
pub const SET: &[Component] = &[SetPage];

/// An account's public page (`/accounts`): its stylesheet, and corten-ui's handler that makes a
/// refused Report review's dialog modal.
pub const ACCOUNT: &[Component] = &[AccountPage, corten_ui::dialog::COMPONENT];

/// The account's own page (`/account`). Its prefix holds every other `/account/..` area, and a page
/// under nested areas links each one's stylesheet, so an area of its own would put this on every
/// account page as one more request: it is in `App::components` instead (todd-skelton/corten#239).
pub const ACCOUNT_HOME: &[Component] = &[AccountHomePage];

/// The notification center (`/account/notifications`).
pub const NOTIFICATIONS: &[Component] = &[NotificationPage];

/// The account's shipping addresses (`/account/shipping-addresses`): its stylesheet, and corten-ui's
/// handler that makes a refused update's dialog modal.
pub const ADDRESSES: &[Component] = &[AddressPage, corten_ui::dialog::COMPONENT];

/// The user's security page (`/account/security`): its stylesheet and corten-ui's Copy for a new
/// secret. Revoke's dialog opens with `command="show-modal"`, which needs no script.
pub const SECURITY: &[Component] = &[SecurityPage, corten_ui::CopyButton];

/// The account's team (`/account/team`): its stylesheet.
pub const TEAM: &[Component] = &[TeamPage];
/// The user's consent history (`/account/consents`): its stylesheet.
pub const CONSENTS: &[Component] = &[ConsentsPage];
/// The account's reviews (`/account/reviews`, `/received`, `/written` and a review's own page):
/// their stylesheet.
pub const REVIEWS: &[Component] = &[ReviewsPage];

/// The account's connected agents (`/account/agents` and a grant's page) and an agent's consent:
/// their stylesheet and corten-ui's Copy for the connector URL and a new signing secret. Revoke
/// access's dialog opens with `command="show-modal"`, which needs no script.
pub const AGENTS: &[Component] = &[AgentsPage, corten_ui::CopyButton];
/// The user's sessions (`/account/sessions`): the list's and a session's stylesheet. Revoke's
/// dialog opens with `command="show-modal"`, which needs no script.
pub const SESSIONS: &[Component] = &[SessionsPage];

/// Create listing's page and its script.
pub const NEW_LISTING: &[Component] = &[NewListingPage, listing_new_page::handlers::COMPONENT];

/// The seller's listings (`/account/listings`): the list with its script, and a listing's page.
pub const SELLER_LISTING: &[Component] = &[SellerListingsPage, seller_listings_page::handlers::COMPONENT, SellerListingPage];

/// The Sell List (`/account/sell-list`) and the Seller Desk's Offers & sell list (`/account/desk/offers`):
/// its stylesheet. No script: Decline selected's dialog opens with `command="show-modal"`.
pub const SELL_LIST: &[Component] = &[SellListPage];

/// Seller checkout (`/checkout/sell/session/{id}`) and its confirmation: their stylesheet. No script:
/// each saved detail folds its fields under a `<details>`.
pub const SELL_CHECKOUT: &[Component] = &[SellCheckoutPage];

/// The Seller Desk home (`/account/desk`).
pub const DESK: &[Component] = &[DeskPage];

/// The Seller Desk's money page (`/account/desk/money`). A payout's breakdown opens with
/// `command="show-modal"`; a wallet adjustment's is drawn open (corten-ui's `dialog::modalClosedBy`).
pub const MONEY: &[Component] = &[MoneyPage];
/// Payout setup (`/account/desk/settings`), with Stripe's Connect components and the Stripe.js
/// module their appearance comes from.
pub const PAYOUT_SETUP: &[Component] = &[PayoutSetupPage, payout_setup_page::ConnectSurface, payment_page::stripe::COMPONENT];
/// A buyer's payment, with Stripe's step and the Stripe.js loader it imports, and starting a payment
/// for the buyer's orders (`/account/payments/new`, no script).
pub const PAYMENT: &[Component] = &[PaymentPage, payment_page::PaymentEntry, payment_page::stripe::COMPONENT, PaymentStartPage];

/// The account's saved payment methods (`/account/payment-methods`), with Add's secure step and the
/// Stripe.js loader it imports.
pub const PAYMENT_METHODS: &[Component] =
    &[PaymentMethodsPage, payment_methods_page::PaymentSetup, payment_page::stripe::COMPONENT];

/// The account's support (`/account/support`) and a Support Request's participant page
/// (`/account/support/{id}`), with corten-ui's `CheckboxGroup` on the affected items and
/// `RequiredWhen` on a partial refund's amount; the handlers check both without a script.
pub const SUPPORT: &[Component] = &[SupportListPage, SupportPage, corten_ui::CheckboxGroup, corten_ui::RequiredWhen];

/// The Seller Desk's repricing page (`/account/desk/repricing`) and the script that applies an
/// editor's choice as it changes.
pub const REPRICING: &[Component] = &[RepricingPage, repricing_page::handlers::COMPONENT];
/// The pricing recommendations (`/account/repricing`).
pub const RECOMMENDATIONS: &[Component] = &[RecommendationsPage];
/// Pricing health (`/account/desk/pricing-health`).
pub const PRICING_HEALTH: &[Component] = &[PricingHealthPage];
pub const CHANNELS: &[Component] = &[ChannelsPage];
/// Bulk reprice (`/account/bulk-reprice`).
pub const BULK_REPRICE: &[Component] = &[BulkRepricePage];

/// The seller's offer matches (`/account/offers/matches`), the list and a match's page.
pub const OFFER_MATCHES: &[Component] = &[OfferMatchesPage];
pub const SUBMITTED_OFFERS: &[Component] = &[SubmittedOffersPage, submitted_offers_page::handlers::COMPONENT];

/// The account's orders (`/account/purchases` and `/account/sales`).
pub const ORDERS: &[Component] = &[OrderPage, OrderReviewPage];
/// The buyer's shipment pages (Fulfillment's).
pub const SHIPMENTS: &[Component] = &[ShipmentPage];
/// The seller's: a shipment's page, the packing page with its script, which the shipment page's
/// Start packing form also uses, and the packing slips with Print's. Not the buyer's, whose pages
/// never pack.
pub const SALE_SHIPMENTS: &[Component] = &[
    ShipmentPage,
    PackingPage,
    packing_page::handlers::COMPONENT,
    corten_ui::CopyButton,
    PackingSlipsPage,
    corten_ui::PrintButton,
];

/// A listing's public page (`/listings`).
pub const LISTING: &[Component] = &[ListingPage];

/// Signing in's pages (`/sign-in`, `/account/select`): the sign-in page's stylesheet.
pub const SIGN_IN: &[Component] = &[SignInPage];

/// Creating an account (`/register`) and accepting an invitation (`/invite`): the sign-in page's
/// stylesheet, which they share.
pub const REGISTER: &[Component] = &[SignInPage];

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
/// resolves, with its fragment (`#feedback`; a `Uri` has none); an absolute one as it is.
pub fn on_marketplace(path: &str) -> String {
    if !path.starts_with('/') {
        return path.to_owned();
    }
    let (path, fragment) = path.split_once('#').map_or((path, None), |(path, fragment)| (path, Some(fragment)));
    match (marketplace(path), fragment) {
        (Some(uri), Some(fragment)) => format!("{uri}#{fragment}"),
        (Some(uri), None) => uri.to_string(),
        (None, _) => String::new(),
    }
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

/// The document around every page: marketplace's shell (the top bar, the account menu and the
/// phone's bottom bar) and the user's color mode, `title`, the page's own `head` tags
/// (description, canonical, social, JSON-LD, `ReadAgain`) and the page (`children`). A client
/// navigation gets only the title, the head tags and `<main>`'s children. `viewer` is the handler's
/// `Caller` (none for a visitor, who gets the visitor's shell), and `cart` the cart's count its
/// `Chrome` read (`crate::chrome`).
#[component]
pub fn Layout<'a, H: Render, C: Render>(
    req: &'a Req,
    viewer: Option<&'a Viewer>,
    cart: Option<u64>,
    title: &'a str,
    head: H,
    children: C,
) -> impl Document + 'a {
    html! {
        <Frame req={req} viewer={viewer} cart={cart} shell={true} title={title} head={head}>{children}</Frame>
    }
}

/// `Layout`'s document, with the shell (`shell`) or without it: for a page that cannot say who is
/// asking, the offline page (the same for everyone; marketplace serves it outside its layout) and
/// a session the API could not read, where a visitor's Sign in would be wrong.
#[component]
pub fn Frame<'a, H: Render, C: Render>(
    req: &'a Req,
    viewer: Option<&'a Viewer>,
    cart: Option<u64>,
    shell: bool,
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
                    href={req.asset(crate::app::Static::FONTS_IBM_PLEX_SANS_LATIN_400_NORMAL_WOFF2)}
                >
                <link rel="stylesheet" href={req.asset(crate::app::Static::STYLE_CSS)}>
                <title>{title}</title>
                {head}
                <Corten />
                <script type="module" src={req.asset(crate::app::Static::APP_JS)}></script>
            </head>
            <body data-shell={shell}>
                if shell {
                    <MarketNav p={p} viewer={viewer} cart={cart} path={req.path()} />
                }
                <main>{children}</main>
            </body>
        </html>
    }
}

/// The page for a failed request, in the layout (`App::error_page`), for who is asking: a member's
/// shell and theme, a visitor's shell, and no shell when the session could not be read. Under
/// `corten dev` it shows the error; Corten sends it with `X-Robots-Tag: noindex`.
pub async fn error_page(failure: Failure, req: Req, chrome: Chrome, session: Option<Caller<Session>>) -> HtmlResult {
    let p: Pilot = req.t();
    // Each case is named, so a case Corten adds stops this compiling.
    let (title, text) = match &failure {
        Failure::NotFound => (p.error_not_found_title(), p.error_not_found()),
        Failure::Refused { .. } | Failure::CrossSite => (p.error_forbidden_title(), p.error_forbidden()),
        Failure::Failed { status, .. } if *status == StatusCode::FORBIDDEN => (p.error_forbidden_title(), p.error_forbidden()),
        // The platform API could not say whose the session is (`Refused::unavailable`).
        Failure::Unidentified { .. } => (p.error_unidentified_title(), p.error_unidentified()),
        // A form Corten could not read (a submit key that is not one, a field of the wrong kind):
        // the page that sent it no longer matches what the server reads.
        Failure::Rejected { status, .. } if *status == StatusCode::UNPROCESSABLE_ENTITY => {
            (p.error_failed_title(), p.check_attempt())
        }
        Failure::WrongMethod
        | Failure::Rejected { .. }
        | Failure::Failed { .. }
        | Failure::Panicked { .. }
        | Failure::TimedOut
        | Failure::Offline => (p.error_failed_title(), p.error_failed()),
    };
    let detail = failure.detail().map(str::to_owned);
    let viewer = session.as_ref().and_then(|Caller(session)| session.viewer());
    let cart = chrome.cart().await;
    // An account refused the seller's listings may not manage listings: marketplace's "Account
    // access required" page (`AccountAccessRequiredPage`), back to the page asked for.
    if let (Failure::Refused { .. }, Some(viewer)) = (&failure, viewer)
        && (req.path() == "/account/listings" || req.path().starts_with("/account/listings/"))
    {
        let t: crate::text::ListingNewMsg = req.t();
        let back = req.path().to_owned();
        return req.page(html! {
            <Layout req={&req} viewer={Some(viewer)} cart={cart} title={t.route_account_access_required_title()} head="">
                <ListingAccessRequired t={t} back={&back} />
            </Layout>
        });
    }
    // Who is asking is unknown when the session could not be read: no shell, not a visitor's.
    let shell = !matches!(failure, Failure::Unidentified { .. });
    req.page(html! {
        <Frame req={&req} viewer={viewer} cart={cart} shell={shell} title={title} head="">
            <h1>{title}</h1>
            <p>{text}</p>
            if let Some(detail) = &detail {
                <pre>{detail}</pre>
            }
        </Frame>
    })
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
                        location={location}
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
                            decision={decision}
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
pub fn cart_page<'a>(t: CartMsg, screen: &'a CartScreen, notice: Option<&'a crate::cart::Notice>) -> impl Render + 'a {
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
    let (search, resolve) = (cart_item::link("/search"), url::CheckoutStart.href());
    // The nav's badge keeps the count this read found (a client navigation keeps the layout).
    let count = (!screen.pending).then(|| screen.item_count());
    html! {
        if let Some(count) = count {
            <span hidden on:connect={market_nav::badge::known(count)}></span>
        }
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
