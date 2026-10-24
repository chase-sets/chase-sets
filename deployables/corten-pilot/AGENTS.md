# Working on corten-pilot

This is the Corten pilot (README.md): a Cargo workspace of Chase Sets screens ported to Corten,
in front of the platform API: `admin/` (admin-web's postage policies and catalog dimensions and
fields, each an `App::area` with its own stylesheet and guard), `marketplace/`
(marketplace's storage locations) and `platform/`, the library both share. Keep it isolated: it is not deployed and is not part of the platform gates. Business
rules stay in the platform API; the pilot checks only the shape of what it sends. A gap another
Corten app would hit goes to Corten (one issue per gap, with a repro in one of its `examples/`
apps); a workaround here links to it. Move the Corten pin in `Cargo.toml` only on purpose, and
add the reason to the README's pin table. Run `node --import tsx scripts/export.mjs --check`
after changing text, nav or tokens the pilot exports.

A Corten app: Rust renders every page with `html!`; the browser gets HTML, a small runtime and
the handler scripts next to components. Run `corten dev` inside the app's directory while
working (it does not rebuild for an edit in `platform/`; save a file in the app) and
`corten check` at the workspace root before you finish.

For recipes (pages, forms with validation, handlers, live data, styles, tests), use the Corten
skill: https://github.com/todd-skelton/corten/tree/main/skills/corten. Install it with your
agent's skill installer, or read it there.

1. Pages are handlers that return `req.page(title, view)`. Markup lives in `html!` in Rust, never
   in strings. A piece of markup used twice is a `#[component]`.
2. A form that updates part of a page has `data-patch`; its handler answers `req.patch(view)`
   when `req.mode == Mode::Action` and the whole page otherwise, so it works without JavaScript.
   Each patched element has an `id`, and the page renders the same component.
3. URLs are `#[derive(Route)]` types (`href={Home}`, `Router::new().route(Home::PATH, ..)`,
   `req.redirect(&Home)`) and field names come from `#[derive(Fields)]` (`Form::FIELDS.name`);
   neither is ever typed as a string.
4. Behavior in the browser is a `#[component(js)]`: `snake_name.js` next to it exports plain
   functions with JSDoc types, and the markup calls them with the elements and values they use:
   `let (save, dialog) = refs();`, `ref={save}`, `on:click={js::confirm(event, dialog)}`.
   `event`, `target`, `signal` and `scope` are the browser's. A wrong element type or a missing
   function is a compile error. Scripts add behavior to server-rendered markup; they do not
   build HTML, and user-facing text stays in the Rust views.
5. A component's styles are `snake_name.css` next to it, with `#[component(css)]`: every rule starts at one of the file's classes, and the markup names them
   as constants, `class={Title}`, never as strings. `static/style.css` is only element defaults
   and the shell. List every component with a script or stylesheet once: in `App::components` when
   pages outside one area render it (the frame, the tokens), else in its area's `.components`.
6. Everything works without JavaScript: links are links and forms post.
