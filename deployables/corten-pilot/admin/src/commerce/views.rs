//! Commerce's views. Each component's stylesheet and script are next to it in `views/`.
use corten::Component;

mod intake_page;
mod payouts_page;
mod recovered_page;
mod terms_page;
mod wallet_page;

pub use intake_page::IntakePage;
pub use payouts_page::{MoneyHealthPage, PayoutOperationsPage, run_part};
pub use recovered_page::RecoveredPage;
pub use terms_page::TermsPage;
pub use wallet_page::{WalletMissing, WalletPage};

/// Return Intake's components: its stylesheet and script.
pub const INTAKE: &[Component] = &[IntakePage];
/// Money Health's and Payout Operations' components: their stylesheet (their live status is the
/// app's, `crate::views::LIVE`).
pub const PAYOUTS: &[Component] = &[MoneyHealthPage];
/// Recovered Returns' components: its stylesheet.
pub const RECOVERED: &[Component] = &[RecoveredPage];
/// Commercial Terms' components: its stylesheet and script, and the sheets' dialog.
pub const TERMS: &[Component] = &[TermsPage, corten_ui::dialog::COMPONENT];
/// The Wallet Workbench's components: its stylesheet.
pub const WALLET: &[Component] = &[WalletPage];
