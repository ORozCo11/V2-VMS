# Barangay Vehicle Management System (VMS) — Documentation

Updated **1 November 2026** after the panel redefense feedback. Read [Redefense-Changes-2026-11-01.md](Redefense-Changes-2026-11-01.md) first: it supersedes anything below that conflicts with it. Older notes: [28 October](Current-Revision-2026-10-28.md), [25 October](Current-Revision-2026-10-25.md).

## 1. What this system is

The Barangay VMS is a fleet management platform for a barangay's emergency response vehicles — ambulances, fire trucks, and rescue boats. It tracks whether a vehicle is ready to respond right now, and manages the full lifecycle of keeping it that way: reporting problems, inspecting them, repairing them, verifying the repair, and scheduling preventive maintenance before problems happen.

It is explicitly **not** a dispatch/operations system, a document-compliance tracker, or a mileage-based service planner. Vehicle dispatch, the Dispatched badge/action, Usage Log and temporary-release feature have been removed. Availability, physical condition and verified readiness remain separate. Sending a vehicle to an external shop remains part of the repair workflow.

See [System-Architecture.svg](../VMS%20FINAL%20DEFENSE%20PREPARATION/System-Architecture.svg) for the component overview. For diagram revision, use [ERD.md](ERD.md), [Use-Case-Diagram.md](Use-Case-Diagram.md) and [requirements traceability](Requirements-Traceability.md). The ERD distinguishes logical associations from physical constraints.

## 2. Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19 (Vite 8), react-router-dom 7, axios, Leaflet/react-leaflet for maps |
| Backend | Laravel 13 (PHP 8.3), Laravel Sanctum for auth |
| Database | **MySQL 8** (`barangay_vms_db`; 47 tables, 74 foreign keys). Automated tests use an in-memory SQLite database. |
| File storage | **Local private disk only** (`storage/app/private`), served through authenticated, signed links. No cloud storage. Photos up to 5 MB, documents up to 10 MB. |
| Auth | Sanctum bearer tokens, tagged with the user's role as a token ability |
| Email | Laravel Mail over **Gmail SMTP**; one branded layout (gear logo in the header band, "Barangay Vehicle Management System" footer) |

The frontend is almost entirely one large component tree (`frontend-spa/src/views/Workspace.jsx`) that renders different modules based on the logged-in user's role and the current route, rather than a page-per-file structure. The Super Admin portal (`SuperAdminWorkspace.jsx`) is a separate, smaller tree.

## 3. Roles

| Role | Scope | What they do |
|---|---|---|
| **Admin** | One Barangay (one Admin per barangay) | Runs the fleet: reviews and approves/declines Custodian-proposed tickets and schedules, assigns mechanics, approves external-shop proposals (it never handles the shop), **creates the barangay's Custodian and Maintenance accounts** (emailed temporary password), manages vehicle categories/locations/master data, and generates reports. Admin does **not** register vehicles, create tickets directly, report issues or verify repairs. |
| **Custodian** | One Barangay | The **only** role that registers vehicles and records condition checks. A Needs Repair check opens the repair request (a ticket proposal for Admin's approval). Records the hand-over and return of external-shop work, **verifies** a finished repair (Verified by) and closes the ticket, signs off readiness and books schedules. Does not test the vehicle. |
| **Maintenance Personnel** | One Barangay | Repairs assigned sub-issues, **tests the vehicle after the work (also after a shop returns it)**, can mark **No repair needed**, logs work, parts, donor parts and evidence, completes assigned schedules, and can view every vehicle in the barangay. Does not record condition checks or create tickets. |
| **Super Admin** (the LGU) | Platform-wide | Creates barangays and each barangay's one Admin (emailed temporary password), resends credentials, manages accounts, handles concern reports and platform support; workspace switching uses the dedicated switcher account. Sees **no** fleet data. |

The intended operational boundary for Admin, Custodian and Maintenance Personnel is their own Barangay. Vehicle-rooted query scopes enforce that boundary for many records, but shared-catalog writes and issue/file access have confirmed open exceptions (AUD-24-01/02/03); full isolation must not be claimed as accepted yet. Each account holds **exactly one** of these roles (`user_roles` allows one row; the API rejects a second role). Older accounts that still carry two roles keep working until an Admin edits them, and the self-verification guards still account for them.

## 4. Accounts & onboarding

There is **no public registration** (removed 1 November 2026: the system is handed over to the LGU, who are the Super Admin).

- The **Super Admin** adds a barangay and creates its **one Admin** (name, email, optional phone).
- The **Admin** creates the barangay's Custodian and Maintenance Personnel accounts from the Users page. One role per account.
- **Nobody types a password for someone else.** The system generates a random temporary password, emails it, and shows it once on screen as a fallback if the email fails. It expires after 72 hours.
- The new user must choose their own password at first sign-in; the API blocks everything else until then.
- **Resend credentials** issues a new emailed temporary password for a lost or expired one. The old password stops working at once.
- The Staff Registration Code, Pending Approvals queue, ID/photo upload and the first-Admin approval flow no longer exist.

## 5. Core workflow: the maintenance ticket lifecycle

This is the heart of the system. **Every ticket enters as a Custodian's proposal that an Admin must review and approve before it's live** — Admin has no direct "create ticket" path: `ticket.create` is a permanently empty permission grant (nobody holds it, by design). A proposal has two possible sources: a human Custodian (`POST /tickets/propose`), or the system itself, auto-proposing one when a Maintenance Schedule's date arrives (§6) — either way, it lands at `Pending Approval` and goes through the exact same Admin review, never a bypass to `Active`. A Custodian who already knows what's wrong (they filed, or were pointed to, an Issue Report) submits a full proposal, picking one repair path: **in-house** (repaired by the barangay's own mechanics; can optionally be flagged as **cannibalized**, swapping in a part taken from a donor vehicle instead of a new one), or **external** (sent to an outside shop). Each sub-issue in the proposal carries its own Repair Type and optional Suggested Mechanic — a single ticket can mix different kinds of repair (e.g. a brake job and an electrical fix) without forcing one category on every sub-issue. The ticket's title is generated automatically when the proposal is created, using the barangay ticket number, vehicle and issue summary; the Custodian does not type a separate title. Admin assigns a mechanic to each in-house sub-issue at approval, and different sub-issues may have different mechanics. When the chosen vehicle has open Issue Reports, the form first shows only a centered card asking whether the repair is for one of them (reports already held by another open ticket are greyed out); the rest of the form appears after the answer. A proposal can link to one open report on that vehicle. Screens show the title without the sub-issue (`MT-0002 — BARKO`), and ticket lists have a Repair Type column (Maintenance Schedule / In-House / External Shop). The Admin ticket list opens with Proposals + Active selected.

The workflow end to end:

1. **Check** — a Custodian records a condition check. Issue Reports no longer exist as a page: a Needs Repair result opens the repair request straight away. The Admin and Maintenance Personnel do not record checks; Maintenance Personnel work from the ticket itself.
2. **Propose** — the Custodian proposes a ticket (optionally linked to that report), entering **Pending Approval**.
3. **Approve** — the Admin reviews, can edit ticket/sub-issue fields, and approves (the ticket becomes **Active**, assigning the mechanics for its in-house sub-issues) or final-declines with a reason (the proposal remains traceable as **Declined**). Admin can instead request corrections; the assigned Custodian edits and resubmits the same Pending Approval proposal for fresh review. Undecline only returns a declined proposal to review, without starting work.
4. **Repair and test** — the assigned Maintenance Personnel logs work on the ticket's sub-issues on the Record Repair Work page (Standard Repair, or Uses Parts From Another Vehicle with one or more donor vehicles and their parts; parts cost only; evidence files that show on the ticket) and **confirms they tested the vehicle** before submitting. If nothing needs fixing they use **No repair needed** with a reason; the ticket goes to the Custodian and no maintenance record is written. For external-shop work the ticket's Custodian logs the vehicle sent to the shop and its return (and any repeat cycle); **a Maintenance Personnel then tests the returned vehicle** and submits it. The Admin only approves the proposal. External costs and provider details are included in the unified ledger at closure.
5. **Verify** — the assigned Custodian verifies the work (**Verified by**). The Maintenance Personnel already tested the vehicle, so the Custodian does not. A user must not verify their own repair — enforced server-side even for an older dual-role account. Verification is Custodian-only, with no Admin fallback; if the assigned Custodian is unavailable, the ticket is reassigned to a different Custodian instead.
6. **Decide** — the assigned Custodian uses the verification popup to Approve or Disapprove. Approval is a confirmation that the Custodian verifies the repairs (the mechanic's test is already recorded). Disapproval requires a reason and selects the failed items for rework; other submitted repairs stay submitted.
7. **Close** — successful Custodian verification closes the ticket and notifies the Admin. The server checks assignment, repair readiness, and self-verification restrictions before accepting the decision.

Extra signals layered on top: **recurrence detection** (the same fault reported again soon after a "fix" flags as a likely rework) and **aging** (a ticket open more than 30 days is flagged).

Selected unfinished work can be reassigned without resetting submitted repairs. Cancellation requires a reason and notifies responsible staff; restoration preserves submitted work and resumes verification when ready. Tickets with repair evidence cannot be permanently deleted. Decision history and fresh locked checks protect the process against stale actions and conflicting source ownership. The schedule-conversion job checks each minute against Philippine date and service time; the deployment must run Laravel's scheduler. See [the ticket process review](Ticket-Process-Review-2026-10-24.md) for the fixes, migration and verification evidence.

## 6. Other modules

- **Issue Reports** — a reporting inbox where Custodians file reports and Admin reviews them (Maintenance Personnel have no Issue Reports page). It also tracks reported donor-vehicle findings and other defects. Filing one lands straight on that report's own page with a **Create Maintenance Ticket** action right there (Custodian only) — not back on a list to search for what was just submitted. Direct issue-detail access currently bypasses the list restriction (AUD-24-02). The only Admin action on one is **Dismiss** (with a required reason) once it's no longer relevant; if a ticket already exists for it, the report's View action opens that ticket directly instead.
- **View Vehicles / Vehicle Categories** — the vehicle catalog. **Only the Custodian registers or imports vehicles**; the Admin edits, archives and decommissions them. Custodians and Maintenance Personnel see all vehicles in their barangay. **View Vehicles** has two sub-pages: **Ready to Respond** and **Not Ready to Respond** (with the reason, the last maintained date and any missing parts). Tables show names only, plain-text dates and no photos; photos appear on the vehicle profile. Vehicle Categories (called Vehicle Type before the redefense) carry a Domain (Land/Water) that changes which fields a vehicle asks for (Hull Material/Engine Type for Water). Custodians can view and add a category (edit and delete stay Admin-only). Categories are shared; cross-barangay write effects remain open under AUD-24-03.
- **Vehicle Location** — a normal street map (no satellite view) of hubs with vehicles grouped under them; hubs can't be deleted while a vehicle is still assigned. The location pin can be dragged, and "Use my location" accepts only a GPS reading accurate to 30 m or better; pins outside the barangay boundary are refused. Admin manages hubs fully; a Custodian can view the map, **add** a hub and edit locations.
- **Vehicle History** — an automatic timeline of every location/issue/condition/maintenance event per vehicle.
- **Condition Monitoring** — Custodian only. One list of the barangay's vehicles with the latest check and three actions: **View**, **Maintenance Schedule** (a routine job) and **Condition Check**. The check form opens already filled with the vehicle, and **Needs Repair** shows the repair form (In-House or External Shop) on the same page. There are no tabs and no Issue Reports. New vehicles show Good; a vehicle shows Needs Repair as soon as a ticket exists for it. Routine upkeep such as an oil change is a scheduled preventive item and never goes through Needs Repair.
- **Maintenance Schedule** — preventive maintenance planning (the Inspection Schedule tab for Admin and Custodian; its own page for Maintenance Personnel), with optional recurrence (fixed intervals or a custom number of months) and an urgency view (Overdue / 1–3 / 4–7 / 8+ days).
- **Maintenance Records** — finished repair history from tickets, external shops and maintenance schedules. Each completed repair appears separately with its work performed, source and completion date; ongoing work remains in the work and verification views.
- **Reports** — generated summaries across fleet, maintenance, issues, and users, exportable per report type.
- **Activity Log** — a full audit trail of actions taken across the fleet, scoped per Barangay.
- **Users** — account management: one role per account, **temporary-password account creation (emailed, shown once, 72-hour expiry), resend credentials**, activation and deactivation (with a 10-second Undo). There is no approving of signups.

## 7. Role responsibility summary & sidebar/navigation decisions

The one-line version of each role, for quick reference:

- **Custodian**: Register vehicles → Check condition → Request repair (a "Needs Repair" check opens the repair form) → Verify → Close (the only role that registers vehicles and records condition checks).
- **Admin**: Manage → Review → Assign → Monitor.
- **Maintenance Personnel**: Repair → Test → Submit (or No repair needed); completes scheduled work (no condition checks).

The sidebar is flat and simple, with no group labels; a page with sub-pages has a chevron that folds it. As of 5 November 2026:

- **Admin**: Dashboard · View Vehicles (Ready to Respond, Not Ready to Respond) · Maintenance (Repair Tickets, Schedule, Records) · Users · Reports · Vehicle Categories · Activity Log.
- **Custodian**: Dashboard · Condition Monitoring (with a Next Maintenance column) · View Vehicles (Ready to Respond, Not Ready to Respond) · Vehicle Location · My Tasks · Vehicle History.
- **Maintenance Personnel**: Dashboard · Vehicles Needing Work · My Work Orders · Maintenance Schedule.

Four navigation decisions are deliberate and final — not oversights to "fix" in a future pass:

1. **Custodian's "My Tasks" is one list** of repairs waiting for verification and the tickets they handle (the History tab was removed as redundant). Independent repair verification is reached from the assigned ticket or the ready-to-close queue.
2. **There is no Issue Reports module for any role.** The Custodian's condition check is the report; a "Needs Repair" result opens the repair request directly. A mechanic's sidebar is Dashboard, Vehicles Needing Work, My Work Orders and Maintenance Schedule.
3. **Readiness Check has no standalone sidebar item.** It stays a contextual action on the relevant vehicle (View Vehicles / vehicle profile), since a readiness check is always about one specific vehicle — a separate module would just make the user pick the vehicle a second time.
4. **Maintenance Personnel's repair evidence stays inside the repair/work-order workflow** (the repair log's own photo field), not the generic Vehicle Documents store. The repair already knows the vehicle, ticket, sub-issue, and mechanic — attaching evidence there avoids a duplicate upload with none of that context.

## 8. Security posture

- Sanctum bearer tokens, no server-side session state.
- Role/ownership guards exist in the backend, including `RestrictSuperAdminScope`, `EnsureUserIsActive`, and per-Barangay query scopes. These do not close the confirmed issue-detail, file-signing and shared-catalog findings. UI visibility is not sufficient authorization.
- Inactive accounts cannot log in at all. A temporary password expires after 72 hours and must be replaced at first sign-in.
- Uploads are stored on the local private disk with enforced type and size limits (photos 5 MB, documents 10 MB) and served only through authenticated, signed links.
- An account created by the Super Admin or an Admin carries `must_change_password`: until the user sets their own password the API returns 403 (`password_change_required`) for everything except sign-out, "who am I" and the password change.
- Destructive actions that matter operationally (e.g. deleting a hub with vehicles still on it) are blocked server-side, not just hidden in the UI.

## 9. Where to look in the code

| Concern | File |
|---|---|
| Nearly all fleet-facing UI | `frontend-spa/src/views/Workspace.jsx` |
| Role-specific dashboard summaries | `frontend-spa/src/components/RoleDashboard.jsx` |
| Super Admin UI | `frontend-spa/src/views/SuperAdminWorkspace.jsx` |
| Shared mechanical brand gear | `frontend-spa/src/components/VMSLogo.jsx` |
| Shared styling | `frontend-spa/src/App.css` |
| Auth, registration, impersonation | `backend-api/app/Http/Controllers/AuthController.php` |
| Vehicles, issues, conditions, schedules, maintenance records | `backend-api/app/Http/Controllers/FleetController.php` |
| Ticket workflow | `backend-api/app/Http/Controllers/TicketController.php` |
| Map hubs | `backend-api/app/Http/Controllers/HubController.php` |
| Super Admin backend | `backend-api/app/Http/Controllers/SuperAdminController.php` |
| Route definitions | `backend-api/routes/api.php` |

## 10. Related documents

Use [the current document index](README.md) to choose the right reference.

- [System-Capabilities.md](System-Capabilities.md): detailed module and feature reference.
- [Must-Haves.md](Must-Haves.md) and [the requirements PDF](VMS-Must-Haves-Updated.pdf): requirements mapping and acceptance criteria.
- [Sample-Data.md](Sample-Data.md): team setup, demo accounts and recorded verification.
- [System-Audit-2026-10-24.md](System-Audit-2026-10-24.md): current open findings and retest criteria.
- [Ticket process review](Ticket-Process-Review-2026-10-24.md): field review, reproduced ticket workflow gaps and proposed improvements.
- [The presentation with examples](VMS-Evidence-and-Defense-Review-With-Examples.pptx): defense preparation and follow-along cases.
- [System-Architecture.svg](../VMS%20FINAL%20DEFENSE%20PREPARATION/System-Architecture.svg), [ERD.svg](../VMS%20FINAL%20DEFENSE%20PREPARATION/ERD.svg) and [Use-Case-Diagram.svg](../VMS%20FINAL%20DEFENSE%20PREPARATION/Use-Case-Diagram.svg): diagrams.
- [Historical archive](../docs/archive/vms/README.md): earlier role decisions, audit passes, UI changes, geographic evidence and superseded exports. These describe earlier revisions.
- Root [README.md](../README.md): project setup and technical overview. The root `docs/` folder also contains earlier manuals and QA material.

## Recent changes (see `System-Capabilities.md` §5.3, §5.4, §14b for detail)

- **1 November 2026 (panel redefense):** no public registration; the Super Admin creates each barangay's one Admin and the Admin creates staff, with emailed temporary passwords. Local-only file storage with size and type limits. Normal street maps. View Vehicles with Ready / Not Ready sub-pages. One Condition Monitoring page. The Maintenance Personnel tests repairs (also shop returns) and can mark No repair needed; the Custodian only verifies. Cannibalization leaves the donor Not Ready until the part is restored. Only the Custodian adds vehicles. "Vehicle type" is now "Vehicle Category". Specific error messages and an Undo banner for key actions. Details and open gaps: [Redefense-Changes-2026-11-01.md](Redefense-Changes-2026-11-01.md).
- **5 November 2026 (menus, pages and flows):** Condition Monitoring is a vehicle list with View, Maintenance Schedule and Condition Check actions; Needs Repair shows the repair form on the same page. Issue Reports are gone. The Admin's Maintenance folder holds Repair Tickets (formerly Maintenance Tickets), Schedule and Records. Decommission replaces Deactivate. All lists are list view only, with specific date column names. Ready to Respond and Not Ready to Respond are view-only (Not Ready has one button, the open ticket). Mark Done for a scheduled job is a page with optional Parts & Materials and a total cost. A part still missing from a donor vehicle cannot be taken again until it is marked restored.

- Focused role dashboards; separate Super Admin platform overview and Barangay Management; flat Super Admin navigation and Province → City/Municipality → Barangay → Staff impersonation selection.
- Three-step registration, clearer ticket-creation layout, compact schedule summaries, and shared blue/white mechanical gear branding. See `Must-Haves.md` for the supplied academic requirement baseline, implementation mapping, and role-alignment items requiring adviser review.
- **Ticketing (12 November 2026):** a mechanic or the shop tester can **Return to Admin** (reason required; Admin and Custodian are notified and see it on the ticket); an external-shop job has a **named shop tester** chosen at approval; unreachable steps (direct create, inspection, per-item verify/confirm/defer, Admin Close, Unconfirm) were removed. The full dataflow is in Ticket-Dataflow-2026-11-12.md.
- **Cannibalization (10 November 2026):** parts taken off a vehicle are logged on the repair ticket. Donors are **retired (decommissioned) vehicles only**; part (add-able list) and quantity are recorded, there is no Admin approval, no inventory, no separate page and no Issue Report on the donor. Older parts from vehicles still in service keep their Blocks readiness / Minor badges and "Put back".
- External-shop repairs: the Custodian logs the dispatch and return; a Maintenance Personnel then tests the returned vehicle and submits it, and the Custodian only verifies (Verified by) and closes the ticket; the Admin only approves the proposal. The Custodian who handled the shop may verify; a mechanic who did the repair cannot verify it.
- The Custodian closes tickets: verification is a popup (Approve / Disapprove with reason); "Tickets Ready to Close" is on the Custodian page; closing notifies the Admin. Verification is never done by Admin or by the repairer.
- Assigned-personnel avatars on tickets, schedules and records; completion counts/stages on ticket cards and a progress bar/percentage in the ticket list; inline per-field validation messages in the shared form.

## 11. Audit baseline and acceptance

The 24 October probes recorded six findings at `0027023`. The table preserves their original descriptions. Later integrated code rejects future completion dates; the remaining controls require their specific acceptance retests. See [current audit disposition](Current-Revision-2026-10-25.md#audit-disposition).

| ID | Severity | Current problem |
|---|---|---|
| AUD-24-01 | High | A profile/free-text response can issue a signed URL for an inaccessible same-barangay managed file, bypassing the renewal endpoint's parent-record check. |
| AUD-24-02 | High | Direct issue details expose reports hidden by the list policy, including linked ticket details denied by the ticket endpoint. |
| AUD-24-03 | High | Barangay Admin edits to shared catalogs affect other barangays' types and completed records; catalog-backed historical rewrites have no corresponding edit audit entry. |
| AUD-24-04 | High | Parts removal flags condition for inspection but does not invalidate an earlier readiness pass. |
| AUD-24-05 | Medium | Shared CSV exports retain formula-leading untrusted values. Spreadsheet execution depends on the receiving application/settings. |
| AUD-24-06 | Medium | Schedule completion accepts future dates and uses them to seed future recurrences. |

Documentation discrepancies AUD-24-07/08 are now aligned with code: registration is a standard Custodian duty and the ticket list currently has percentage progress. This does not approve any change to the supplied academic baseline. See [the audit evidence and retest criteria](System-Audit-2026-10-24.md) and [Must-Haves acceptance criteria](Must-Haves.md#8-required-acceptance-criteria-from-the-24-october-audit).

Verification record: the merged revision passed 480 backend tests (2,245 assertions), frontend lint/build and targeted desktop/mobile checks. A later six-test isolated investigation (36 assertions), plus a CSV-generation probe, reproduced the findings above. Passing those probes confirmed the defective behavior, not its resolution. The investigation files were removed and no application fixes were made in this documentation update.

The editable requirements source is `Must-Haves.md`; its PDF is an earlier export and was not regenerated in this update. Older audit documents and the earlier generated DOCX are historical artifacts in `docs/archive/vms/`. Deployment storage policy, persistence, recovery and representative-user acceptance still need target-host evidence; this is not an exhaustive penetration-test certification.
