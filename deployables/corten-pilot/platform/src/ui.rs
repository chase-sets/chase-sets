// corten ui 0.1.0
//! The UI kit's components, which `corten ui add` copied into `src/ui/`, styled by the design
//! system's tokens: the kit's theme names (`tokens/ui.tokens.json`, written by
//! scripts/export.mjs) are references to the design system's, in the one resolver
//! [`crate::theme`] reads, so the dark theme reaches them too. They are the pilot's to change;
//! `corten ui diff` shows how they differ from the kit.

use corten::Component;

pub mod accordion;
pub mod alert;
pub mod avatar;
pub mod badge;
pub mod breadcrumb;
pub mod button;
pub mod card;
pub mod checkbox;
pub mod combobox;
pub mod dialog;
pub mod dropdown_menu;
pub mod field;
pub mod input;
pub mod pagination;
pub mod popover;
pub mod radio_group;
pub mod select;
pub mod separator;
pub mod sheet;
pub mod skeleton;
pub mod slider;
pub mod switch;
pub mod table;
pub mod tabs;
pub mod textarea;
pub mod toasts;

/// Each component with a stylesheet, after [`crate::theme::TOKENS`]: `App::components(ui::COMPONENTS)`.
pub const COMPONENTS: &[Component] = &[
    accordion::Accordion,
    alert::Alert,
    avatar::Avatar,
    badge::Badge,
    breadcrumb::Breadcrumb,
    button::Button,
    card::Card,
    checkbox::Checkbox,
    combobox::Combobox,
    dialog::Dialog,
    dropdown_menu::DropdownMenu,
    field::Field,
    input::Input,
    pagination::Pagination,
    popover::Popover,
    radio_group::RadioGroup,
    select::Select,
    separator::Separator,
    sheet::Sheet,
    skeleton::Skeleton,
    slider::Slider,
    switch::Switch,
    table::Table,
    tabs::Tabs,
    textarea::Textarea,
    toasts::Toasts,
];
