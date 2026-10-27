//! The app: the home page, the market pages' area and the crawler files. Every page is the same for
//! everyone, so each GET answers `Public` and cannot read who is asking; joining the waitlist is
//! the one write.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /` | the home page, the waitlist's landing (`Public`) |
//! | `POST /` | join the waitlist (reads the visitor's address, so it is private) |
//! | `GET /market/{slug}` | an item's price history, market stats and links to buy or sell it on marketplace |
//! | `GET /robots.txt` | the crawler rules, and the sitemap when the site may be indexed |
//! | `GET /sitemap.xml` | the market pages, when the site may be indexed |
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
/// page's links to the compare pages, the founders' terms, the FAQ, the policies and `/welcome`.
pub fn public_web() -> &'static str {
    static ORIGIN: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
        std::env::var("PUBLIC_WEB_ORIGIN").unwrap_or_else(|_| "http://localhost:7754".into()).trim_end_matches('/').into()
    });
    &ORIGIN
}

/// Every URL the app serves.
pub mod url {
    pub use files::Sitemap;
    pub use market::{Market, MarketPage};

    /// The home page and the crawler files, outside every area.
    #[corten::routes(state = crate::app::Shared)]
    pub mod files {
        /// The home page; a signup posts to it with the address's query.
        #[route("/", get = crate::home::page, post = crate::home::join)]
        pub struct Home;

        #[route("/robots.txt", get = crate::market::robots)]
        pub struct Robots;

        #[route("/sitemap.xml", get = crate::market::sitemap)]
        pub struct Sitemap;
    }

    /// The market pages, public.
    #[corten::routes(state = crate::app::Shared, area = Market)]
    pub mod market {
        /// The area: its prefix (no page of its own) and stylesheet.
        #[route("/market", link)]
        pub struct Market;

        /// An item's market page, by its catalog slug.
        #[derive(Clone, Debug)]
        #[route("/market/{slug}", get = crate::market::page)]
        pub struct MarketPage<'a> {
            pub slug: &'a str,
        }
    }
}

pub fn app(config: Config) -> App {
    let shared: Shared = Arc::new(config);
    App::new(url::files::router(shared.clone()))
        .messages::<crate::text::MarketMsg>()
        .components(views::COMPONENTS)
        .area::<url::Market>(|area| url::market::area(area, shared).components(views::MARKET))
        .error_page(views::error_page, ())
}
