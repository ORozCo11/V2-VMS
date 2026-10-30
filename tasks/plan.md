# Implementation Plan: Panel Feedback Revisions

> Replaces the earlier "City/Municipality tier" plan. The panel feedback says the **LGU is the Super Admin**
> and creates each barangay's Admin directly, so there is no separate City Admin role.

## Overview
Apply the panel's revision list to the Barangay VMS: simpler account onboarding (LGU → barangay Admin →
staff), system-wide consistency (errors, dates, uploads, sidebar, maps, labels), vehicle-page fixes and new
pages (available vehicles, borrowing), reworked maintenance/condition/ticket flows, and the missing
deliverables (state transition diagram, documentation, UI screenshots).

Stack: Laravel 13 + Sanctum (`backend-api/`), React 19 + Vite SPA (`frontend-spa/`), sqlite locally.
Most UI lives in `frontend-spa/src/views/Workspace.jsx` (~16k lines); abilities in `backend-api/config/permissions.php`.

## Feedback → task map
| Feedback item | Task |
|---|---|
| LGU = Super Admin, creates the Admin account for each barangay | T2 |
| Admin adds the other users for their barangay | T4, T6 |
| Email has a link to the login page | T2, T3, T4 |
| Once Super Admin approves, user can log in directly | T3 |
| Remove the map; registration should be simpler / change registration | T5 |
| Invite a user | T4 |
| Batch upload | T6 |
| Size limitation, file types that can be uploaded | T8 |
| Error is specific, not generic / BE SPECIFIC | T7 |
| Dates in a simple format | T9 |
| Pagination shouldn't be visible | T10 |
| Vehicle sidebar collapsible / rearrange the sidebar | T11 |
| One layer on the map | T12 |
| Arrange the database properly, consistent labeling | T13 |
| Visually pleasing but not functioning | T14 |
| View vehicles: only those that need to be shown | T15 |
| Ready to respond = yes/no (new column) | T16 |
| Last maintained, not last checked | T17 |
| Page for all available (usable) vehicles | T18 |
| Page dedicated to borrowing | T19, T20 |
| Cannibalization donors = vehicles no longer in use | T21 |
| Vehicle type is "vehicle category", move under Maintenance sidebar | T22 |
| Maintenance does condition monitoring, verified by Custodian | T23 |
| Condition check findings auto-populate the ticket; Custodian just submits; Admin approves / propose ticket from condition monitoring | T24 |
| Merge maintenance schedule and condition monitoring | T25 |
| External shop: Pending → Approved → Tested by MP → Verified by Custodian → Closed | T26 |
| Option of returning a ticket | T27 |
| Assigned To column shows names, not profiles | T28 |
| State transition diagram (submit) | T29 |
| Documentation, UI screenshots (lacking) | T30 |

## Current state that drives the design (from code survey)
- **Onboarding:** first registrant for a barangay becomes Admin, then Super Admin approves, emails a staff code, user logs in and enters the code (4 steps). Staff register with a staff code and need Admin approval. No invites, no temp passwords, no login link except the "activated" email. Admin-approved staff get no email.
- **Registration:** 3-step wizard in `Register.jsx` (676 lines) with province/city/barangay cascade, boundary map, street address, role + staff code.
- **Errors:** no axios response interceptor; per-view `showError` falls back to "Something went wrong while saving." and similar generic strings in ~8 places.
- **Dates:** at least 8 formatters, some ignore Manila timezone.
- **Uploads:** limits vary (4/8/10 MB, 2 MB import) and are shown in the UI for only some.
- **Sidebar:** groups defined in `modulesByRole` (`Workspace.jsx:50-141`) but rendered flat with no headings or collapse.
- **Maps:** 6 map surfaces using Esri, Carto and OSM, several with Map/Satellite toggles.
- **Vehicles:** list shows Decommissioned by default; readiness is a 6-state badge; no "last maintained" anywhere; no available-only page; no borrowing (a usage/dispatch feature was removed 2026-10-24).
- **Cannibalization:** donor dropdown and `assertDonorEligible` allow Available + Under Maintenance and exclude Inactive/Decommissioned, the opposite of the feedback.
- **Condition checks:** Custodian creates; MP can't see them; "Propose Ticket" pre-fills only `condition_check_id`.
- **Tickets:** Pending Approval → Active → For Verification → Closed (+ Declined, Cancelled). External shop is timestamps on the work item while the ticket stays Active, and Admin logs the repair. Ten abilities are mapped to `[]` (dead routes).
- **Assigned To:** avatar chips only.

## Architecture Decisions
- **No City Admin role.** Super Admin (LGU) creates barangays and their Admins; barangay Admin creates staff.
- **Temp password + forced change** (`users.must_change_password`, enforced by server middleware) for every account created by someone else. Emails carry a "Sign in" link built from `config('app.frontend_url')`.
- **Invites** = account created inactive-with-token; email link opens a "set your password" page; using it activates the account. Reuses the same email template family (`AccountMail`).
- **Staff-code chain retired** for new accounts once T2/T3 land; existing staff-code columns stay until T13 cleans them up.
- **Shared frontend utilities** replace per-view copies: one `formatDate`, one error-message extractor (axios response interceptor), one upload-limits constant mirrored from a backend config file.
- **Borrowing is a new module** with its own table and statuses; it does not reuse the removed `vehicle_usage_logs` migration (dropped tables stay dropped).
- **Merging schedule + condition monitoring** = one "Maintenance" page with tabs, and a condition check becomes an action performed on a vehicle/scheduled item, not a separate sidebar module. Exact UX is an open question.
- **Workspace.jsx** is touched by most tasks: tasks extract the component they change into `frontend-spa/src/views/<module>/` when practical to reduce merge conflicts.

## Task List
Detail (acceptance criteria, verification, files) in `tasks/todo.md`.

### Phase 1: Accounts and onboarding
- [x] T1: Accounts created by someone else must change password on first login
- [x] T2: Super Admin (LGU) creates a barangay's Admin account; email has login link
- [x] T3: Approval means immediate login; approval email has login link
- [ ] T4: Barangay Admin invites a user by email
- [ ] T5: Simplified registration (no map)
- [ ] T6: Barangay Admin batch-uploads users

### Checkpoint A: Onboarding
- [ ] LGU creates Barangay Admin → Admin signs in from email link → changes password → invites Custodian → Custodian sets password and signs in

### Phase 2: System-wide consistency
- [ ] T7: Specific error messages everywhere
- [ ] T8: Upload file types and size limits enforced and shown
- [ ] T9: One simple date format
- [ ] T10: Hide pagination controls
- [ ] T11: Rearranged, collapsible sidebar
- [ ] T12: Maps use a single base layer
- [ ] T13: Database and label consistency
- [ ] T14: Functional sweep of every page

### Checkpoint B: Consistency
- [ ] No generic error string left (`grep -r "Something went wrong" frontend-spa/src` → only ErrorBoundary)
- [ ] Every sidebar page loads and every visible button works for each role

### Phase 3: Vehicles
- [ ] T15: View Vehicles shows only vehicles in use, with trimmed columns
- [ ] T16: "Ready to Respond" Yes/No column
- [ ] T17: "Last maintained" replaces "last checked"
- [ ] T18: Available Vehicles page
- [ ] T19: Borrowing page: request and approve
- [ ] T20: Borrowing page: release and return
- [ ] T21: Cannibalization donors are only vehicles no longer in use
- [ ] T22: Vehicle Category moved under Maintenance

### Checkpoint C: Vehicles
- [ ] Borrow → approve → release → return round trip works; vehicle status follows

### Phase 4: Maintenance and tickets
- [ ] T23: Maintenance Personnel performs condition checks; Custodian verifies
- [ ] T24: Ticket proposed from a condition check is auto-filled from its findings
- [ ] T25: Merge Maintenance Schedule and Condition Monitoring
- [ ] T26: External shop flow: Pending → Approved → Tested → Verified → Closed
- [ ] T27: Return a ticket
- [ ] T28: "Assigned To" shows names

### Checkpoint D: Workflows
- [ ] Condition check (MP) → verified (Custodian) → ticket auto-filled → Admin approves → repair → verify → closed
- [ ] External shop ticket follows the 5-state flow

### Phase 5: Deliverables
- [ ] T29: Finalize state transition diagram
- [ ] T30: Documentation and UI screenshots

### Checkpoint E: Complete
- [ ] `php artisan test` green, `npm run build` + `npm run lint` clean
- [ ] Reviewed with human / adviser

## Risks and Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| `Workspace.jsx` is ~16k lines and nearly every task touches it → merge conflicts, regressions | High | One branch per task (`Jake/<WhatWeFixed>`), extract touched modules into their own files, run full test + build each task |
| Changing who does condition checks (T23) and the external flow (T26) breaks existing tests and seed data | High | Update tests in the same task; seed data updated alongside; Checkpoint D end-to-end walk |
| Renaming DB columns/labels (T13) breaks API consumers | Med | Glossary first, rename UI labels freely, rename DB columns only via migrations with test coverage; avoid renames that aren't asked for |
| Borrowing scope creep (who borrows, external borrowers, approvals) | Med | Open question 4 answered before T19 starts |
| Retiring the staff-code chain strands accounts mid-activation | Med | T3 activates any `awaiting_staff_code` account on approval, with a migration for existing rows |
| Temp passwords leaked | High | Hash only; shown once / emailed once; never in activity log; test asserts it |
| Panel items open to interpretation (pagination, "return a ticket", merge) | Med | Open questions below; confirm with adviser before those tasks |

## Open Questions (confirm with adviser/panel before the linked task)
1. **T5:** Should public self-registration stay at all, now that the LGU creates Admins and Admins invite staff? (Recommendation: remove it, keep only invite and sign-in.)
2. **T10:** "Pagination shouldn't be visible" — show everything with scrolling, load more as you scroll, or keep paging but hide the controls when there's only one page?
3. **T16:** "Add a new column" — a Yes/No column in the vehicle table (computed), or a stored Yes/No field the Custodian sets?
4. **T19/T20:** Who borrows (other barangays, residents, internal staff)? Who approves? What details are recorded (purpose, driver, destination, odometer)?
5. **T25:** In the merged page, is a condition check something done as part of a scheduled maintenance, or a separate action on the same page?
6. **T27:** "Returning a ticket" — Maintenance Personnel returning a ticket to Admin (can't do the work), Admin returning a proposal to the Custodian, or both?
7. **T13:** Which labels did the panel find inconsistent? (Known: "Vehicle Type" vs "Vehicle Category", "Total Repair Records" on the vehicle card, "Condition Monitoring" vs "Condition Check".)
8. **T14:** Which screens looked finished but didn't work?
