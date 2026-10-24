//! The screen's text. `Msg` is admin-web's own catalog for the screen (exported from
//! contracts/localization by scripts/export.mjs, so the copy cannot drift); `Pilot` is the
//! pilot's shell and input checks. `messages!` checks every call against the catalogs when the
//! crate compiles.
pub use ordering::Msg;
pub use pilot::Pilot;

mod ordering {
    corten::i18n::messages! {
        pub struct Msg { "en" => "locales/en.json" }
    }
}

mod pilot {
    corten::i18n::messages! {
        pub struct Pilot { "en" => "locales/pilot.en.json" }
    }
}
