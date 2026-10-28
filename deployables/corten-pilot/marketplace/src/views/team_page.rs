//! The account's team (Identity's `TeamPage`, a `CustomerSummaryPage`): the title and what the
//! page is for; what the last write did; Invite (an email and a role); then each member, with its
//! role and status, Change Role and Revoke (behind a dialog that asks first) or Reinstate, and each
//! invitation, with Cancel (behind a dialog) while it is pending. One column on a phone, every
//! control at least 2.75rem tall; from 48rem the invite form's fields sit side by side and each
//! row's controls sit beside its words.
use corten::prelude::*;

use super::account_home_page::humanized;
use crate::{
    addresses::Said,
    api::{AccountAction, Invitation, Membership},
    app::url,
    team::{Draft, Place, ROLES, TeamInput, TeamScreen},
    text::{Pilot, TeamMsg},
};

/// Invite's form: a refused invite draws it again.
#[derive(Id, Clone, Copy)]
pub struct InviteFormId;

/// The dialog a member's Revoke opens.
#[derive(Id)]
pub struct RevokeMemberDialogId<'a>(pub &'a str);

/// The dialog an invitation's Cancel opens.
#[derive(Id)]
pub struct CancelInvitationDialogId<'a>(pub &'a str);

/// Identity's `formatMachineValue` with this page's words.
fn machine(known: Option<&'static str>, t: TeamMsg, family: &str, value: &str) -> String {
    match (known, humanized(value)) {
        (Some(word), _) => word.to_owned(),
        (None, Some(human)) => t.value_unrecognized_with_value(family, &human).to_string(),
        (None, None) => t.value_unrecognized(family).to_string(),
    }
}

/// A role's words (`membershipRoleLabel`).
pub fn role(t: TeamMsg, value: &str) -> String {
    let known = match value {
        "platform-admin" => Some(t.role_platform_admin()),
        "owner" => Some(t.role_owner()),
        "manager" => Some(t.role_manager()),
        "fulfillment" => Some(t.role_fulfillment()),
        "viewer" => Some(t.role_viewer()),
        _ => None,
    };
    machine(known, t, t.family_membership_role(), value)
}

fn membership_status(t: TeamMsg, value: &str) -> String {
    let known = match value {
        "active" => Some(t.membership_status_active()),
        "revoked" => Some(t.membership_status_revoked()),
        _ => None,
    };
    machine(known, t, t.family_membership_status(), value)
}

fn invitation_status(t: TeamMsg, value: &str) -> String {
    let known = match value {
        "pending" => Some(t.invitation_status_pending()),
        "accepted" => Some(t.invitation_status_accepted()),
        "declined" => Some(t.invitation_status_declined()),
        "cancelled" => Some(t.invitation_status_cancelled()),
        "expired" => Some(t.invitation_status_expired()),
        _ => None,
    };
    machine(known, t, t.family_invitation_status(), value)
}

/// A member's name: its display name, else its email, else its id (`userLabel`).
fn user_label(m: &Membership) -> &str {
    m.user_display_name.as_deref().or(m.user_primary_email.as_deref()).unwrap_or(&m.user_id)
}

fn account_label<'a>(display: &'a Option<String>, name: &'a Option<String>, id: &'a str) -> &'a str {
    display.as_deref().or(name.as_deref()).unwrap_or(id)
}

/// The page.
#[component(css)]
pub fn TeamPage<'a>(t: TeamMsg, p: Pilot, screen: &'a TeamScreen) -> impl Render {
    let banner = match &screen.said {
        Said::Editing => None,
        Said::Saved => Some(("info", t.manage_state_succeeded())),
        // A refused write's own words (an out-of-date form, invalid details), else nothing was recorded.
        Said::NotSaved => {
            Some(("danger", screen.posted.as_ref().and_then(|d| d.errors.form()).unwrap_or(t.manage_state_failed_safe())))
        }
        Said::Conflict => Some(("warning", t.manage_state_conflict())),
        Said::Unconfirmed { .. } => Some(("warning", t.manage_state_ambiguous())),
        Said::Denied => Some(("danger", t.manage_state_route_denied())),
    };
    let again = match &screen.said {
        Said::Unconfirmed { attempt, action, target } => Some(
            url::Team {
                place: Place { check: Some(attempt.clone()), action: Some(*action), target: target.clone(), ..Place::default() },
            }
            .href(),
        ),
        _ => None,
    };
    html! {
        <header class={Header}>
            <div class={Heading}>
                <h1 class={Title}>{t.page_team()}</h1>
                <p class={Muted}>{t.page_manage_the_people_who_can_act()}</p>
            </div>
            <InviteForm t={t} draft={&screen.invite()} held={screen.said.holds(AccountAction::CreateInvitation, None)} />
        </header>
        <div class={Status} role="status" aria-live="polite">
            if let Some((tone, text)) = banner {
                <div class={Banner} data-tone={tone} tabindex="-1" autofocus>
                    <p class={Strong}>{text}</p>
                    if let Some(again) = &again {
                        <p><a href={again}>{p.addresses_check()}</a></p>
                    }
                </div>
            }
            if screen.pending {
                <div class={Banner} data-tone="warning">
                    <p>{p.team_pending()}</p>
                </div>
            }
        </div>
        <ul class={Rows}>
            for member in &screen.memberships {
                <MemberRow t={t} p={p} member={member} said={&screen.said} />
            }
            for invitation in &screen.invitations {
                <InvitationRow t={t} p={p} invitation={invitation} said={&screen.said} />
            }
        </ul>
    }
}

/// The roles a select offers, with `chosen` selected.
#[component(css = TeamPage)]
fn RoleSelect<'a>(t: TeamMsg, name: FieldName, chosen: &'a str, label: &'a str) -> impl Render {
    html! {
        <label class={Field}>
            <span class={Label}>{label}</span>
            <select name={name}>
                for value in ROLES {
                    <option value={value} selected={value == chosen}>{role(t, value)}</option>
                }
            </select>
        </label>
    }
}

/// Invite: an email and a role, off while its last write is unconfirmed.
#[component(css = TeamPage)]
fn InviteForm<'a>(t: TeamMsg, draft: &'a Draft, held: bool) -> impl Render {
    let f = TeamInput::FIELDS;
    let (i, e) = (&draft.input, draft.errors.within(InviteFormId));
    html! {
        <form id={InviteFormId} class={Form} method="post" action={url::Team::default()}>
            <input type="hidden" name={f.intent} value="create-invitation">
            {SubmitKey::field(f.attempt)}
            {draft.errors.form_message()}
            <fieldset class={Invite} disabled={held}>
                <label class={Field}>
                    <span class={Label}>{t.page_email()}</span>
                    <input type="email" name={f.email} value={&i.email} required autocomplete="off" {..e.aria(f.email)}>
                </label>
                <RoleSelect t={t} name={f.role_key} chosen={&i.role_key} label={t.page_role()} />
                <button type="submit" class={Primary}>{t.page_invite()}</button>
            </fieldset>
        </form>
    }
}

/// A member: its name, role and status, Change Role, and Revoke (a dialog that asks first) while
/// it is active, else Reinstate.
#[component(css = TeamPage)]
fn MemberRow<'a>(t: TeamMsg, p: Pilot, member: &'a Membership, said: &'a Said) -> impl Render {
    let f = TeamInput::FIELDS;
    let id = member.membership_id.as_str();
    let user = user_label(member);
    let account = account_label(&member.account_display_name, &member.account_name, &member.account_id);
    let summary = t.page_membership_summary(role(t, &member.role_key), membership_status(t, &member.status)).to_string();
    let title = t.page_revoke_confirm_title(user).to_string();
    let description = t.page_revoke_confirm_description(user, account).to_string();
    let (title_id, text_id) = (format!("revoke-title-{id}"), format!("revoke-text-{id}"));
    let active = member.status == "active";
    html! {
        <li class={Row} data-membership={id}>
            <div class={Words}>
                <p class={Strong}>{user}</p>
                <p class={Muted}>{&summary}</p>
            </div>
            <div class={Controls}>
                <form class={RoleForm} method="post" action={url::Team::default()}>
                    <input type="hidden" name={f.intent} value="change-role">
                    <input type="hidden" name={f.membership_id} value={id}>
                    {SubmitKey::field(f.attempt)}
                    <RoleSelect t={t} name={f.role_key} chosen={&member.role_key} label={t.page_role()} />
                    <button type="submit" class={Secondary} disabled={said.holds(AccountAction::ChangeRole, Some(id))}>
                        {t.page_change_role()}
                    </button>
                </form>
                if active {
                    <button type="button" class={Danger} command="show-modal" commandfor={RevokeMemberDialogId(id)}>
                        {t.page_revoke()}
                    </button>
                } else {
                    <form method="post" action={url::Team::default()}>
                        <input type="hidden" name={f.intent} value="reinstate">
                        <input type="hidden" name={f.membership_id} value={id}>
                        {SubmitKey::field(f.attempt)}
                        <button type="submit" class={Primary} disabled={said.holds(AccountAction::Reinstate, Some(id))}>
                            {t.page_reinstate()}
                        </button>
                    </form>
                }
            </div>
            if active {
                <dialog id={RevokeMemberDialogId(id)} class={Dialog} aria-labelledby={&title_id} aria-describedby={&text_id}>
                    <h2 id={&title_id} class={DialogTitle}>{&title}</h2>
                    <p id={&text_id} class={Muted}>{&description}</p>
                    <form class={Buttons} method="post" action={url::Team::default()}>
                        <input type="hidden" name={f.intent} value="revoke">
                        <input type="hidden" name={f.membership_id} value={id}>
                        {SubmitKey::field(f.attempt)}
                        <button type="button" class={Secondary} command="close" commandfor={RevokeMemberDialogId(id)}>
                            {p.addresses_cancel()}
                        </button>
                        <button type="submit" class={Danger} disabled={said.holds(AccountAction::Revoke, Some(id))}>
                            {t.page_revoke_confirm_action()}
                        </button>
                    </form>
                </dialog>
            }
        </li>
    }
}

/// An invitation: its email, role and status, and Cancel (a dialog that asks first) while it is
/// pending.
#[component(css = TeamPage)]
fn InvitationRow<'a>(t: TeamMsg, p: Pilot, invitation: &'a Invitation, said: &'a Said) -> impl Render {
    let f = TeamInput::FIELDS;
    let id = invitation.invitation_id.as_str();
    let email = invitation.email.as_str();
    let account = account_label(&invitation.account_display_name, &invitation.account_name, &invitation.account_id);
    let summary = t.page_invitation_summary(role(t, &invitation.role_key), invitation_status(t, &invitation.status)).to_string();
    let title = t.page_cancel_confirm_title(email).to_string();
    let description = t.page_cancel_confirm_description(email, account).to_string();
    let (title_id, text_id) = (format!("cancel-title-{id}"), format!("cancel-text-{id}"));
    let pending = invitation.status == "pending";
    html! {
        <li class={Row} data-invitation={id}>
            <div class={Words}>
                <p class={Strong}>{email}</p>
                <p class={Muted}>{&summary}</p>
            </div>
            if pending {
                <div class={Controls}>
                    <button type="button" class={Danger} command="show-modal" commandfor={CancelInvitationDialogId(id)}>
                        {t.page_cancel()}
                    </button>
                </div>
                <dialog id={CancelInvitationDialogId(id)} class={Dialog} aria-labelledby={&title_id} aria-describedby={&text_id}>
                    <h2 id={&title_id} class={DialogTitle}>{&title}</h2>
                    <p id={&text_id} class={Muted}>{&description}</p>
                    <form class={Buttons} method="post" action={url::Team::default()}>
                        <input type="hidden" name={f.intent} value="cancel-invitation">
                        <input type="hidden" name={f.invitation_id} value={id}>
                        {SubmitKey::field(f.attempt)}
                        <button type="button" class={Secondary} command="close" commandfor={CancelInvitationDialogId(id)}>
                            {p.addresses_cancel()}
                        </button>
                        <button type="submit" class={Danger} disabled={said.holds(AccountAction::CancelInvitation, Some(id))}>
                            {t.page_cancel_confirm_action()}
                        </button>
                    </form>
                </dialog>
            }
        </li>
    }
}
