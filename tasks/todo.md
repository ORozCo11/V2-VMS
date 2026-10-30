# Todo: Panel Feedback Revisions

See `tasks/plan.md` for the feedback → task map, design decisions, risks and open questions.

Commands:
- Backend tests: `cd backend-api && php artisan test --filter=<TestName>` (full: `php artisan test`)
- Frontend: `cd frontend-spa && npm run build && npm run lint`
- Branch per task: `Jake/<WhatWeFixed>`, pushed.

Abbreviations: WS = `frontend-spa/src/views/Workspace.jsx`, FC = `backend-api/app/Http/Controllers/FleetController.php`, TC = `.../TicketController.php`.

---

## Phase 1: Accounts and onboarding

### T1: Accounts created by someone else must change password on first login ✅
**Description:** Add `users.must_change_password`. Server middleware returns 403 `password_change_required` on every protected route except `profile/password`, `user`, `logout` while it's set. Login returns the flag; the SPA forces a change-password screen. Add a helper that generates a temp password and sets the flag.

**Acceptance criteria:**
- [x] Flagged user gets 403 on other protected routes; `PUT /profile/password` succeeds and clears the flag
- [x] SPA sends a flagged user to the change-password screen from any route (`ProtectedRoute` renders `ForceChangePassword`)

**Done notes:** helper is `User::issueTemporaryPassword()`. New password must now differ from the current one (applies to every password change).

**Verification:** `php artisan test --filter=ForcedPasswordChangeTest`; `npm run build`; manual: flag a seeded user in tinker and log in.

**Dependencies:** None · **Files:** new migration, `app/Http/Middleware/EnsurePasswordChanged.php`, `routes/api.php`, `AuthController.php`, `ProtectedRoute.jsx`, new `ForceChangePassword.jsx`, test · **Scope:** M

### T2: Super Admin (LGU) creates a barangay's Admin account ✅
**Description:** New `POST /superadmin/barangays/{id}/admins` (name, email, phone). Creates an active `Admin` with a temp password (T1) and emails them the password once with a "Sign in to VMS" link (`config('app.frontend_url')/login`). "Add Admin" button on Barangay Management detail. Add `FRONTEND_URL` to `.env.example`.

**Acceptance criteria:**
- [x] Created user is Admin of that barangay, active, flagged; DB holds only the hash
- [x] Email contains the temp password and a working login link; activity log doesn't contain the password
- [x] Non-Super-Admin gets 403; duplicate email rejected with a specific message

**Done notes:** ability `barangay.create_admin`. Creation and email run in one transaction, so a failed email leaves no account (502 with a specific message). The temp password is only in the email, never in the API response or UI. Creating an Admin also marks the barangay provisioned. UI: "Create Administrator account" section on the barangay detail page.

**Verification:** `php artisan test --filter=SuperAdminCreatesBarangayAdminTest` (uses `Mail::fake`); `npm run build`; manual: create an Admin, open the email in the log mailer, follow the link.

**Dependencies:** T1 · **Files:** `SuperAdminController.php`, `routes/api.php`, `app/Mail/AccountMail.php`, new `resources/views/emails/admin-created.blade.php`, `SuperAdminPanels.jsx`, test · **Scope:** M

### T3: Approval means immediate login; approval email has a login link
**Description:** `SuperAdminController@activateUser` and `UserController@activate` set the account active right away (no staff-code step) and send an "approved" email with a sign-in link. Existing `awaiting_staff_code` accounts become activatable this way. Remove the staff-code prompt from `Login.jsx`.

**Acceptance criteria:**
- [ ] After approval by Super Admin or Admin, the user can log in immediately
- [ ] An "approved" email with a sign-in link is sent in both cases
- [ ] `Login.jsx` no longer shows the staff-code window

**Verification:** `php artisan test --filter=ApprovalImmediateLoginTest` + existing approval tests updated; `npm run build`; manual: approve a pending user, log in as them.

**Dependencies:** None · **Files:** `SuperAdminController.php`, `UserController.php`, `AccountMail.php`, new `emails/approved.blade.php`, `Login.jsx`, tests · **Scope:** M

### T4: Barangay Admin invites a user by email
**Description:** "Invite User" on the Users page (name, email, role(s)). Creates an inactive account with a one-time token (expires in 7 days) and emails a link to a "Set your password" page. Submitting the password activates the account and logs them in. Admin can resend or cancel a pending invite.

**Acceptance criteria:**
- [ ] Invite email link opens the set-password page; after setting it, the user is active in the Admin's barangay with the invited role
- [ ] Expired or used token shows a specific message ("This invite has expired — ask your barangay Admin to resend it")
- [ ] Users list shows invite status (Invited / Active) with Resend and Cancel

**Verification:** `php artisan test --filter=UserInviteTest`; `npm run build`; manual: invite, accept, log in.

**Dependencies:** T3 (email template family) · **Files:** new migration (invite token columns or `user_invites` table), `UserController.php` or new `UserInviteController.php`, `routes/api.php`, new `emails/invite.blade.php`, new `AcceptInvite.jsx`, `App.jsx`, WS Users module, test · **Scope:** M

### T5: Simplified registration (no map)
**Description:** **Depends on Open Question 1.** If registration stays: single page, no boundary map, no street address step, barangay chosen from one searchable list of provisioned barangays. If it's removed: delete `/register` route and page and point "Create account" links to a note saying accounts are created by the LGU or barangay Admin.

**Acceptance criteria:**
- [ ] No map on the registration path
- [ ] Registration (if kept) fits on one screen with ≤ 6 fields
- [ ] Registration tests updated and passing

**Verification:** `php artisan test --filter=Registration`; `npm run build`; manual on a phone-width screen.

**Dependencies:** T2, T4, Open Question 1 · **Files:** `Register.jsx`, `Register.css`, `AuthController.php`, `App.jsx`, `Welcome`/landing links, tests · **Scope:** M

### T6: Barangay Admin batch-uploads users
**Description:** Copy the `VehicleImportController` shape: template download (xlsx/csv: full name, email, phone, role), preview with per-row errors, commit that sends an invite (T4) to each valid row. Limits: .xlsx/.csv, 2 MB, 500 rows, shown in the dialog.

**Acceptance criteria:**
- [ ] Preview flags exactly the invalid rows with a reason (bad email, duplicate, unknown role); creates nothing
- [ ] Commit creates and invites only valid rows; re-commit rejected
- [ ] Wrong file type or too big rejected with a message naming the limit

**Verification:** `php artisan test --filter=UserImportTest`; `npm run build`; manual: 20-row file with 2 bad rows.

**Dependencies:** T4 · **Files:** new `UserImportController.php`, migration for `user_imports`, `routes/api.php`, `config/permissions.php`, new `UserImportModal.jsx`, test · **Scope:** M

## Checkpoint A: Onboarding
- [ ] Full test suite green, build + lint clean
- [ ] LGU creates Barangay Admin → Admin signs in from email → changes password → invites Custodian → Custodian sets password, signs in
- [ ] Review with human before proceeding

---

## Phase 2: System-wide consistency

### T7: Specific error messages everywhere
**Description:** Add an axios response interceptor that turns every error into a specific message: Laravel validation errors per field, `message` from the server, and for network/500 errors a message naming the action ("Couldn't save the vehicle — the server didn't respond"). Replace `showError` fallbacks and the generic strings (WS:10527, 16025, 16053, 16074; `SuperAdminWorkspace.jsx:214, 365`; `Register.jsx:321`). Audit backend `abort(...)` calls with vague messages.

**Acceptance criteria:**
- [ ] `grep -rn "Something went wrong" frontend-spa/src` returns only `ErrorBoundary.jsx`
- [ ] Each form shows the failing field's message next to the field
- [ ] Every fallback names what failed

**Verification:** `npm run build && npm run lint`; manual: submit invalid forms on Vehicles, Users, Tickets; stop the backend and try a save.

**Dependencies:** None · **Files:** `frontend-spa/src/api/axios.js`, new `utils/errorMessage.js`, WS (showError), `SuperAdminWorkspace.jsx`, `Register.jsx` · **Scope:** M

### T8: Upload file types and size limits enforced and shown
**Description:** One backend config (`config/uploads.php`) defining types and max size per upload kind (photo, document, receipt, attachment, evidence, import), used by every validator listed in the survey. Expose it via `/lookups`; every file input uses it for `accept`, a client-side size check, and a visible hint ("PDF, JPG or PNG · up to 10 MB").

**Acceptance criteria:**
- [ ] Every upload input shows allowed types and max size
- [ ] Too-large or wrong-type file is rejected before upload with a specific message, and the server also rejects it
- [ ] Validators read from `config/uploads.php` (no hard-coded `max:` left in upload rules)

**Verification:** `php artisan test --filter=UploadLimitsTest`; `npm run build`; manual: try an 11 MB PDF and an .exe on each upload.

**Dependencies:** None · **Files:** new `config/uploads.php`, `FC`, `TC`, `UserController.php`, `AuthController.php`, `CannibalizationController.php`, new `components/FileInputHint.jsx`, `FileCabinet.jsx`, `RepairFileCabinet.jsx`, WS file inputs · **Scope:** L, so split into backend and frontend PRs

### T9: One simple date format
**Description:** One `utils/date.js` with `formatDate` ("Oct 30, 2026") and `formatDateTime` ("Oct 30, 2026, 3:04 PM"), always Asia/Manila. Replace WS `formatDate`, `formatLogDateTime`, `formatForecastDate`, the inline `toLocaleString`, `RoleDashboard` `date`, and `adminDate.js`.

**Acceptance criteria:**
- [ ] Every displayed date uses one of the two formats
- [ ] No other date formatter left (grep for `toLocaleString(`, `toLocaleDateString(`)

**Verification:** `npm run build && npm run lint`; manual: compare dates on Tickets, Activity Log, Schedules, Super Admin.

**Dependencies:** None · **Files:** new `utils/date.js`, WS, `RoleDashboard.jsx`, `adminDate.js`, `SuperAdminPanels.jsx`, `SupportCenterTab.jsx` · **Scope:** M

### T10: Hide pagination controls
**Description:** **Depends on Open Question 2.** Default plan: tables show all rows in a scroll area, or load more on scroll, with no page/page-size controls. Apply to both `PaginatedTable` components (WS:9901, `SuperAdminUI.jsx:50`) and `PaginatedCardGrid`.

**Acceptance criteria:**
- [ ] No pagination controls visible on any page
- [ ] Lists of 500+ rows still render without freezing

**Verification:** `npm run build`; manual with a seeded 500-vehicle barangay.

**Dependencies:** Open Question 2 · **Files:** `PaginationControls.jsx`, WS `PaginatedTable`/`PaginatedCardGrid`, `SuperAdminUI.jsx` · **Scope:** S–M

### T11: Rearranged, collapsible sidebar
**Description:** Render `modulesByRole` groups with headings and collapse/expand (remembered per user). New order, e.g. Admin: Dashboard · Vehicles (View Vehicles, Available Vehicles, Borrowing, Vehicle Location) · Maintenance (Tickets, Maintenance & Condition, Records, Vehicle Category) · Administration (Users, Reports, Activity Log). Equivalent for Custodian and Maintenance Personnel. Super Admin tabs grouped too.

**Acceptance criteria:**
- [ ] Each group has a heading and collapses and expands
- [ ] Order matches the agreed layout for each role; mobile bottom nav still works

**Verification:** `npm run build`; manual for each role.

**Dependencies:** T22 placement agreed; new pages (T18–T20, T25) slot in as they land · **Files:** WS (`modulesByRole`, sidebar render ~2551), CSS · **Scope:** S

### T12: Maps use a single base layer
**Description:** One OSM street tile layer on every map; remove Map/Satellite toggles, Esri label overlays and the double boundary polygon. Shared `components/BaseMapLayer.jsx`.

**Acceptance criteria:**
- [ ] Every map renders one tile layer and no layer switcher
- [ ] Boundary (where shown) is a single polygon

**Verification:** `npm run build`; manual on Vehicle Location, Vehicle profile, Add Location, Super Admin boundary.

**Dependencies:** T5 (registration map removed there) · **Files:** `LocationDensityMap.jsx`, `VehicleLocationMap.jsx`, `AddLocationMap.jsx`, `SuperAdminWorkspace.jsx`, `BoundaryReviewModal.jsx`, new `BaseMapLayer.jsx` · **Scope:** M

### T13: Database and label consistency
**Description:** Write `docs/glossary.md` (one term per concept: Vehicle Category, Condition Check, Maintenance Ticket, Work Item, etc.) and apply it to UI labels. Remove dead routes and abilities mapped to `[]` (`ticket.create`, `ticket.inspect`, `ticket.close`, `subissue.*` verify/confirm/defer/assign, `schedule.suggest`, `vehicle.request_inspection`). Drop retired staff-code columns after T3. Rename DB columns only where the glossary requires it, via migrations. Fix "Total Repair Records" on the vehicle card (WS:3166).

**Acceptance criteria:**
- [ ] Glossary exists and UI labels match it
- [ ] No route left whose ability is `[]`
- [ ] Full test suite green after removals

**Verification:** `php artisan test`; `php artisan route:list` diffed against the glossary; `npm run build`.

**Dependencies:** T3, Open Question 7 · **Files:** `docs/glossary.md`, `routes/api.php`, `config/permissions.php`, `TC` (dead methods), migrations, WS labels · **Scope:** L, so split into labels PR and dead-code PR

### T14: Functional sweep of every page
**Description:** For each role, open every sidebar page and click every visible button, filter and link. Log anything that looks done but doesn't work in `tasks/functional-sweep.md`, then fix or remove each item. Start with screens named in Open Question 8.

**Acceptance criteria:**
- [ ] Sweep log covers every page for every role
- [ ] Every logged item is fixed or removed

**Verification:** Sweep log checked off; manual re-walk.

**Dependencies:** T7–T13 · **Files:** `tasks/functional-sweep.md` + files found · **Scope:** varies (split per finding)

## Checkpoint B: Consistency
- [ ] Full suite green, build + lint clean
- [ ] Generic error grep clean; one date format; no pagination; one map layer
- [ ] Review with human before proceeding

---

## Phase 3: Vehicles

### T15: View Vehicles shows only vehicles in use
**Description:** Default list hides Inactive and Decommissioned (an "Include retired vehicles" toggle shows them). Trim default columns to Vehicle, Plate, Category, Status, Ready to Respond, Last Maintained, Location; the rest stays available in the column chooser.

**Acceptance criteria:**
- [ ] Default list has no Inactive/Decommissioned vehicles; toggle reveals them
- [ ] Default columns as listed

**Verification:** `npm run build`; manual with seeded retired vehicles.

**Dependencies:** T16, T17 (columns) · **Files:** WS (`vehicleColumns` ~8043, filters ~1812), `FC@vehicles` (optional server default) · **Scope:** S

### T16: "Ready to Respond" Yes/No column
**Description:** **Depends on Open Question 3.** Default: computed column showing **Yes** or **No** from `responseReadinessState()` (`ready` → Yes, anything else → No), with the reason as a tooltip ("No: under maintenance"). If a stored field is wanted, add `vehicles.ready_to_respond` boolean, set by readiness checks.

**Acceptance criteria:**
- [ ] Column shows only Yes or No; tooltip gives the reason for No
- [ ] Filter and stat card use the same Yes/No logic

**Verification:** `php artisan test --filter=ReadinessYesNoTest`; `npm run build`.

**Dependencies:** Open Question 3 · **Files:** `FC` (`vehicles` payload ~980), WS (`vehicleColumns`, `READINESS_BADGE`) · **Scope:** S

### T17: "Last maintained" replaces "last checked"
**Description:** Add `last_maintained_at` to the vehicle payload: latest of closed-ticket close date and `vehicle_maintenance_records.date_completed`. Show it in the vehicle list and profile Operational card, replacing "Last readiness check".

**Acceptance criteria:**
- [ ] Vehicle with a closed ticket shows that date; vehicle never maintained shows "Never"
- [ ] "Last readiness check" no longer shown as the main date

**Verification:** `php artisan test --filter=LastMaintainedTest`; `npm run build`.

**Dependencies:** T9 · **Files:** `FC` (`vehicles`, `vehicleReadiness`/profile), WS (list + profile ~14076), test · **Scope:** S

### T18: Available Vehicles page
**Description:** New sidebar page listing only vehicles that are Available and Ready to Respond = Yes, as cards with category, plate, location and last maintained. Visible to all barangay roles.

**Acceptance criteria:**
- [ ] Shows exactly vehicles with status Available and ready = Yes
- [ ] Updates after a vehicle goes under maintenance

**Verification:** `php artisan test --filter=AvailableVehiclesTest`; `npm run build`.

**Dependencies:** T16 · **Files:** `FC` (new `availableVehicles` or `vehicles?available=1`), `routes/api.php`, new `views/AvailableVehicles.jsx`, WS sidebar · **Scope:** S–M

### T19: Borrowing page: request and approve
**Description:** **Depends on Open Question 4.** New `vehicle_borrowings` table (vehicle, borrower, purpose, destination, requested start/end, status, approved_by). Statuses: Requested → Approved / Declined. Borrowing page lists requests; only Available + ready vehicles can be requested; Admin approves or declines.

**Acceptance criteria:**
- [ ] Request a borrow for an available vehicle; overlapping dates on the same vehicle are rejected with a specific message
- [ ] Admin approves or declines; requester is notified

**Verification:** `php artisan test --filter=VehicleBorrowingRequestTest`; `npm run build`.

**Dependencies:** T18, Open Question 4 · **Files:** migration, new `VehicleBorrowing` model + controller, `routes/api.php`, `permissions.php`, new `views/Borrowing.jsx` · **Scope:** M

### T20: Borrowing page: release and return
**Description:** Approved → Released (Custodian hands over; records odometer, vehicle status becomes "In Use" or a borrowing flag) → Returned (odometer, condition notes; Needs Repair can trigger a condition check or ticket). Add Borrowing to the state transition diagram.

**Acceptance criteria:**
- [ ] Release blocks other borrows and hides the vehicle from Available Vehicles
- [ ] Return restores availability; a damaged return creates a pending condition check

**Verification:** `php artisan test --filter=VehicleBorrowingLifecycleTest`; `npm run build`.

**Dependencies:** T19 · **Files:** `VehicleBorrowingController`, `FC` (status), `views/Borrowing.jsx`, `docs/diagrams/vms-state-transitions.drawio` · **Scope:** M

### T21: Cannibalization donors are only vehicles no longer in use
**Description:** Flip the donor rule: donors must be Inactive or Decommissioned, in the same barangay. Update `assertDonorEligible` (TC:1877), `/tickets/lookups` donor list (TC:183), `DonorVehiclePicker` (WS:15164), the propose/new-ticket filters (WS:12381, 12855) and the maintenance-record "Source Vehicle" (WS:10296).

**Acceptance criteria:**
- [ ] Every donor dropdown lists only Inactive/Decommissioned vehicles
- [ ] Server rejects an Available or Under Maintenance donor with "Donor must be a vehicle no longer in use (Inactive or Decommissioned)"

**Verification:** `php artisan test --filter=Cannibalization` (update `CannibalizationRecordTest`, `DonorPartsCrudTest`); `npm run build`.

**Dependencies:** None · **Files:** TC, WS, tests · **Scope:** S

### T22: Vehicle Category moved under Maintenance
**Description:** Rename "Vehicle Types" to "Vehicle Category" everywhere in the UI (ambulance, fire truck, …) and move the sidebar entry from Fleet & Assets to the Maintenance group.

**Acceptance criteria:**
- [ ] Sidebar shows "Vehicle Category" under Maintenance; no "Vehicle Type" label left in UI
- [ ] Routes `/categories*` still work

**Verification:** `npm run build`; `grep -rn "Vehicle Type" frontend-spa/src` clean.

**Dependencies:** T11 · **Files:** WS (`modulesByRole` ~71, category pages ~3232, labels) · **Scope:** XS–S

## Checkpoint C: Vehicles
- [ ] Full suite green, build + lint clean
- [ ] Borrow → approve → release → return works; Available Vehicles updates
- [ ] Review with human before proceeding

---

## Phase 4: Maintenance and tickets

### T23: Maintenance Personnel performs condition checks; Custodian verifies
**Description:** `condition.create/edit` → Maintenance Personnel. New `condition.verify` → Custodian, with `verified_by`/`verified_at` on `vehicle_condition_checks`. Checks show Pending Verification until the Custodian verifies. MP can see condition checks.

**Acceptance criteria:**
- [ ] MP creates a check; Custodian can't create but can verify
- [ ] Unverified checks are labelled; verified shows who and when

**Verification:** `php artisan test --filter=ConditionCheckRolesTest` (update existing condition tests); `npm run build`.

**Dependencies:** None · **Files:** `permissions.php`, migration, `FC` (`storeCondition` 1387, list 1370), WS (`conditionColumns` 8304, sidebar), tests · **Scope:** M

### T24: Ticket proposed from a condition check is auto-filled
**Description:** A verified "Needs Repair" check gets a "Propose Ticket" action that pre-fills vehicle, description (from observations), priority and a work item per finding. The Custodian reviews and submits without retyping; Admin approves as usual. Condition check findings become structured (checklist of items with pass/fail + note) so they can map to work items.

**Acceptance criteria:**
- [ ] Proposing from a check opens a filled form; submitting needs no extra typing
- [ ] Ticket links back to the check; check shows the ticket number

**Verification:** `php artisan test --filter=ProposeFromConditionCheckTest`; `npm run build`; manual.

**Dependencies:** T23 · **Files:** migration (findings items), `FC`, TC (`proposeTicket` 512), WS (`ProposeTicketPage` 12700, condition actions 1328) · **Scope:** M

### T25: Merge Maintenance Schedule and Condition Monitoring
**Description:** **Depends on Open Question 5.** One "Maintenance & Condition" page: upcoming schedules and condition checks in one list/calendar; performing a scheduled maintenance includes the condition check. Remove the separate Condition Monitoring sidebar entry.

**Acceptance criteria:**
- [ ] One sidebar entry; both schedules and checks reachable from it
- [ ] Completing a scheduled maintenance records a condition check

**Verification:** `php artisan test --filter=Schedule` + condition tests; `npm run build`; manual for MP and Custodian.

**Dependencies:** T23, T24, Open Question 5 · **Files:** WS (schedule module 3891, condition module 3521, sidebar) → extract to `views/maintenance/`, `FC@completeSchedule` 3050 · **Scope:** L, so split into page merge and complete-with-check

### T26: External shop flow: Pending → Approved → Tested → Verified → Closed
**Description:** Make the external path explicit: after the vehicle returns from the shop, the **Maintenance Personnel** (not Admin) records the test result (pass/fail), then Custodian verifies, then Closed. Fail sends it back to the shop. Show these labels on the ticket. Update `authorizeWorkOrderActor` (TC:1965) and `logRepairs` for external work items.

**Acceptance criteria:**
- [ ] External ticket displays Pending → Approved → Tested → Verified → Closed in order
- [ ] Only MP can record the test; only Custodian can verify; failed test returns it to "at shop"

**Verification:** `php artisan test --filter=ExternalShopTicketTest` (update); `npm run build`; manual.

**Dependencies:** None · **Files:** TC (`markExternalReturned` 2030, `logRepairs` 2062, 1965), WS (`TicketDetailPanel` ~11515), tests, state diagram page 2 · **Scope:** M

### T27: Return a ticket
**Description:** **Depends on Open Question 6.** Likely: Maintenance Personnel can return an assigned ticket to Admin with a reason (e.g. needs external shop, parts unavailable); Admin reassigns or converts to external. Rename "Request corrections" to "Return to Custodian" for consistency.

**Acceptance criteria:**
- [ ] Return requires a reason and notifies the receiver
- [ ] Returned ticket shows its return history

**Verification:** `php artisan test --filter=ReturnTicketTest`; `npm run build`.

**Dependencies:** Open Question 6 · **Files:** TC, `routes/api.php`, `permissions.php`, WS ticket actions, state diagram · **Scope:** M

### T28: "Assigned To" shows names
**Description:** Replace avatar chips with plain names ("Juan Dela Cruz (Custodian), Pedro Santos") in the ticket list (WS:15599) and schedule list (WS:9346).

**Acceptance criteria:**
- [ ] Names visible without hovering; "Not assigned" when empty

**Verification:** `npm run build`; manual.

**Dependencies:** None · **Files:** WS (`TicketPersonnelAvatars` 14278 usage, 9346) · **Scope:** XS

## Checkpoint D: Workflows
- [ ] Full suite green, build + lint clean
- [ ] MP condition check → Custodian verifies → auto-filled ticket → Admin approves → repair → verify → Closed
- [ ] External shop ticket follows the 5-state flow
- [ ] Review with human before proceeding

---

## Phase 5: Deliverables

### T29: Finalize state transition diagram
**Description:** Update `docs/diagrams/vms-state-transitions.drawio` (draft has Ticket, External Shop, Vehicle, Issue Report, Schedule) for the changes in T20, T23, T26 and T27, and add Borrowing and Condition Check pages. Export PNG/PDF for submission.

**Acceptance criteria:**
- [ ] Every status and transition in code appears in the diagram, labelled with role and action
- [ ] PNG/PDF exported to `docs/diagrams/`

**Verification:** Cross-check against status constants in `FC`/TC and the tests.

**Dependencies:** T20, T23, T26, T27 · **Files:** `docs/diagrams/*` · **Scope:** S

### T30: Documentation and UI screenshots
**Description:** Update the user manual for each role (LGU/Super Admin, Admin, Custodian, Maintenance Personnel) with the new flows, and capture screenshots of every page (scripted with the browser tool against seeded demo data so they can be re-taken). Update `ROLE-AUDIT.md`.

**Acceptance criteria:**
- [ ] Manual covers every sidebar page per role with a screenshot
- [ ] Screenshots saved in `docs/screenshots/<role>/`

**Verification:** Manual review by human/adviser.

**Dependencies:** Phase 1–4 complete · **Files:** `docs/`, `ROLE-AUDIT.md`, `README.md` · **Scope:** M

## Checkpoint E: Complete
- [ ] `php artisan test` green, `npm run build` + `npm run lint` clean
- [ ] Every feedback item in the plan's map checked off
- [ ] Reviewed with human / adviser
