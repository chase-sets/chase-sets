//! The app: the home page, the market pages' area and the crawler files. Every page is the same for
//! everyone, so each GET answers `Public` and cannot read who is asking; joining the waitlist is
//! the one write.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /` | the home page, the waitlist's landing (`Public`) |
//! | `POST /` | join the waitlist (reads the visitor's address, so it is private), then the welcome page |
//! | `GET /welcome`, `POST /welcome` | a signup's welcome page and its wave-placement answers (private, `noindex`) |
//! | `GET /terms`, `/privacy`, `/founders`, `/seller-agreement`, `/payments-terms`, `/agent-terms`, `/authenticity-terms` | a policy document (`Public`) |
//! | `GET /help`, `/help/{category}`, `/help/{category}/{slug}`, `/sales-fees`, `/press` | the help center and its articles (`Public`) |
//! | `GET /compare/tcgplayer`, `/compare/ebay` | a comparison with the fee calculator (`Public`; with a script the calculator's GET answers with its section) |
//! | `GET /contact` | Contact (`Public`) |
//! | `GET /developers`, `/developers/{slug}`, `/developers/manifest.json`, `/llms.txt` | the developer portal, a 404 until `CHASE_SETS_M86_DEVELOPER_PORTAL_READY` (`Public`, out of search) |
//! | `GET /faq`, `/order-protection`, `/refunds-and-returns` and public-web's two older addresses | moved for good to their articles |
//! | `GET /market/{slug}` | an item's price history, market stats and links to buy or sell it on marketplace |
//! | `GET /robots.txt` | the crawler rules, and the sitemap when the site may be indexed |
//! | `GET /sitemap.xml` | the market pages, when the site may be indexed |
//! | `GET /manifest.webmanifest` | the web app manifest (`Public`, an hour) |
//! | `GET /favicon.svg`, `/favicon.ico` | the design system's logo (`Public`, a day) |
//! | `GET /.well-known/appspecific/com.chrome.devtools.json` | nothing (204, `no-store`), so Chrome stops asking |
//! | `GET /health/ready`, `/health/live` | Corten's own |
use std::sync::Arc;

use corten::prelude::*;

use crate::{api::Platform, views};

/// Where the app finds the platform API and the origins its pages name. The variables are
/// public-web's own, so the two read the same configuration.
pub struct Config {
    pub platform: Platform,
    /// The site's canonical origin (`CHASE_SETS_PUBLIC_ORIGIN`, `https://chasesets.com`): the
    /// canonical links, the sitemap's URLs, and the host the API is told it is called for.
    pub origin: String,
    /// Marketplace's origin (`CHASE_SETS_MARKETPLACE_ORIGIN`), where the item's page is.
    pub marketplace: String,
    /// Whether crawlers may index the site (`CHASE_SETS_PUBLIC_INDEXING`, `shouldIndexFromEnv`:
    /// anything but `0`, `false`, `no` or `off`).
    pub indexing: bool,
    /// The Discord invite the home page links (`CHASE_SETS_DISCORD_INVITE_URL`), when set.
    pub discord: Option<String>,
    /// Whether the developer portal is open (`CHASE_SETS_M86_DEVELOPER_PORTAL_READY` is `true`);
    /// every address of it is a 404 until it is.
    pub developers: bool,
    /// The home page's reads, kept for the next visitor.
    pub home: crate::home::Kept,
}

impl Config {
    pub fn from_env() -> Self {
        let var = |name: &str| std::env::var(name).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let origin = |name: &str, default: &str| var(name).unwrap_or_else(|| default.into()).trim_end_matches('/').to_owned();
        Config {
            platform: Platform::new(&origin("PLATFORM_API_ORIGIN", "http://localhost:7762")),
            origin: origin("CHASE_SETS_PUBLIC_ORIGIN", "https://chasesets.com"),
            marketplace: origin("CHASE_SETS_MARKETPLACE_ORIGIN", "https://marketplace.chasesets.com"),
            indexing: indexing(var("CHASE_SETS_PUBLIC_INDEXING").as_deref()),
            discord: var("CHASE_SETS_DISCORD_INVITE_URL"),
            developers: crate::developers::ready(var("CHASE_SETS_M86_DEVELOPER_PORTAL_READY").as_deref()),
            home: crate::home::Kept::default(),
        }
    }

    /// The API's calls, for no one in particular, as if for the site's own host.
    pub fn api(&self) -> crate::api::Caller<'_> {
        let host = self.origin.split_once("://").map_or(self.origin.as_str(), |(_, host)| host);
        self.platform.anonymous(host, self.proto())
    }

    /// The site's scheme, as the API is told it.
    pub fn proto(&self) -> &'static str {
        if self.origin.starts_with("http://") { "http" } else { "https" }
    }
}

/// `shouldIndexFromEnv`: on unless the variable says off.
pub fn indexing(value: Option<&str>) -> bool {
    !matches!(value.map(str::to_ascii_lowercase).as_deref(), Some("0" | "false" | "no" | "off"))
}

pub type Shared = Arc<Config>;

/// public-web's origin (`PUBLIC_WEB_ORIGIN`), for its pages this app does not serve: the home
/// page's links to the compare pages and the FAQ, and the footer's help center, fees, press and
/// contact.
pub fn public_web() -> &'static str {
    static ORIGIN: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
        std::env::var("PUBLIC_WEB_ORIGIN").unwrap_or_else(|_| "http://localhost:7754".into()).trim_end_matches('/').into()
    });
    &ORIGIN
}

/// Every URL the app serves.
pub mod url {
    pub use files::{Founders, Sitemap};
    pub use market::MarketPage;

    /// The home page and the crawler files, outside every area.
    #[corten::routes(state = crate::app::Shared)]
    pub mod files {
        /// The home page; a signup posts to it with the address's query.
        #[route("/", get = crate::home::page, post = crate::home::join)]
        pub struct Home;

        /// The policy documents (`crate::policy`).
        #[route("/terms", get = crate::policy::terms)]
        pub struct Terms;

        #[route("/privacy", get = crate::policy::privacy)]
        pub struct Privacy;

        #[route("/founders", get = crate::policy::founders)]
        pub struct Founders;

        #[route("/seller-agreement", get = crate::policy::seller_agreement)]
        pub struct SellerAgreement;

        #[route("/payments-terms", get = crate::policy::payments_terms)]
        pub struct PaymentsTerms;

        #[route("/agent-terms", get = crate::policy::agent_terms)]
        pub struct AgentTerms;

        #[route("/authenticity-terms", get = crate::policy::authenticity_terms)]
        pub struct AuthenticityTerms;

        /// Where Join lands: the signup's welcome page, and its wave-placement answers.
        #[derive(Clone, Debug, Default)]
        #[route("/welcome", get = crate::welcome::page, post = crate::welcome::save)]
        pub struct Welcome {
            #[route(query)]
            pub arrival: crate::welcome::Arrival,
        }

        /// public-web's old addresses for three articles, moved for good.
        #[route("/faq", get = crate::help::faq)]
        pub struct Faq;

        #[route("/order-protection", get = crate::help::order_protection)]
        pub struct OrderProtection;

        #[route("/refunds-and-returns", get = crate::help::refunds)]
        pub struct RefundsAndReturns;

        /// public-web's two older addresses, before those (its routes.ts).
        #[route("/buyer-protection", get = crate::help::older_protection)]
        pub struct OlderProtection;

        #[route("/seller-fees", get = crate::help::older_fees)]
        pub struct OlderFees;

        /// `llms.txt`, the developer portal's index for agents.
        #[route("/llms.txt", get = crate::developers::llms_file)]
        pub struct Llms;

        #[route("/robots.txt", get = crate::market::robots)]
        pub struct Robots;

        #[route("/sitemap.xml", get = crate::market::sitemap)]
        pub struct Sitemap;

        /// The site's own files (`crate::site`): the web app manifest, the favicon at both of
        /// public-web's addresses, and Chrome's devtools probe.
        #[route("/manifest.webmanifest", get = crate::site::web_manifest)]
        pub struct WebManifest;

        #[route("/favicon.svg", get = crate::site::favicon)]
        pub struct FaviconSvg;

        #[route("/favicon.ico", get = crate::site::favicon)]
        pub struct FaviconIco;

        #[route("/.well-known/appspecific/com.chrome.devtools.json", get = crate::site::devtools)]
        pub struct ChromeDevtools;
    }

    /// The help center (`crate::help`), an area so its stylesheet is linked from its pages only.
    #[corten::routes(state = crate::app::Shared, area = Help)]
    pub mod help {
        #[route("/help", get = crate::help::hub)]
        pub struct Help;

        #[route("/help/{category}", get = crate::help::category)]
        pub struct HelpCategory<'a> {
            pub category: &'a str,
        }

        #[route("/help/{category}/{slug}", get = crate::help::article)]
        pub struct HelpArticle<'a> {
            pub category: &'a str,
            pub slug: &'a str,
        }
    }

    /// Two articles public-web serves at their own addresses, each an area listing the help
    /// center's components, so the three share one stylesheet no other page links.
    #[corten::routes(state = crate::app::Shared, area = SalesFees)]
    pub mod sales_fees {
        #[route("/sales-fees", get = crate::help::sales_fees)]
        pub struct SalesFees;
    }

    #[corten::routes(state = crate::app::Shared, area = Press)]
    pub mod press {
        #[route("/press", get = crate::help::press)]
        pub struct Press;
    }

    /// The compare pages (`crate::compare`), an area sharing its stylesheet with Contact's.
    #[corten::routes(state = crate::app::Shared, area = CompareArea)]
    pub mod compare {
        /// The area's prefix: no page is served at `/compare` (public-web answers it 404).
        #[route("/compare")]
        pub struct CompareArea;

        /// A competitor's compare page, with the calculator's two fields as the address has them.
        #[derive(Clone, Debug, Default)]
        #[route("/compare/{competitor}", get = crate::compare::page)]
        pub struct Compare<'a> {
            pub competitor: &'a str,
            #[route(query)]
            pub inputs: crate::compare::Inputs,
        }
    }

    /// Contact, an area listing the compare pages' components.
    #[corten::routes(state = crate::app::Shared, area = Contact)]
    pub mod contact {
        #[route("/contact", get = crate::compare::contact)]
        pub struct Contact;
    }

    /// The developer portal (`crate::developers`), an area listing the help center's components.
    #[corten::routes(state = crate::app::Shared, area = Developers)]
    pub mod developers {
        #[route("/developers", get = crate::developers::portal)]
        pub struct Developers;

        #[route("/developers/manifest.json", get = crate::developers::manifest_file)]
        pub struct Manifest;

        #[route("/developers/{slug}", get = crate::developers::article)]
        pub struct Guide<'a> {
            pub slug: &'a str,
        }
    }

    /// The market pages, public.
    #[corten::routes(state = crate::app::Shared, area = Market)]
    pub mod market {
        /// The area's prefix: only the start of its pages' paths. No page is served at `/market`
        /// (public-web answers it 404), so it names no handler and nothing can link to it.
        #[route("/market")]
        pub struct Market;

        /// An item's market page, by its catalog slug.
        #[derive(Clone, Debug)]
        #[route("/market/{slug}", get = crate::market::page)]
        pub struct MarketPage<'a> {
            pub slug: &'a str,
        }
    }
}

// The app's `static/` directory, compiled into the program, so the binary is the whole deploy
// (todd-skelton/corten#268).
corten::assets::embed!(pub struct Static = "static");

pub fn app(config: Config) -> App {
    let shared: Shared = Arc::new(config);
    App::new(url::files::router(shared.clone()))
        .assets(Static)
        .messages::<crate::text::MarketMsg>()
        .components(views::COMPONENTS)
        .area(|area| url::help::area(area, shared.clone()).components(views::HELP))
        .area(|area| url::sales_fees::area(area, shared.clone()).components(views::HELP))
        .area(|area| url::press::area(area, shared.clone()).components(views::HELP))
        .area(|area| url::developers::area(area, shared.clone()).components(views::HELP))
        .area(|area| url::compare::area(area, shared.clone()).components(views::COMPARE))
        .area(|area| url::contact::area(area, shared.clone()).components(views::COMPARE))
        .area(|area| url::market::area(area, shared).components(views::MARKET))
        .error_page(views::error_page, ())
}
