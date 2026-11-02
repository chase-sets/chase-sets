//! The help center's views, after `help-pages.tsx`: the hub, a category's page, an article and
//! the article cards. No script: the contents are links, and the article's sticky contents column
//! is CSS.
use corten::prelude::*;

use crate::{
    app::url,
    developers::Tool,
    help::{self, Article, Audience, Block, Category, Inline, Values},
    text::{DevelopersMsg, HelpMsg, Pilot},
};

/// The hub (`HelpHubPage`): each audience with an article, and its categories as cards.
#[component(css)]
pub fn HelpHub(t: HelpMsg) -> impl Render {
    let groups: Vec<(Audience, Vec<Category>)> =
        Audience::ALL.into_iter().map(|a| (a, help::categories_for(a))).filter(|(_, c)| !c.is_empty()).collect();
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{t.eyebrow()}</p>
                <h1 class={Title}>{t.title()}</h1>
                <p class={Muted}>{t.description()}</p>
            </header>
            for (audience, categories) in &groups {
                <section class={Section} aria-label={audience.title(t)}>
                    <div class={SectionHead}>
                        <h2 class={SectionTitle}>{audience.title(t)}</h2>
                        <p class={Muted}>{audience.description(t)}</p>
                    </div>
                    <div class={(Grid, Three)}>
                        for category in categories {
                            <div class={Card}>
                                <h3 class={CardTitle}>{category.title(t)}</h3>
                                <p class={Muted}>{category.description(t)}</p>
                                <p class={Note}>{t.article_count(&help::in_category(*category).len().to_string())}</p>
                                <p>
                                    <a class={Button} href={url::help::HelpCategory { category: category.slug() }}>
                                        {t.browse_category(category.title(t))}
                                    </a>
                                </p>
                            </div>
                        }
                    </div>
                </section>
            }
        </div>
    }
}

/// The trail above a category or an article.
#[component(css = HelpHub)]
fn Trail<'a>(t: HelpMsg, category: Category, article: Option<&'a str>) -> impl Render + 'a {
    html! {
        <nav class={Trail} aria-label={t.breadcrumb()}>
            <ol>
                <li><a href={url::help::Help}>{t.breadcrumb()}</a></li>
                match article {
                    Some(title) => {
                        <li><a href={url::help::HelpCategory { category: category.slug() }}>{category.title(t)}</a></li>
                        <li aria-current="page">{title}</li>
                    }
                    None => { <li aria-current="page">{category.title(t)}</li> }
                }
            </ol>
        </nav>
    }
}

/// A category's page (`HelpCategoryPage`).
#[component(css = HelpHub)]
pub fn HelpCategoryPage(t: HelpMsg, category: Category) -> impl Render {
    let articles = help::in_category(category);
    html! {
        <div class={Page}>
            <Trail t={t} category={category} article={None} />
            <header class={Header}>
                <p class={Eyebrow}>{t.category_eyebrow()}</p>
                <h1 class={Title}>{category.title(t)}</h1>
                <p class={Muted}>{category.description(t)}</p>
            </header>
            <div class={(Grid, Two)}>
                for article in &articles {
                    <ArticleCard t={t} article={article} />
                }
            </div>
        </div>
    }
}

/// An article's card (`ArticleCard`): its audience, title, description and Read article.
#[component(css = HelpHub)]
fn ArticleCard<'a>(t: HelpMsg, article: &'a Article) -> impl Render + 'a {
    html! {
        <article class={Card}>
            <p class={Note}>{article.audience.title(t)}</p>
            <h2 class={CardTitle}>{&article.title}</h2>
            <p class={Muted}>{&article.description}</p>
            <p><a class={Button} href={&article.href}>{t.read_article()}</a></p>
        </article>
    }
}

/// An article (`HelpArticlePage`): the trail, the header, when it was last reviewed, a banner for
/// each value change on the way, the body with its contents beside it from 64rem when it has
/// three headings or more, and the related articles.
#[component(css = HelpHub)]
pub fn HelpArticlePage<'a>(
    t: HelpMsg,
    p: Pilot,
    req: &'a Req,
    article: &'a Article,
    values: &'a Values,
    related: &'a [&'a Article],
    marketplace: Option<&'a str>,
) -> impl Render + 'a {
    let under_help = article.href.starts_with("/help/");
    html! {
        <div class={(Page, Wide)}>
            if under_help {
                <Trail t={t} category={article.category} article={Some(article.title.as_str())} />
            }
            <header class={Header}>
                <p class={Eyebrow}>{article.audience.title(t)}</p>
                <h1 class={Title}>{&article.title}</h1>
                <p class={Muted}>{&article.description}</p>
            </header>
            <p class={Note}>{t.last_reviewed(&help::long_date(t, &article.reviewed_at))}</p>
            for change in &values.changes {
                <div class={Banner} role="status">
                    <p class={BannerTitle}>{t.changing_on(&help::long_date(t, change))}</p>
                    <p>{p.help_change()}</p>
                </div>
            }
            <ArticleBody t={t} req={req} article={article} values={values} marketplace={marketplace} />
            if !related.is_empty() {
                <section class={Section} aria-labelledby="help-related">
                    <div class={SectionHead}>
                        <h2 class={SectionTitle} id="help-related">{t.related_title()}</h2>
                        <p class={Muted}>{t.related_description()}</p>
                    </div>
                    <div class={(Grid, Three)}>
                        for candidate in related {
                            <ArticleCard t={t} article={candidate} />
                        }
                    </div>
                </section>
            }
        </div>
    }
}

/// An article's body (`CompiledArticleBody`), with its contents beside it from 64rem when it has
/// three headings or more (`ArticleTableOfContents`): the help center's and the developer
/// portal's.
#[component(css = HelpHub)]
pub fn ArticleBody<'a>(
    t: HelpMsg,
    req: &'a Req,
    article: &'a Article,
    values: &'a Values,
    marketplace: Option<&'a str>,
) -> impl Render + 'a {
    let contents = article.headings.len() >= 3;
    let unavailable = values.unavailable(article);
    let degraded = (!unavailable.is_empty()).then(|| unavailable.join(","));
    html! {
        <div class={(Split, contents.then_some(WithContents))}>
            <article
                class={Body}
                data-policy-values-state={degraded.as_ref().map(|_| "degraded")}
                data-policy-value-keys={degraded.as_deref()}
            >
                for block in &article.blocks {
                    match block {
                        Block::Heading { level, id, content } => {
                            if *level == 3 {
                                <h3 class={H3} id={id}>
                                    <Inlines t={t} req={req} content={content} values={values} marketplace={marketplace} />
                                </h3>
                            } else {
                                <h2 class={H2} id={id}>
                                    <Inlines t={t} req={req} content={content} values={values} marketplace={marketplace} />
                                </h2>
                            }
                        }
                        Block::List { ordered, items } => {
                            if *ordered {
                                <ol class={List}>
                                    for item in items {
                                        <li>
                                            <Inlines
                                                t={t}
                                                req={req}
                                                content={item}
                                                values={values}
                                                marketplace={marketplace}
                                            />
                                        </li>
                                    }
                                </ol>
                            } else {
                                <ul class={List}>
                                    for item in items {
                                        <li>
                                            <Inlines
                                                t={t}
                                                req={req}
                                                content={item}
                                                values={values}
                                                marketplace={marketplace}
                                            />
                                        </li>
                                    }
                                </ul>
                            }
                        }
                        Block::Paragraph { content } => {
                            <p class={Paragraph}>
                                <Inlines t={t} req={req} content={content} values={values} marketplace={marketplace} />
                            </p>
                        }
                    }
                }
            </article>
            if contents {
                <nav class={(Card, Contents)} aria-label={t.toc_title()}>
                    <h2 class={CardTitle}>{t.toc_title()}</h2>
                    <ul>
                        for heading in &article.headings {
                            <li><a href={format!("#{}", heading.id)}>{&heading.text}</a></li>
                        }
                    </ul>
                </nav>
            }
        </div>
    }
}

/// A block's text: a cited value as the API has it now, or Temporarily unavailable.
#[component(css = HelpHub)]
fn Inlines<'a>(
    t: HelpMsg,
    req: &'a Req,
    content: &'a [Inline],
    values: &'a Values,
    marketplace: Option<&'a str>,
) -> impl Render + 'a {
    html! {
        for inline in content {
            match inline {
                Inline::Text { value } => { {value} }
                Inline::Strong { value } => { <strong>{value}</strong> }
                Inline::Emphasis { value } => { <em>{value}</em> }
                Inline::Code { value } => { <code>{value}</code> }
                Inline::Link { label, href } => {
                    match help::link_href(req, href, marketplace) {
                        Some(to) => { <a href={to}>{label}</a> }
                        None => { {label} }
                    }
                }
                Inline::PolicyValue { key } => {
                    match values.shown.get(key) {
                        Some(text) => { {text} }
                        None => {
                            <span class={Unavailable} data-policy-value-state="unavailable" data-policy-value-key={key}>
                                {t.policy_value_unavailable()}
                            </span>
                        }
                    }
                }
            }
        }
    }
}

/// The developer portal (`DeveloperPortalPage`): the guides as cards and the agent-readable
/// documents.
#[component(css = HelpHub)]
pub fn DeveloperPortal(d: DevelopersMsg) -> impl Render {
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{d.eyebrow()}</p>
                <h1 class={Title}>{d.title()}</h1>
                <p class={Muted}>{d.description()}</p>
            </header>
            <div class={(Grid, Two)}>
                for article in crate::developers::articles() {
                    <article class={Card}>
                        <h2 class={CardTitle}>{&article.title}</h2>
                        <p class={Muted}>{&article.description}</p>
                        <p><a class={Button} href={&article.href}>{d.read_article()}</a></p>
                    </article>
                }
            </div>
            <section class={Section} aria-labelledby="developers-machine">
                <div class={SectionHead}>
                    <h2 class={SectionTitle} id="developers-machine">{d.machine_title()}</h2>
                    <p class={Muted}>{d.machine_description()}</p>
                </div>
                <div class={Links}>
                    <a class={Button} href={crate::developers::agent_terms()}>{d.agent_terms()}</a>
                    <a class={Button} href={url::developers::Manifest}>{d.machine_manifest()}</a>
                    <a class={Button} href={url::files::Llms}>{d.machine_llms()}</a>
                </div>
            </section>
        </div>
    }
}

/// A developer guide (`DeveloperArticlePage`): the trail, the header, when it was last reviewed,
/// the body, and on the tool catalog's guide the generated tool descriptors.
#[component(css = HelpHub)]
pub fn DeveloperArticle<'a>(
    d: DevelopersMsg,
    h: HelpMsg,
    req: &'a Req,
    article: &'a Article,
    values: &'a Values,
) -> impl Render + 'a {
    html! {
        <div class={(Page, Wide)}>
            <nav class={Trail} aria-label={d.breadcrumb()}>
                <ol>
                    <li><a href={url::developers::Developers}>{d.breadcrumb()}</a></li>
                    <li aria-current="page">{&article.title}</li>
                </ol>
            </nav>
            <header class={Header}>
                <p class={Eyebrow}>{d.eyebrow()}</p>
                <h1 class={Title}>{&article.title}</h1>
                <p class={Muted}>{&article.description}</p>
            </header>
            <p class={Note}>{h.last_reviewed(&help::long_date(h, &article.reviewed_at))}</p>
            <ArticleBody t={h} req={req} article={article} values={values} marketplace={None} />
            if article.slug == "mcp-tool-catalog" {
                <ToolCatalog d={d} />
            }
        </div>
    }
}

/// `McpToolCatalog`: the available tools, then the planned ones.
#[component(css = HelpHub)]
fn ToolCatalog(d: DevelopersMsg) -> impl Render {
    let (available, planned) = (crate::developers::tools(true), crate::developers::tools(false));
    html! {
        <section class={Section} aria-labelledby="developers-catalog">
            <div class={SectionHead}>
                <h2 class={SectionTitle} id="developers-catalog">{d.catalog_title()}</h2>
                <p class={Muted}>{d.catalog_description(available.len(), planned.len())}</p>
            </div>
            <ToolGroup d={d} title={d.catalog_available()} description={d.catalog_available_description()} tools={&available} />
            <ToolGroup d={d} title={d.catalog_planned()} description={d.catalog_planned_description()} tools={&planned} />
        </section>
    }
}

#[component(css = HelpHub)]
fn ToolGroup<'a>(d: DevelopersMsg, title: &'a str, description: &'a str, tools: &'a [&'a Tool]) -> impl Render + 'a {
    html! {
        <div class={Section}>
            <h3 class={H3}>{title}</h3>
            <p class={Muted}>{description}</p>
            for tool in tools {
                <ToolDescriptor d={d} tool={tool} />
            }
        </div>
    }
}

/// `ToolDescriptor`: what the tool does, who may call it, and its schemas.
#[component(css = HelpHub)]
fn ToolDescriptor<'a>(d: DevelopersMsg, tool: &'a Tool) -> impl Render + 'a {
    let none = || vec![d.catalog_none().to_owned()];
    let permissions = if tool.permissions.is_empty() { none() } else { tool.permissions.clone() };
    let scopes = if tool.scopes.is_empty() { none() } else { tool.scopes.clone() };
    let confirmation = if tool.confirmation { d.catalog_required() } else { d.catalog_not_required() };
    let dry_run = if tool.dry_run { d.catalog_supported() } else { d.catalog_not_supported() };
    html! {
        <article class={(Card, Tool)}>
            <h4 class={CardTitle}>{&tool.title}</h4>
            <p class={Note}><code>{&tool.name}</code></p>
            <p class={Muted}>{&tool.description}</p>
            <p class={Note}>{d.catalog_summary(&tool.service, &tool.risk, &tool.scope)}</p>
            <p class={Note}>{d.catalog_permissions()}</p>
            <ul class={List}>for item in &permissions { <li>{item}</li> }</ul>
            <p class={Note}>{d.catalog_oauth_scopes()}</p>
            <ul class={List}>for item in &scopes { <li>{item}</li> }</ul>
            <p class={Note}>{d.catalog_expected_usage()}</p>
            <ul class={List}>for item in &tool.usage { <li>{item}</li> }</ul>
            <p class={Note}>{d.catalog_guardrails(confirmation, &tool.idempotency, dry_run)}</p>
            <div class={Schema}>
                <p class={SchemaLabel}>{d.catalog_input_schema()}</p>
                <pre>{&tool.input_schema}</pre>
            </div>
            if let Some(output) = &tool.output_schema {
                <div class={Schema}>
                    <p class={SchemaLabel}>{d.catalog_output_schema()}</p>
                    <pre>{output}</pre>
                </div>
            }
        </article>
    }
}
