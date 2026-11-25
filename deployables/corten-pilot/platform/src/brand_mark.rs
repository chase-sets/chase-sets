use corten::prelude::*;

/// The design system's 20px Chase Sets mark for a brand link whose text supplies its name.
/// Each placement on a page supplies a different gradient ID.
#[component(css)]
pub fn BrandMark<'a>(gradient_id: &'a str) -> impl Render {
    let fill = format!("url(#{gradient_id})");
    html! {
        <svg class={Mark} width="20" height="20" viewBox="0 0 1254 1254" aria-hidden="true" focusable="false">
            <defs>
                <linearGradient id={gradient_id} gradientUnits="userSpaceOnUse" x1="248" y1="420" x2="1012" y2="842">
                    <stop offset="0" class={StopStart}></stop>
                    <stop offset="0.52" class={StopMid}></stop>
                    <stop offset="1" class={StopEnd}></stop>
                </linearGradient>
            </defs>
            <g fill={&fill}>
                <path d="M638 66 L988 310 L867 395 L640 246 L423 393 L423 488 L735 706 L628 788 L272 538 L272 323 Z"></path>
                <path d="M647 385 L994 621 L994 852 L645 1108 L286 842 L399 759 L630 928 L832 778 L832 666 L540 461 Z"></path>
            </g>
        </svg>
    }
}
