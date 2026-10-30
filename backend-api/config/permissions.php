<?php

// Single source of truth for role -> ability grants (VMS-IMPROVEMENT-PLAN.md
// Phase B1). Each ability maps to the roles allowed to perform it; ownership
// and live-state conditions (e.g. "only your own Pending report", "not the
// mechanic who logged this repair", "not the barangay's last active Admin")
// are NOT expressed here — they stay as separate guard calls in the
// controller, the same way GuardsLastAdmin already works, because they
// depend on a database record, not just the actor's role.
//
// This file reflected CURRENT (Phase A) behavior when it was first written
// for Phase B1. Phase B4 has since tightened the role lists below to match
// the target role model in VMS-IMPROVEMENT-PLAN.md — see the comments next
// to each changed ability for what moved and why.

return [
    // Vehicle types
    // .view is a broad grant — it's custom-field schema/labels (not vehicle
    // data), needed by anyone viewing a vehicle with custom fields filled
    // in, not just whoever manages the type itself.
    'vehicle_type.view' => ['Admin', 'Custodian', 'Maintenance Personnel'],
    'vehicle_type.create' => ['Admin'],
    'vehicle_type.edit' => ['Admin'],
    'vehicle_type.delete' => ['Admin'],

    // Vehicles
    // Registration is a standard Admin/Custodian duty; editing remains Admin-only.
    'vehicle.create' => ['Admin', 'Custodian'],
    // Bulk import follows the same role eligibility as single registration.
    'vehicle.import' => ['Admin', 'Custodian'],
    'vehicle.edit' => ['Admin'],
    'vehicle.archive' => ['Admin'],
    'vehicle.restore' => ['Admin'],
    'vehicle.decommission' => ['Admin'],
    'vehicle.readiness_check' => ['Custodian'],
    'vehicle.mark_available' => ['Admin', 'Custodian'],
    'vehicle.update_location' => ['Admin'],
    // Custodian gets a "Vehicle History" sidebar entry (role-realignment
    // decision 13) — they're the ones day-to-day with the vehicle, so
    // reading its timeline isn't a management-only concern the way editing
    // it is.
    'vehicle.view_history' => ['Admin', 'Custodian'],
    // Admin who suspects a problem can't report an issue or open a ticket
    // themselves — they ask the Custodian to physically inspect instead.
    // Deprecated workflow: condition history remains readable, but no role
    // can start a standalone inspection from the live application.
    'vehicle.request_inspection' => [],

    // Hubs
    'hub.create' => ['Admin'],
    'hub.edit' => ['Admin'],
    'hub.delete' => ['Admin'],

    // Condition checks
    // Recording a condition is a Custodian's hands-on job — Admin no longer
    // records or edits checks (Admin still deletes a mistaken one).
    'condition.create' => ['Custodian'],
    // ...and a Custodian may only edit the check THEY performed
    // (FleetController enforces the ownership half via checked_by).
    'condition.edit' => ['Custodian'],
    // Phase B4 — delete narrowed to Admin only (was Admin+Custodian, any row).
    'condition.delete' => ['Admin'],

    // Issue reports
    'issue.view' => ['Admin', 'Custodian', 'Maintenance Personnel'],
    // Admin does not originate reports (spec: Admin can view/manage them, and
    // asks a Custodian to inspect via vehicle.request_inspection instead).
    'issue.create' => ['Custodian', 'Maintenance Personnel'],
    // Maintenance Personnel can't create a ticket, but can ask the Custodian
    // to open one from a technical finding.
    'issue.recommend_ticket' => ['Maintenance Personnel'],
    // Phase B4 — Maintenance Personnel no longer edits issue reports (their
    // Status+Remarks form and the whole module are removed); Custodian's
    // existing own-report-while-Pending narrowing is unaffected.
    'issue.edit' => ['Admin', 'Custodian'],
    'issue.delete' => ['Admin'],
    // Admin's one next step on an open report that doesn't need a ticket.
    // (Turning a report into a ticket is a Custodian's proposal; Admin asking a
    // Custodian to propose would just be Admin asking themselves — circular.)
    'issue.dismiss' => ['Admin'],

    // Vehicle documents — production-readiness final stabilization pass
    // (2026-10-05, P0): Maintenance Personnel has NO Vehicle Documents
    // access at all now, not even view-only — they still see repair
    // evidence/photos through the ticket/work-order record itself, which is
    // a separate thing from this module. Custodian may upload and edit
    // their OWN upload (FleetController enforces the ownership half via
    // added_by), but delete is Admin-only. `document.view` didn't exist
    // before — the list endpoint had no ability check at all, reachable by
    // anyone authenticated; this makes the Maintenance Personnel exclusion
    // an explicit grant instead of an accident of what wasn't gated.
    // Spec §16 (2026-10-06) reverses the 2026-10-05 exclusion: Maintenance
    // Personnel may view documents and upload repair/service evidence,
    // editing only what they uploaded themselves; delete stays Admin-only.
    'document.view' => ['Admin', 'Custodian', 'Maintenance Personnel'],
    'document.create' => ['Admin', 'Custodian', 'Maintenance Personnel'],
    'document.edit' => ['Admin', 'Custodian', 'Maintenance Personnel'],
    'document.delete' => ['Admin'],

    // Maintenance records (standalone ledger) — Phase B4: only Admin makes
    // manual/historical entries now; Custodian is read-only and Maintenance
    // Personnel has no involvement at all outside the auto-generated ledger
    // line a confirmed ticket sub-issue creates.
    'record.create' => ['Admin'],
    'record.edit' => ['Admin'],
    'record.verify' => ['Custodian'],
    'record.confirm' => ['Admin'],
    'record.decision_close' => ['Admin'],

    // Maintenance schedules — current model (2026-10-15): a Custodian books
    // one directly (schedule.create), but it parks at 'Pending Approval'
    // until an Admin reviews it (schedule.approve/.decline) — the same
    // propose/approve/decline shape as ticket.propose/.approve/.decline, just
    // for schedules. schedule.suggest (notify-only, books nothing) is unused
    // while schedule.create covers the same need with a real booking.
    'schedule.create' => ['Custodian'],
    'schedule.suggest' => [],
    'schedule.approve' => ['Admin'],
    'schedule.decline' => ['Admin'],
    // Custodian edits only the one they themselves created (ownership check
    // in FleetController::updateSchedule) — matches schedule.create above.
    'schedule.edit' => ['Custodian'],
    'schedule.reassign' => ['Admin'],
    // Final senior system review (2026-10-05, §2/§12) — Admin no longer
    // completes a schedule directly. "Complete" means physically performed
    // the maintenance, and Admin never performs repair work in this system
    // (same rule as ticket sub-issues). Previously Admin could complete ANY
    // schedule, including an unassigned one with nobody specified as the
    // performer, which silently recorded ADMIN as the repair performer —
    // inconsistent with storeMaintenanceRecord()'s own stricter requirement
    // that a performer always be named explicitly. An Admin who needs to
    // hand off a stuck/unassigned schedule now reassigns it
    // (schedule.reassign) to the Maintenance Personnel who'll actually do
    // the work, exactly like reassigning a ticket's mechanic.
    'schedule.complete' => ['Maintenance Personnel'],
    'schedule.delete' => ['Custodian'],
    'schedule.restore' => ['Custodian'],

    // Reports & fleet-operational activity log
    'report.generate' => ['Admin'],
    'activity_log.view' => ['Admin'],

    // Tickets
    'ticket.view_open_for_vehicle' => ['Admin'],
    'ticket.view_archives' => ['Admin'],
    'ticket.manage_list_visibility' => ['Admin', 'Custodian', 'Maintenance Personnel'],
    'ticket.check_recurrence' => ['Admin', 'Custodian'],
    // Nobody holds this any more — every ticket must originate as a
    // Custodian's proposal (ticket.propose) that Admin then reviews, edits,
    // and approves or declines (ticket.approve/decline). Kept as an explicit
    // empty grant, not deleted, so the POST /tickets endpoint it gates
    // (TicketController::createTicket) stays documented as intentionally
    // unreachable rather than looking like an oversight.
    'ticket.create' => [],
    'ticket.propose' => ['Custodian'],
    'ticket.approve' => ['Admin'],
    'ticket.decline' => ['Admin'],
    'ticket.request_corrections' => ['Admin'],
    'ticket.resubmit' => ['Custodian'],
    'ticket.inspect' => [],
    'ticket.reassign_custodian' => ['Admin'],
    'ticket.close' => [],
    'ticket.cancel' => ['Admin'],
    'ticket.uncancel' => ['Admin'],
    'ticket.delete' => ['Admin'],
    'ticket.reopen_archived' => ['Admin'],
    'ticket.assign_mechanic' => ['Admin'],
    'ticket.submit_for_verification' => ['Maintenance Personnel'],
    'ticket.verify' => ['Custodian'],

    // Sub-issues
    // Only Admin may change an active ticket's sub-issues; Custodians propose and verify.
    'subissue.manage' => ['Admin'],
    'subissue.assign_mechanic' => [],
    'subissue.reassign_mechanic' => [],
    'subissue.log_repair' => ['Maintenance Personnel'],
    // Dispatching / receiving / writing up an EXTERNAL-shop repair that has no
    // in-house mechanic. Admin records it (never the verifying Custodian).
    'external.handle' => ['Admin'],
    // Cannibalization records: anyone on the barangay's repair side can record
    // and read them. There is no approval ability by design.
    'cannibalization.record' => ['Admin', 'Custodian', 'Maintenance Personnel'],
    'cannibalization.view' => ['Admin', 'Custodian', 'Maintenance Personnel'],
    // Production-readiness audit finding #2 — Admin was a general Tier-1
    // verification fallback; removed. Verification is a Custodian-only
    // action now. An unavailable Custodian is handled by reassigning the
    // ticket (ticket.reassign_custodian), not by Admin standing in.
    'subissue.verify' => [],
    'subissue.confirm' => [],
    'subissue.reopen_confirmed' => ['Admin'],
    'subissue.defer' => [],

    // Cannibalized-repair approval
    'repair.approve_cannibalized' => ['Admin'],
    'repair.reject_cannibalized' => ['Admin'],

    // Shared dropdown catalogs.
    // Operational users manage the shared issue and repair catalogs inline.
    'catalog.create' => ['Admin', 'Custodian', 'Maintenance Personnel'],
    'catalog.edit' => ['Admin'],
    'catalog.delete' => ['Admin'],

    // Users (barangay-scoped, managed by that barangay's Admin)
    'user.view' => ['Admin'],
    'user.create' => ['Admin'],
    'user.edit' => ['Admin'],
    'user.deactivate' => ['Admin'],
    'user.activate' => ['Admin'],
    'registration_code.view' => ['Admin'],
    'registration_code.regenerate' => ['Admin'],

    // Impersonation
    'impersonation.start' => ['Impersonator'],

    // Super Admin platform administration
    'barangay.view_all' => ['Super Admin'],
    'barangay.create' => ['Super Admin'],
    'barangay.create_admin' => ['Super Admin'],
    'barangay.refresh_boundary' => ['Super Admin'],
    'barangay.view_registration_code' => ['Super Admin'],
    'barangay.regenerate_registration_code' => ['Super Admin'],
    'user.view_all_platform' => ['Super Admin'],
    'user.activate_platform' => ['Super Admin'],
    'user.deactivate_platform' => ['Super Admin'],
    'user.reject' => ['Super Admin'],
    'user.view_pending' => ['Super Admin'],
    'user.change_role_platform' => ['Super Admin'],
    'user.email_platform' => ['Super Admin'],
    'activity_log.view_platform' => ['Super Admin'],
    'concern_report.view' => ['Super Admin'],
    'concern_report.resolve' => ['Super Admin'],
    'concern_report.reopen' => ['Super Admin'],
    'concern_report.delete' => ['Super Admin'],
];
