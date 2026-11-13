# Barangay VMS — Full System Capabilities Reference

Updated **1 November 2026** after the panel redefense feedback. Read [Redefense-Changes-2026-11-01.md](Redefense-Changes-2026-11-01.md) first: it supersedes anything below that conflicts with it (no public registration, local-only storage, Maintenance Personnel tests repairs, merged Condition Monitoring, View Vehicles sub-pages). Older notes: [28 October](Current-Revision-2026-10-28.md), [25 October](Current-Revision-2026-10-25.md).

A complete, code-verified catalog of everything the system can do today, organized by module. Every capability listed here was confirmed directly against the current codebase (not assumed) — where something is partially built, unused, or a known gap, it's flagged explicitly rather than glossed over. See `Documentation.md` in this folder for the shorter architectural overview; this document goes deep on every feature.

**Audit baseline:** the 24 October report records findings at `0027023`. See [current disposition](Current-Revision-2026-10-25.md#audit-disposition) before treating those findings as current or resolved.

---

## 1. Roles

| Role | Scope | One-line summary |
|---|---|---|
| **Admin** | One Barangay (exactly one Admin per barangay) | Manage → Approve → Assign → Monitor. Runs the fleet; does **not** report issues, create tickets directly, **register vehicles**, or verify/close tickets. Creates the barangay's Custodian and Maintenance accounts (the system emails each a temporary password). |
| **Custodian** | One Barangay | Check → Request repair → Verify. The **only** role that registers vehicles and records condition checks, and the one who creates a repair request (a ticket proposal). Records the hand-over and return of external-shop work. **Verifies** finished repairs (Verified by) and closes the ticket; does not test the vehicle. |
| **Maintenance Personnel** | One Barangay | Repair → Test → Submit. Repairs assigned work, **tests the vehicle after the work (also after it returns from an outside shop)**, can mark "No repair needed", records parts and evidence, completes assigned schedules, and can view every vehicle in the barangay. **Cannot report an issue** or create a ticket. |
| **Super Admin** (the LGU) | Platform-wide | Creates barangays and each barangay's one Admin (system-emailed temporary password), resends credentials, manages accounts, concern reports and the platform log. **No access to fleet data** (vehicles, tickets, issues); enforced server-side, not just hidden in the UI. |

An account holds **exactly one** of the three barangay roles (the `user_roles` table allows one row and the API rejects a second role). Older accounts created before 28 October may still carry two roles; they keep working until an Admin edits them, and the self-verification guard (§5.4) still accounts for them. Permissions come from `backend-api/config/permissions.php`.

The sidebar is flat and simple. Admin: Dashboard; Fleet (**View Vehicles** with **Ready to Respond** and **Not Ready to Respond** dropping down under it, Vehicle Location); Operations (Maintenance Tickets, **Condition Monitoring**, Maintenance Records); Administration (Users, Reports, Activity Log); Reference (Vehicle Categories, Vehicle History). Custodian: Dashboard; Fleet (same as Admin); Work (Condition Monitoring, My Tasks, Maintenance Records); Reference (Vehicle Categories, Vehicle History). Maintenance Personnel: Dashboard; Fleet (View Vehicles and its two sub-pages); Work (My Work Orders, Maintenance Schedule, Maintenance Records). Super Admin: Dashboard, Barangay Management, Users, Activity Log, Support Center.

---

## 2. Accounts & Onboarding

There is **no public registration** (removed 1 November 2026, because the system is handed over to the LGU). Accounts are created from the top down:

1. The **Super Admin** (the LGU) adds a barangay (Barangay Management → Add Barangay), then clicks **Create Admin** with the Admin's name, email and optional phone. A barangay can have **exactly one Admin**; a second is refused with a clear message.
2. The **Admin** creates the barangay's Custodian and Maintenance Personnel accounts (Users → Add User). One role per account; the barangay is always the Admin's own.
3. **Nobody types a password for someone else.** The server generates a random 10-character temporary password (no look-alike characters), stores only its hash, and **emails it** to the new user. The creator sees it **once** on screen as a fallback; if the email fails, the dialog says so and the password can be handed over in person.
4. The temporary password **expires after 72 hours**. An expired one cannot sign in and the login says so ("ask your administrator to send you a new one").
5. At first sign-in the user must choose their own password; until then the API refuses everything except `GET /user`, `POST /logout` and `PUT /profile/password` (impersonation sessions are exempt).
6. **Resend credentials** (a mail icon on the Users page for the Admin, a key icon for the Super Admin) replaces a lost or expired password with a new emailed temporary one and signs the person out everywhere. An Admin can resend only for their own staff, never for another Admin (the Super Admin does that).

Removed with registration: the Staff Registration Code, the Pending Approvals queue, the applicant valid-ID and photo upload, approve/reject of registrations, and the staff-code email. The database no longer has the `registration_settings` table or the staff-code and applicant-document columns.

Barangay data stays separate. Every vehicle, ticket and user belongs to one barangay, and each role sees only its own barangay. The Super Admin sees barangays and accounts, never a barangay's fleet.

---

## 3. Vehicle & Fleet Management

### 3.1 Vehicle Management

**Registration** is the **Custodian's** duty only (changed 1 November 2026): an Admin can no longer add or import vehicles, but still edits, archives and decommissions them. The form is a 3-step wizard:
1. **Basic Information** — Land/Water domain (asked first, drives the rest of the form), Vehicle Name, Plate Number (labeled "Registration/Hull No." for Water), Vehicle Category (a creatable dropdown — a new category can be added inline without leaving the form).
2. **Specs** — Brand, Model, Year, Capacity (with unit — kg/tons/L/pax for Land, L/gal/m³/pax for Water), Acquisition Cost (optional — feeds the Reliability card's decommission signal, §9.7), Color, Fuel Type; Water vehicles additionally require Hull Material (Fiberglass/Aluminum/Steel/Wood/Rubber-Inflatable) and Engine Type. Any **custom fields** an Admin defined for the chosen Vehicle Category (§3.2) appear at the end of this step and are validated server-side.
3. **Photo & Location** — an optional photo (JPG, PNG or WEBP, up to 5 MB) beside the vehicle's file cabinet, then Current Location (tied into the hub system, with a live map preview below it as you pick/create a hub), and optional Remarks.

New vehicles start at status **Available**, condition **Good** (and read Good in Condition Monitoring). Custodians and Maintenance Personnel see **every vehicle in their barangay** in View Vehicles. Registration has no document upload — documents are added from the vehicle's own profile (§3.4).

**Vehicle imports (API only)**: The Vehicles toolbar's spreadsheet-import button and its unused dialog were removed on 25 October 2026. Add Vehicle remains the registration action in the UI. The existing Custodian import API, templates, preview/commit validation and audit records remain available; Maintenance Personnel cannot import. Import requests retain server-side role, barangay, file and duplicate-plate checks.

**Operational criticality** (Critical / High / Normal): each Vehicle Category has a default; an Admin can override it per vehicle (or choose *Inherit* to return to the default). A Custodian cannot set it at registration. It ranks the readiness watch (§9).

**Editing** (Admin only) reuses the same field set; blanking an optional custom field clears its stored value. Changing Current Location through the edit form also writes a location-history record automatically, same as the dedicated "set location" flow.

**Archiving** ("Deactivate" in the UI) sets a vehicle Inactive; **Decommissioning** is a documented end-of-life retirement requiring a written reason, setting it Decommissioned/Needs Repair. Both are blocked while the vehicle has any open (non-Closed/Cancelled) ticket. **Restoring** (from either Inactive or Decommissioned) brings a vehicle back to Available/Good and clears the archive/decommission fields; the same action is relabeled "Recommission" when shown for a Decommissioned vehicle.

**Statuses**: Available, Under Maintenance, Inactive, Decommissioned. Status is mostly system-driven: a failed condition check, an active issue report, or an active ticket automatically flips a vehicle between Available and Under Maintenance. Admin/Custodian can also force a vehicle back to Available via a readiness-check shortcut even with a lingering repair flag — deliberate, since physical readiness and an outstanding paperwork flag are tracked independently.

**Conditions**: Good and Needs Repair — driven by issue reports, condition checks, or a ticket moving into maintenance. A retired vehicle (Inactive/Decommissioned) is explicitly protected from having any of this un-retire it.

**View Vehicles and its sub-pages** (1 November 2026). The parent page lists the vehicles with only the columns a reader needs: ID, Vehicle (name only, no photo), Plate Number, Category, Location, Status and Ready to Respond. Photos appear only on the vehicle's own profile. Two sub-pages drop down under it in the sidebar: **Ready to Respond** (vehicles that are ready now) and **Not Ready to Respond**, which adds **Reason Not Ready** (open repair, failed or expired readiness check, a missing part, never confirmed), **Last Maintained** (the date maintenance work was last *finished*, not the last readiness check) and **Missing Parts**. Filters are limited to Category, Location and (parent page) Status. Retired vehicles are excluded from both sub-pages.

**Vehicle Profile page** is a single dashboard-style layout (not tabs): a vehicle identity header with role-gated actions; Vehicle Information; an at-a-glance Operational Status section (availability, condition, readiness, criticality, active ticket, current location and key dates); a single-pin location map; and a Files card alongside the overview (documents, §3.4). The Reliability card is not shown on the profile. Authorized users can record a Parts Transfer from the profile action bar; the transfer-history card is not shown on the profile. The profile has no embedded Reports card; report generation remains available through the separate Reports module and its existing functionality. Header actions remain role-gated: Edit — Admin; Readiness Check — Custodian; **Request Custodian Inspection** — Admin, which notifies the Custodians to inspect without opening an issue or ticket on their behalf; Decommission/Recommission — Admin.

### 3.2 Vehicle Categories

A Vehicle Category (called Vehicle Type before the redefense; the database already used "category") captures a unique name, a Domain (Land/Water, required), a **default operational criticality** (Critical/High/Normal), and an optional description. It can also carry Admin-defined **custom fields** — field name, type (Text, Number, Dropdown, Date, Yes/No), required or not, an optional unit, dropdown options and display order — supported by the existing data model and API. The Custom Fields management section is removed from Edit Vehicle Category on `ui/custom-fields-layout`; stored values and vehicle/import handling remain. Fields are **archived, never deleted**: an archived field stops being asked for, but vehicles keep the values they hold (and the profile still shows them); a field's type is fixed once created so stored values stay valid. Values are stored per vehicle and validated server-side on add, edit and import. Admin has full CRUD; a **Custodian can view the list and add a category** (edit and delete stay Admin-only; Maintenance Personnel have no page); deletion is blocked while any vehicle (in any barangay) still references the type. Domain is what makes a vehicle "Water" for every Hull Material/Engine Type requirement elsewhere in the system, and it also relabels fields (Plate Number → "Registration/Hull No.") and changes the capacity-unit choices offered.

### 3.3 Vehicle Location

One module, two tabs:

- **Vehicles Map** — a Leaflet map of named, lat/lng-pinned **hubs** shared barangay-wide, with vehicles grouped onto the hub matching their `current_location`. Features: a normal street map only (the satellite view and the Map/Satellite toggle were removed on 1 November 2026), a service-area boundary overlay (the barangay boundary on file; a missing outline is not replaced with an invented service boundary), Add Hub (opens the add-location form with click-to-pin, a **draggable pin**, a **Use my location** button that only accepts a GPS reading accurate to 30 m or better, and a reverse-geocoded address; a pin outside the barangay boundary is refused; Admin **and Custodian**), Remove Hub (default hubs can only be hidden/restored, custom hubs can be truly deleted if no vehicle points at them), focus-on-a-specific-vehicle flyto, fullscreen mode (the on-map barangay label and the "By Coordinates" button were removed), and **Download Map** — captures the live map (tiles, pins, boundary) to a PNG file, excluding UI chrome from the image.
- **Vehicle Location Record** — a plain tabular history of every recorded location change, filterable by status/location, searchable, with its own Add/Edit flow (Admin and Custodian; hub delete, hide and Restore Hubs stay Admin-only).

### 3.4 Vehicle Documents

A per-vehicle file cabinet, separate from the vehicle's cover photo — Title (required), Category (free text), File (jpg/jpeg/png/pdf/doc/docx, ≤10MB). Admin can manage any document; Custodian can upload and edit only documents **they personally uploaded**; delete is Admin-only. **Maintenance Personnel can view documents and upload repair evidence** (they edit only their own uploads; they cannot delete — a 2026-10-06 spec decision that reversed the earlier no-access rule). Documents live **only in the vehicle profile** — a compact card expandable into a full table; the separate cross-vehicle "Vehicle Documents" sidebar page was removed.

### 3.5 Vehicle History

A fully automatic, derived activity timeline — there is no manual "add a history entry." The backend writes an entry on nearly every vehicle-affecting action: added, info updated, location changed, archived, restored, decommissioned, readiness checked (pass/fail), marked available, condition checked/updated/deleted, issue reported/updated, document added, spreadsheet import, and — closed as a gap in the final senior system review (2026-10-10), since these are arguably the biggest status/condition drivers in the system — a ticket being approved, inspected, closed, cancelled, or restored. Viewable with activity-type and date-range filters, free-text search, a list presentation, CSV export, and print — available to Admin and Custodian.

### 3.6 Condition Monitoring

The fleet's condition view and a Custodian's *proactive* inspection log — explicitly distinct from an Issue Report (which is reactive, "something's already wrong"). **Condition updates itself:** a new vehicle is Good; the moment a ticket exists for a vehicle (proposal: Needs Repair, approval: Needs Repair and Under Maintenance) the list shows **Needs Repair**; a verified closure returns it to service. Recorded checks use Good or Needs Repair with free-text Observations; legacy inconclusive results remain stored. A vehicle with no recorded check and a Good condition shows **Good**, not Not Checked. There is **no manual Add button** (neither in the header nor per row). A Custodian can edit only a check **they personally performed**; only Admin can delete one (which reverts the vehicle to its next-latest remaining check, or Good if none remain). A "Needs Repair" result flips the vehicle to Under Maintenance. From the list, a check can be turned directly into a ticket proposal ("Create Ticket from Condition" — pre-fills title/description/priority/sub-issue) or into a maintenance schedule for a non-urgent follow-up ("Suggest Schedule from Condition", which still waits for Admin approval — §6). Not visible to Maintenance Personnel at all — scoped out by design.

**Current design (5 November 2026).** Condition Monitoring is Custodian only: one list of vehicles, each with View, Maintenance Schedule and Condition Check actions; a Needs Repair check shows the repair form on the same page. There are no tabs and no Issue Reports pages, and the two paragraphs above and the next one describe the earlier design. (Earlier design:) **One page, three tabs (1 November 2026).** Admin and Custodian had a single **Condition Monitoring** sidebar entry whose tabs were **Inspection Schedule** (the landing tab; its button is **Add Schedule**), **Condition Checks** and **Issue Reports**. The separate Report Vehicle Issue and Maintenance Schedule sidebar entries are gone for these roles. A "Needs Repair" finding goes to **Propose Ticket**, where the Custodian chooses an in-house or external-shop repair. Routine upkeep such as an **oil change is preventive maintenance**: it is a scheduled item that is completed and logged, and it never goes through Needs Repair. Maintenance Personnel keep a Maintenance Schedule entry because they complete the scheduled work.

### 3.7 Readiness Checks

A Custodian signs off that the vehicle is ready to respond. The Maintenance Personnel does the testing; the Custodian does not have to operate the vehicle (changed 9 November 2026). A fresh readiness sign-off is still required after a repair ticket closes. The current form requires an explicit confirmation and permits notes; the former type-specific checklist remains historical data rather than the current form.

The dialog loads server eligibility. Confirmation stays disabled if eligibility cannot be retrieved. The save endpoint checks eligibility again under a vehicle lock: Under Maintenance, an Active/For Verification ticket, or retirement blocks confirmation. Rejected requests create no check. Repair closure invalidates earlier readiness evidence; independent repair verification must be followed by a fresh operation check.

A passing attestation remains fresh for **24 hours**. Availability, physical condition and readiness are separate indicators. States include ready, stale, not_ready, unchecked, in_maintenance and retired. The historical Mark Available endpoint retains open-ticket and retirement guards; it does not bypass active repairs.

---

## 4. Issue Reporting

> **Superseded (5 November 2026).** Issue Reports no longer have their own pages or a sidebar entry. The Custodian's condition check is the report, and a Needs Repair result opens the repair request directly (§3.6). The text below describes the earlier design and the data that still exists.

An Issue Report captures: vehicle, issue type (a free-text catalog that grows as new values are typed, not a fixed list), description, severity (Low/Medium/High), any number of file attachments (jpg/jpeg/png/pdf/doc/docx, 10MB each), and optional remarks.

**Who can file**: **only a Custodian** (`issue.create`). An Admin cannot (they request a Custodian inspection from the vehicle profile instead, §3.1) and **Maintenance Personnel cannot** (the API returns 403; they have no Issue Reports page and work from the ticket and sub-issue assigned to them). The `issue.recommend_ticket` ability and endpoint still exist in the code but have no user entry point. Filing a report sets the vehicle's condition to "Needs Repair" and notifies that barangay's Admins.

When a Custodian later proposes a ticket for that vehicle, the proposal form first asks whether the repair is for one of the vehicle's open reports (§5.1). After submitting, the system lands directly on that report's own detail page — not back on a list — with a **Create Maintenance Ticket** action right there for whoever holds that permission (Custodian).

**Statuses**: Pending → Under Review → In Maintenance → Resolved, kept in lockstep with the vehicle's own status/condition. A Custodian may edit or delete **their own** report only while it's still Pending. **Dismissal** (Admin only, requires a reason) is only available before a ticket exists for the report, and deliberately does not touch the vehicle's status, since nothing about the vehicle itself changed.

**No auto-escalation exists** — a filed report with nobody acting on it just sits there indefinitely; there's no timer or automatic conversion to a ticket. Downstream of a ticket, a linked report follows the ticket: declining the proposal puts it back to Pending, and the Custodian's verification closing the ticket marks it Resolved. (Per-sub-issue Deferral, which used to reopen a linked report as a reminder breadcrumb, is no longer reachable — no role holds `subissue.defer` since the 2026-10-07 workflow simplification.)

**Duplicate-report aid**: before filing, the form checks for any other currently-open report on the same vehicle and shows a non-blocking warning (never forces a merge — left to human judgment).

---

## 5. Maintenance Ticket Workflow

This is the heart of the system. **Every ticket enters as a `Pending Approval` proposal that an Admin must review and approve before it's live** — there is no reachable "Admin creates directly" path (the direct-create endpoint exists in code but is permanently unreachable by permission design, kept only as documentation of the shared business rules). A proposal has exactly two sources: a **human** Custodian proposing one by hand, or the **system** auto-proposing one from a Maintenance Schedule whose date has arrived (§6) — either way, it's the same `Pending Approval` → Admin-reviews → `Active` pipeline, never a bypass.

### 5.1 Creating a proposal (Custodian only)

Required on every proposal: vehicle, priority, and **at least one sub-issue**; the Details field records the work scope where applicable — there's no "diagnose later" mode for a proposal, since the Custodian has already seen the vehicle and Admin's review is the check that stands in for a separate inspection step. There is no separate title field: the system composes the ticket's stored title itself (`MT-0010 — <Vehicle> — <Issue>`, using the first sub-issue's title as the issue summary, which duplicate and recurrence checks match on) the moment the proposal is created — any title sent by the client is ignored. **Screens show the title without the sub-issue** (`display_title`, e.g. `MT-0010 — Fire Truck Uno`); ticket lists also show a **Repair Type** column (Maintenance Schedule / In-House Repair / External Shop / In-House + External). Optionally linked to an Issue Report and/or a Condition Check (each validated to belong to the same vehicle and not already claimed elsewhere). **Open-report step:** when the chosen vehicle has open Issue Reports (Pending / Under Review) the form shows only a centered card until the user answers "Is this repair for one of them?" — pick a report, or "None of these — this is something new"; reports already held by another open ticket (directly or via a sub-issue) are greyed out as "Already linked to Ticket #N" (`GET /vehicles/{id}/open-issues` returns `reserved_by_ticket`). Validation messages appear as a centered overlay.

Three repair-path modes, chosen once per ticket and stamped onto every sub-issue:
- **In-house** — no extra fields beyond the sub-issue basics.
- **Cannibalized** — requires a first donor vehicle (different vehicle, same barangay, not retired) plus, per sub-issue, what's missing and what part is being pulled from the donor; more donors can be added later on the repair page (§5.3).
- **External** — requires a reason from a fixed, objective-and-Admin-checkable list (warranty coverage; parts/service only at an authorized shop; needs specialized shop equipment; requires licensed/certified service; mechanic recommended it) and a work-scope description; optionally vendor, shop contact, who sent it, contact person, and estimated cost.

Each sub-issue also carries a free-text maintenance-type (another growing catalog) and an optional **suggested mechanic** — informational only; it doesn't dispatch anything or notify anyone. The Admin assigns a mechanic to each in-house work item at approval (§5.2).

**Duplicate-ticket prevention**: titles are normalized (an auto-added "[Issue #N]" prefix stripped, case/whitespace-insensitive) and checked against current proposals and live tickets on the same vehicle (final Declined, Cancelled and Closed tickets are excluded), re-checked again under a row lock at the moment of creation so two concurrent proposals can't both slip through.

**Recurrence detection**: looks back 90 days on the same vehicle for a matching closed ticket or completed maintenance record (by maintenance type, then issue type, then title). A match stamps a recurrence count on the new ticket and sends all barangay Admins a "Recurring Fault Detected" notification naming the occurrence number and explicitly suggesting a deeper fix or a decommission review. A standalone check endpoint lets the UI show this *before* a proposal is even submitted.

### 5.2 Admin review (Admin only)

Can edit description, priority, assigned custodian, and per-sub-issue title/maintenance-type/suggested-mechanic before deciding.

**On approve**: requires an assigned mechanic for each in-house sub-issue; a ticket-level `assigned_mechanic_id` can supply a fallback. Status becomes Active; the vehicle goes Needs Repair/Under Maintenance; every sub-issue goes Under Repair under its assigned mechanic; the proposing Custodian and the mechanic are notified. The ticket's title was finalized at proposal or correction-resubmission time (§5.1) and is never touched here; duplicate and recurrence matching compare the issue part of it only. At least one sub-issue must exist, and the vehicle must not have gone Inactive/Decommissioned since the proposal was filed.

**Request Corrections**: Admin gives a required reason. The proposal stays Pending Approval with a visible Corrections requested flag; approval is blocked. Only its assigned Custodian can edit the existing work-item titles/types, details, priority and external reason/scope, then resubmit the same ticket for fresh Admin review. Vehicle, repair method and work-item identity remain fixed. The original proposal and review reasons remain in decision history. Admin can final-decline the proposal while corrections are pending.

**On decline**: requires a reason and preserves the proposal as Declined, notifies the Custodian and releases its report reservation if no other current ticket owns it. Decline is not a statement that the physical defect is fixed. A final decline does not block a new proposal for the same fault. **Undecline** returns it to Pending Approval, never directly to Active; Admin must approve separately. Reconsideration is refused if another live ticket owns the source or covers the same work, or the source is no longer open.

**Decision integrity**: decision actions freshly lock the vehicle, ticket and work items before checking eligibility. Browser decisions include the reviewed revision; stale revisions return a conflict and refresh the record. Legacy API callers without a revision still receive fresh-state checks. Decision history records who acted, when and why. Issue-report links select the current non-declined/non-cancelled ticket rather than an older rejected proposal.

### 5.3 Assignment & repair

**One assigned mechanic per in-house sub-issue.** Admin selects each mechanic beside Repair Type during proposal review. Different mechanics may work on one ticket. Admin can reassign selected unfinished in-house items while Active, with a reason; submitted work is preserved and must first be returned for rework before its assignment changes. The new and outgoing mechanics are notified. Prior actors and work events remain in the item history. Custodian reassignment moves verification responsibility; warnings include previous mechanics.

While the ticket is Active, only an Admin can add, edit or delete sub-issues through the API (`subissue.manage`). Custodians cannot edit or cancel an active ticket. Edit/delete only applies to a sub-issue that is still Open or Under Repair, and the last remaining sub-issue can never be deleted (cancel the ticket instead). An added sub-issue inherits a shared ticket mechanic, or requires an explicit active mechanic when assignments are split. Maintenance Personnel cannot. The ticket page itself no longer offers "Add sub-issue" on an Active ticket — new problems go in a new proposal.

The assigned mechanic logs repair notes (append-only, never overwritten), parts used, cost and evidence files on the **Record Repair Work** page (sections: Work Order Overview, Repair Details; Submit Repair Log and Cancel at the bottom left). The two methods are **Standard Repair** (own mechanic, bought or on-hand parts) and **Uses Parts From Another Vehicle** (cannibalization), chosen with radio buttons. Submitted files appear on the ticket as a **View attachments (N)** chip on the sub-issue and an "Attached Files" list in its details. Repair submission records its time and completion date automatically; verification and closure keep separate timestamps. Supported historical API dates cannot be in the future or finish before the repair starts. Parts/materials contribute to the in-house total (there is no separate labor/service cost field any more).

**Cannibalized repair (no approval step).** The mechanic picks a donor vehicle (a different vehicle, same barangay) and can **Add Donor Vehicle** for more (vehicles already used are greyed out as "already selected"; a donor is saved with its first part). Each donor has its own block and manages its parts as a list — add, edit, delete — each with part name, quantity (whole number ≥ 1), condition, installed date (not in the future), reason and notes. Parts and the donor are saved immediately, so they survive a reload, and can only be changed by the assigned mechanic while the work order is Under Repair; after the repair is logged they are locked history. A cannibalized repair needs at least one donor part to be submitted. Submitting goes straight to the Custodian (no Admin approval); Admins receive a single notification naming every donor, and the ticket shows "Donors: A, B". Since 10 November 2026 no Issue Report is filed on the donor and its condition is not changed: the parts appear as missing on the donor's profile, and only a part it cannot respond without keeps it Not Ready. Each part also records "can the vehicle still respond without it?". Each part stores its `donor_vehicle_id` (older parts were backfilled to the original donor). Donor parts never add to the maintenance cost. Older single-part data was migrated into the `ticket_sub_issue_donor_parts` table.

**External-shop repair.** Approved external work has no in-house mechanic. The Admin only approves the proposal; it never handles the shop. The ticket's own Custodian records sending the vehicle to the shop and its return. **After the return, a Maintenance Personnel tests the vehicle and submits it** (changed 1 November 2026; the Custodian no longer tests or submits it). Such shop work waiting for a test appears in the Maintenance Personnel's My Work Orders. The server refuses completion without both shop events and the mechanic's test. Reviewed details prefill the send form. Rejected work can be sent again, preserving earlier shop cycles, handlers, notes and costs. The ticket's Custodian receives a rework notification and logs the new shop visit. Every closed external item creates a linked maintenance-ledger entry with its shop and cumulative recorded invoice costs; unknown cost stays unknown and a recorded zero stays zero. Repair-log payloads cannot override the recorded shop, warranty or invoice total. Switching between in-house and external requires a new Admin-reviewed proposal.

**Mechanic test and "No repair needed" (1 November 2026).** Submitting a repair log requires the Maintenance Personnel to tick **"I tested the vehicle after the work and it is working"** (the API rejects a log without it) and may add test notes; the test time, tester and notes are stored on the sub-issue. If the mechanic inspects the vehicle and finds nothing to fix, they use **No repair needed** with a required reason (at least five characters). The item goes to For Inspection, the Admin is notified, the ticket moves to the Custodian to verify and close, and **no maintenance record is written** because nothing was maintained. A returned shop job cannot use this shortcut.

**Cannibalization (10 November 2026).** Parts taken off a vehicle are logged on the repair ticket (Record Repair Work, "Uses Parts From Another Vehicle"). It is not an inventory: nothing is counted in a warehouse. There is no separate Cannibalization page and no Admin approval.

- **Donors are retired vehicles only.** The donor list shows only vehicles that are no longer in use (decommissioned); a vehicle still in service cannot be a donor, and the server refuses it when a ticket is proposed, a donor is chosen or the repair is logged. If there is no retired vehicle, the picker says to decommission one first.
- Each part records the donor vehicle, the part (chosen from one add-able list with edit and delete, so it is always spelled the same way) and the quantity.
- **Duplicate check:** the same part cannot be logged again for the same vehicle while it is still missing (any capitalisation or spacing).
- A retired donor is already out of the fleet, so its parts never hold anything up and there is nothing to put back. No Issue Report is opened on the donor and its condition is not changed; the parts show on the donor's profile.
- **Older data:** parts logged before this change from vehicles still in service keep working. They show on the donor's profile with "Blocks readiness" or "Minor" badges, "Mark as minor / Mark as blocking" and "Put back"; only a part marked as blocking keeps that vehicle Not Ready.
- The server still has a standalone `POST /cannibalizations` endpoint and the flag endpoints, but no screen uses them.

## 5.4 Handoff & Custodian verification

Lifecycle: **Pending Approval → (Admin approves) Active → For Verification → (Custodian approves) Closed**, or **(Custodian returns) → Active** again for rework.

**Automatic handoff.** When the mechanic logs the last outstanding repair — — the ticket moves to **For Verification** on its own, and the assigned Custodian gets exactly one **"Repair Ready for Verification"** notification that opens the ticket. Logging a repair while other sub-issues are still unlogged does not notify the Custodian. The mechanic's manual "Submit for Verification" endpoint still exists as a fallback; on a ticket already For Verification it is a no-op and sends no duplicate notice. The Custodian's sidebar **My Tasks** badge counts the tickets For Verification assigned to them, and the **Tickets Ready to Close** panel (tickets For Verification assigned to that Custodian) now lives at the top of the Custodian's verification page — the Admin tickets page no longer has it. Verification is a popup with Approve / Disapprove (a reason is required to disapprove); closing a ticket notifies the Admin.

**Verify (Custodian only - Admin is never a fallback verifier).** The assigned Custodian selects Approve or Disapprove. The Maintenance Personnel has already tested the vehicle (§5.3), so the Custodian's approval is a **"Verified by" confirmation** that they verify the repairs; they do not test the vehicle themselves (changed 1 November 2026). The API still requires the verdict and the attestation flag, and rejects any supplied failing check. The dialog keeps the functional checklist optional. Two outcomes:

- **Approve Repair** - records the explicit verdict and personal-test attestation, finalizes every work item, creates its linked maintenance record (including external work), resolves linked reports, completes a linked schedule and seeds its recurrence, archives the ticket, recomputes vehicle availability, and notifies participants. Closure does not itself create a fresh readiness check.
- **Return for Repair** - the dialog requires selecting the failed items and giving a reason. Only those items return to Under Repair; other submitted repairs stay submitted. The ticket becomes Active until the failed work is resubmitted, then returns automatically for final verification. Responsible mechanics (or, for shop work, the ticket's Custodian who logs the next shop visit) are notified. Earlier evidence and work events remain available. Legacy API rejection payloads omitting item IDs retain whole-ticket rejection behavior.

**Who may verify — enforced by the server for both outcomes:**
- only an account holding `ticket.verify` (Custodian role);
- only **exactly the ticket's assigned Custodian** — another Custodian, an Admin or a mechanic gets 403. If that Custodian is unavailable, Admin reassigns the ticket's Custodian (§5.3) and the verification moves with it; the previous Custodian loses access;
- **self-verification is blocked for mechanics**: the current mechanic and every mechanic ever assigned to the ticket (`prior_mechanic_ids`) can never verify it. The Custodian who logged the external-shop send and return is not barred: they receive the vehicle, test it and close the ticket.

There is **no Admin confirm step** any more: the Custodian's approval closes the ticket. The legacy per-sub-issue verify/confirm endpoints (`subissue.verify`, `subissue.confirm`) remain in code but no role holds those abilities since the 2026-10-07 workflow simplification. `subissue.reopen_confirmed` is still Admin-held but needs an Active ticket with a Done sub-issue, which this flow no longer produces.

### 5.5 Deferral & closing

**A ticket closes only through the assigned Custodian's verification (§5.4).** Manual close and decision-close are unreachable (`ticket.close` is held by no role), and so is per-sub-issue deferral (`subissue.defer`); their code paths remain for reference. **A Closed ticket is permanently locked** — no more sub-issues, no reopening, ever.

### 5.6 Cancellation, deletion, archiving

Cancel/Uncancel is Admin-only. Cancellation requires a written reason, retains work evidence and notifies the assigned Custodian, mechanics and external handlers. It is available only for unfinished approved work, not Closed tickets or unapproved proposals. A vehicle still at an external shop must be recorded returned before cancellation. Restoring checks retirement, duplicate work and source ownership again. It restores fully submitted work directly to For Verification and sends one fresh Custodian task; otherwise it returns unfinished work to Active (historical uninspected tickets remain Open). Cancellation reasons remain in decision history after restoration.

Permanent deletion is limited to untouched mistakes. Repair notes, recorded dates, parts, cost (including zero), attachments, donor-part records, shop events or work history block deletion; use cancellation instead. Closed work is permanently locked. Historical Deleted archives created by earlier versions remain recoverable under source/duplicate checks; Closed archives can never be reopened. These rules preserve availability, condition and verified readiness as separate indicators.

---

## 6. Maintenance Schedules

Shown as the **Inspection Schedule** tab of Condition Monitoring for Admin and Custodian (button: **Add Schedule**), and as the Maintenance Schedule page for Maintenance Personnel. Cancelling a schedule shows an **Undo** banner for 10 seconds.

Once a linked ticket is Active, For Verification, Closed or Cancelled, its schedule can no longer be edited or cancelled; the work is managed through the ticket.

Captures vehicle, maintenance type, scheduled date/time, service location, notes, an optional assignee, and an optional recurrence (any whole number of months, 1–60 — not a fixed weekly/monthly/yearly preset list).

**Conflict warnings** (never blocking, always "confirm anyway"): fire when the same vehicle already has another entry on that exact date, or when the barangay's total scheduled count for that date reaches a configurable daily-volume threshold. Pending Approval and Declined bookings count toward these warnings too.

**Approval workflow.** A Custodian **books** a schedule; it starts as **Pending Approval** and all barangay Admins are notified. An Admin then **approves** it (the booking Custodian and the assignee are notified), **declines** it with a required reason (the booking Custodian is notified), or **undeclines** a declined one back to Pending Approval (the booking Custodian is notified). Pending and Declined schedules are hidden from a pure Maintenance Personnel account — mechanics only see approved work.

**Who does what**: Custodians share schedule planning within their barangay and may edit/cancel/restore unlocked schedules; reassigning the mechanic is Admin-only; approve/decline/undecline is Admin-only; **completing is the specific Maintenance Personnel it's assigned to, and only them** — Admin has no blanket override (final senior system review, 2026-10-05, since "complete" means physically performed the work, and Admin never performs repair work in this system). An Admin who needs to hand off a stuck or unassigned schedule reassigns it to someone else first, exactly like reassigning a ticket's mechanic. (The older Custodian "suggest a schedule" endpoint remains in code but `schedule.suggest` is held by no role — a real booking replaced it.)

**Approval and history locks (2026-10-23 audit).** Changing an approved plan or restoring a cancelled plan returns it to Pending Approval. An edit cannot set Scheduled or Completed directly. Completed schedules, schedules with a resulting record, and schedules already linked to a ticket (including a proposal) are locked; further work belongs on the resulting ticket/record. Suggested and assigned mechanics must be active Maintenance Personnel in the vehicle's barangay. The calendar's assigned mechanic can only be changed by Admin after approval. Retired vehicles cannot be scheduled, approved, or completed. Schedule transitions and due-job conversion read the current row under a transaction lock to reject stale duplicate actions.

Completing a schedule creates a proof-of-work maintenance record, always at **For Verification** — a receipt or completed-work photo can still be attached as evidence, but it never substitutes for an independent Custodian check (a "receipt attached = instantly Completed" shortcut existed here previously and was removed in the final stabilization pass, 2026-10-05, since it let whoever performed the work certify it themselves). A recurring schedule auto-creates its next occurrence at completion date + interval, correctly handling month-end edge cases (a Jan 31 monthly schedule lands on Feb 28, or Feb 29 in a leap year — not an overflow into March).

A background job checks **every minute using Philippine date and scheduled service time**, automatically turning each due approved schedule into a ticket **proposal** — `Pending Approval`, exactly like a human Custodian's, titled "Preventive Maintenance - [type]" with its one sub-issue titled "Scheduled Maintenance" (the real maintenance type stays in that sub-issue's own Maintenance Type field) — so it reads as planned work, not a diagnosed defect, anywhere it shows up. Its scheduled mechanic (if any) rides along as a suggestion only. It still has to pass through the same Admin review/approve step as every other proposal (and the same duplicate-ticket check) before it becomes a live, Active ticket running the normal assign → repair → Custodian-verify pipeline (§5.4); the Custodian's approval also completes the schedule. This was previously a direct bypass straight to an Active, pre-assigned ticket — fixed in the production-readiness audit (2026-10-05) specifically because it skipped Admin review, duplicate prevention, and the mechanic-assignment ability.

---

## 7. Maintenance Records (standalone ledger)

> Records are written automatically when a Custodian verifies a ticket (one per sub-issue) and from completed schedules. Manual entry remains Admin-only, kept for legacy/historical work; it is not a standing workflow for other roles.

The unified history displays only **Completed** repairs, one row per repair, including separate repairs on the same vehicle. Sources are **In-House Repair**, **Sent to External Shop** and **Maintenance Schedule**. Scheduled origin takes precedence over repair method so categories do not overlap. Summary cards, source filters and details use the same categories; search includes source labels and date filters use completion dates.

The barangay-scoped history includes other mechanics and external shops without granting editing or verification rights. Ongoing, submitted, on-hold and reopened repairs stay in active-work and verification views. The authorized API retains these states and its personal-history filter.

Manual historical entry remains Admin-only. Standalone records require independent Custodian verification followed by Admin confirmation; ticket-generated records finalize through ticket closure. Passing standalone verification requires personal-test attestation; rejection requires notes. Manual and schedule completion dates cannot exceed the Philippine current date. Invalid requests must not create a completion record or recurrence.

---

## 8. Notifications

**The mechanism itself**: every user has an in-app notification list (latest 50), can mark one or all as read, and can delete one. Clicking a notification opens the exact ticket, issue report, or maintenance schedule it's about (not just a generic dashboard) whenever one is linked to it. Old notifications are pruned automatically by a **daily scheduled job** — a read notification is removed after 30 days, and anything (read or not) is removed after 90 days regardless.

**What triggers one, and who gets it** — every distinct event found wired to a notification across the ticket/issue/schedule workflow:

| Event | Recipient |
|---|---|
| Maintenance Personnel recommends a ticket for an issue (API only; no UI entry point) | Barangay Custodians (links to that issue) |
| Custodian books a maintenance schedule (Pending Approval) | Barangay Admins |
| Admin approves / declines / undeclines a schedule | The booking Custodian (+ the assignee, on approval) |
| Custodian proposes a ticket | Barangay Admins |
| Admin approves a proposal | The proposing Custodian + the assigned mechanic |
| Admin declines / undeclines a proposal | The assigned Custodian |
| Admin requests proposal corrections | The assigned Custodian |
| Custodian resubmits corrections | Barangay Admins |
| Admin cancels / restores a ticket | Assigned Custodian, mechanics and external handlers; fully submitted restoration sends the Custodian one verification task |
| Admin reassigns the ticket's mechanic | The new mechanic + the previous one |
| A ticket's Custodian is reassigned | The new Custodian (+ the previous one) |
| Every repair on the ticket is logged → ticket moves to For Verification | The assigned Custodian, once ("Repair Ready for Verification", opens the ticket) |
| A cannibalized repair is submitted (one notice naming every donor) | Barangay Admins |
| Custodian approves the repair → ticket closed | The mechanic ("Repair Verified & Closed") |
| Custodian returns the repair | The mechanic ("Repair Returned for Rework", with the failed checks and notes) |
| An archived ticket is reopened | The newly-assigned Custodian |
| An issue report is filed (Custodian only) | Barangay Admins |
| An issue report is dismissed | The original reporter |
| A recurring fault is detected | Barangay Admins |
| A non-Admin self-files a maintenance record | Barangay Admins |
| A maintenance record is decision-closed without verification | Barangay Custodians |
| A schedule is created/edited/reassigned/restored with an assignee | That assignee (+ the previous one, on reassignment) |
| A due schedule auto-converts into a ticket proposal | That schedule's Custodian + Barangay Admins (it still needs their review, same as a human proposal) |

---

**Emails.** Account emails are now the **credentials email** (new account or resent credentials: the temporary password, its expiry, and a Sign-in button), Super Admin messages and concern replies. They are sent through Gmail SMTP using one layout: a blue header band with the gear logo (embedded inline) and a footer reading "Barangay Vehicle Management System. All rights reserved." Sign-in buttons are hidden while `FRONTEND_URL` is localhost. If the credentials email cannot be sent, the account is still created and the creator is told, with the password shown once. The welcome, staff-code, activation, rejection and expiry emails were removed with registration.

---

## 9. Fleet Intelligence & Dashboard

All computed live on every dashboard load — there is no caching or scheduled pre-computation for these numbers:

1. **Readiness & Coverage** — per-vehicle-type counts (total / ready / verified-ready / down), flagging a vehicle category with zero ready units as having no coverage at all.
2. **Availability Forecast** (Admin) — every vehicle currently under maintenance with its expected return date, soonest first.
3. **Preventive-maintenance-due watch** — schedules due within 7 days or already overdue.
4. **Readiness watch** — vehicles that are "Available" on paper but not actually *verified* ready (stale, failed, or never-checked).
5. **Single-point-of-failure detection** — any vehicle category down to one (or zero, flagged critical) ready unit.
6. **Fleet-wide failure-pattern detection** — the last 12 months of maintenance grouped by type, surfacing a systemic recurring cause rather than isolated incidents.
7. **Per-vehicle reliability lens** — failure counts, average days out of service, lifetime repair spend, a "chronic" flag, and a decommission signal when lifetime repair spend nears acquisition cost. The calculation is available through the reliability API; the current Vehicle Profile layout hides the Reliability card (?3.1).
8. **Action Queue** (Admin) — one ranked worklist combining pending issue reports, sub-issues needing attention, tickets ready to close, readiness-check gaps, overdue schedules, and recurring-fault reviews.
9. **My Scheduled Work** (Maintenance Personnel) — that mechanic's own upcoming assigned schedules.
10. **Sole-active-Admin warning** — proactively flags an Admin if they're the only one left for their barangay, before anyone tries to deactivate/demote them (the guard itself is described in §11.2).
11. Supporting KPI tiles and charts: fleet counts by status, by type, by location, by condition; total maintenance spend; a recent-activity feed; role-tailored metric subsets (Admin gets the full operational/financial picture; Custodian gets issue-centric counts; Maintenance Personnel gets repair/schedule-centric counts plus a "vehicles needing attention" list).
12. **Fleet Capability & Readiness Impact** — the per-vehicle Criticality Watch (below) rolled up to the Vehicle Category level, answering "what emergency capability is at risk right now?" rather than "which vehicle." Each affected type gets a coverage state — `COVERED` (not shown — only affected types are listed), `LIMITED` (ready units exist, but something's down), `AT_RISK` (down to its last ready unit — agrees with the single-point-of-failure flag above), or `NO_COVERAGE` (zero ready units) — plus the type's highest effective criticality, a primary reason, the specific affected vehicles, and a link to each one's active ticket when one exists. Built entirely from the same `responseReadinessState`/`effectiveCriticality` primitives as everything else here — no second algorithm. Shown as a dashboard card (Custodian/Maintenance Personnel) or inside Risk & Readiness Watch (Admin).

---

### 9.x Fleet Readiness & Criticality Watch

One list of every operational vehicle that is **not** currently verified ready — in maintenance, failed readiness check, never checked, or check out of date — ranked **Critical → High → Normal** using each vehicle's effective criticality (§3.1). It reuses the single readiness rule used everywhere else (`responseReadinessState`), so the watch can never disagree with the vehicle profile. Admins see it inside Risk & Readiness Watch; Custodians and Maintenance Personnel see it as a dashboard card.

---

## 10. Reports

Seven report types, Admin-only: Vehicle Inventory, Vehicle Category, Vehicle Location, Vehicle Issue, Vehicle Maintenance, Vehicle Maintenance Schedule, and Vehicle History — each filterable by its own relevant fields (category, location, issue type/severity, maintenance type/date range, etc.). Preview renders in-browser; "print" uses the browser's native print rather than a generated PDF. CSV export is available for the report output itself and separately for the vehicle list, user list, schedules, vehicle history, the work tracker, and activity-log breakdowns. Every report generation is itself logged to the Activity Log.

---

## 11. Users & Administration

### 11.1 User management (barangay-scoped, by that barangay's Admin)

List/search/filter users, create a user (barangay is forced server-side to the Admin's own; **one role**; **no password is entered**: the system generates and emails a temporary one, shown once as a fallback), edit (one role; the form shows the user's barangay read-only and a separate Address field; an Admin cannot set another user's password), **resend credentials** (not for another Admin), deactivate (which immediately revokes every one of that user's active login tokens, not just a flag flip) and reactivate. Deactivating shows an **Undo** banner for 10 seconds. The Users table shows the avatar; other tables show names only. **Temporary passwords:** an account created this way has `must_change_password` and a `temp_password_expires_at` 72 hours out; at first sign-in the SPA shows a "Set your own password" screen and the API answers 403 (`password_change_required`) to everything except `GET /user`, `POST /logout` and `PUT /profile/password` (impersonation sessions are exempt). An expired temporary password answers 403 (`temporary_password_expired`) at login. The new password must differ from the current one. Every one of these actions writes an Activity Log entry (never the password).

**Last-Admin protection**: blocks deactivating, or removing the Admin role from, a barangay's only active Admin — with a clear explanation of why, naming the account and asking that someone else be promoted first. This does **not** prevent a sole Admin from simply walking away with no successor promoted; that specific recovery case is what the Super Admin's platform-level role-change tool exists for.

**Open-work protection**: separately, nobody can be deactivated while they still have open work assigned to them — an open ticket as Custodian, an unfinished sub-issue as mechanic, or a Scheduled maintenance entry — the system lists exactly what needs reassigning first. Nobody can deactivate their own account.

### 11.2 Authentication

Token-based (Sanctum), no server-side session state. Login and password-change are both rate-limited against brute-forcing. Tokens are tagged with the account's role, and carry a computed ability list the frontend uses to decide what to show. A self-service password change requires the current password, must differ from it, clears `must_change_password` and revokes other sessions while retaining the current token. An Admin password reset revokes all of the target account's tokens. Tokens expire after 7 days by default (configurable). **There is no self-service "forgot password" flow** — confirmed absent, not just unverified; recovery is entirely through an Admin editing the account.

A deactivated account's existing token stops working on its very next request, not just at the next login attempt.

### 11.3 Impersonation

Impersonation can be started only from a dedicated Impersonator account or a directly logged-in Super Admin. Ordinary Admin, Custodian and Maintenance Personnel accounts cannot start it. The dedicated login automatically opens a default active barangay Admin; the header then offers **Province ? City/Municipality ? Barangay ? User ? Impersonate**, with direct switching and an automatically recorded reason. The backend dedicated account can target platform accounts, but the updated header province dropdown excludes the ?Platform accounts? option and lists only named provinces; a Super Admin cannot impersonate another Super Admin. An impersonated account cannot start nested sessions. Outside local/testing environments, impersonated sessions are read-only and expire after 30 minutes. The dedicated account cannot be converted into a tenantless staff account through platform role editing.

### 11.4 Activity Log

Every logged action records who did it, **which specific role/function they were acting under** (not just their primary role — so an older two-role account's action is attributed correctly), what the action was, what module and record it affected, and a free-text detail sentence. A barangay's own Admin sees their full operational log (vehicles, tickets, issues, everything), filterable and searchable. The platform-wide Super Admin log is deliberately restricted to account-level activity only (account creation, credential resends, impersonation, profile changes) — fleet-detail entries never leak through that view.

---

## 12. Super Admin Platform Portal

Entirely separate from the three barangay roles, and **explicitly barred from all fleet data** by a server-side allowlist middleware — not a UI convention, a hard block that 403s any attempt to reach a vehicle/ticket/issue/maintenance endpoint.

Capabilities: list every barangay (with staff counts, whether it has an Admin, and boundary status) and add new ones; **create a barangay's one Admin** (name, email, phone) and **resend credentials** to any account, both through a result dialog that shows the emailed temporary password once; look up a missing boundary against a public geocoder (a real, working feature, though coverage isn't guaranteed for every barangay); deactivate any user system-wide (subject to the same last-Admin and open-work guards as barangay-level deactivation); change any user's role platform-wide, including recovering an Admin-less barangay by promoting someone already there; view, resolve, reopen, or permanently delete publicly-submitted **Concern Reports** (unauthenticated "something's wrong with a barangay's account" submissions from the Support page); message users by email (`user.email_platform`), reply to concern reporters by email (`concern_report.email`), and view the platform-wide, account-only activity log. Removed on 1 November 2026: registration codes, the Pending Approvals queue and approving, rejecting or emailing a staff code for registrations.

**Boundary review workflow** (final stabilization, 2026-10-11): a boundary match from the geocoder is never auto-saved. It lands as a candidate awaiting review — shown as a **Needs Review** badge in Barangay Management (a dashboard KPI card and filter tab surface these across the whole platform) — which opens a real map preview of the matched polygon before a Super Admin explicitly **Confirms** it (writing it as the barangay's official boundary, stamped with who/when/source) or **Discards** it. Three real states exist: **Verified** (confirmed and on file — all pre-existing boundary data was backfilled into this state so it doesn't suddenly look unreviewed), **Needs Review** (a found-but-unconfirmed candidate), and **Not Found** (the geocoder returned nothing usable — includes a geometry sanity check that rejects a degenerate or unclosed polygon before it's even offered for review). An already-verified boundary can never be silently overwritten by a later lookup — the refresh endpoint refuses to touch one once confirmed.

---

## 13. Security Posture

- Token auth (Sanctum) with no server-side session state; CORS restricted to a single configured frontend origin.
- Rate limiting on login, credential creation and resend, concern-report submission, and password changes.
- Input sanitization strips control characters globally (deliberately does **not** strip HTML — the actual XSS defense is React's own output-escaping, not input mangling).
- A full set of security headers on every response (clickjacking, MIME-sniffing, referrer, permissions-policy, and a restrictive Content-Security-Policy), plus removal of headers that would advertise the tech stack.
- No raw/interpolated SQL — all queries go through parameterized Eloquent/query-builder calls.
- Every controller action enforces a specific permission ability against a single source-of-truth role→ability map before doing anything; ownership and live-state rules (own record only, not-the-repairer, same barangay, last-Admin) are layered on top as separate, explicit checks rather than folded into that map.
- A deactivated account's token dies immediately on its next request, independent of its stated expiry.
- **Cross-barangay access is blocked structurally, not just by convention**: `Vehicle` (and models hanging off it, like its documents and location history) carries a global `BelongsToBarangay` query scope, so route-model binding itself 404s before a controller even runs if the requested record belongs to a different barangay — confirmed in the final stabilization pass by direct code review, not assumed from the permission map alone.

---

## 14. Known Gaps & Partially-Built Items

Stated plainly, as found in the code — not implied to be bugs, just not (yet) user-facing or fully wired:

- **Local file storage (1 November 2026):** all uploads live on the server's private local disk and are served only through an authenticated, signed link. There is no cloud copy, so the server's backup policy is the only protection against loss. Limits: photos JPG, PNG or WEBP up to 5 MB; documents and attachments JPG, PNG, PDF, DOC or DOCX up to 10 MB (receipts 8 MB).
- **Database design:** the 46 tables were not renamed or re-normalized in the redefense revision; the ERD documents the current design. A rename and normalization plan is still open.
- **Simplified lists (1 November 2026):** every page shows one plain purpose sentence under its title. Lists open with only the essential columns; IDs, plate numbers, times and notes are hidden by default and can be added from the column picker. Charts and most dropdown filters were removed from Tickets, Issue Reports, Users, Categories and Condition Checks (status chips, a few essential filters and search remain). Dashboards, the vehicle profile and ticket details were not changed in this pass.
- **Undo** exists for archiving a vehicle, cancelling a schedule and deactivating a user (10 seconds). Other risky actions rely on their confirmation dialogs.
- **No self-service "forgot password" flow.** Recovery is by **Resend credentials** from the person who created the account (§2, §11.1); nobody can set another user's password directly.
- **Managed file delivery:** new managed uploads use private storage and five-minute signed delivery URLs. The renewal endpoint checks parent-record access, but response-wide signing can bypass that check for a same-barangay reference echoed in profile data (AUD-24-01, open); deleting the managed-file row revokes delivery. A signed URL can be used by its holder until expiry. Historical legacy URLs require migration separately if old records still reference public storage.
- The **last-Admin protection** stops specific actions (deactivate, remove Admin role, platform role change) but doesn't prevent every conceivable way a barangay could end up without an active Admin — the Super Admin recovery tool exists specifically to fix that case after the fact, not to make it impossible in advance.
- **Import / custom-field limits:** an import takes at most 500 rows / 2 MB per file; custom fields are per Vehicle Category (a template column per distinct label), and the import template does not yet include a per-row hull/engine hint beyond the Instructions sheet.
- **Barangay boundary lookup** depends on a public third-party geocoder with no guaranteed coverage — a legitimate "no boundary found" result is expected for some barangays, not a bug.

---

## 14b. Interface Conventions

- **Focus style**: every text field, dropdown and textarea shares one focus look (solid blue border and soft ring); standard forms float the label onto the border.
- **Sidebar icons**: Reports uses a bar-chart icon and Activity Log a pulse-line icon.

- **Searchable dropdowns**: type to filter vehicles, users, locations and other existing choices across forms and workspaces. Selecting an option preserves its underlying ID; catalog fields retain their existing add-new workflow.
- **Ticket proposal form**: green In-House Repair and purple Sent to External Shop methods; a full-width vehicle image above its details; external work uses one required Details field, optional Repair Type, and Priority beside Estimated Cost. Repair logs no longer ask for Start or Completion dates.

- **Assigned-personnel avatars** (`TicketPersonnelAvatars`, one shared component): small overlapping circular profile pictures (existing `users.photo_url`; initials fallback when missing or broken), tooltip "Name · Role", zoom on hover/focus, accessible labels. Shown on ticket cards and the ticket list's "Assigned Personnel" column (Custodian first, then the mechanic read from the open work orders, so reassignment is reflected; Pending Approval tickets show no mechanic), on maintenance schedule cards/table (assigned mechanic) and maintenance record rows (verifier + mechanic). Maintenance Records use a list view only.
- **Ticket progress**: the old card progress ring is removed. Cards show workflow stages and completion counts; the current ticket list includes a progress bar and percentage (documentation alignment AUD-24-08).
- **Inline field validation**: required/invalid fields in the shared form component show a red border with the message directly under the field (e.g. "Vehicle Category Name is required."), focus the first problem, and clear as the user types — replacing the old popup list. Vehicle Category and User forms already used this style. Forms with hand-written checks (ticket proposal/create, Log Repairs, add-option dialogs) still use the summary style.
- **Sidebar badges** come from one dashboard source and are cleared per user once the page has been viewed (stored in the browser), reappearing only for new items.
- Row action menus collapse into "…" only when three or more actions exist; rows open their own record, and only the vehicle cell opens the vehicle.

---

## 15. Where This Was Verified

This document was compiled by direct code review, not from memory or prior documentation, primarily against:

- `backend-api/app/Http/Controllers/{FleetController,TicketController,UserController,AuthController,SuperAdminController,HubController,NotificationController}.php`
- `backend-api/app/Http/Controllers/Concerns/{AuthorizesAbilities,ChecksRecurrence,GuardsLastAdmin,GuardsOpenWorkOnDeactivation,BelongsToBarangay}.php`
- `backend-api/app/Http/Middleware/{SecurityHeaders,SanitizeInput,EnsureUserIsActive,RestrictImpersonatedToReadOnly,RestrictSuperAdminScope}.php`
- `backend-api/app/Models/{User,Vehicle,Notification}.php`
- `backend-api/config/{permissions,cors,sanctum,scheduling}.php`
- `backend-api/app/Console/Commands/{ConvertDueSchedulesToTickets,PruneOldNotifications}.php`
- `backend-api/database/migrations/2026_10_05_*.php` (vehicle-registration delegation, notification record links)
- `backend-api/app/Http/Controllers/{VehicleImportController,VehicleTypeFieldController}.php` and `backend-api/database/migrations/2026_10_0[6-9]_*.php` (notification vehicle link, vehicle imports, type custom fields, repair-method details, criticality)
- `backend-api/database/migrations/2026_10_10_000001_add_prior_mechanics_to_ticket_sub_issues.php` (the mid-repair-reassignment self-verification fix) and `backend-api/app/Models/TicketSubIssue.php`
- `backend-api/database/migrations/2026_10_11_000001_add_boundary_status_to_barangays_table.php` and `backend-api/app/Models/Barangay.php` (the boundary review workflow)
- `backend-api/database/migrations/2026_10_1{2,4,5}_*.php` (streamlined one-mechanic ticket workflow, reversible ticket decline, schedule approval workflow)
- `backend-api/tests/Feature/CustodianVerificationHandoffTest.php` (automatic handoff, approve/return outcomes, assigned-Custodian-only and self-verification guards)
- `frontend-spa/src/views/Workspace.jsx` and `frontend-spa/src/components/{LocationDensityMap,VehicleLocationMap,AddLocationMap}.jsx`
- `frontend-spa/src/views/SuperAdminWorkspace.jsx` and `frontend-spa/src/utils/boundary.js`

See `Documentation.md` for the shorter architectural overview, and [the archived role analysis](../docs/archive/vms/Role-Realignment-Analysis.md) for the history behind the current role/permission model.

Audit follow-up: see [System Audit ? 2026-10-23](../docs/archive/vms/System-Audit-2026-10-23.md) for confirmed defects, corrections, regression checks, and verification limits.

## Follow-up corrections ? 23 October 2026

- Editing verified repair details or changing the recorded performer clears the old verification and requires a fresh Custodian check. Completed repair details stay locked; administrative corrections remain available. Confirmation rejects legacy self-verification.
- Maintenance-record edits reject self-donor vehicles, issue reports from another vehicle, and performers from another barangay.
- Ticket Custodian assignments require active accounts. External-shop dispatch and return require an Active parent ticket.
- Restoring a vehicle considers unfinished maintenance before making it available. Recurrence searches beyond 60 occupied dates without creating a duplicate booking.
- Light/dark mode is available from the workspace header for barangay roles and Super Admin; the preference survives navigation and reload.
- Schedule detail pages render completion, reassignment and decline dialogs. Only the assigned mechanic can mark an approved, unconverted schedule done. This creates a record awaiting Custodian verification; it does not approve the repair. A schedule already converted to a ticket is completed through the ticket workflow instead.

## Work-list status defaults

Most operational lists open with ongoing work selected. Admin tickets retain Proposals + Active; mechanic work orders open with all assigned statuses, including Completed; Custodian verification selects Active + To Verify; maintenance schedules select Pending Approval + Scheduled; Maintenance Records shows completed repair work only; issue reports select Pending + Under Review + In Maintenance. Historical and completed items remain available through status filters. Work orders, verification and schedules support independent multi-status selection. Work orders, verification and schedules all use the status dropdown only; there are no Ongoing only or All statuses shortcut buttons. Archive/history pages retain their historical scope. Maintenance Records totals count completed repairs only. Other work-list totals represent all accessible records, and clicking Total shows all statuses.


## QA Run 1 follow-up - 25 October 2026

> **Superseded on 1 November 2026:** the registration, Pending Approvals and staff-code statements in this section describe the earlier onboarding model, which has been removed (see §2 and the redefense revision at the end).

See [the 37-finding implementation/retest record](QA-Run1-Fixes-2026-10-25.md) for corrections to the older behavior described above. Schedule editing is creator-only; completion dates cannot be in the future. Standalone verification requires a reason for failure and personal-test attestation to pass. Catalogue creation remains available to operational staff; edit/delete are Admin-only. Approved Active/For Verification tickets are cancelled with a reason, never deleted. Ticket titles use the actual first problem, and unchanged correction resubmissions are rejected.

Repair closure and relevant physical changes invalidate older readiness evidence; a fresh readiness attestation is required after repair. Active maintenance blocks readiness confirmation. Availability, physical condition and readiness remain separate. Completed preventive work awaiting verification holds availability with Needs Repair rather than automatically diagnosing a new defect; a newer Good observation is preserved when no active repair exists.

Impersonation captures initiating identity/session/reason on activity entries. Ordinary barangay-role logins have no switcher. The dedicated superadmin@demotest.com account keeps its picker inside impersonated workspaces so it can switch repeatedly; other support sessions retain return-to-original-account. Deployed support remains read-only with a 30-minute impersonated token. Module URLs retain selection through a module query parameter, date/time presentation uses Asia/Manila, and reports retain cost fields and identify record types. Historical bad data and missing events are not silently rewritten or fabricated.


### Registration and support UI updates (2026-10-25)

- Public concern reports accept optional province, city/municipality and barangay names through suggestions or manual entry; platform reviewers see the full location. Apply migration `2026_10_25_000002_add_concern_location_names.php` after pulling.
- Registration uses a top back arrow, centered progress and green completed steps/connectors. The address is the applicant's personal contact address, not a barangay/BDRMO office address.
- Address suggestions are off by default and require the registrant's explicit consent to send typed text and selected location to Photon/OpenStreetMap. Requests are debounced, cancelled when stale and rate limited; failures leave manual entry available. Public map suggestions do not verify residence or authority. `PHOTON_URL` can select a compatible private provider endpoint.
- First-Admin submission creates an in-app Super Admin notification and Pending Approvals entry. No email/SMS alert is sent. The applicant may leave the page and coordinate through the barangay office; Support Center is a follow-up channel. Reviewers must verify appointment through a trusted contact; possession of the staff code alone does not establish authority.
- The impersonation selector labels Province, City, Barangay and User. It generates an account/location access description for existing audit metadata instead of asking for a written reason. Role checks, initiating identity and production read-only restrictions remain enforced.
- Super Admin registration-code lookup/regeneration is independent of boundary availability or pending review. Issuing a code neither approves an applicant nor verifies a boundary.

Verification: 541 backend tests passed (2,736 assertions); concern-location migration up/down/up passed on fresh and existing database copies, preserving existing vehicle counts. Browser checks cover public concern submission, registration back/progress, personal-address help, consent-gated suggestions/manual entry, complete first-Admin submission, role switching and date controls across themes/screen sizes.


### Ticket list and handover updates (2026-10-25)

The ticket table heading is **Title**. Priority filters retain two independently reachable handles even when narrowed to one value. Ticket age is highlighted in amber, the header priority/stage badges have matching dimensions, and Overview shows vehicle availability/condition without repeating repair progress.

The archive icon now **hides a ticket from the current user's main list**. Use **Hidden** to open or restore it. This preference is stored per account and does not hide the ticket from teammates, cancel/close work, change vehicle indicators, remove assignments, suppress notifications or exclude it from operational totals. Hidden-list rows obey the same search/status/date filters. Closed-ticket Archives remain separate. Apply `2026_10_25_000003_create_hidden_ticket_lists.php` after pulling; it adds only visibility preferences. Rolling it back removes preferences while preserving tickets and repair evidence.

Mechanic reassignment creates a timeline entry for each affected work item, including its title, previous and new mechanic, reason, actor and time. Other work items and repair evidence remain intact. Reassignment-dialog Cancel and Submit buttons have matching rounded corners.

Verification: 543 backend tests passed (2,765 assertions), 26 frontend tests passed, lint and production build passed. Browser checks covered repeated priority dragging/keyboard input, hide/details/restore, badge dimensions, timeline visibility and matching dialog corners. Visibility migration up/down/up passed on fresh and existing database copies with vehicles, tickets and sub-issues unchanged.


### Unified maintenance ledger (2026-10-25)

Maintenance Records shows finished repair work (`Completed`) within the viewer's barangay, including work performed by other mechanics and external shops. Ongoing, on-hold, submitted-for-verification and reopened repairs stay out of this history. The authorized API ledger retains all progress states for active-work and verification views, and its explicit `mine=1` filter retains personal-history access. This read scope does not grant repair editing, verification or access to another barangay.

Summary cards show **Total Maintenance Records**, **In-House Repair**, **Sent to External Shop** and **Maintenance Schedule**. Counts refer only to completed repair records; each completed repair gets its own row, including separate repairs on the same vehicle. Each row shows its source, repair type, work performed, mechanic or shop, and completion date. Source cards and the Sources dropdown filter the same categories. Scheduled work, including schedule-generated tickets, takes precedence over repair method so categories do not overlap; other external work counts under External Shop and remaining work under In-House Repair. Opening a row displays that specific repair and its evidence/verification details. Search includes source labels, and date filters use the completion date. The source categories are shown as In-House Repair, Sent to External Shop and Maintenance Schedule in both the list and detail view.


My Work Orders now defaults to List View, reusing the Maintenance Tickets columns, column chooser, pagination and row/detail action. Card View remains selectable with smaller cards and vehicle photos, scoped to the mechanic's Work Orders and its Archive. Both views use the same assigned-ticket scope, search and status filters; reopening the module starts in List View.


Readiness confirmation now checks current server eligibility when its dialog opens. Ongoing maintenance or an Active/For Verification ticket disables the attestation and Confirm Ready action, and explains the required maintenance completion, independent Custodian verification and fresh vehicle operation check. Vehicle list actions show a warning color for known blocked vehicles. If eligibility cannot be loaded, confirmation stays disabled until the user closes and retries. The save endpoint rechecks the same rule inside its vehicle-lock transaction, including when an older screen still says Available; a rejected request creates no readiness check.

Readiness validation verification: 545 backend tests passed; frontend lint/build and browser checks passed. Coverage includes Under Maintenance, Active/For Verification tickets despite an Available vehicle status, zero checks saved on rejection, eligibility-service failure, and successful confirmation once eligible.

## Redefense revision - 1 November 2026

Panel feedback was applied across the system. The item-by-item table, the demo script and the list of open gaps are in [Redefense-Changes-2026-11-01.md](Redefense-Changes-2026-11-01.md). In short:

- Accounts are created top-down (Super Admin → one Admin per barangay → staff) with emailed temporary passwords; public registration is gone (§2).
- Local-only storage with enforced file limits; normal street maps only; pagination hidden when there is a single page.
- View Vehicles has Ready / Not Ready sub-pages; tables show plain-text dates, names only and no photos (§3.1).
- Condition Monitoring was first built as one page with tabs (§3.6). It was redesigned on 5 November 2026; see the section below.
- The Maintenance Personnel tests repairs (including shop returns) and may mark No repair needed; the Custodian only verifies (§5.3, §5.4).
- Parts are only taken from retired vehicles, so a donor never affects readiness; no inventory (§5.3).
- Only the Custodian adds vehicles. "Vehicle type" is now "Vehicle Category". Errors state their specific cause. Vehicle Categories and Vehicle History sit at the end of the sidebar.
- Verification: the full backend suite passed 605 tests after these changes; every changed page loaded without console errors for all four roles.

## Revision - 5 November 2026

Follow-up changes to menus, pages and flows. The sidebar contents per role are listed in [Documentation.md](Documentation.md) §7.

- **Condition Monitoring (§3.6) and Issue Reporting (§4).** Condition Monitoring is now one list of the barangay's vehicles, each with its latest check, and three actions: View, Maintenance Schedule (a routine job such as an oil change, never a repair) and Condition Check. The check form opens already filled with the vehicle. A "Needs Repair" result shows the repair form (In-House or External Shop) on the same page and sends the request. The Issue Reports pages and the old tabs are removed because the condition check is the report. Condition checks are shared across the barangay: a vehicle shows once, with the latest check and whoever made it.
- **Repair Tickets.** "Maintenance Tickets" is renamed Repair Tickets. Under the Admin's Maintenance folder it sits with Schedule and Records. The Next Step cell reads "No action needed" for closed, cancelled and declined tickets instead of a dash.
- **Vehicle list (§3.1).** One retirement action, Decommission, which needs a reason and offers Undo; the Inactive status is no longer offered. The summary cards are Total Vehicles, Available and Under Maintenance. Ready to Respond shows Location and Last Readiness Check with no actions; Not Ready to Respond shows the reason and Last Maintained, with one action (open the ticket holding the vehicle). A missing part is named in the reason. It is cleared from the donor vehicle's own profile, where a "Missing parts" block lists each part with a "Put back" button (Admin, Custodian and mechanic).
- **Lists and tables.** All lists are list view only. Date columns say what they date (Date Completed, Scheduled Date, Date Created, Date Archived, Date Assigned, Date Logged). Vehicle numbers are per barangay and the Pahina Central sample vehicles are numbered 1 to 5.
- **Maintenance Schedules (§6).** Mark Done is a page, not a popup. The assigned mechanic enters the date, notes, an optional proof file and optional Parts & Materials with a cost for each part; the record keeps the part names and the total cost (each part's price is not stored separately). It still goes to the Custodian to verify.
- **Cannibalization (§5.3).** A part that is still missing from a donor vehicle cannot be taken from it again until it is marked restored; the rule is checked on the server and matches names regardless of capitalisation. There is no parts inventory.
- **Role pages.** The Admin has no Vehicle Location, Condition Monitoring or Vehicle History page. The Custodian has Maintenance Schedule in the menu (to see, edit and cancel the schedules they create) but no Maintenance Records or Vehicle Categories page (a category can still be added from the Add Vehicle form; only the Admin can edit or delete one). The mechanic dashboard shows only "What needs your attention".
- **Verification:** the full backend suite passed 608 tests; a Mark Done submission with parts and a proof photo was tested end to end in the browser (the test data was removed afterwards).

## Revision - 10 November 2026

- **Cannibalization on the repair ticket** (see §5.3): donors are retired (decommissioned) vehicles only; part from an add-able list and quantity. A separate Cannibalization page was tried and removed as redundant.
- Admin approval of cannibalized repairs and the Issue Report on the donor were removed; one rule set applies to every logged part.
- Retired (decommissioned) vehicles can be donors; their parts are logged as used.
- **Ready to Respond** shows **Last Maintained** (the last time maintenance work was finished) instead of Last Readiness Check.
- **Custodian menu:** the separate Maintenance Schedule item is removed. Condition Monitoring now has a **Next Maintenance** column (the soonest open schedule for each vehicle, which opens the schedule's page to view, edit or cancel it); planned maintenance is still added from the Condition Check form.

## Revision - 12 November 2026

- **Return to Admin.** A mechanic (or the named shop tester) can hand a work item back to the Admin with a reason (at least five characters) while it is Under Repair. The item stays Under Repair with nobody assigned; the Admin and the Custodian are both notified, the reason shows on the ticket for every role, and the Next Step reads "Returned to Admin - needs reassignment". The Admin's dashboard lists it under "Reassign returned work". Reassigning clears the notice.
- **Named shop tester.** When the Admin approves an external-shop job, they choose the Maintenance Personnel who will test the vehicle when it returns from the shop (required). Only that person sees and can submit the shop test; the Admin can change the tester from the ticket, and the tester can return the test.
- **Declined, cancelled or deleted proposals.** The vehicle is deliberately not reset, because the Custodian's finding still stands, and the notice now says so. It stays Needs Repair because the proposal's issue report stays open. To clear it the Custodian records a **Condition Check with the result Good**; if open reports remain from the withdrawn repair, the system asks "Close the open report?" and, once confirmed, closes them, clears Needs Repair and releases the vehicle so it can be confirmed Ready (QA-001, fixed 12 November). Without the confirmation nothing changes.
- **Dead code removed.** Direct ticket creation, the inspection step and "Open" status, per-item assign, reassign, verify, confirm and defer, the Admin "Close" button and "Unconfirm" were unreachable and are removed. Closing is only by the Custodian's verification. See Ticket-Dataflow-2026-11-12.md.
- **Screens.** Repair Tickets cards order is Total, Proposals, Active, Closed, Declined, Cancelled, with a compact status filter. The dashboard attention list groups items by kind with one colour per kind and a "High priority" tag. "My Active Work Orders" opens the list already filtered to Active. The Condition Check and Record Repair Work pages were resized.
- **Sidebar groups.** Clicking an item such as View Vehicles or Maintenance never folds its group any more; only the small arrow does. Groups are open on every fresh load and reopen when you move to another page.
