//! The queue's views. Each component's stylesheet is next to it in `views/`; together they are the
//! area's stylesheet.
use corten::Component;

mod attention_page;

pub use attention_page::{AttentionPage, queue_body};

/// The area's components: its stylesheet. Its live status is the app's (`views::COMPONENTS`): the
/// catalog's lists show it too.
pub const COMPONENTS: &[Component] = &[AttentionPage];

pub mod ids {
    use corten::prelude::*;

    /// The element that streams the queue.
    #[derive(Id, Clone, Copy)]
    pub struct AttentionLiveId;
    pub const LIVE: AttentionLiveId = AttentionLiveId;

    /// The queue's counts, sources and items: what each change draws again.
    #[derive(Id, Clone, Copy)]
    pub struct AttentionQueueId;
    pub const QUEUE: AttentionQueueId = AttentionQueueId;
}
