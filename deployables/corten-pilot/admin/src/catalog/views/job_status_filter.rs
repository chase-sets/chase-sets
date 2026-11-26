//! The import jobs' Status filter (admin-web's `import-jobs-module.tsx` status filter, which it
//! shows for TCGplayer): a select of the operator statuses, and how many jobs were read and how
//! many show. The rows carry their operator status, and the stylesheet hides the ones the chosen
//! status leaves out (`:has(option:checked)`), so a choice narrows the list at once, with or
//! without JavaScript; it also shows the chosen status's count and, for a status with no jobs,
//! admin-web's empty state. The filter is a GET form on the page's own working set with the
//! choice as `jobStatus`, so Apply keeps it in the address without the script; with it, the
//! script hides Apply, keeps the address on each choice and keeps
//! `data-catalog-import-job-status-filter` on the chosen status, as admin-web's does.
use corten::prelude::*;
use platform::ui::{
    button::{Button, ButtonSize, ButtonVariant},
    select::Select,
};

use super::integrations_page::{Empty, state_label};
use crate::{
    catalog::daily::{self, ImportJob, JOB_STATUS, JOB_STATUSES},
    text::Cat,
};

/// The filter over `jobs`, on the page the working set `context` draws its stages on, with
/// `children` (the jobs' table, whose rows carry `data-catalog-import-job-operator-status`)
/// below it. The chosen status is the working set's `jobStatus`, or all.
#[component(css, js)]
pub fn JobStatusFilter<'a, C: Render>(t: Cat, jobs: &'a [ImportJob], context: &'a str, children: C) -> impl Render {
    let (filter, apply) = refs();
    let chosen = daily::job_status(context);
    let all = t.list_all_statuses();
    let count = |status: &str| jobs.iter().filter(|job| job.operator_status == status).count();
    let kept = daily::context_fields(&daily::with_query(context, &[(JOB_STATUS, None)]));
    html! {
        <div class={Filtered} on:connect={js::connect(filter, apply)} on:change={js::chosen(filter)}>
            <form
                ref={filter}
                class={Filter}
                method="get"
                action={&daily::home(context)}
                data-catalog-import-job-status-filter={chosen}
            >
                for (name, value) in &kept {
                    <input type="hidden" name={name.as_str()} value={value.as_str()}>
                }
                <div class={Choose}>
                    <label class={Pick}>
                        <span class={Label}>{t.list_status()}</span>
                        <select class={Select {}} name={JOB_STATUS}>
                            <option value="all" selected={chosen == "all"}>{all}</option>
                            for status in JOB_STATUSES {
                                <option value={status} selected={chosen == status}>{state_label(status)}</option>
                            }
                        </select>
                    </label>
                    <button
                        ref={apply}
                        type="submit"
                        class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }}
                    >
                        {t.list_apply_filters()}
                    </button>
                </div>
                <dl class={Summary}>
                    <div>
                        <dt>{t.pd_jobs_title()}</dt>
                        <dd>{jobs.len()}</dd>
                    </div>
                    <div data-status="all">
                        <dt>{all}</dt>
                        <dd>{jobs.len()}</dd>
                    </div>
                    for status in JOB_STATUSES {
                        <div data-status={status}>
                            <dt>{state_label(status)}</dt>
                            <dd>{count(status)}</dd>
                        </div>
                    }
                </dl>
            </form>
            {children}
            for status in JOB_STATUSES.into_iter().filter(|status| count(status) == 0) {
                let title = t.list_none_found(state_label(status)).to_string();
                <div class={NoneFound} data-status={status}>
                    <Empty title={&title} description={t.list_try_adjusting_your_filters()} />
                </div>
            }
        </div>
    }
}
