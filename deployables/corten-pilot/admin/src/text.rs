//! The screens' text. `Msg` is admin-web's own catalog for the postage screen and `Cat` its
//! catalog area's, `Ops` the Operations Attention queue's (all exported from contracts/localization
//! by scripts/export.mjs, so the copy cannot drift); `Pilot` is the pilot's shell and input checks. `messages!` checks every call
//! against the catalogs when the crate compiles.
pub use catalog::Cat;
pub use operations::Ops;
pub use ordering::Msg;
pub use pilot::Pilot;

/// A name as `export.mjs` writes a key's segment: `aliasCandidate` is `alias_candidate`.
pub fn snake_case(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 4);
    let mut after_word = false;
    for c in name.chars() {
        if c.is_ascii_uppercase() && after_word {
            out.push('_');
        }
        after_word = c.is_ascii_lowercase() || c.is_ascii_digit();
        out.push(c.to_ascii_lowercase());
    }
    out
}

mod ordering {
    corten::i18n::messages! {
        pub struct Msg { "en" => "locales/en.json" }
    }
}

mod catalog {
    corten::i18n::messages! {
        pub struct Cat { "en" => "locales/catalog.en.json" }
    }
}

mod operations {
    corten::i18n::messages! {
        pub struct Ops { "en" => "locales/operations.en.json" }
    }
}

mod pilot {
    corten::i18n::messages! {
        pub struct Pilot { "en" => "locales/pilot.en.json" }
    }
}
