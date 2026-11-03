//! The pages' text. `MarketMsg` is the Pricing context's market page catalog with public-web's
//! own (its error and not-found words), `HomeMsg` Public Presence's home page catalog, `PolicyMsg` its policy pages', `HelpMsg` its help center's, `CompareMsg` its compare pages' and Contact's, exported from contracts/localization by
//! scripts/export.mjs, so the copy cannot drift; `Pilot` is what the pilot says itself, the
//! design system's English chart words among it. `messages!` checks every call against the
//! catalogs when the crate compiles.
pub use compare::CompareMsg;
pub use developers::DevelopersMsg;
pub use help::HelpMsg;
pub use home::HomeMsg;
pub use market::MarketMsg;
pub use pilot::Pilot;
pub use policy::PolicyMsg;

mod market {
    corten::i18n::messages! {
        pub struct MarketMsg { "en" => "locales/market.en.json" }
    }
}

mod home {
    corten::i18n::messages! {
        pub struct HomeMsg { "en" => "locales/home.en.json" }
    }
}

mod compare {
    corten::i18n::messages! {
        pub struct CompareMsg { "en" => "locales/compare.en.json" }
    }
}

mod developers {
    corten::i18n::messages! {
        pub struct DevelopersMsg { "en" => "locales/developers.en.json" }
    }
}

mod help {
    corten::i18n::messages! {
        pub struct HelpMsg { "en" => "locales/help.en.json" }
    }
}

mod policy {
    corten::i18n::messages! {
        pub struct PolicyMsg { "en" => "locales/policy.en.json" }
    }
}

mod pilot {
    corten::i18n::messages! {
        pub struct Pilot { "en" => "locales/pilot.en.json" }
    }
}
