//! The pages' text. `MarketMsg` is the Pricing context's market page catalog with public-web's
//! own (its error and not-found words), exported from contracts/localization by
//! scripts/export.mjs, so the copy cannot drift; `Pilot` is what the pilot says itself, the
//! design system's English chart words among it. `messages!` checks every call against the
//! catalogs when the crate compiles.
pub use market::MarketMsg;
pub use pilot::Pilot;

mod market {
    corten::i18n::messages! {
        pub struct MarketMsg { "en" => "locales/market.en.json" }
    }
}

mod pilot {
    corten::i18n::messages! {
        pub struct Pilot { "en" => "locales/pilot.en.json" }
    }
}
