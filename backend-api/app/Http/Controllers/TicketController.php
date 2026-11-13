<?php

namespace App\Http\Controllers;

use App\Http\Controllers\Concerns\AuthorizesAbilities;
use App\Http\Controllers\Concerns\ChecksRecurrence;
use App\Http\Controllers\Concerns\UploadsImages;
use App\Models\ActivityLog;
use App\Models\FaultCategory;
use App\Models\MaintenanceTicket;
use App\Models\MaintenanceType;
use App\Models\ReportedPerson;
use App\Models\TicketArchiveLog;
use App\Models\TicketSubIssue;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleConditionCheck;
use App\Models\VehicleHistory;
use App\Models\CannibalizationPart;
use App\Models\VehicleIssueReport;
use App\Models\VehicleMaintenanceSchedule;
use App\Models\VehicleMaintenanceRecord;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

/**
 * TicketController — drives the Main Issue / Sub-Issue maintenance workflow.
 *
 * A ticket is a Main Issue container (e.g. "Overheating"). During inspection
 * it's populated with one or more Sub-Issues (e.g. "low coolant level"),
 * each running its own independent pipeline with its own mechanic:
 *
 *   Open -> Under Repair -> For Inspection -> For Confirmation -> Done
 *
 * A cannibalized repair (repair_type = cannibalized, a part taken from
 * another vehicle) follows the same path: no Admin approval step. The parts
 * taken are listed on the donor vehicle, and only those it cannot respond
 * without keep it from being ready.
 *
 * The ticket's progress is X/N sub-issues Done. New sub-issues can be
 * appended for as long as the ticket is Active. Once an Admin explicitly
 * Closes the ticket (only allowed at N/N), it is permanently locked — no
 * further sub-issues, no reopening, ever.
 *
 * Phase 2: A new sub-issue can be added later              -> addSubIssue()
 * Phase 3: Admin assigns the mechanic when approving       -> approveTicket()
 *          Mechanic logs repair per sub-issue              -> logRepairs()
 *          Mechanic can hand a work item back to the Admin -> returnToAdmin()
 * Phase 4: Custodian verifies the whole ticket; approving closes it,
 *          rejecting returns it for repair                 -> verifyTicket()
 */
class TicketController extends Controller
{
    use UploadsImages;
    use ChecksRecurrence;
    use AuthorizesAbilities;

    private array $priorities       = ['Low', 'Medium', 'High'];

    // Objective grounds for sending a repair outside — each is something the
    // Admin can verify, rather than a Custodian's opinion of the mechanics.
    public const EXTERNAL_REASONS = [
        'Covered by dealer / manufacturer warranty',
        'Parts or service only available from an authorized shop',
        'Needs specialized shop equipment (e.g. alignment, A/C recovery, dyno)',
        'Requires licensed / certified service (e.g. emissions, LTO inspection)',
        'Mechanic assessed and recommended external repair',
    ];

    /** The user-growable list (external_reasons table); the built-in five until it exists. */
    private function externalReasons(): array
    {
        return \Illuminate\Support\Facades\Schema::hasTable('external_reasons')
            ? \Illuminate\Support\Facades\DB::table('external_reasons')->orderBy('name')->pluck('name')->all()
            : self::EXTERNAL_REASONS;
    }

    // ===================================================================
    // READ ENDPOINTS
    // ===================================================================

    public function index(Request $request)
    {
        $user  = $request->user();
        $query = MaintenanceTicket::with($this->eagerLoads());

        // Non-admins see only what's relevant to a hat they wear. A person
        // holding BOTH Custodian and Maintenance sees tickets assigned to
        // them as custodian OR any with a sub-issue assigned to them.
        if (!$user->hasRole('Admin')) {
            $query->where(function ($scoped) use ($user) {
                if ($user->hasRole('Custodian')) {
                    $scoped->orWhere('assigned_custodian_id', $user->id);
                }
                if ($user->hasRole('Maintenance Personnel')) {
                    $scoped->orWhere('assigned_mechanic_id', $user->id)
                        ->orWhereHas('subIssues', fn ($q) => $q->where('assigned_mechanic_id', $user->id))
                        // Shop work that is back and waiting for a Maintenance Personnel to test it.
                        ->orWhereHas('subIssues', fn ($q) => $q->where('repair_type', 'external')->whereNull('assigned_mechanic_id')
                            ->whereNotNull('external_returned_at')->where('status', 'Under Repair'));
                }
            });
        }

        $query
            ->when($request->filled('status'), fn ($q) => $q->where('status', $request->status))
            ->when($request->filled('vehicle_id'), fn ($q) => $q->where('vehicle_id', $request->vehicle_id))
            ->when($request->filled('priority'), fn ($q) => $q->where('priority', $request->priority));

        if ($request->filled('q')) {
            $search = $request->string('q');
            $query->where(function ($nested) use ($search) {
                $nested->where('ticket_title', 'like', "%{$search}%")
                    ->orWhere('ticket_description', 'like', "%{$search}%")
                    ->orWhereHas('vehicle', fn ($v) => $v
                        ->where('vehicle_name', 'like', "%{$search}%")
                        ->orWhere('plate_number', 'like', "%{$search}%"));
            });
        }

        $hidden = DB::table('hidden_ticket_lists')->where('user_id', $user->id)->pluck('ticket_id')->flip();
        return $query->latest('ticket_id')->get()->each(fn ($ticket) => $ticket->setAttribute('hidden_from_list', $hidden->has($ticket->ticket_id)));
    }

    public function show(Request $request, MaintenanceTicket $ticket)
    {
        $user = $request->user();

        // Mirrors index()'s scoping so a ticket id can't be opened directly
        // by someone it wasn't already visible to in the list (VMS-IMPROVEMENT-PLAN.md
        // Phase B3). A dual-hat account (e.g. Custodian + Maintenance Personnel)
        // passes if EITHER hat gives them a reason to be here.
        if (!$user->hasRole('Admin')) {
            $isAssignedCustodian = $user->hasRole('Custodian') && $ticket->assigned_custodian_id === $user->id;
            $isAssignedMechanic = $user->hasRole('Maintenance Personnel')
                && ((int) $ticket->assigned_mechanic_id === (int) $user->id
                    || $ticket->subIssues()->where('assigned_mechanic_id', $user->id)->exists()
                    || $ticket->subIssues()->where('repair_type', 'external')->whereNull('assigned_mechanic_id')
                        ->whereNotNull('external_returned_at')->where('status', 'Under Repair')->exists());

            abort_unless($isAssignedCustodian || $isAssignedMechanic, 403, 'You are not assigned to this ticket.');
        }

        $ticket->load($this->eagerLoads());

        // This ticket's own Activity Log entries, for the Ticket Details
        // page's Activity History — only on this single-ticket endpoint.
        $ticket->setAttribute('activity', ActivityLog::with('user:id,name')
            ->where('module', 'Maintenance Tickets')
            ->where('affected_record_id', (string) $ticket->ticket_id)
            ->orderBy('log_id')
            ->get(['log_id', 'user_id', 'role', 'action', 'details', 'created_at']));

        return $ticket;
    }

    public function listVisibility(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.manage_list_visibility');
        $this->show($request, $ticket); // Apply the same tenant/assignment access as ticket details.
        $data = $request->validate(['hidden' => ['required', 'boolean']]);
        $key = ['user_id' => $request->user()->id, 'ticket_id' => $ticket->ticket_id];
        if ($data['hidden']) DB::table('hidden_ticket_lists')->insertOrIgnore($key);
        else DB::table('hidden_ticket_lists')->where($key)->delete();
        return response()->json(['hidden_from_list' => (bool) $data['hidden']]);
    }

    private function mechanicsWithWorkload(?int $barangayId)
    {
        $tickets = MaintenanceTicket::whereIn('status', ['Active', 'For Verification'])
            ->with('subIssues:sub_issue_id,ticket_id,assigned_mechanic_id')
            ->get(['ticket_id', 'assigned_mechanic_id'])
            ->flatMap(fn ($ticket) => $ticket->subIssues->pluck('assigned_mechanic_id')
                ->push($ticket->assigned_mechanic_id)->filter()->unique()->values())
            ->countBy();
        $schedules = VehicleMaintenanceSchedule::where('status', 'Scheduled')
            ->whereNotNull('assigned_to')
            ->selectRaw('assigned_to, COUNT(*) as n')
            ->groupBy('assigned_to')->pluck('n', 'assigned_to');

        return User::where('barangay_id', $barangayId)->where('is_active', true)->havingRole('Maintenance Personnel')->orderBy('name')
            ->get(['id', 'name', 'email'])
            ->each(function ($m) use ($tickets, $schedules) {
                $m->setAttribute('active_tickets', (int) ($tickets[$m->id] ?? 0));
                $m->setAttribute('scheduled_jobs', (int) ($schedules[$m->id] ?? 0));
            });
    }

    public function lookups(Request $request)
    {
        return response()->json([
            // at_external_shop: an open ticket has work sent out and not yet
            // returned, so the vehicle can't be proposed for in-house repair.
            'vehicles'              => Vehicle::whereNotIn('status', ['Inactive', 'Decommissioned'])
                ->with('category:category_id,category_name')
                ->select(['vehicle_id', 'vehicle_name', 'plate_number', 'status', 'condition', 'photo_url', 'brand', 'model', 'category_id', 'current_location'])
                ->withExists(['tickets as at_external_shop' => fn ($tickets) => $tickets
                    ->whereIn('status', ['Active', 'For Verification'])
                    ->whereHas('subIssues', fn ($items) => $items->whereNotNull('external_sent_at')->whereNull('external_returned_at'))])
                ->orderBy('vehicle_name')
                ->get(),
            // User carries no global scope — filter by barangay by hand,
            // or a ticket could get assigned to staff from another barangay.
            'custodians'            => User::where('barangay_id', $request->user()->barangay_id)->havingRole('Custodian')->orderBy('name')->get(['id', 'name', 'email', 'photo_url']),
            // Each mechanic's current load rides along so Admin/Custodian can
            // balance work before picking one: tickets still in their hands
            // (Active or awaiting verification) and approved schedules waiting.
            'maintenance_personnel' => $this->mechanicsWithWorkload($request->user()->barangay_id),
            'priorities'            => $this->priorities,
            'maintenance_types'     => MaintenanceType::orderBy('name')->pluck('name'),
            // 'Pending Approval' included so a Custodian's proposal has a
            // checkbox of its own in the ticket list's status filter — it
            // used to have none, so narrowing by any of the other 4 statuses
            // silently hid every pending proposal with no way to bring it
            // back except clicking the "Proposals" stat card specifically.
            'ticket_statuses'       => ['Pending Approval', 'Declined', 'Active', 'For Verification', 'Closed', 'Cancelled'],
            'sub_issue_statuses'    => ['Open', 'Under Repair', 'Pending Approval', 'For Inspection', 'For Confirmation', 'Done', 'Deferred'],
            'external_reasons'      => $this->externalReasons(),
        ]);
    }

    /**
     * Layer 2 duplicate-prevention aid — every currently open (non-Closed/
     * Cancelled) ticket on a vehicle, regardless of title wording. Title
     * matching alone can never catch "Brake Problem" vs "Brakes Squeaking"
     * being the same real Main Issue, so the Create Ticket form calls this
     * as soon as a vehicle is picked and shows a non-blocking warning
     * listing whatever comes back — letting the Admin catch it visually.
     */
    public function openTicketsForVehicle(Request $request, Vehicle $vehicle)
    {
        $this->requireAbility($request, 'ticket.view_open_for_vehicle');

        return MaintenanceTicket::where('vehicle_id', $vehicle->vehicle_id)
            ->whereNotIn('status', ['Closed', 'Cancelled', 'Declined'])
            ->orderByDesc('ticket_id')
            ->get(['ticket_id', 'barangay_number', 'ticket_title', 'status', 'priority']);
    }

    public function archives(Request $request)
    {
        $this->requireAbility($request, 'ticket.view_archives');

        $query = TicketArchiveLog::withTrashed()->with(['vehicle', 'archivedBy'])
            ->when($request->filled('vehicle_id'), fn ($q) => $q->where('vehicle_id', $request->vehicle_id));

        if ($request->filled('q')) {
            $search = $request->string('q');
            $query->where(function ($nested) use ($search) {
                $nested->where('ticket_title', 'like', "%{$search}%")
                    ->orWhere('vehicle_name', 'like', "%{$search}%")
                    ->orWhere('plate_number', 'like', "%{$search}%");
            });
        }

        return $query->orderByDesc('archived_at')->get();
    }

    public function deleteArchive(Request $request, TicketArchiveLog $archive)
    {
        $this->requireAbility($request, 'ticket.delete');
        $archive->delete();
        $this->log($request, 'Delete Archived Ticket', "Archive #{$archive->archive_id} moved to Deleted Tickets.", $archive->ticket_id);

        return response()->json(['message' => 'Archived ticket moved to Deleted Tickets.']);
    }

    /** Takes a Closed ticket back out of Archived Tickets; it stays in the Maintenance Tickets list. */
    public function unarchive(Request $request, TicketArchiveLog $archive)
    {
        $this->requireAbility($request, 'ticket.reopen_archived');
        abort_if($archive->trashed(), 422, 'Restore this archive from Deleted Tickets first.');
        abort_unless($archive->final_status === 'Closed', 422, 'Only a closed ticket can be unarchived.');

        DB::transaction(function () use ($archive, $request) {
            MaintenanceTicket::whereKey($archive->ticket_id)->update(['archived_at' => null]);
            $archive->forceDelete();
            $this->log($request, 'Unarchive Ticket', "Archive #{$archive->archive_id} returned to the ticket list.", $archive->ticket_id);
        });

        return response()->json(['message' => 'Ticket returned to the ticket list.']);
    }

    public function restoreArchive(Request $request, TicketArchiveLog $archive)
    {
        $this->requireAbility($request, 'ticket.reopen_archived');
        abort_unless($archive->trashed(), 422, 'This archive has not been deleted.');
        $archive->restore();
        $this->log($request, 'Restore Archived Ticket', "Archive #{$archive->archive_id} restored.", $archive->ticket_id);

        return response()->json(['message' => 'Archived ticket restored.']);
    }

    // ===================================================================
    // PHASE 1 — Create Ticket (Main Issue) & Assign to Custodian
    // Deliberately unreachable now — ticket.create has no role assigned
    // (config/permissions.php). Every ticket must originate as a Custodian's
    // proposal (proposeTicket() below) that an Admin reviews/edits/approves.
    // Left in place (not deleted) since its business rules — duplicate-Main-
    // Issue guard, recurrence stamping, entry-mode/repair-type handling —
    // document what a ticket "being created" means; proposeTicket() reuses
    // the first two directly.
    // ===================================================================

    // ===================================================================
    // Custodian: propose a ticket; Admin: review, edit, approve or decline
    // ===================================================================

    /**
     * A Custodian's own version of createTicket()'s pre-diagnosed mode —
     * they log what's wrong and who they think should fix it, but nothing
     * goes live until an Admin approves it (see approveTicket()). This is
     * now the ONLY way a ticket comes into existence — createTicket() above
     * is unreachable (ticket.create has no role) — so it carries the same
     * duplicate-Main-Issue guard, recurrence stamping, and Issue Report /
     * Condition Check linking that endpoint used to be the sole source of.
     */
    public function proposeTicket(Request $request)
    {
        $this->requireAbility($request, 'ticket.propose');

        $data = $request->validate([
            'vehicle_id'          => ['required', 'exists:vehicles,vehicle_id'],
            'issue_report_id'     => ['nullable', 'exists:vehicle_issue_reports,issue_report_id'],
            'condition_check_id'  => ['nullable', 'exists:vehicle_condition_checks,condition_check_id'],
            // Ignored if sent — the server composes the "MT-0010 — Vehicle — Issue" title.
            'ticket_title'        => ['nullable', 'string', 'max:255'],
            'ticket_description'  => ['required', 'string'],
            'priority'            => ['required', Rule::in($this->priorities)],
            // How the repair will be done. A proposal always states what is
            // wrong and how it will be fixed (the Custodian has already seen
            // the vehicle; Admin's approval is the check), so there is no
            // "needs inspection" mode and sub-issues are always required.
            'entry_mode'          => ['nullable', Rule::in(['in_house', 'cannibalized', 'external'])],
            'source_vehicle_id'   => ['nullable', 'required_if:entry_mode,cannibalized', 'exists:vehicles,vehicle_id', 'different:vehicle_id'],
            'external_vendor'     => ['nullable', 'string', 'max:255'],
            // The basis for sending it out must be an objective reason Admin
            // can check, not a judgment call about the in-house mechanics.
            'external_reason'     => ['nullable', 'required_if:entry_mode,external', Rule::in($this->externalReasons())],
            'external_work_scope' => ['nullable', 'required_if:entry_mode,external', 'string', 'max:5000'],
            'external_shop_contact'   => ['nullable', 'regex:/^09[0-9]{9}$/'],
            'external_sent_by'        => ['nullable', 'string', 'max:255'],
            'external_contact_person' => ['nullable', 'string', 'max:255'],
            'external_estimated_cost' => ['nullable', 'numeric', 'min:0'],
            'sub_issues'                          => ['required', 'array', 'min:1'],
            'sub_issues.*.title'                  => ['required', 'string', 'max:255'],
            'sub_issues.*.maintenance_type'        => ['nullable', 'string', 'max:150'],
            // Cannibalized: one row per part — what's missing here, and the
            // part pulled off the (single, shared) donor to replace it.
            'sub_issues.*.part_missing'           => ['nullable', 'required_if:entry_mode,cannibalized', 'string', 'max:255'],
            'sub_issues.*.part_needed'            => ['nullable', 'required_if:entry_mode,cannibalized', 'string', 'max:255'],
            // Who the Custodian THINKS should do the repair — a suggestion
            // only. Doesn't become a real work-order dispatch (and doesn't
            // notify the mechanic) unless an Admin approves it.
            'sub_issues.*.suggested_mechanic_id'   => ['nullable', 'exists:users,id'],
        ]);

        if (!empty($data['external_sent_by'])) {
            $data['external_sent_by'] = ReportedPerson::resolve($data['external_sent_by']);
        }
        $data['sub_issues'] = $data['sub_issues'] ?? [];
        foreach ($data['sub_issues'] as &$sub) {
            if (!empty($sub['maintenance_type'])) {
                $sub['maintenance_type'] = MaintenanceType::resolve($sub['maintenance_type']);
            }
        }
        unset($sub);

        $entryMode = $data['entry_mode'] ?? null;
        if ($entryMode === 'cannibalized') {
            $this->assertRetiredDonor($data['source_vehicle_id'] ?? null);
        }
        // Only stamped on sub-issues when the repair type is actually known.
        $repairType = in_array($entryMode, ['in_house', 'cannibalized', 'external'], true) ? $entryMode : null;

        $vehicle = Vehicle::findOrFail($data['vehicle_id']);
        abort_if(
            in_array($vehicle->status, ['Inactive', 'Decommissioned'], true),
            422,
            'Cannot propose a ticket on an archived or decommissioned vehicle.'
        );

        foreach ($data['sub_issues'] as $sub) {
            if (empty($sub['suggested_mechanic_id'])) {
                continue;
            }
            $suggested = User::findOrFail($sub['suggested_mechanic_id']);
            abort_unless($suggested->hasRole('Maintenance Personnel'), 422, 'A suggested mechanic must be Maintenance Personnel.');
            abort_unless($suggested->barangay_id === $vehicle->barangay_id, 422, 'The suggested mechanic does not belong to this barangay.');
        }

        // Linked records must really belong to this vehicle and not already be
        // in someone's hands — otherwise a proposal could flip another
        // vehicle's report or steal a condition check's ticket link.
        if (!empty($data['issue_report_id'])) {
            $linkedIssue = VehicleIssueReport::findOrFail($data['issue_report_id']);
            abort_unless((int) $linkedIssue->vehicle_id === (int) $data['vehicle_id'], 422, 'That issue report belongs to a different vehicle.');
            abort_unless(in_array($linkedIssue->status, ['Pending', 'Under Review'], true), 422, 'That issue report is already being handled or resolved.');
        }
        if (!empty($data['condition_check_id'])) {
            $linkedCheck = VehicleConditionCheck::findOrFail($data['condition_check_id']);
            abort_unless((int) $linkedCheck->vehicle_id === (int) $data['vehicle_id'], 422, 'That condition check belongs to a different vehicle.');
            abort_if($linkedCheck->resulting_ticket_id, 422, 'That condition check already has a ticket.');
        }
        if (!empty($data['source_vehicle_id'])) {
            $donor = Vehicle::findOrFail($data['source_vehicle_id']);
            abort_unless($donor->barangay_id === $vehicle->barangay_id, 422, 'The donor vehicle must be in the same barangay.');
        }

        $maintenanceTypes = array_column($data['sub_issues'], 'maintenance_type');
        $issueType = !empty($data['issue_report_id']) ? optional(VehicleIssueReport::find($data['issue_report_id']))->issue_type : null;
        $issueSummary = $data['sub_issues'][0]['title'] ?? $issueType ?? 'Maintenance';
        // Provisional (no number yet) — gets its MT-#### prefix once the row has an id.
        $data['ticket_title'] = "{$vehicle->vehicle_name} — {$issueSummary}";

        // Same "no duplicate open Main Issue on this vehicle" precheck
        // createTicket() does — a fast, friendly rejection before the real,
        // row-locked recheck inside the transaction below.
        $normalizedIncomingTitle = $this->normalizeTicketTitle($issueSummary);
        $duplicateMainIssue = MaintenanceTicket::where('vehicle_id', $data['vehicle_id'])
            ->whereNotIn('status', ['Closed', 'Cancelled', 'Declined'])
            ->get(['ticket_id', 'barangay_number', 'ticket_title'])
            ->first(fn ($t) => $this->normalizeSummaryForVehicle($t->ticket_title, $vehicle->vehicle_name) === $normalizedIncomingTitle);

        if ($duplicateMainIssue) {
            return response()->json([
                'message' => "This vehicle already has an open ticket for \"{$issueSummary}\" (Ticket #{$duplicateMainIssue->display_number}). Ask your Admin to review the existing ticket's scope instead of proposing duplicate work."
            ], 422);
        }

        $recurrenceInfo = $this->checkRecurrence((int) $data['vehicle_id'], $maintenanceTypes, $issueType, $issueSummary);
        $recurrence = $recurrenceInfo['count'];
        $recurrenceLabel = implode(' / ', array_filter(array_unique($maintenanceTypes))) ?: ($issueType ?? $data['ticket_title']);

        $ticket = DB::transaction(function () use ($data, $request, $vehicle, $recurrence, $recurrenceInfo, $normalizedIncomingTitle, $repairType, $recurrenceLabel, $issueSummary) {
            // Lock the vehicle row first — same TOCTOU fix as createTicket(),
            // serializing concurrent proposals for the SAME vehicle so two
            // requests can't both pass the duplicate check before either has
            // inserted.
            Vehicle::where('vehicle_id', $data['vehicle_id'])->lockForUpdate()->first();
            if (!empty($data['issue_report_id'])) {
                $report = VehicleIssueReport::whereKey($data['issue_report_id'])->lockForUpdate()->firstOrFail();
                abort_unless(in_array($report->status, ['Pending', 'Under Review'], true), 422, 'That report is no longer available for a proposal.');
                abort_if($this->sourceOwner($report->issue_report_id), 422, 'That report is already reserved by another ticket.');
            }
            if (!empty($data['condition_check_id'])) {
                $check = VehicleConditionCheck::whereKey($data['condition_check_id'])->lockForUpdate()->firstOrFail();
                abort_if($check->resulting_ticket_id, 422, 'That condition check already has a ticket.');
            }

            $duplicateMainIssue = MaintenanceTicket::where('vehicle_id', $data['vehicle_id'])
                ->whereNotIn('status', ['Closed', 'Cancelled', 'Declined'])
                ->get(['ticket_id', 'barangay_number', 'ticket_title'])
                ->first(fn ($t) => $this->normalizeSummaryForVehicle($t->ticket_title, $vehicle->vehicle_name) === $normalizedIncomingTitle);

            abort_if(
                $duplicateMainIssue,
                422,
                "This vehicle already has an open ticket for \"{$data['ticket_title']}\" (Ticket #{$duplicateMainIssue?->display_number}). Ask your Admin to review the existing ticket's scope instead of proposing duplicate work."
            );

            // A Custodian no longer files a separate Issue Report before
            // proposing a ticket — proposing IS the report now. Auto-create
            // one (unless this proposal already links an existing report)
            // so every problem being tracked still shows up in Issue
            // Reports, not just the ones filed through that older, now
            // de-emphasized entry point.
            $issueReportId = $data['issue_report_id'] ?? null;
            if (!$issueReportId) {
                $severity = match ($data['priority']) {
                    'Critical', 'High' => 'High',
                    'Medium' => 'Medium',
                    default => 'Low',
                };
                $issueReportId = VehicleIssueReport::create([
                    'vehicle_id'        => $data['vehicle_id'],
                    'issue_type'        => 'Other',
                    'issue_description' => $data['ticket_description'],
                    'severity_level'    => $severity,
                    'reported_by'       => $request->user()->id,
                    'status'            => 'Under Review',
                    'remarks'           => 'Auto-created from a maintenance ticket proposal.',
                ])->issue_report_id;
            }

            $ticket = MaintenanceTicket::create([
                'vehicle_id'              => $data['vehicle_id'],
                'issue_report_id'         => $issueReportId,
                'created_by'              => $request->user()->id,
                'ticket_title'            => $data['ticket_title'],
                'ticket_description'      => $data['ticket_description'],
                'priority'                => $data['priority'],
                'status'                  => 'Pending Approval',
                'assigned_custodian_id'   => $request->user()->id,
                'assigned_at'             => now(),
                'recurrence_count'        => $recurrence,
                'recurrence_of_ticket_id' => $recurrenceInfo['last_type'] === 'ticket' ? $recurrenceInfo['last_id'] : null,
            ]);

            // The number only exists now — finish the "MT-0010 — Vehicle —
            // Issue" title (and use it in the log/notification text below).
            $data['ticket_title'] = MaintenanceTicket::composeTitle($ticket->barangay_number ?? $ticket->ticket_id, $vehicle->vehicle_name, $issueSummary);
            $ticket->update(['ticket_title' => $data['ticket_title']]);

            foreach ($data['sub_issues'] as $sub) {
                TicketSubIssue::create([
                    'ticket_id'              => $ticket->ticket_id,
                    'created_by'             => $request->user()->id,
                    'title'                  => $sub['title'],
                    'maintenance_type'       => $sub['maintenance_type'] ?? null,
                    'suggested_mechanic_id'  => $sub['suggested_mechanic_id'] ?? null,
                    'repair_type'            => $repairType,
                    'source_vehicle_id'      => $repairType === 'cannibalized' ? ($data['source_vehicle_id'] ?? null) : null,
                    'part_missing'           => $repairType === 'cannibalized' ? ($sub['part_missing'] ?? null) : null,
                    'part_needed'            => $repairType === 'cannibalized' ? ($sub['part_needed'] ?? null) : null,
                    'external_vendor'        => $repairType === 'external' ? ($data['external_vendor'] ?? null) : null,
                    'external_reason'        => $repairType === 'external' ? ($data['external_reason'] ?? null) : null,
                    'external_work_scope'    => $repairType === 'external' ? ($data['external_work_scope'] ?? null) : null,
                    'external_shop_contact'  => $repairType === 'external' ? ($data['external_shop_contact'] ?? null) : null,
                    'external_sent_by'       => $repairType === 'external' ? ($data['external_sent_by'] ?? null) : null,
                    'external_contact_person' => $repairType === 'external' ? ($data['external_contact_person'] ?? null) : null,
                    'external_estimated_cost' => $repairType === 'external' ? ($data['external_estimated_cost'] ?? null) : null,
                    'status'                 => 'Open',
                ]);
            }

            if (!empty($data['issue_report_id'])) {
                VehicleIssueReport::where('issue_report_id', $data['issue_report_id'])->update([
                    'status' => 'Under Review',
                ]);
            }

            // Set once, never touched again — Condition Monitoring reads the
            // linked ticket's live status through this instead of a snapshot,
            // so the historical check row itself never has to change.
            if (!empty($data['condition_check_id'])) {
                VehicleConditionCheck::where('condition_check_id', $data['condition_check_id'])->update([
                    'resulting_ticket_id' => $ticket->ticket_id,
                ]);
            }

            if ($vehicle->condition === 'Good') $vehicle->update(['condition' => 'Needs Repair']);
            $this->history($vehicle, 'Ticket Proposed', 'Maintenance proposal submitted for Admin review.', 'maintenance_tickets', $ticket->ticket_id, $request);
            $this->log($request, 'Propose Ticket', "Ticket proposal \"{$data['ticket_title']}\" for {$vehicle->vehicle_name} submitted for Admin review.", $ticket->ticket_id);

            $this->notifyAdmins(
                'New Ticket Proposal Awaiting Review',
                "{$request->user()->name} proposed a ticket — \"{$data['ticket_title']}\" for {$vehicle->vehicle_name}. Review, edit if needed, then approve or decline.",
                'ticket_proposed',
                $ticket->ticket_id,
                $vehicle->barangay_id
            );

            if ($recurrence > 0) {
                $lastFixSource = $recurrenceInfo['last_type'] === 'record'
                    ? "Maintenance Record #{$recurrenceInfo['last_id']}"
                    : "Ticket #{$recurrenceInfo['last_id']}";
                $ordinal = ['st', 'nd', 'rd'][$recurrence] ?? 'th';
                $this->notifyAdmins(
                    'Recurring Fault Detected',
                    "This is the " . ($recurrence + 1) . "{$ordinal} time \"" . $recurrenceLabel . "\" has been logged on {$vehicle->vehicle_name} in 90 days — last fixed via {$lastFixSource} (Ticket #{$ticket->display_number}). Consider a deeper fix or decommission review.",
                    'recurring_fault',
                    $ticket->ticket_id,
                    $vehicle->barangay_id
                );
            }

            return $ticket;
        });

        return response()->json($ticket->load($this->eagerLoads()), 201);
    }

    /**
     * Admin reviews a Pending Approval ticket: optionally edits ticket-level
     * fields and/or individual sub-issues (matched by sub_issue_id — only
     * the ones you want to change need to be included), then approves.
     * Approving is what actually dispatches any suggested mechanic (the
     * same effect as assignMechanic()) and puts the vehicle out of service —
     * none of that happens at proposal time.
     */
    public function approveTicket(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.approve');

        // A Declined proposal has to be undeclined first (back to Pending
        // Approval) — only then can it be approved and assigned.
        abort_unless(
            $ticket->status === 'Pending Approval',
            422,
            $ticket->status === 'Declined'
                ? 'This proposal was declined — undecline it first, then approve and assign it.'
                : "Only a Pending Approval ticket can be approved. Current: {$ticket->status}."
        );

        $data = $request->validate([
            'ticket_description'    => ['sometimes', 'string'],
            'priority'              => ['sometimes', Rule::in($this->priorities)],
            'assigned_custodian_id' => ['sometimes', 'exists:users,id'],
            // Required for an in-house ticket. An EXTERNAL-shop ticket has no
            // in-house mechanic: the vehicle goes to an outside shop.
            'assigned_mechanic_id'  => ['nullable', 'exists:users,id'],
            'sub_issues'                        => ['nullable', 'array'],
            'sub_issues.*.sub_issue_id'          => ['required_with:sub_issues', 'exists:ticket_sub_issues,sub_issue_id'],
            'sub_issues.*.title'                 => ['nullable', 'string', 'max:255'],
            'sub_issues.*.maintenance_type'      => ['nullable', 'string', 'max:150'],
            'sub_issues.*.suggested_mechanic_id' => ['nullable', 'exists:users,id'],
            'sub_issues.*.assigned_mechanic_id' => ['nullable', 'exists:users,id'],
        ]);

        if (isset($data['assigned_custodian_id'])) {
            $newCustodian = User::findOrFail($data['assigned_custodian_id']);
            abort_unless($newCustodian->is_active && $newCustodian->hasRole('Custodian'), 422, 'The selected user is not a Custodian.');
            abort_unless($newCustodian->barangay_id === $ticket->vehicle->barangay_id, 422, 'The selected Custodian does not belong to this barangay.');
        }

        $subIssues = $ticket->subIssues()->get();
        $isExternalTicket = $subIssues->isNotEmpty() && $subIssues->every(fn ($sub) => $sub->repair_type === 'external');
        // Each in-house work item needs its own reviewed assignment. The
        // ticket-level field remains a fallback for older API clients.
        $rows = collect($data['sub_issues'] ?? []);
        abort_if($rows->pluck('sub_issue_id')->duplicates()->isNotEmpty(), 422, 'Each sub-issue may appear only once.');
        abort_if($rows->contains(fn ($row) => !$subIssues->contains('sub_issue_id', (int) $row['sub_issue_id'])), 422, 'A sub-issue does not belong to this ticket.');
        $assignments = [];
        $shopTesters = [];
        foreach ($subIssues as $subIssue) {
            $row = $rows->firstWhere('sub_issue_id', $subIssue->sub_issue_id);
            if ($subIssue->repair_type === 'external') {
                // No in-house mechanic, but the Admin names who will test the vehicle when it returns from the shop.
                $testerId = $row['assigned_mechanic_id'] ?? $data['assigned_mechanic_id'] ?? null;
                abort_unless($testerId, 422, 'Choose the Maintenance Personnel who will test the vehicle when it returns from the shop.');
                $tester = User::findOrFail($testerId);
                abort_unless($tester->is_active && $tester->hasRole('Maintenance Personnel') && $tester->barangay_id === $ticket->vehicle->barangay_id, 422, 'Choose active Maintenance Personnel from this barangay.');
                $shopTesters[$subIssue->sub_issue_id] = $tester;
                continue;
            }
            $mechanicId = $row['assigned_mechanic_id'] ?? $data['assigned_mechanic_id'] ?? null;
            abort_unless($mechanicId, 422, 'Choose Maintenance Personnel for every sub-issue.');
            $mechanic = User::findOrFail($mechanicId);
            abort_unless($mechanic->is_active && $mechanic->hasRole('Maintenance Personnel'), 422, 'Choose active Maintenance Personnel.');
            abort_unless($mechanic->barangay_id === $ticket->vehicle->barangay_id, 422, 'The selected mechanic does not belong to this barangay.');
            $assignments[$subIssue->sub_issue_id] = $mechanic;
        }
        $uniqueMechanics = collect($assignments)->unique('id');
        $assignedMechanic = $uniqueMechanics->count() === 1 ? $uniqueMechanics->first() : null;

        abort_if(
            in_array($ticket->vehicle->status, ['Inactive', 'Decommissioned'], true),
            422,
            'This vehicle has been archived or decommissioned since it was proposed — decline the proposal instead.'
        );
        abort_if($ticket->subIssues()->count() === 0, 422, 'A proposal needs at least one sub-issue before it can be approved.');

        $ticket = DB::transaction(function () use ($ticket, $data, $request, $assignedMechanic, $assignments, $isExternalTicket, $shopTesters) {
            // Serialize against a concurrent approve/decline of the same proposal.
            $locked = $this->lockTicket($ticket, $request);
            abort_unless($locked->status === 'Pending Approval' && !$locked->correction_requested_at, 422, 'This proposal is no longer awaiting an approval decision.');
            $ticket = $locked;
            abort_if(in_array($ticket->vehicle->status, ['Inactive', 'Decommissioned'], true), 422, 'This vehicle is retired; the proposal cannot be approved.');
            $this->assertSourcesAvailable($ticket);
            $this->assertNoDuplicateProposal($ticket);
            $currentIds = $ticket->subIssues()->pluck('sub_issue_id');
            abort_if(collect($data['sub_issues'] ?? [])->pluck('sub_issue_id')->diff($currentIds)->isNotEmpty(), 422, 'The proposal changed. Refresh and review it again.');

            $ticket->update(array_intersect_key($data, array_flip([
                'ticket_description', 'priority', 'assigned_custodian_id',
            ])) + ['assigned_mechanic_id' => $assignedMechanic?->id]);

            foreach ($data['sub_issues'] ?? [] as $subData) {
                $subIssue = TicketSubIssue::where('ticket_id', $ticket->ticket_id)
                    ->where('sub_issue_id', $subData['sub_issue_id'])
                    ->firstOrFail();

                $patch = [];
                if (array_key_exists('title', $subData) && $subData['title'] !== null) {
                    $patch['title'] = $subData['title'];
                }
                if (array_key_exists('maintenance_type', $subData) && $subData['maintenance_type'] !== null) {
                    $patch['maintenance_type'] = MaintenanceType::resolve($subData['maintenance_type']);
                }
                if (array_key_exists('suggested_mechanic_id', $subData)) {
                    $patch['suggested_mechanic_id'] = $subData['suggested_mechanic_id'];
                }
                if ($patch) {
                    $subIssue->update($patch);
                }
            }

            $vehicle = $ticket->vehicle;

            $ticket->update([
                'status'            => 'Active',
                'decline_reason'    => null,
                'down_since'        => $ticket->down_since ?? now(),
                'inspection_result' => 'Needs Maintenance',
                'inspection_notes'  => 'Proposed by Custodian, reviewed and approved by Admin — inspection skipped.',
                'inspected_by'      => $ticket->assigned_custodian_id,
                'inspected_at'      => $ticket->created_at,
            ]);
            // Covers approving directly from Declined (declineTicket() reset
            // this to Pending while nothing was happening) — a no-op for the
            // normal fresh-proposal path, where it's already In Maintenance.
            $this->resetLinkedIssueReports($ticket, 'In Maintenance');
            $vehicle->update(['condition' => 'Needs Repair', 'status' => 'Under Maintenance']);
            $this->history($vehicle, 'Ticket Approved', "Ticket #{$ticket->display_number} (\"{$ticket->ticket_title}\") was approved — {$vehicle->vehicle_name} moved to Under Maintenance.", 'maintenance_tickets', $ticket->ticket_id, $request);

            $dispatchedMechanics = [];
            foreach ($ticket->subIssues()->get() as $subIssue) {
                $mechanic = $assignments[$subIssue->sub_issue_id] ?? null;
                $subIssue->update([
                    'status' => 'Under Repair',
                    'assigned_mechanic_id' => $mechanic?->id,
                    'mechanic_assigned_at' => $mechanic ? now() : null,
                    'mechanic_assigned_by' => $mechanic ? $request->user()->id : null,
                    'external_tester_id' => isset($shopTesters[$subIssue->sub_issue_id]) ? $shopTesters[$subIssue->sub_issue_id]->id : null,
                ]);
                if ($mechanic) $dispatchedMechanics[$mechanic->id] = $mechanic;
                if (isset($shopTesters[$subIssue->sub_issue_id])) {
                    $this->notifyUser($shopTesters[$subIssue->sub_issue_id]->id, 'Shop Test Assigned to You', "Ticket #{$ticket->display_number}: you will test \"{$subIssue->title}\" when it returns from the shop.", 'work_order_assigned', $ticket->ticket_id);
                }
            }
            $this->decisionEvent($ticket, $request, 'Approved', ['assigned_mechanics' => collect($assignments)->map(fn ($person) => $person->id)->all()]);
            $this->log($request, 'Approve Ticket', "Ticket #{$ticket->display_number} ({$ticket->ticket_title}) proposal approved" . ($isExternalTicket ? ' for an external shop (no in-house mechanic).' : ' with Maintenance Personnel assigned to each sub-issue.'), $ticket->ticket_id);

            $this->notifyUser(
                $ticket->assigned_custodian_id,
                'Ticket Proposal Approved',
                "Your proposed ticket \"{$ticket->ticket_title}\" for {$vehicle->vehicle_name} was approved.",
                'ticket_approved',
                $ticket->ticket_id
            );
            foreach ($dispatchedMechanics as $mechanic) {
                $this->notifyUser(
                    $mechanic->id,
                    'Maintenance Ticket Assigned',
                    "You have been assigned Ticket #{$ticket->display_number} ({$vehicle->vehicle_name}).",
                    'ticket_assigned',
                    $ticket->ticket_id
                );
            }

            return $ticket;
        });

        return response()->json($ticket->load($this->eagerLoads()));
    }

    /**
     * Admin hands the whole ticket (all of its sub-issues) to a different
     * mechanic — e.g. the originally assigned one is out sick. Mirrors the
     * old per-sub-issue reassignMechanic(), applied to every line item at
     * once, so each sub-issue's own prior_mechanic_ids keeps carrying the
     * self-verification guarantee even though the ticket is now one job.
     */
    public function assignTicketMechanic(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.assign_mechanic');
        $data = $request->validate([
            'assigned_mechanic_id' => ['required', 'exists:users,id'],
            'sub_issue_ids' => ['nullable', 'array', 'min:1'],
            'sub_issue_ids.*' => ['required', 'integer', 'distinct'],
            'reassign_reason' => ['required', 'string', 'max:5000'],
        ]);
        return DB::transaction(function () use ($request, $ticket, $data) {
            $ticket = $this->lockTicket($ticket, $request);
            abort_unless($ticket->status === 'Active', 422, 'Only unfinished work on an Active ticket can be reassigned. Return the affected repair for rework first if it was already submitted.');
            $mechanic = User::findOrFail($data['assigned_mechanic_id']);
            abort_unless($mechanic->is_active && $mechanic->hasRole('Maintenance Personnel') && $mechanic->barangay_id === $ticket->vehicle->barangay_id, 422, 'Choose active Maintenance Personnel from this barangay.');
            abort_if((int) $ticket->assigned_custodian_id === (int) $mechanic->id, 422, 'Choose a mechanic different from the assigned verifying Custodian.');
            $items = $ticket->subIssues()->lockForUpdate()->get();
            $selected = isset($data['sub_issue_ids'])
                ? $items->whereIn('sub_issue_id', $data['sub_issue_ids'])
                : $items->filter(fn ($item) => $item->status === 'Under Repair' && $item->repair_type !== 'external');
            abort_if(isset($data['sub_issue_ids']) && $selected->count() !== count($data['sub_issue_ids']), 422, 'A selected work item does not belong to this ticket.');
            abort_if($selected->isEmpty(), 422, 'There is no unfinished in-house work to reassign.');
            foreach ($selected as $item) {
                abort_unless($item->status === 'Under Repair' && $item->repair_type !== 'external', 422, 'Submitted, verified and external work cannot be reassigned.');
                abort_if((int) $item->assigned_mechanic_id === (int) $mechanic->id, 422, 'That mechanic already owns a selected work item.');
            }
            foreach ($selected as $item) {
                $previous = $item->assigned_mechanic_id;
                $previousName = $previous ? (User::find($previous)?->name ?? 'Previous mechanic') : 'Unassigned';
                $this->workEvent($item, $request, 'Reassigned', ['previous_mechanic_id' => $previous, 'new_mechanic_id' => $mechanic->id, 'reason' => $data['reassign_reason']]);
                $item->update([
                    'assigned_mechanic_id' => $mechanic->id,
                    'prior_mechanic_ids' => collect($item->prior_mechanic_ids ?? [])->push($previous)->filter()->unique()->values()->all(),
                    'mechanic_assigned_at' => now(), 'mechanic_assigned_by' => $request->user()->id,
                    'returned_to_admin_at' => null, 'returned_to_admin_by' => null, 'returned_to_admin_reason' => null,
                ]);
                $this->notifyUser($mechanic->id, 'Work Order Reassigned to You', "Ticket #{$ticket->display_number}: {$item->title}. Reason: {$data['reassign_reason']}", 'work_order_assigned', $ticket->ticket_id);
                if ($previous) $this->notifyUser($previous, 'Work Order Reassigned', "Ticket #{$ticket->display_number}: {$item->title} was reassigned to {$mechanic->name}.", 'work_order_reassigned', $ticket->ticket_id);
                $this->log($request, 'Ticket Mechanic Reassigned', "Ticket #{$ticket->display_number}: {$item->title} reassigned from {$previousName} to {$mechanic->name}. Reason: {$data['reassign_reason']}", $ticket->ticket_id);
            }
            $ids = $ticket->subIssues()->pluck('assigned_mechanic_id')->filter()->unique();
            $ticket->update(['assigned_mechanic_id' => $ids->count() === 1 ? $ids->first() : null]);
            return response()->json($ticket->fresh($this->eagerLoads()));
        });
    }

    /**
     * The assigned mechanic (or the named shop tester) hands a work item back to the Admin, with a reason: it
     * should not be theirs, for example it needs different work. The item stays Under Repair but has nobody
     * assigned; the Admin reassigns it (or cancels the ticket). The Custodian is told too, and the return shows
     * on the ticket for everyone until the item is reassigned.
     */
    public function returnToAdmin(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireAbility($request, 'subissue.log_repair');
        $this->assertBelongsToTicket($ticket, $subIssue);
        $data = $request->validate(['reason' => ['required', 'string', 'min:5', 'max:2000']]);

        return DB::transaction(function () use ($request, $ticket, $subIssue, $data) {
            $ticket = $this->lockTicket($ticket, $request);
            $subIssue = TicketSubIssue::whereKey($subIssue->sub_issue_id)->lockForUpdate()->firstOrFail();
            $uid = (int) $request->user()->id;
            $isTester = $subIssue->repair_type === 'external' && ! $subIssue->assigned_mechanic_id && (int) $subIssue->external_tester_id === $uid;
            abort_unless($isTester || (int) $subIssue->assigned_mechanic_id === $uid, 403, 'This work order is not assigned to you.');
            abort_unless($ticket->status === 'Active', 422, "Work can only be returned while the ticket is Active. Current status: {$ticket->status}.");
            abort_unless($subIssue->status === 'Under Repair', 422, "Only an Under Repair item can be returned to the Admin. Current: {$subIssue->status}.");
            abort_if(
                $subIssue->repair_type === 'external' && $subIssue->external_sent_at && ! $subIssue->external_returned_at,
                422,
                'This item is at an outside shop. Record its return before sending it back to the Admin.'
            );

            $this->workEvent($subIssue, $request, 'Returned to Admin', ['reason' => $data['reason']]);
            $patch = [
                'returned_to_admin_at' => now(),
                'returned_to_admin_by' => $uid,
                'returned_to_admin_reason' => $data['reason'],
            ];
            if ($isTester) {
                $patch['external_tester_id'] = null;
            } else {
                $patch += [
                    'assigned_mechanic_id' => null,
                    'mechanic_assigned_at' => null,
                    'prior_mechanic_ids' => collect($subIssue->prior_mechanic_ids ?? [])->push($uid)->unique()->values()->all(),
                ];
            }
            $subIssue->update($patch);

            $ids = $ticket->subIssues()->pluck('assigned_mechanic_id')->filter()->unique();
            $ticket->update(['assigned_mechanic_id' => $ids->count() === 1 ? $ids->first() : null]);

            $vehicleName = $ticket->vehicle->vehicle_name;
            $message = "{$request->user()->name} returned \"{$subIssue->title}\" on Ticket #{$ticket->display_number} ({$vehicleName}) to the Admin. Reason: {$data['reason']}";
            $this->notifyAdmins('Work Returned to Admin', $message . ' Reassign it or cancel the ticket.', 'work_order_returned', $ticket->ticket_id, $ticket->vehicle->barangay_id);
            $this->notifyUser($ticket->assigned_custodian_id, 'Work Returned to Admin', $message . ' The Admin will reassign it.', 'work_order_returned', $ticket->ticket_id);
            $this->log($request, 'Work Returned to Admin', "Ticket #{$ticket->display_number}: {$subIssue->title} returned to the Admin by {$request->user()->name}. Reason: {$data['reason']}", $ticket->ticket_id);

            return response()->json($ticket->fresh($this->eagerLoads()));
        });
    }

    /** The Admin names (or changes) the Maintenance Personnel who tests an external-shop job when it returns. */
    public function setExternalTester(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireAbility($request, 'ticket.assign_mechanic');
        $this->assertBelongsToTicket($ticket, $subIssue);
        $data = $request->validate(['tester_id' => ['required', 'exists:users,id']]);

        return DB::transaction(function () use ($request, $ticket, $subIssue, $data) {
            $ticket = $this->lockTicket($ticket, $request);
            abort_unless($ticket->status === 'Active', 422, "The tester can only be changed while the ticket is Active. Current status: {$ticket->status}.");
            abort_unless($subIssue->repair_type === 'external' && $subIssue->status === 'Under Repair', 422, 'Only an unfinished external-shop item has a shop tester.');
            $tester = User::findOrFail($data['tester_id']);
            abort_unless($tester->is_active && $tester->hasRole('Maintenance Personnel') && $tester->barangay_id === $ticket->vehicle->barangay_id, 422, 'Choose active Maintenance Personnel from this barangay.');

            $previous = $subIssue->external_tester_id;
            $this->workEvent($subIssue, $request, 'Shop Tester Assigned', ['previous_tester_id' => $previous, 'new_tester_id' => $tester->id]);
            $subIssue->update(['external_tester_id' => $tester->id, 'returned_to_admin_at' => null, 'returned_to_admin_by' => null, 'returned_to_admin_reason' => null]);
            $this->notifyUser($tester->id, 'Shop Test Assigned to You', "Ticket #{$ticket->display_number}: you will test \"{$subIssue->title}\" when it returns from the shop.", 'work_order_assigned', $ticket->ticket_id);
            if ($previous && (int) $previous !== (int) $tester->id) {
                $this->notifyUser($previous, 'Shop Test Reassigned', "Ticket #{$ticket->display_number}: the shop test for \"{$subIssue->title}\" was given to {$tester->name}.", 'work_order_reassigned', $ticket->ticket_id);
            }
            $this->log($request, 'Shop Tester Assigned', "Ticket #{$ticket->display_number}: {$tester->name} will test \"{$subIssue->title}\" after the shop.", $ticket->ticket_id);

            return response()->json($ticket->fresh($this->eagerLoads()));
        });
    }

    /**
     * The ticket's one assigned mechanic submits the whole job for
     * verification once every sub-issue's repair has been logged
     * (For Inspection). A cannibalized line item still awaiting Admin
     * approval blocks this exactly as it blocked the old per-sub-issue
     * flow, since it won't be at For Inspection yet.
     */
    public function submitForVerification(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.submit_for_verification');

        abort_unless(
            ((int) $ticket->assigned_mechanic_id === (int) $request->user()->id
                || $ticket->subIssues()->where('assigned_mechanic_id', $request->user()->id)->exists()),
            403,
            'This ticket is not assigned to you.'
        );

        // Logging the last outstanding repair now advances the ticket on its
        // own (advanceToVerificationIfReady()), so this manual button is a
        // fallback — pressing it after that already happened is a no-op, not
        // an error, and doesn't re-notify the Custodian.
        if ($ticket->status === 'For Verification') {
            return response()->json($ticket->fresh($this->eagerLoads()));
        }

        abort_unless($ticket->status === 'Active', 422, "A ticket can only be submitted for verification while Active. Current status: {$ticket->status}.");

        $ticket->load('subIssues');
        $notReady = $ticket->subIssues->reject(fn ($s) => in_array($s->status, ['For Inspection', 'Done'], true));
        abort_if(
            $notReady->isNotEmpty(),
            422,
            'Every sub-issue needs its repair logged before the ticket can go to verification: ' . $notReady->pluck('title')->implode(', ')
        );

        DB::transaction(function () use ($ticket, $request) {
            $locked = $this->lockTicket($ticket, $request);
            abort_unless($locked && $locked->status === 'Active', 422, 'This ticket was already submitted or changed.');
            abort_unless($locked->subIssues->isNotEmpty() && $locked->subIssues->every(fn ($item) => in_array($item->status, ['For Inspection', 'Done'], true)), 422, 'The work changed. Every repair must be submitted before verification.');

            $locked->update(['status' => 'For Verification']);

            $this->log(
                $request,
                'Submitted for Verification',
                "Ticket #{$ticket->display_number} ({$ticket->ticket_title}) submitted for Custodian verification.",
                $ticket->ticket_id
            );

            $this->notifyRepairReadyForVerification($ticket, $request);
        });

        return response()->json($ticket->fresh($this->eagerLoads()));
    }

    /**
     * Once every sub-issue on an Active ticket has its repair logged (For
     * Inspection), the ticket moves to For Verification on its own and the
     * assigned Custodian is told — the same transition submitForVerification()
     * makes, but no longer dependent on the mechanic finding a second button
     * after logging the last repair. That missed step is what left Custodians
     * notified to verify a ticket that was still Active (and so not yet
     * verifiable). Same readiness rule as submitForVerification(): anything
     * not at For Inspection — including a cannibalized repair still awaiting
     * Admin approval — keeps the ticket Active. Call inside the caller's
     * transaction. Returns whether the ticket advanced.
     */
    private function advanceToVerificationIfReady(MaintenanceTicket $ticket, Request $request): bool
    {
        $locked = $this->lockTicket($ticket, $request);
        if (!$locked || $locked->status !== 'Active') {
            return false;
        }

        $subIssues = TicketSubIssue::where('ticket_id', $ticket->ticket_id)->get();
        if ($subIssues->isEmpty() || $subIssues->contains(fn ($s) => !in_array($s->status, ['For Inspection', 'Done'], true))) {
            return false;
        }

        $locked->update(['status' => 'For Verification']);

        $this->log(
            $request,
            'Submitted for Verification',
            "Ticket #{$ticket->display_number} ({$ticket->ticket_title}) — every repair logged; sent to the Custodian for verification.",
            $ticket->ticket_id
        );
        $this->notifyRepairReadyForVerification($ticket, $request);

        return true;
    }

    // One wording for "this ticket is now waiting on you", whichever path
    // got it there (automatic advance or the manual fallback button). Links
    // to the ticket, which is where the Custodian's Verify section lives.
    private function notifyRepairReadyForVerification(MaintenanceTicket $ticket, Request $request): void
    {
        $this->history($ticket->vehicle, 'Ready for Verification', 'All repair work is submitted for independent Custodian verification.', 'maintenance_tickets', $ticket->ticket_id, $request);
        $this->notifyUser(
            $ticket->assigned_custodian_id,
            'Repair Ready for Verification',
            "Ticket #{$ticket->display_number} — {$ticket->vehicle->vehicle_name}: the repair has been submitted and is ready for your verification.",
            'repairs_completed',
            $ticket->ticket_id
        );
    }

    /**
     * The ticket's assigned Custodian gives one plain attestation for the
     * whole job ("I confirm I personally operated and tested this vehicle")
     * and the ticket closes — no checklist, no notes, no separate
     * reject-and-rework step. Internally this finalizes every sub-issue the
     * same way an Admin Tier-2 confirm used to (finalizeConfirmedSubIssue()),
     * so the maintenance ledger is written exactly as before.
     */
    public function verifyTicket(Request $request, MaintenanceTicket $ticket)
    {
        return DB::transaction(function () use ($request, $ticket) {
            $ticket = $this->lockTicket($ticket, $request);
            return $this->verifyTicketLocked($request, $ticket);
        });
    }

    private function verifyTicketLocked(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.verify');

        abort_unless(
            (int) $ticket->assigned_custodian_id === (int) $request->user()->id,
            403,
            "This verification is assigned to {$ticket->assignedCustodian?->name}."
        );

        $ticket->load('subIssues');
        $priorMechanicIds = $ticket->subIssues
            ->flatMap(fn ($s) => $s->prior_mechanic_ids ?? [])
            ->push($ticket->assigned_mechanic_id)
            ->merge($ticket->subIssues->pluck('assigned_mechanic_id'))
            ->filter()
            ->unique()
            ->values()
            ->all();
        abort_if(
            in_array($request->user()->id, $priorMechanicIds, true),
            403,
            'You performed repair work on this ticket — it must be verified by a different Custodian. Reassign this ticket to another Custodian.'
        );

        abort_unless($ticket->status === 'For Verification', 422, "Verification can only be submitted when the ticket is For Verification. Current: {$ticket->status}.");

        // The verdict is explicit; approval requires the Custodian's test attestation.
        $data = $request->validate([
            'verification_verdict'     => ['required', Rule::in(['Approved', 'Rejected'])],
            'verification_notes'       => ['nullable', 'string', 'max:5000'],
            'functional_test'          => ['nullable', 'array'],
            'functional_test.*.item'   => ['required', 'string', 'max:255'],
            'functional_test.*.passed' => ['required', 'boolean'],
            'test_attested'            => ['required_if:verification_verdict,Approved', 'boolean'],
            'failed_sub_issue_ids' => ['nullable', 'array', 'min:1'],
            'failed_sub_issue_ids.*' => ['required', 'integer', 'distinct'],
        ]);
        $approved = $data['verification_verdict'] === 'Approved';
        abort_unless($ticket->subIssues->isNotEmpty() && $ticket->subIssues->every(fn ($item) => in_array($item->status, ['For Inspection', 'Done'], true)), 422, 'Every repair must be submitted before verification.');
        abort_if(isset($data['failed_sub_issue_ids']) && collect($data['failed_sub_issue_ids'])->diff($ticket->subIssues->pluck('sub_issue_id'))->isNotEmpty(), 422, 'A failed work item does not belong to this ticket.');
        $functionalTest = $data['functional_test'] ?? null;
        $failedChecks = collect($functionalTest ?? [])->reject(fn ($i) => $i['passed'])->pluck('item');

        if ($approved) {
            abort_unless($request->boolean('test_attested'), 422, 'Confirm that you personally tested the vehicle and the repairs passed.');
            abort_if(!empty($data['failed_sub_issue_ids']), 422, 'Failed work items must be returned for repair.');
            // A submitted failed check can never be approved.
            abort_if(
                $failedChecks->isNotEmpty(),
                422,
                'This functional test has a failed check — it cannot be approved. Return it for repair instead.'
            );
        } else {
            abort_if(
                $failedChecks->isEmpty() && blank($data['verification_notes'] ?? null),
                422,
                'Say what is wrong — mark the failing check or add a note — so the mechanic knows what to redo.'
            );

            return $this->returnTicketForRepair($ticket, $request, $data, $functionalTest, $failedChecks);
        }

        DB::transaction(function () use ($ticket, $request, $data, $functionalTest) {
            $locked = $this->lockTicket($ticket, $request);
            abort_unless($locked && $locked->status === 'For Verification', 422, 'This ticket was already verified or changed.');

            $ticket->load('subIssues');
            foreach ($ticket->subIssues as $subIssue) {
                if ($subIssue->status === 'Done') {
                    continue;
                }
                $this->workEvent($subIssue, $request, 'Verification Approved', ['notes' => $data['verification_notes'] ?? null, 'test_attested' => true]);
                $subIssue->update([
                    'verification_verdict' => 'Approved',
                    'verification_notes'    => $data['verification_notes'] ?? null,
                    'verified_by'           => $request->user()->id,
                    'verified_at'           => now(),
                    'functional_test'       => $functionalTest,
                    'test_attested'         => true,
                ]);
                $this->finalizeConfirmedSubIssue($ticket, $subIssue, $request->user()->id, null);
            }

            $locked->update([
                'status'              => 'Closed',
                'closed_by'           => $request->user()->id,
                'closed_at'           => now(),
                'returned_to_service' => true,
                'archived_at'         => now(),
            ]);

            if ($ticket->issue_report_id) {
                $this->resetLinkedIssueReports($ticket, 'Resolved');
            }

            // Same permanent audit trail the old closeTicket() always wrote —
            // without this, a ticket closed through this endpoint would
            // silently vanish from the Ticket Archive Log / "View Archives"
            // screen (TicketController::archives()) that every other closed
            // ticket appears in.
            $ticket->refresh()->load('subIssues');
            $this->archiveCompleted($ticket, $request->user()->id, 'Closed');

            // A ticket auto-created from a due Maintenance Schedule finishes
            // that schedule too — otherwise it stays "Scheduled" forever
            // (counted overdue) and a recurring service never seeds its next
            // occurrence. Same call the old closeTicket() always made.
            $this->completeLinkedSchedule($ticket, $request->user()->id);

            $ticket->vehicle->update(['readiness_invalidated_at' => now()]);
            $this->recomputeVehicleStatus($ticket->vehicle_id, $request);
            $this->history($ticket->vehicle, 'Ticket Closed', 'Repair independently verified and ticket closed. A fresh readiness check is required.', 'maintenance_tickets', $ticket->ticket_id, $request);

            $this->log(
                $request,
                'Ticket Verified & Closed',
                "Ticket #{$ticket->display_number} ({$ticket->ticket_title}) verified by Custodian and closed.",
                $ticket->ticket_id
            );

            $vehicleName = $ticket->vehicle->vehicle_name;
            $this->notifyTicketMechanics(
                $ticket,
                'Repair Verified & Closed',
                "Your repair work on Ticket #{$ticket->display_number} ({$vehicleName}) was verified and the ticket is now closed.",
                'ticket_verified',
                $ticket->ticket_id
            );
            // Admin isn't in the verification loop, so tell them it closed
            // (the Maintenance Tickets sidebar badge also counts it).
            $this->notifyAdmins(
                'Ticket Closed',
                "Ticket #{$ticket->display_number} ({$vehicleName}) was verified by {$request->user()->name} and is now closed.",
                'ticket_closed',
                $ticket->ticket_id,
                $ticket->vehicle->barangay_id
            );
        });

        return response()->json($ticket->fresh($this->eagerLoads()));
    }

    private function notifyTicketMechanics(MaintenanceTicket $ticket, string $title, string $message, string $type, int $ticketId): void
    {
        foreach ($ticket->subIssues()->pluck('assigned_mechanic_id')->push($ticket->assigned_mechanic_id)->filter()->unique() as $mechanicId) {
            $this->notifyUser($mechanicId, $title, $message, $type, $ticketId);
        }
    }

    /**
     * The Custodian's functional test failed — the ticket goes back to its
     * repair stage through the normal workflow, not a frontend status flip:
     * ticket Active again, each logged line item Under Repair again (the
     * only state logRepairs() accepts), with the Rejected verdict, the
     * checklist result, who/when and the Custodian's notes recorded on
     * every one. The same mechanic is notified with what failed; once they
     * re-log, advanceToVerificationIfReady() brings it back to this same
     * Custodian. Called from verifyTicket() after all its guards passed.
     */
    private function returnTicketForRepair(MaintenanceTicket $ticket, Request $request, array $data, ?array $functionalTest, $failedChecks)
    {
        DB::transaction(function () use ($ticket, $request, $data, $functionalTest, $failedChecks) {
            $locked = $this->lockTicket($ticket, $request);
            abort_unless($locked && $locked->status === 'For Verification', 422, 'This ticket was already verified or changed.');

            $notes = $data['verification_notes'] ?? null;
            $failedIds = $data['failed_sub_issue_ids'] ?? $ticket->subIssues->pluck('sub_issue_id')->all();
            $recipients = collect();
            foreach (TicketSubIssue::where('ticket_id', $ticket->ticket_id)->whereIn('sub_issue_id', $failedIds)->where('status', 'For Inspection')->get() as $subIssue) {
                $this->workEvent($subIssue, $request, 'Returned for Rework', ['notes' => $notes, 'functional_test' => $functionalTest]);
                if ($subIssue->repair_type === 'external') {
                    $recipients = $recipients->merge([$subIssue->external_handled_by, $subIssue->external_received_by, $ticket->assigned_custodian_id]);
                } else {
                    $recipients->push($subIssue->assigned_mechanic_id);
                }
                $subIssue->update([
                    'status'               => 'Under Repair',
                    'verification_verdict' => 'Rejected',
                    'verification_notes'   => $notes,
                    'verified_by'          => $request->user()->id,
                    'verified_at'          => now(),
                    'repair_completed_at'  => null,
                    'functional_test'      => $functionalTest,
                    'test_attested'        => false,
                ]);
            }

            $locked->update(['status' => 'Active']);

            $reason = collect([
                $failedChecks->isNotEmpty() ? 'Failed checks: ' . $failedChecks->implode(', ') : null,
                $notes ? "Notes: {$notes}" : null,
            ])->filter()->implode('. ');

            $this->log(
                $request,
                'Verification Failed — Returned for Repair',
                "Ticket #{$ticket->display_number} ({$ticket->ticket_title}) failed Custodian verification and was returned for repair. {$reason}",
                $ticket->ticket_id
            );

            foreach ($recipients->filter()->unique() as $recipient) $this->notifyUser(
                $recipient,
                'Repair Returned for Rework',
                "{$request->user()->name} returned Ticket #{$ticket->display_number} ({$ticket->vehicle->vehicle_name}) for repair after verification. {$reason}",
                'repairs_rejected',
                $ticket->ticket_id
            );
        });

        return response()->json($ticket->fresh($this->eagerLoads()));
    }

    /** Decline preserves the proposal; reconsideration requires undecline before approval. */
    public function declineTicket(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.decline');
        $data = $request->validate(['decline_reason' => ['required', 'string', 'max:5000']]);
        return DB::transaction(function () use ($request, $ticket, $data) {
            $ticket = $this->lockTicket($ticket, $request);
            abort_unless($ticket->status === 'Pending Approval', 422, 'Only an unapproved proposal can be declined.');
            $this->decisionEvent($ticket, $request, 'Declined', ['reason' => $data['decline_reason']]);
            $ticket->update(['status' => 'Declined', 'decline_reason' => $data['decline_reason'], 'correction_reason' => null, 'correction_requested_at' => null]);
            $this->resetLinkedIssueReports($ticket, 'Pending');
            $this->log($request, 'Decline Ticket', "Ticket #{$ticket->display_number} declined. Reason: {$data['decline_reason']}", $ticket->ticket_id);
            $this->notifyUser($ticket->assigned_custodian_id, 'Ticket Proposal Declined', "Ticket #{$ticket->display_number} was declined. Reason: {$data['decline_reason']}. This does not certify that the reported defect is repaired. The vehicle stays marked Needs Repair. Record a new Condition Check with the result Good to clear it.", 'ticket_declined', $ticket->ticket_id);
            return response()->json($ticket->fresh($this->eagerLoads()));
        });
    }

    public function undeclineTicket(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.decline');
        return DB::transaction(function () use ($request, $ticket) {
            $ticket = $this->lockTicket($ticket, $request);
            abort_unless($ticket->status === 'Declined', 422, 'Only a Declined proposal can be reconsidered.');
            $this->assertSourcesAvailable($ticket);
            $this->assertNoDuplicateProposal($ticket);
            $this->decisionEvent($ticket, $request, 'Undeclined', ['previous_reason' => $ticket->decline_reason]);
            $ticket->update(['status' => 'Pending Approval', 'decline_reason' => null]);
            $this->resetLinkedIssueReports($ticket, 'In Maintenance');
            $this->log($request, 'Undecline Ticket', "Ticket #{$ticket->display_number} restored to Pending Approval.", $ticket->ticket_id);
            $this->notifyUser($ticket->assigned_custodian_id, 'Ticket Proposal Reconsidered', "Ticket #{$ticket->display_number} is back under Admin review. Work has not been approved yet.", 'ticket_proposed', $ticket->ticket_id);
            return response()->json($ticket->fresh($this->eagerLoads()));
        });
    }

    public function requestCorrections(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.request_corrections');
        $data = $request->validate(['correction_reason' => ['required', 'string', 'max:5000']]);
        return DB::transaction(function () use ($request, $ticket, $data) {
            $ticket = $this->lockTicket($ticket, $request);
            abort_unless($ticket->status === 'Pending Approval' && !$ticket->correction_requested_at, 422, 'Only a proposal awaiting Admin review can be returned for corrections.');
            abort_if($this->hasRepairEvidence($ticket), 422, 'Work evidence already exists; this proposal cannot be rewritten.');
            $this->decisionEvent($ticket, $request, 'Corrections Requested', ['reason' => $data['correction_reason']]);
            $ticket->update(['correction_reason' => $data['correction_reason'], 'correction_requested_at' => now()]);
            $this->log($request, 'Request Ticket Corrections', "Ticket #{$ticket->display_number}: {$data['correction_reason']}", $ticket->ticket_id);
            $this->notifyUser($ticket->assigned_custodian_id, 'Ticket Corrections Requested', "Please revise Ticket #{$ticket->display_number}: {$data['correction_reason']}", 'ticket_corrections_requested', $ticket->ticket_id);
            return response()->json($ticket->fresh($this->eagerLoads()));
        });
    }

    public function resubmitProposal(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.resubmit');
        $data = $request->validate([
            'ticket_description' => ['required', 'string'],
            'priority' => ['required', Rule::in($this->priorities)],
            'sub_issues' => ['required', 'array', 'min:1'],
            'sub_issues.*.sub_issue_id' => ['required', 'integer', 'distinct'],
            'sub_issues.*.title' => ['required', 'string', 'max:255'],
            'sub_issues.*.maintenance_type' => ['nullable', 'string', 'max:150'],
            'external_work_scope' => ['nullable', 'string', 'max:5000'],
            'external_reason' => ['nullable', Rule::in($this->externalReasons())],
        ]);
        return DB::transaction(function () use ($request, $ticket, $data) {
            $ticket = $this->lockTicket($ticket, $request);
            abort_unless((int) $ticket->assigned_custodian_id === (int) $request->user()->id, 403, 'Only the assigned Custodian can revise this proposal.');
            abort_unless($ticket->status === 'Pending Approval' && $ticket->correction_requested_at, 422, 'This proposal is not awaiting corrections.');
            abort_if($this->hasRepairEvidence($ticket), 422, 'Recorded repair evidence cannot be rewritten.');
            $this->assertSourcesAvailable($ticket);
            $items = $ticket->subIssues;
            abort_unless(collect($data['sub_issues'])->pluck('sub_issue_id')->sort()->values()->all() === $items->pluck('sub_issue_id')->sort()->values()->all(), 422, 'Include each existing work item exactly once.');
            $changed = $ticket->ticket_description !== $data['ticket_description'] || $ticket->priority !== $data['priority'];
            foreach ($data['sub_issues'] as $row) {
                $item = $items->firstWhere('sub_issue_id', $row['sub_issue_id']);
                $changed = $changed || $item->title !== $row['title'] || ($item->maintenance_type ?? '') !== ($row['maintenance_type'] ?? '');
                if ($item->repair_type === 'external') $changed = $changed || $item->external_work_scope !== ($data['external_work_scope'] ?? null) || $item->external_reason !== ($data['external_reason'] ?? null);
            }
            abort_unless($changed, 422, 'Make the requested correction before resubmitting this proposal.');
            $this->decisionEvent($ticket, $request, 'Proposal Resubmitted', ['previous_proposal' => $ticket->only(['ticket_description', 'priority', 'ticket_title', 'correction_reason']), 'previous_items' => $items->map->only(['sub_issue_id', 'title', 'maintenance_type', 'external_reason', 'external_work_scope'])->all()]);
            foreach ($data['sub_issues'] as $row) {
                $item = $items->firstWhere('sub_issue_id', $row['sub_issue_id']);
                $patch = ['title' => $row['title'], 'maintenance_type' => $row['maintenance_type'] ?? null];
                if ($item->repair_type === 'external') {
                    abort_if(blank($data['external_work_scope'] ?? null) || blank($data['external_reason'] ?? null), 422, 'External work needs a reason and scope.');
                    $patch += ['external_work_scope' => $data['external_work_scope'], 'external_reason' => $data['external_reason']];
                }
                $item->update($patch);
            }
            $first = $ticket->subIssues()->orderBy('sub_issue_id')->first();
            $summary = $first->title;
            $ticket->update(['ticket_description' => $data['ticket_description'], 'priority' => $data['priority'], 'ticket_title' => MaintenanceTicket::composeTitle($ticket->barangay_number ?? $ticket->ticket_id, $ticket->vehicle->vehicle_name, $summary), 'correction_requested_at' => null, 'correction_reason' => null]);
            $this->assertNoDuplicateProposal($ticket);
            $this->log($request, 'Resubmit Ticket Proposal', "Ticket #{$ticket->display_number} corrected by the assigned Custodian; awaiting fresh Admin review.", $ticket->ticket_id);
            $this->notifyAdmins('Ticket Proposal Resubmitted', "Ticket #{$ticket->display_number} was corrected and needs your review.", 'ticket_resubmitted', $ticket->ticket_id, $ticket->vehicle->barangay_id);
            return response()->json($ticket->fresh($this->eagerLoads()));
        });
    }

    // ===================================================================
    // PHASE 2 — Custodian: Submit Inspection, Populate Sub-Issues
    // ===================================================================

    // ===================================================================
    // PHASE 3 — Admin: Assign Mechanic to a Sub-Issue (Work Order)
    // ===================================================================

    // ===================================================================
    // Admin: Reassign the ticket's Custodian
    // ===================================================================

    /**
     * The Custodian chosen at creation is hard-locked as BOTH the inspector
     * (submitInspection) and the verifier (verifyRepair, via each sub-issue's
     * verification_assigned_to). Without this endpoint, that person going on
     * leave or leaving the barangay strands the ticket permanently: nobody
     * else can inspect it, nobody else can verify its repairs, and a ticket
     * still sitting at Open can't even be closed (closeTicket requires
     * Active) — the only exits were cancel or delete.
     *
     * Deliberately narrow, mirroring reassignMechanic(): this changes WHO is
     * responsible and nothing else. It cannot touch status, verdicts, costs,
     * or sub-issue content, so it can't be used to rewrite history.
     */
    public function reassignCustodian(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.reassign_custodian');

        // Allowed while Open (stuck awaiting inspection — the main case this
        // exists for) or Active. A finished ticket is left alone: reassigning
        // responsibility for completed work would only muddy the audit trail.
        abort_if(
            in_array($ticket->status, ['Closed', 'Cancelled'], true),
            422,
            "A {$ticket->status} ticket's Custodian cannot be reassigned."
        );

        $data = $request->validate([
            'assigned_custodian_id' => ['required', 'exists:users,id'],
            'reassign_reason'       => ['required', 'string'],
        ], [
            'reassign_reason.required' => 'A reason is required so the audit trail shows why responsibility moved.',
        ]);

        $newCustodian = User::findOrFail($data['assigned_custodian_id']);
        abort_unless($newCustodian->is_active && $newCustodian->hasRole('Custodian'), 422, 'The selected user is not a Custodian.');
        abort_unless($newCustodian->barangay_id === $ticket->vehicle->barangay_id, 422, 'The selected Custodian does not belong to this barangay.');
        abort_if($newCustodian->id === $ticket->assigned_custodian_id, 422, 'That Custodian is already assigned to this ticket.');

        $previousCustodianId = $ticket->assigned_custodian_id;

        // Not blocked, same reasoning as assignMechanic()'s equivalent
        // check — but checked the other way around: does the incoming
        // Custodian already have a still-open work order of their own on
        // THIS ticket? 'Done' is excluded — that repair is already
        // verified, so there's no self-verification risk left to warn about.
        $conflictingSubIssueTitles = $ticket->subIssues()->get()->filter(function ($item) use ($newCustodian) {
            $ids = collect($item->prior_mechanic_ids ?? [])->push($item->assigned_mechanic_id);
            return $item->status !== 'Done' && $ids->filter()->contains(fn ($id) => (int) $id === (int) $newCustodian->id);
        })->pluck('title');
        $selfVerificationWarning = $conflictingSubIssueTitles->isNotEmpty()
            ? "{$newCustodian->name} has performed or handled repair work on: {$conflictingSubIssueTitles->implode(', ')}. They won't be able to verify their own repair there — reassign those sub-issues to a different mechanic, or this ticket to a different Custodian."
            : null;

        DB::transaction(function () use ($ticket, $data, $request, $newCustodian, $previousCustodianId, $selfVerificationWarning) {
            $ticket = $this->lockTicket($ticket, $request);
            abort_if(in_array($ticket->status, ['Closed', 'Cancelled'], true), 422, 'This ticket is no longer open for reassignment.');
            $previousCustodianId = $ticket->assigned_custodian_id;
            $previousName = User::find($previousCustodianId)?->name ?? 'the previous Custodian';

            $ticket->update(['assigned_custodian_id' => $newCustodian->id]);

            // Sub-issues already handed off for verification have the OLD
            // custodian stamped on them (logRepairs copies it at that moment),
            // and verifyRepair matches on that stamp — so without this cascade
            // the reassignment wouldn't actually unstick those verifications.
            // Sub-issues not yet at that stage need nothing: they'll pick up
            // the new custodian from the ticket when they reach logRepairs.
            $cascaded = $ticket->subIssues()
                ->whereIn('status', ['For Inspection', 'Pending Approval'])
                ->update(['verification_assigned_to' => $newCustodian->id]);

            $vehicleName = $ticket->vehicle->vehicle_name;
            $this->log(
                $request,
                'Custodian Reassigned',
                "Ticket #{$ticket->display_number} — Custodian reassigned from {$previousName} to {$newCustodian->name}."
                . ($cascaded > 0 ? " {$cascaded} pending verification(s) moved with it." : '')
                . " Reason: {$data['reassign_reason']}"
                . ($selfVerificationWarning ? " ⚠ {$selfVerificationWarning}" : ''),
                $ticket->ticket_id
            );

            $this->notifyUser(
                $newCustodian->id,
                'Ticket Reassigned to You',
                "You are now the Custodian for Ticket #{$ticket->display_number} ({$vehicleName})."
                . ($cascaded > 0 ? " {$cascaded} repair(s) are awaiting your verification." : ''),
                'ticket_reassigned',
                $ticket->ticket_id
            );

            if ($previousCustodianId) {
                $this->notifyUser(
                    $previousCustodianId,
                    'Ticket Reassigned',
                    "Ticket #{$ticket->display_number} ({$vehicleName}) was reassigned to {$newCustodian->name}.",
                    'ticket_reassigned',
                    $ticket->ticket_id
                );
            }
        });

        $response = $ticket->fresh($this->eagerLoads())->toArray();
        if ($selfVerificationWarning) {
            $response['warning'] = $selfVerificationWarning;
        }

        return $response;
    }

    // ===================================================================
    // PHASE 3 — Mechanic: Log Repair on a Sub-Issue
    // ===================================================================

    /**
     * Sub-issues can be added, renamed and removed after the inspection, but
     * only while they are still plain "Open" — no mechanic dispatched, no work
     * started — so nobody's recorded work is ever edited out from under them.
     * Only Admin may change active work items; Custodians propose and verify.
     */
    private function authorizeSubIssueEdit(Request $request, MaintenanceTicket $ticket): void
    {
        $this->requireAbility($request, 'subissue.manage');
        if (!$request->user()->hasRole('Admin')) {
            abort_unless($ticket->assigned_custodian_id === $request->user()->id, 403, 'This ticket is not assigned to you.');
        }
        abort_unless($ticket->status === 'Active', 422, "Sub-issues can only be changed while the ticket is Active. Current status: {$ticket->status}.");
    }

    public function addSubIssue(Request $request, MaintenanceTicket $ticket)
    {
        $this->authorizeSubIssueEdit($request, $ticket);

        $data = $request->validate([
            'title' => ['required', 'string', 'max:255'],
            'maintenance_type' => ['nullable', 'string', 'max:150'],
            'assigned_mechanic_id' => ['nullable', 'integer', 'exists:users,id'],
        ]);

        $mechanicId = $data['assigned_mechanic_id'] ?? $ticket->assigned_mechanic_id;
        abort_unless($mechanicId, 422, 'Choose a mechanic for this additional repair.');
        $mechanic = User::findOrFail($mechanicId);
        abort_unless($mechanic->is_active && $mechanic->hasRole('Maintenance Personnel') && $mechanic->barangay_id === $ticket->vehicle->barangay_id, 422, 'Choose active Maintenance Personnel from this barangay.');

        $subIssue = TicketSubIssue::create([
            'ticket_id' => $ticket->ticket_id,
            'created_by' => $request->user()->id,
            'title' => $data['title'],
            'maintenance_type' => !empty($data['maintenance_type']) ? MaintenanceType::resolve($data['maintenance_type']) : null,
            'status' => 'Under Repair',
            'assigned_mechanic_id' => $mechanicId,
            'mechanic_assigned_at' => now(),
            'mechanic_assigned_by' => $request->user()->id,
        ]);
        $this->log($request, 'Sub-issue Added', "Ticket #{$ticket->display_number} — added sub-issue \"{$subIssue->title}\".", $ticket->ticket_id);

        return response()->json($subIssue, 201);
    }

    public function updateSubIssue(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->authorizeSubIssueEdit($request, $ticket);
        $this->assertBelongsToTicket($ticket, $subIssue);
        abort_unless(in_array($subIssue->status, ['Open', 'Under Repair'], true), 422, 'Only a sub-issue that has not had repairs logged yet can be edited.');

        $data = $request->validate([
            'title' => ['required', 'string', 'max:255'],
            'maintenance_type' => ['nullable', 'string', 'max:150'],
        ]);

        $old = $subIssue->title;
        $subIssue->update([
            'title' => $data['title'],
            'maintenance_type' => !empty($data['maintenance_type']) ? MaintenanceType::resolve($data['maintenance_type']) : null,
        ]);
        $this->log($request, 'Sub-issue Edited', "Ticket #{$ticket->display_number} — sub-issue \"{$old}\" updated to \"{$subIssue->title}\".", $ticket->ticket_id);

        return $subIssue->fresh();
    }

    public function deleteSubIssue(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->authorizeSubIssueEdit($request, $ticket);
        $this->assertBelongsToTicket($ticket, $subIssue);
        abort_unless(in_array($subIssue->status, ['Open', 'Under Repair'], true), 422, 'Only a sub-issue that has not had repairs logged yet can be removed.');
        abort_if(TicketSubIssue::where('ticket_id', $ticket->ticket_id)->count() <= 1, 422, 'A ticket needs at least one sub-issue. Cancel the ticket instead.');

        DB::transaction(function () use ($request, $ticket, $subIssue) {
            $this->log($request, 'Sub-issue Removed', "Ticket #{$ticket->display_number} — removed sub-issue \"{$subIssue->title}\".", $ticket->ticket_id);
            $subIssue->delete();
            // Removing the one line still waiting on the mechanic can leave
            // every remaining repair logged — same hand-off logRepairs() makes.
            $this->advanceToVerificationIfReady($ticket, $request);
        });

        return response()->json(['message' => 'Sub-issue removed.']);
    }

    // ===================================================================
    // Cannibalized repair — donor vehicle + its parts (CRUD)
    // ===================================================================

    /**
     * Who may change a cannibalized repair's donor details: the assigned
     * mechanic, while the work order is still being repaired. Once the repair
     * is logged (For Inspection and beyond) the parts are history and locked.
     */
    private function authorizeDonorEdit(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue): void
    {
        $this->requireAbility($request, 'subissue.log_repair');
        $this->assertBelongsToTicket($ticket, $subIssue);
        abort_unless((int) $subIssue->assigned_mechanic_id === (int) $request->user()->id, 403, 'This work order is not assigned to you.');
        abort_unless($ticket->status === 'Active', 422, "Donor parts can only be changed while the ticket is Active. Current status: {$ticket->status}.");
        abort_unless($subIssue->status === 'Under Repair', 422, 'This repair has already been logged, so its donor parts are locked.');
        abort_if($subIssue->repair_type === 'external', 422, 'An external-shop repair cannot use donor parts.');
    }

    /** Parts are only taken from vehicles that are no longer in use (retired / decommissioned). */
    private function assertRetiredDonor(?int $donorId): void
    {
        if (! $donorId) {
            return;
        }
        $donor = Vehicle::find($donorId);
        abort_if(! $donor, 422, 'The donor vehicle no longer exists.');
        abort_unless(
            in_array($donor->status, ['Inactive', 'Decommissioned'], true),
            422,
            "{$donor->vehicle_name} is still in use. Parts can only be taken from a retired (decommissioned) vehicle."
        );
    }

    private function assertDonorEligible(MaintenanceTicket $ticket, ?int $donorId): Vehicle
    {
        abort_if(!$donorId, 422, 'Choose the donor vehicle first.');
        $donor = Vehicle::find($donorId);
        abort_if(!$donor, 422, 'The donor vehicle no longer exists.');
        abort_if((int) $donor->vehicle_id === (int) $ticket->vehicle_id, 422, 'The donor vehicle must be a different vehicle from the one being repaired.');
        abort_unless($donor->barangay_id === $ticket->vehicle->barangay_id, 422, 'The donor vehicle must be in the same barangay.');
        $this->assertRetiredDonor((int) $donor->vehicle_id);

        return $donor;
    }

    /** Choose (or clear) the donor vehicle. Clearing is refused while parts exist. */
    public function setDonorVehicle(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->authorizeDonorEdit($request, $ticket, $subIssue);
        $data = $request->validate([
            'source_vehicle_id' => ['nullable', 'exists:vehicles,vehicle_id'],
            'keep_cannibalized' => ['sometimes', 'boolean'],
        ]);

        if (empty($data['source_vehicle_id'])) {
            abort_if($subIssue->donorParts()->exists(), 422, 'Remove the donor parts before removing the last donor vehicle.');
            $subIssue->update(['repair_type' => ($data['keep_cannibalized'] ?? false) ? 'cannibalized' : 'in_house', 'source_vehicle_id' => null]);
        } else {
            $this->assertDonorEligible($ticket, (int) $data['source_vehicle_id']);
            $subIssue->update(['repair_type' => 'cannibalized', 'source_vehicle_id' => $data['source_vehicle_id']]);
        }
        $this->log($request, 'Donor Vehicle Set', "Ticket #{$ticket->display_number} - sub-issue \"{$subIssue->title}\" repair method is now {$subIssue->repair_type}.", $ticket->ticket_id);

        return $subIssue->fresh(['donorParts', 'sourceVehicle:vehicle_id,vehicle_name,plate_number']);
    }

    private function donorPartRules(): array
    {
        return [
            'donor_vehicle_id' => ['nullable', 'integer', 'exists:vehicles,vehicle_id'],
            'part_name'      => ['required', 'string', 'max:255'],
            'quantity'       => ['required', 'integer', 'min:1', 'max:100000'],
            'blocks_readiness' => ['nullable', 'boolean'],
            'part_condition' => ['nullable', 'string', 'max:100'],
            'installed_at'   => ['nullable', 'date', 'before_or_equal:today'],
            'reason'         => ['nullable', 'string', 'max:2000'],
            'notes'          => ['nullable', 'string', 'max:2000'],
        ];
    }

    private function requireDonorSet(MaintenanceTicket $ticket, TicketSubIssue $subIssue): void
    {
        abort_unless($subIssue->repair_type === 'cannibalized' && $subIssue->source_vehicle_id, 422, 'Choose the donor vehicle before adding parts.');
        $this->assertDonorEligible($ticket, (int) $subIssue->source_vehicle_id);
    }

    public function storeDonorPart(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->authorizeDonorEdit($request, $ticket, $subIssue);
        $this->requireDonorSet($ticket, $subIssue);
        $data = $request->validate($this->donorPartRules());

        // Which donor this part came from — the repair's first donor unless
        // another one is named (a repair may draw parts from several vehicles).
        $data['donor_vehicle_id'] = $data['donor_vehicle_id'] ?? $subIssue->source_vehicle_id;
        $this->assertDonorEligible($ticket, (int) $data['donor_vehicle_id']);

        // A part that is still missing from a vehicle cannot be taken from it again. Raise the quantity
        // instead, or mark the first one restored. (This stops the same transmission being recorded twice,
        // whether it was logged on a ticket or in a cannibalization record.)
        abort_if(
            CannibalizationPart::stillMissing((int) $data['donor_vehicle_id'], $data['part_name']),
            422,
            "{$data['part_name']} is already logged as removed from that donor vehicle and has not been put back. Mark it restored before taking it again, or raise the quantity on the existing entry."
        );

        // A retired vehicle is already out of the fleet, so its parts never hold anything up.
        $donorRetired = in_array(Vehicle::find($data['donor_vehicle_id'])?->status, ['Inactive', 'Decommissioned'], true);
        $data['blocks_readiness'] = $donorRetired ? false : (bool) ($data['blocks_readiness'] ?? true);

        $part = $subIssue->donorParts()->create($data);
        $this->log($request, 'Donor Part Added', "Ticket #{$ticket->display_number} - added {$part->quantity} x {$part->part_name} from the donor vehicle.", $ticket->ticket_id);

        return response()->json($part, 201);
    }

    public function updateDonorPart(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue, int $part)
    {
        $this->authorizeDonorEdit($request, $ticket, $subIssue);
        $this->requireDonorSet($ticket, $subIssue);
        $record = $subIssue->donorParts()->where('part_id', $part)->firstOrFail();
        $data = $request->validate($this->donorPartRules());
        // A part stays with the donor it was recorded against.
        unset($data['donor_vehicle_id']);
        $record->update($data);
        $this->log($request, 'Donor Part Updated', "Ticket #{$ticket->display_number} - updated donor part {$record->part_name}.", $ticket->ticket_id);

        return $record->fresh();
    }

    public function deleteDonorPart(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue, int $part)
    {
        $this->authorizeDonorEdit($request, $ticket, $subIssue);
        $record = $subIssue->donorParts()->where('part_id', $part)->firstOrFail();
        $name = $record->part_name;
        $record->delete();
        $this->log($request, 'Donor Part Removed', "Ticket #{$ticket->display_number} - removed donor part {$name}.", $ticket->ticket_id);

        return response()->json(['message' => 'Donor part removed.']);
    }

    /**
     * The assigned mechanic may always act on their own work order. An
     * EXTERNAL-shop work order with no in-house mechanic is handled by the
     * ticket's own Custodian (ability external.handle): they log the vehicle
     * going to the shop and receiving it back, then test it and close the
     * ticket by verifying. The Admin only approves the proposal.
     */
    private function authorizeWorkOrderActor(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue): void
    {
        $uid = $request->user()->id;
        if ($subIssue->assigned_mechanic_id && (int) $subIssue->assigned_mechanic_id === (int) $uid) {
            $this->requireAbility($request, 'subissue.log_repair');
            return;
        }
        // Work that came back from an outside shop is tested by Maintenance Personnel, who know
        // the vehicle. The Custodian only records the hand-over and later verifies.
        $externalNoMechanic = $subIssue->repair_type === 'external' && !$subIssue->assigned_mechanic_id;
        abort_unless($externalNoMechanic, 403, 'This work order is not assigned to you.');
        abort_if(
            $subIssue->external_tester_id && (int) $subIssue->external_tester_id !== (int) $uid,
            403,
            'This shop test is assigned to ' . ($subIssue->externalTester?->name ?? 'another Maintenance Personnel') . '.'
        );
        abort_unless($request->user()->hasRole('Maintenance Personnel'), 403, 'After the shop returns the vehicle, a Maintenance Personnel must test it. The Custodian then verifies it.');
        $this->requireAbility($request, 'subissue.log_repair');
    }

    /** The responsible person hands the vehicle (or part) to an outside shop. */
    public function markExternalSent(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        return DB::transaction(function () use ($request, $ticket, $subIssue) {
            $ticket = $this->lockTicket($ticket, $request);
            $subIssue = TicketSubIssue::whereKey($subIssue->sub_issue_id)->lockForUpdate()->firstOrFail();
            abort_unless($ticket->status === 'Active', 422, 'External shop actions require an Active ticket.');
            return $this->markExternalSentLocked($request, $ticket, $subIssue);
        });
    }

    private function markExternalSentLocked(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->assertBelongsToTicket($ticket, $subIssue);
        $this->requireAbility($request, 'external.handle');
        abort_unless((int) $ticket->assigned_custodian_id === (int) $request->user()->id, 403, 'Only the Custodian assigned to this ticket can record the shop handling.');
        abort_unless($subIssue->repair_type === 'external' && !$subIssue->assigned_mechanic_id, 422, 'Only approved external work can be sent to a shop.');
        abort_unless($subIssue->status === 'Under Repair', 422, "Only an Under Repair sub-issue can be sent out. Current: {$subIssue->status}.");
        $resending = $subIssue->external_sent_at && $subIssue->external_returned_at && $subIssue->verification_verdict === 'Rejected';
        abort_if($subIssue->external_sent_at && !$resending, 422, 'This repair has already been sent out.');

        $data = $request->validate([
            'external_vendor' => ['required', 'string', 'max:255'],
            'external_reason' => ['required', 'string', 'max:255'],
            'external_work_scope' => ['required', 'string'],
            'external_shop_contact' => ['nullable', 'regex:/^09[0-9]{9}$/'],
            'external_shop_address' => ['nullable', 'string', 'max:255'],
            'external_contact_person' => ['nullable', 'string', 'max:255'],
            'external_estimated_cost' => ['nullable', 'numeric', 'min:0'],
            'external_expected_return' => ['nullable', 'date'],
        ]);

        if ($resending) {
            $cycles = $subIssue->external_cycles ?? [];
            $cycles[] = $subIssue->only(['external_vendor', 'external_reason', 'external_work_scope', 'external_sent_at', 'external_returned_at', 'external_return_notes', 'external_actual_cost', 'external_handled_by', 'external_received_by', 'warranty_until', 'verification_notes']);
            $subIssue->update(['external_cycles' => $cycles]);
        }
        $this->workEvent($subIssue, $request, 'Sent to External Shop', $data);
        // Accountable handler is the signed-in Custodian; retain any separately named transporter.
        $subIssue->update($data + [
            'repair_type' => 'external',
            'external_sent_at' => now(),
            'external_sent_by' => $subIssue->external_sent_by ?: $request->user()->name,
            'external_returned_at' => null, 'external_return_notes' => null,
            'external_actual_cost' => null, 'external_received_by' => null,
            'maintenance_cost' => null, 'verification_verdict' => null,
            'external_handled_by' => $request->user()->id,
        ]);
        $this->log($request, 'Sent Out', "Ticket #{$ticket->display_number} — sub-issue \"{$subIssue->title}\" sent to {$data['external_vendor']}.", $ticket->ticket_id);

        return $subIssue->fresh();
    }

    /** The shop returns it; the mechanic records the outcome before writing up the repair. */
    public function markExternalReturned(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        return DB::transaction(function () use ($request, $ticket, $subIssue) {
            $ticket = $this->lockTicket($ticket, $request);
            $subIssue = TicketSubIssue::whereKey($subIssue->sub_issue_id)->lockForUpdate()->firstOrFail();
            abort_unless($ticket->status === 'Active', 422, 'External shop actions require an Active ticket.');
            return $this->markExternalReturnedLocked($request, $ticket, $subIssue);
        });
    }

    private function markExternalReturnedLocked(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->assertBelongsToTicket($ticket, $subIssue);
        $this->requireAbility($request, 'external.handle');
        abort_unless((int) $ticket->assigned_custodian_id === (int) $request->user()->id, 403, 'Only the Custodian assigned to this ticket can record the shop handling.');
        abort_unless($subIssue->repair_type === 'external' && $subIssue->status === 'Under Repair', 422, 'Only unfinished external work can be received.');
        abort_unless($subIssue->external_sent_at, 422, 'This repair has not been sent out yet.');
        abort_if($subIssue->external_returned_at, 422, 'This repair has already been marked returned.');

        $data = $request->validate([
            'external_return_notes' => ['required', 'string'],
            'external_actual_cost' => ['nullable', 'numeric', 'min:0'],
            'warranty_until' => ['nullable', 'date'],
        ]);

        $costs = collect($subIssue->external_cycles ?? [])->pluck('external_actual_cost')->push($data['external_actual_cost'] ?? null);
        $this->workEvent($subIssue, $request, 'Returned from External Shop', $data);
        $subIssue->update($data + ['external_returned_at' => now(), 'external_received_by' => $request->user()->id, 'maintenance_cost' => $costs->contains(fn ($cost) => $cost === null) ? null : $costs->sum()]);
        $this->log($request, 'Returned From Shop', "Ticket #{$ticket->display_number} — sub-issue \"{$subIssue->title}\" returned from {$subIssue->external_vendor}.", $ticket->ticket_id);

        return $subIssue->fresh();
    }

    /**
     * The Maintenance Personnel inspected the vehicle and found nothing to repair. The ticket does
     * not need a repair: it goes to the Custodian to verify and close, and no maintenance record is
     * written (nothing was maintained).
     */
    public function noRepairNeeded(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        return DB::transaction(function () use ($request, $ticket, $subIssue) {
            $ticket = $this->lockTicket($ticket, $request);
            $subIssue = TicketSubIssue::whereKey($subIssue->sub_issue_id)->lockForUpdate()->firstOrFail();
            $this->assertBelongsToTicket($ticket, $subIssue);
            $this->authorizeWorkOrderActor($request, $ticket, $subIssue);
            abort_unless($ticket->status === 'Active', 422, "A ticket can only be returned while it is Active. Current status: {$ticket->status}.");
            abort_unless($subIssue->status === 'Under Repair', 422, "Only an Under Repair item can be marked as needing no repair. Current: {$subIssue->status}.");
            abort_if($subIssue->repair_type === 'external' && $subIssue->external_sent_at, 422, 'This item was sent to an outside shop. Record its return and test it instead.');

            $data = $request->validate(['notes' => ['required', 'string', 'min:5', 'max:2000']], [
                'notes.required' => 'Explain what you checked and why no repair is needed.',
                'notes.min' => 'Explain what you checked and why no repair is needed (at least 5 characters).',
            ]);

            $this->workEvent($subIssue, $request, 'No Repair Needed', ['notes' => $data['notes']]);
            $subIssue->update([
                'status' => 'For Inspection',
                'no_repair_needed' => true,
                'mechanic_tested_at' => now(),
                'mechanic_tested_by' => $request->user()->id,
                'mechanic_test_notes' => $data['notes'],
                'verification_assigned_to' => $ticket->assigned_custodian_id,
                'repair_logs' => '[' . now()->toIso8601String() . '] No repair needed: ' . $data['notes'],
                'repair_completed_at' => now('Asia/Manila')->toDateString(),
                'verification_verdict' => null,
            ]);
            $this->log($request, 'No Repair Needed', "Ticket #{$ticket->display_number} — sub-issue \"{$subIssue->title}\" inspected: no repair needed.", $ticket->ticket_id);
            $this->notifyAdmins(
                'No Repair Needed',
                "{$request->user()->name} inspected \"{$subIssue->title}\" on Ticket #{$ticket->display_number} ({$ticket->vehicle->vehicle_name}) and found no repair needed. The Custodian will verify and close it.",
                'no_repair_needed',
                $ticket->ticket_id,
                $ticket->vehicle->barangay_id
            );
            $this->advanceToVerificationIfReady($ticket, $request);

            return $subIssue->fresh();
        });
    }

    public function logRepairs(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        return DB::transaction(function () use ($request, $ticket, $subIssue) {
            $ticket = $this->lockTicket($ticket, $request);
            $subIssue = TicketSubIssue::whereKey($subIssue->sub_issue_id)->lockForUpdate()->firstOrFail();
            return $this->logRepairsLocked($request, $ticket, $subIssue);
        });
    }

    private function logRepairsLocked(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->assertBelongsToTicket($ticket, $subIssue);
        $this->authorizeWorkOrderActor($request, $ticket, $subIssue);
        abort_unless($ticket->status === 'Active', 422, "Repairs can only be logged while the ticket is Active. Current status: {$ticket->status}.");
        abort_unless($subIssue->status === 'Under Repair', 422, "Repairs can only be logged when the sub-issue is Under Repair. Current: {$subIssue->status}.");

        $data = $request->validate([
            // A donor-part-only job (just swapping a part in) needs no repair
            // narrative; a repair, or a repair + donor part, still does.
            'repair_logs'           => ['required_unless:repair_type,cannibalized', 'nullable', 'string'],
            'parts_used'            => ['nullable', 'string'],
            'photo'                 => ['nullable', 'file', 'mimes:jpg,jpeg,png,pdf,doc,docx', 'max:8192'],
            'photos'                => ['nullable', 'array', 'max:10'],
            'photos.*'              => ['file', 'mimes:jpg,jpeg,png,pdf,doc,docx', 'max:8192'],
            'repair_started_at'     => ['nullable', 'date', 'before_or_equal:' . now('Asia/Manila')->toDateString()],
            'repair_completed_at'   => ['nullable', 'date', 'before_or_equal:' . now('Asia/Manila')->toDateString()],
            'maintenance_cost'      => ['nullable', 'numeric', 'min:0'],
            'estimated_return_date' => ['nullable', 'date'],
            // May already be set from ticket creation (pre-diagnosed) — this
            // lets the mechanic confirm it, or correct it if the actual
            // repair ended up differing from the original plan.
            'repair_type'           => ['nullable', Rule::in(['in_house', 'cannibalized', 'external'])],
            'source_vehicle_id'     => ['nullable', 'required_if:repair_type,cannibalized', 'exists:vehicles,vehicle_id'],
            'external_vendor'       => ['nullable', 'string', 'max:255'],
            'warranty_until'        => ['nullable', 'date'],
            'part_missing'          => ['nullable', 'string', 'max:255'],
            'part_needed'           => ['nullable', 'string', 'max:255'],
            'part_quantity'         => ['nullable', 'integer', 'min:1'],
            'part_condition'        => ['nullable', 'string', 'max:255'],
            'cannibal_reason'       => ['nullable', 'string'],
            'part_installed_at'     => ['nullable', 'date'],
            // The Maintenance Personnel tests the vehicle after the work; the Custodian only verifies.
            'tested_ok'             => ['required', 'accepted'],
            'test_notes'            => ['nullable', 'string', 'max:2000'],
        ], [
            'tested_ok.required' => 'Confirm that you tested the vehicle after the work before submitting.',
            'tested_ok.accepted' => 'Confirm that you tested the vehicle after the work before submitting.',
        ]);

        if (!empty($data['repair_completed_at']) && ($start = $data['repair_started_at'] ?? $subIssue->repair_started_at)) {
            abort_if(\Carbon\Carbon::parse($data['repair_completed_at'])->lt(\Carbon\Carbon::parse($start)), 422, 'Repair completion cannot precede its start.');
        }

        $effectiveRepairType = $data['repair_type'] ?? $subIssue->repair_type;
        abort_if(($effectiveRepairType === 'external') !== ($subIssue->repair_type === 'external'), 422, 'Changing to or from an external shop requires a new Admin-reviewed proposal.');
        if ($effectiveRepairType === 'external') {
            abort_unless($subIssue->external_sent_at && $subIssue->external_returned_at && $subIssue->verification_verdict !== 'Rejected', 422, 'Send this repair to the shop and record its return before submitting. Rejected work needs a new shop cycle.');
            unset($data['maintenance_cost'], $data['external_vendor'], $data['warranty_until']);
        }

        // Once a repair has been sent out to a shop it can't be written up as
        // done until the vehicle is marked back (markExternalReturned()).
        abort_if(
            $subIssue->external_sent_at && !$subIssue->external_returned_at,
            422,
            'This repair was sent to an outside shop. Mark it as returned before submitting the repair.'
        );

        if ($effectiveRepairType === 'cannibalized') {
            $donorId = $data['source_vehicle_id'] ?? $subIssue->source_vehicle_id;
            abort_if(!$donorId, 422, 'A cannibalized repair needs a donor vehicle.');
            $donor = Vehicle::find($donorId);
            abort_if(!$donor, 422, 'The donor vehicle no longer exists.');
            abort_if((int) $donor->vehicle_id === (int) $ticket->vehicle_id, 422, 'The donor vehicle must be a different vehicle from the one being repaired.');
            abort_unless($donor->barangay_id === $ticket->vehicle->barangay_id, 422, 'The donor vehicle must be in the same barangay.');
            $this->assertRetiredDonor((int) $donor->vehicle_id);
        }

        // A job can be a repair only, a donor part only, or a repair that also
        // uses a donor part — all go straight to Custodian verification now;
        // no Admin sign-off. Taking a part off another vehicle is still
        // recorded on that vehicle (an Issue Report) so it is never invisible.
        $usesDonorPart = $effectiveRepairType === 'cannibalized'
            && ($data['source_vehicle_id'] ?? $subIssue->source_vehicle_id);

        if ($usesDonorPart) {
            // Older clients send one part inline; keep that working by turning it
            // into a donor-part row (only when none exist yet).
            if (!$subIssue->donorParts()->exists() && !empty($data['part_needed'])) {
                $subIssue->donorParts()->create([
                    'donor_vehicle_id' => $data['source_vehicle_id'] ?? $subIssue->source_vehicle_id,
                    'blocks_readiness' => ! in_array(Vehicle::find($data['source_vehicle_id'] ?? $subIssue->source_vehicle_id)?->status, ['Inactive', 'Decommissioned'], true),
                    'part_name' => $data['part_needed'], 'quantity' => max(1, (int) ($data['part_quantity'] ?? 1)),
                    'part_condition' => $data['part_condition'] ?? null, 'installed_at' => isset($data['part_installed_at']) ? substr($data['part_installed_at'], 0, 10) : null,
                    'reason' => $data['cannibal_reason'] ?? null,
                ]);
            }
            abort_unless($subIssue->donorParts()->exists(), 422, 'Add at least one donor part before submitting a cannibalized repair.');
        }

        DB::transaction(function () use ($ticket, $subIssue, $data, $request, $effectiveRepairType, $usesDonorPart) {
            $existingLogs = $subIssue->repair_logs ? $subIssue->repair_logs . "\n\n" : '';
            $logText = trim((string) ($data['repair_logs'] ?? ''));
            if ($logText === '' && $usesDonorPart) {
                $donorName = Vehicle::find($data['source_vehicle_id'] ?? $subIssue->source_vehicle_id)?->vehicle_name ?? 'another vehicle';
                $logText = 'Part taken from ' . $donorName . ' and installed.';
            }

            $attachmentFiles = $subIssue->attachment_files ?? [];
            foreach ($request->file('photos', []) as $file) {
                $attachmentFiles[] = [
                    'url' => $this->storeUploadedImage($file, 'repair-attachments'),
                    'name' => $file->getClientOriginalName(),
                    'size' => $file->getSize(),
                    'added_by' => $request->user()->name,
                    'added_at' => now()->toIso8601String(),
                ];
            }

            $this->workEvent($subIssue, $request, 'Repair Submitted', ['repair_logs' => $logText, 'parts_used' => $data['parts_used'] ?? null, 'maintenance_cost' => $data['maintenance_cost'] ?? $subIssue->maintenance_cost]);
            $subIssue->update([
                'status'                    => 'For Inspection',
                'mechanic_tested_at'        => now(),
                'mechanic_tested_by'        => $request->user()->id,
                'mechanic_test_notes'       => $data['test_notes'] ?? null,
                'no_repair_needed'          => false,
                'verification_assigned_to'  => $ticket->assigned_custodian_id,
                'repair_logs'               => $existingLogs . '[' . now()->toIso8601String() . '] ' . $logText,
                'parts_used'                => $data['parts_used'] ?? $subIssue->parts_used,
                'attachment_files'          => $attachmentFiles,
                'attachment_url'            => $request->hasFile('photo')
                    ? $this->storeUploadedImage($request->file('photo'), 'repair-attachments')
                    : $subIssue->attachment_url,
                'repair_started_at'         => $data['repair_started_at'] ?? $subIssue->repair_started_at,
                'repair_completed_at'       => $data['repair_completed_at'] ?? now('Asia/Manila')->toDateString(),
                'verification_verdict' => null,
                'maintenance_cost'          => $data['maintenance_cost'] ?? $subIssue->maintenance_cost,
                'repair_type'               => $effectiveRepairType,
                'source_vehicle_id'         => $effectiveRepairType === 'cannibalized'
                    ? ($data['source_vehicle_id'] ?? $subIssue->source_vehicle_id)
                    : null,
                'external_vendor'           => $effectiveRepairType === 'external'
                    ? ($data['external_vendor'] ?? $subIssue->external_vendor)
                    : null,
                'part_missing'              => $effectiveRepairType === 'cannibalized' ? ($data['part_missing'] ?? $subIssue->part_missing) : $subIssue->part_missing,
                'part_needed'               => $effectiveRepairType === 'cannibalized' ? ($data['part_needed'] ?? $subIssue->part_needed) : $subIssue->part_needed,
                'part_quantity'             => $effectiveRepairType === 'cannibalized' ? ($data['part_quantity'] ?? $subIssue->part_quantity) : null,
                'part_condition'            => $effectiveRepairType === 'cannibalized' ? ($data['part_condition'] ?? $subIssue->part_condition) : null,
                'cannibal_reason'           => $effectiveRepairType === 'cannibalized' ? ($data['cannibal_reason'] ?? $subIssue->cannibal_reason) : null,
                'part_installed_at'         => $effectiveRepairType === 'cannibalized' ? ($data['part_installed_at'] ?? $subIssue->part_installed_at) : null,
                'warranty_until'            => $effectiveRepairType === 'external'
                    ? ($data['warranty_until'] ?? $subIssue->warranty_until)
                    : null,
                // Reset on every (re-)submission, not just the first: if a
                // previously-rejected cannibalized repair is resubmitted
                // (same or different donor vehicle), it needs a fresh
                // Pending review, not to still read Rejected.
                'cannibalization_status'            => null,
                'cannibalization_rejection_reason'  => null,
                'cannibalization_reviewed_by'       => null,
                'cannibalization_reviewed_at'       => null,
            ]);

            if (array_key_exists('estimated_return_date', $data) && $data['estimated_return_date']) {
                $ticket->vehicle->update(['estimated_return_date' => $data['estimated_return_date']]);
            }

            $this->log($request, 'Repairs Logged', "Ticket #{$ticket->display_number} — sub-issue \"{$subIssue->title}\" repair logs submitted.", $ticket->ticket_id);

            $mechanicName = $request->user()->name;
            $vehicleName = $ticket->vehicle->vehicle_name;

            if ($usesDonorPart) {
                // No separate issue report any more: the parts are in the donor's missing-parts list, and
                // only the ones it cannot respond without hold up its readiness.
                $freshSub = $subIssue->fresh('donorParts');
                $donorNames = $freshSub->donorParts->map(fn ($p) => Vehicle::find($p->donor_vehicle_id ?: $subIssue->source_vehicle_id)?->vehicle_name)
                    ->filter()->unique()->values()->all();
                $this->notifyAdmins(
                    'Part Taken From Another Vehicle',
                    "Mechanic {$mechanicName} used parts from " . implode(', ', $donorNames) . " for \"{$subIssue->title}\" on Ticket #{$ticket->display_number} ({$vehicleName}).",
                    'cannibalization_recorded',
                    $ticket->ticket_id,
                    $ticket->vehicle->barangay_id
                );
            }
            // The Custodian is told once, when the last repair on the ticket
            // is logged (advanceToVerificationIfReady()).
            $this->advanceToVerificationIfReady($ticket, $request);
        });

        return $subIssue->fresh();
    }

    // ===================================================================
    // PHASE 4 Tier 1 — Custodian: Verify a Sub-Issue's Repair
    // ===================================================================

    // ===================================================================
    // PHASE 4 Tier 2 — Admin: Confirm (or Rework) a Sub-Issue
    // ===================================================================

    // ===================================================================
    // PHASE 5 — Admin: Explicit Ticket Closure (only at N/N)
    // ===================================================================

    /**
     * PUT /tickets/:ticket/cancel — Admin cancels a ticket at any stage
     * before it's Closed.
     */
    public function cancelTicket(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.cancel');
        $data = $request->validate(['closing_notes' => ['required', 'string', 'max:5000']]);
        return DB::transaction(function () use ($request, $ticket, $data) {
            $ticket = $this->lockTicket($ticket, $request);
            abort_unless(in_array($ticket->status, ['Open', 'Active', 'For Verification'], true), 422, 'Only an unfinished approved ticket can be cancelled.');
            abort_if($ticket->subIssues->isNotEmpty() && $ticket->unresolvedSubIssues()->isEmpty(), 422, 'Completed repairs cannot be cancelled.');
            abort_if($ticket->subIssues->contains(fn ($item) => $item->external_sent_at && !$item->external_returned_at), 422, 'Record the return from the shop before cancelling this ticket.');
            $this->decisionEvent($ticket, $request, 'Cancelled', ['reason' => $data['closing_notes'], 'previous_status' => $ticket->status]);
            $ticket->update(['status' => 'Cancelled', 'closing_notes' => $data['closing_notes']]);
            $this->resetLinkedIssueReports($ticket, 'Pending');
            VehicleMaintenanceSchedule::where('resulting_ticket_id', $ticket->ticket_id)->where('status', 'Scheduled')->update(['status' => 'Cancelled']);
            $this->recomputeVehicleStatus($ticket->vehicle_id, $request);
            $this->log($request, 'Ticket Cancelled', "Ticket #{$ticket->display_number} cancelled. Reason: {$data['closing_notes']}", $ticket->ticket_id);
            $this->notifyTicketActors($ticket, 'Ticket Cancelled', "Ticket #{$ticket->display_number} was cancelled. Reason: {$data['closing_notes']}. Recorded repair evidence is retained; this is not repair verification.", 'ticket_cancelled');
            return response()->json($ticket->fresh($this->eagerLoads()));
        });
    }

    public function uncancelTicket(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.uncancel');
        return DB::transaction(function () use ($request, $ticket) {
            $ticket = $this->lockTicket($ticket, $request);
            abort_unless($ticket->status === 'Cancelled' && !$ticket->closed_at, 422, 'Only a cancelled, never-closed ticket can be restored.');
            abort_if(in_array($ticket->vehicle->status, ['Inactive', 'Decommissioned'], true), 422, 'Restore the retired vehicle before restoring repair work.');
            $this->assertSourcesAvailable($ticket);
            $this->assertNoDuplicateProposal($ticket);
            $submitted = $ticket->subIssues->isNotEmpty() && $ticket->subIssues->every(fn ($item) => in_array($item->status, ['For Inspection', 'Done'], true));
            $status = $submitted ? 'For Verification' : ($ticket->inspected_at ? 'Active' : 'Open');
            $this->decisionEvent($ticket, $request, 'Restored', ['restored_status' => $status, 'cancellation_reason' => $ticket->closing_notes]);
            $ticket->update(['status' => $status]);
            $this->resetLinkedIssueReports($ticket, 'In Maintenance');
            VehicleMaintenanceSchedule::where('resulting_ticket_id', $ticket->ticket_id)->where('status', 'Cancelled')->update(['status' => 'Scheduled']);
            $this->recomputeVehicleStatus($ticket->vehicle_id, $request);
            $this->log($request, 'Ticket Restored', "Ticket #{$ticket->display_number} restored to {$status}.", $ticket->ticket_id);
            $this->notifyTicketActors($ticket, 'Ticket Restored', "Ticket #{$ticket->display_number} was restored to {$status}. Previous work evidence is retained.", 'ticket_restored', $submitted ? $ticket->assigned_custodian_id : null);
            if ($submitted) $this->notifyRepairReadyForVerification($ticket, $request);
            return response()->json($ticket->fresh($this->eagerLoads()));
        });
    }

    public function deleteTicket(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.delete');
        return DB::transaction(function () use ($request, $ticket) {
            $ticket = $this->lockTicket($ticket, $request);
            abort_if($ticket->status === 'Closed' || $ticket->closed_at, 422, 'A closed ticket is permanent and cannot be deleted.');
            abort_if(in_array($ticket->status, ['Active', 'For Verification'], true), 422, 'Cancel an approved ticket with a reason; do not delete its decision trail.');
            abort_if($this->hasRepairEvidence($ticket), 422, 'This ticket has repair, parts, shop or cost evidence. Cancel it with a reason instead; its evidence must be retained.');
            $this->resetLinkedIssueReports($ticket, 'Pending');
            $vehicleId = $ticket->vehicle_id;
            $this->log($request, 'Delete Ticket', "Untouched Ticket #{$ticket->display_number} deleted by Admin.", $ticket->ticket_id);
            $ticket->delete();
            $this->recomputeVehicleStatus($vehicleId, $request);
            return response()->json(['message' => 'Untouched ticket deleted.']);
        });
    }

    /**
     * PUT /ticket-archives/:archive/reopen — Admin recovers an accidentally
     * deleted ticket that had real progress on it. Only ever available for
     * archive entries tagged "Deleted" — a "Closed" entry is permanently
     * locked and this will refuse it.
     */
    public function reopenArchive(Request $request, TicketArchiveLog $archive)
    {
        $this->requireAbility($request, 'ticket.reopen_archived');

        abort_unless($archive->final_status === 'Deleted', 422, 'Only a deleted, not-yet-finished ticket can be reopened — a Closed ticket is permanently locked.');

        $snapshot = $archive->full_ticket_snapshot;

        $normalizedSnapshotTitle = $this->normalizeTicketTitle($snapshot['ticket_title']);
        $duplicateMainIssue = MaintenanceTicket::where('vehicle_id', $archive->vehicle_id)
            ->whereNotIn('status', ['Closed', 'Cancelled', 'Declined'])
            ->get(['ticket_title'])
            ->contains(fn ($t) => $this->normalizeTicketTitle($t->ticket_title) === $normalizedSnapshotTitle);

        abort_if($duplicateMainIssue, 422, 'This vehicle already has an open ticket for this Main Issue — cannot reopen a duplicate.');

        $ticket = DB::transaction(function () use ($snapshot, $archive, $request) {
            Vehicle::whereKey($archive->vehicle_id)->lockForUpdate()->firstOrFail();
            $archive = TicketArchiveLog::whereKey($archive->archive_id)->lockForUpdate()->firstOrFail();
            abort_unless($archive->final_status === 'Deleted', 422, 'Only a deleted archive can be recovered.');
            $snapshot = $archive->full_ticket_snapshot;
            abort_if(($snapshot['status'] ?? null) === 'Closed' || !empty($snapshot['closed_at']), 422, 'Closed work cannot be reopened.');
            $ticket = MaintenanceTicket::create([
                'vehicle_id'            => $snapshot['vehicle_id'],
                'issue_report_id'       => $snapshot['issue_report_id'] ?? null,
                'created_by'            => $snapshot['created_by'],
                'ticket_title'          => $snapshot['ticket_title'],
                'ticket_description'    => $snapshot['ticket_description'],
                'priority'              => $snapshot['priority'],
                'status'                => $snapshot['status'],
                'assigned_custodian_id' => $snapshot['assigned_custodian_id'] ?? null,
                'assigned_at'           => $snapshot['assigned_at'] ?? null,
                // The ticket's one mechanic — without it they can't submit it
                // for verification and Admin loses Reassign Mechanic.
                'assigned_mechanic_id'  => $snapshot['assigned_mechanic_id'] ?? null,
                'down_since'            => $snapshot['down_since'] ?? null,
                'inspection_notes'      => $snapshot['inspection_notes'] ?? null,
                'inspection_result'     => $snapshot['inspection_result'] ?? null,
                'inspected_by'          => $snapshot['inspected_by'] ?? null,
                'inspected_at'          => $snapshot['inspected_at'] ?? null,
            ]);

            $subIssueFields = [
                'issue_report_id', 'created_by', 'title', 'status', 'assigned_mechanic_id', 'prior_mechanic_ids',
                'maintenance_type', 'work_order_notes', 'mechanic_assigned_at', 'mechanic_assigned_by',
                'repair_logs', 'parts_used', 'repair_started_at', 'repair_completed_at', 'maintenance_cost',
                'attachment_url', 'attachment_files',
                'repair_type', 'source_vehicle_id', 'external_vendor', 'external_reason', 'external_work_scope',
                'external_shop_contact', 'external_sent_by', 'external_contact_person', 'external_shop_address',
                'external_expected_return', 'external_handled_by', 'external_received_by', 'external_estimated_cost',
                'external_sent_at', 'external_returned_at', 'external_return_notes', 'external_actual_cost', 'warranty_until',
                'external_cycles', 'work_history', 'prior_mechanic_ids', 'functional_test', 'test_attested',
                'verification_verdict', 'verification_notes', 'verified_by', 'verified_at',
                'confirmation_verdict', 'confirmation_notes', 'confirmed_by', 'confirmed_at',
                'deferred_reason', 'deferred_by', 'deferred_at', 'deferred_issue_report_id',
            ];

            foreach ($snapshot['sub_issues'] ?? [] as $si) {
                TicketSubIssue::create([
                    'ticket_id' => $ticket->ticket_id,
                    ...array_intersect_key($si, array_flip($subIssueFields)),
                ]);

            }

            if (!in_array($ticket->status, ['Declined', 'Cancelled'], true)) $this->assertSourcesAvailable($ticket);
            $this->assertNoDuplicateProposal($ticket);
            $this->resetLinkedIssueReports($ticket, in_array($ticket->status, ['Declined', 'Cancelled'], true) ? 'Pending' : 'In Maintenance');

            $this->recomputeVehicleStatus($ticket->vehicle_id, $request);

            $archive->forceDelete();

            $this->log($request, 'Ticket Reopened', "Deleted Ticket #{$archive->ticket_number} was reopened by Admin as new Ticket #{$ticket->display_number}.", $ticket->ticket_id);

            $this->notifyUser($ticket->assigned_custodian_id, 'Ticket Reopened', "A deleted ticket for {$archive->vehicle_name} was reopened by Admin as Ticket #{$ticket->display_number}.", 'ticket_reopened', $ticket->ticket_id);

            return $ticket;
        });

        return response()->json($ticket->load($this->eagerLoads()), 201);
    }

    // ===================================================================
    // Internal helpers
    // ===================================================================

    /**
     * Every closed/cancelled ticket check runs through here: a vehicle
     * only returns to Available once NONE of its tickets are still open.
     * This is the single choke point — no other action may flip the
     * vehicle's status, which is what prevents an emergency vehicle from
     * being marked ready while a second, unrelated ticket is still open.
     */
    /**
     * Marks the Maintenance Schedule a ticket was auto-created from as
     * Completed and, if it repeats, seeds the next occurrence. No-op for a
     * ticket that didn't come from a schedule.
     */
    private function completeLinkedSchedule(MaintenanceTicket $ticket, int $userId): void
    {
        $schedule = VehicleMaintenanceSchedule::where('resulting_ticket_id', $ticket->ticket_id)
            ->where('status', 'Scheduled')
            ->first();
        if (!$schedule) {
            return;
        }

        $schedule->update(['status' => 'Completed']);
        $schedule->seedNextRecurrence(now()->toDateString(), $userId);
    }

    private function recomputeVehicleStatus(int $vehicleId, Request $request): void
    {
        $vehicle = Vehicle::find($vehicleId);
        if (!$vehicle) {
            return;
        }
        $previousStatus = $vehicle->status;
        \App\Services\VehicleOperationalState::refresh($vehicle);
        if ($vehicle->status !== $previousStatus) {
            $this->history($vehicle, 'Operational Status Updated', "{$vehicle->vehicle_name} moved to {$vehicle->status} after checking outstanding repair work.", 'vehicles', $vehicle->vehicle_id, $request);
        }
    }

    /**
     * Shared "Confirmed" finalization for a sub-issue — marks it Done,
     * resolves its linked Issue Report, and writes the permanent
     * VehicleMaintenanceRecord ledger line. Used by confirmSubIssue()'s
     * Confirmed branch AND by closeTicket(), which must finalize (not
     * defer) a sub-issue that's already sitting at For Confirmation with
     * an Approved verdict when the ticket is closed.
     */
    private function finalizeConfirmedSubIssue(MaintenanceTicket $ticket, TicketSubIssue $subIssue, int $userId, ?string $confirmationNotes = null): void
    {
        $subIssue->update([
            'status'               => 'Done',
            'confirmation_verdict' => 'Confirmed',
            'confirmation_notes'   => $confirmationNotes,
            'confirmed_by'         => $userId,
            'confirmed_at'         => now(),
        ]);

        if ($subIssue->issue_report_id) {
            $this->resetLinkedIssueReports($ticket, 'Resolved');
        }

        // Unify ledger: every confirmed sub-issue is a line in the
        // single complete maintenance history, same as before.
        if (!$subIssue->no_repair_needed && ($subIssue->assigned_mechanic_id || $subIssue->repair_type === 'external')) {
            VehicleMaintenanceRecord::firstOrCreate(['ticket_sub_issue_id' => $subIssue->sub_issue_id], [
                'vehicle_id'               => $ticket->vehicle_id,
                'issue_report_id'          => $subIssue->issue_report_id,
                'maintenance_type'         => $subIssue->maintenance_type ?? 'Repair',
                'problem_reason'           => $ticket->ticket_title . ': ' . $subIssue->title,
                'date_started'             => $subIssue->repair_started_at,
                'date_completed'           => $subIssue->repair_completed_at ?? now()->toDateString(),
                'maintenance_personnel_id' => $subIssue->assigned_mechanic_id,
                'is_external' => $subIssue->repair_type === 'external',
                'external_vendor' => $subIssue->external_vendor,
                'performed_by_other' => $subIssue->repair_type === 'external' ? $subIssue->external_vendor : null,
                'warranty_until' => $subIssue->warranty_until,
                'action_taken'             => $subIssue->repair_logs ?? 'No logs provided.',
                'parts_used'               => $subIssue->parts_used,
                'maintenance_cost'         => $subIssue->maintenance_cost,
                'progress_status'          => 'Completed',
                'remarks'                  => $subIssue->confirmation_notes ?? "Confirmed through Ticket #{$ticket->display_number}",
                'verification_result'      => 'Passed',
                'verification_notes'       => $subIssue->verification_notes,
                'verified_by'              => $subIssue->verified_by,
                'verified_at'              => $subIssue->verified_at,
                'confirmed_by'             => $subIssue->confirmed_by,
                'confirmed_at'             => $subIssue->confirmed_at,
            ]);
        }
    }

    /**
     * The "breadcrumb": a deferred defect must not vanish. If the sub-issue
     * came from a real Issue Report, resurface that same report as Pending
     * so it's back on the active radar. Otherwise (a defect first found
     * during inspection, with no formal report) open a fresh one. Returns
     * the report id either way.
     */
    private function createDeferralBreadcrumb(MaintenanceTicket $ticket, TicketSubIssue $subIssue, string $reason, int $userId): ?int
    {
        if ($subIssue->issue_report_id) {
            VehicleIssueReport::where('issue_report_id', $subIssue->issue_report_id)->update([
                'status'  => 'Pending',
                'remarks' => "Deferred from Ticket #{$ticket->display_number}: {$reason}",
            ]);

            return $subIssue->issue_report_id;
        }

        $report = VehicleIssueReport::create([
            'vehicle_id'        => $ticket->vehicle_id,
            'issue_type'        => 'Other',
            'issue_description' => "[Deferred from Ticket #{$ticket->display_number}] {$subIssue->title}",
            'severity_level'    => 'Medium',
            'reported_by'       => $userId,
            'status'            => 'Pending',
            'remarks'           => "Auto-created when this repair was deferred. Reason: {$reason}. Re-open a ticket when it can be addressed.",
        ]);

        return $report->issue_report_id;
    }

    private function resetLinkedIssueReports(MaintenanceTicket $ticket, string $status): void
    {
        $ids = $ticket->subIssues()->pluck('issue_report_id')->push($ticket->issue_report_id)->filter()->unique()->sort();
        foreach ($ids as $id) {
            $report = VehicleIssueReport::whereKey($id)->lockForUpdate()->first();
            if (!$report) continue;
            $owner = $this->sourceOwner($id, $ticket->ticket_id);
            $report->update(['status' => $owner ? 'In Maintenance' : $status]);
        }
    }

    private function sourceOwner(int $issueId, ?int $except = null): ?MaintenanceTicket
    {
        return MaintenanceTicket::whereNotIn('status', ['Closed', 'Cancelled', 'Declined'])
            ->when($except, fn ($q) => $q->where('ticket_id', '!=', $except))
            ->where(fn ($q) => $q->where('issue_report_id', $issueId)->orWhereHas('subIssues', fn ($s) => $s->where('issue_report_id', $issueId)))->first();
    }

    private function assertSourcesAvailable(MaintenanceTicket $ticket): void
    {
        foreach ($ticket->subIssues()->pluck('issue_report_id')->push($ticket->issue_report_id)->filter()->unique()->sort() as $id) {
            $report = VehicleIssueReport::whereKey($id)->lockForUpdate()->firstOrFail();
            $owner = $this->sourceOwner($id, $ticket->ticket_id);
            abort_unless((int) $report->vehicle_id === (int) $ticket->vehicle_id, 422, 'This source report belongs to a different vehicle.');
            abort_if($owner, 422, "This report is reserved by Ticket #{$owner?->display_number}; resolve that work before restoring this proposal.");
            abort_unless(in_array($report->status, ['Pending', 'Under Review', 'In Maintenance'], true), 422, 'This source report is no longer open. Create a new report for a new fault.');
        }
    }

    private function assertNoDuplicateProposal(MaintenanceTicket $ticket): void
    {
        $vehicle = $ticket->vehicle;
        $summary = $this->normalizeSummaryForVehicle($ticket->ticket_title, $vehicle->vehicle_name);
        $duplicate = MaintenanceTicket::where('vehicle_id', $vehicle->vehicle_id)->where('ticket_id', '!=', $ticket->ticket_id)
            ->whereNotIn('status', ['Closed', 'Cancelled', 'Declined'])->get()
            ->first(fn ($other) => $this->normalizeSummaryForVehicle($other->ticket_title, $vehicle->vehicle_name) === $summary);
        abort_if($duplicate, 422, "Ticket #{$duplicate?->display_number} already covers this work. Review that ticket instead of restoring duplicate work.");
    }

    private function lockTicket(MaintenanceTicket $snapshot, Request $request): MaintenanceTicket
    {
        Vehicle::whereKey($snapshot->vehicle_id)->lockForUpdate()->firstOrFail();
        $ticket = MaintenanceTicket::whereKey($snapshot->ticket_id)->lockForUpdate()->firstOrFail();
        $request->validate(['expected_revision' => ['sometimes', 'integer', 'min:0']]);
        $revision = $request->input('expected_revision');
        abort_if($revision !== null && (!is_numeric($revision) || (int) $revision !== $ticket->decision_revision), 409, 'This ticket changed. Refresh it and review the latest decision.');
        $ticket->setRelation('subIssues', $ticket->subIssues()->orderBy('sub_issue_id')->lockForUpdate()->get());
        return $ticket;
    }

    private function hasRepairEvidence(MaintenanceTicket $ticket): bool
    {
        return $ticket->subIssues->contains(fn ($item) => in_array($item->status, ['For Inspection', 'For Confirmation', 'Done', 'Deferred'], true)
            || filled($item->repair_logs) || filled($item->parts_used) || $item->repair_started_at || $item->repair_completed_at || $item->part_installed_at || $item->maintenance_cost !== null
            || filled($item->attachment_url) || !empty($item->attachment_files) || $item->external_sent_at || $item->external_returned_at
            || !empty($item->external_cycles) || !empty($item->work_history) || $item->donorParts()->exists());
    }

    private function decisionEvent(MaintenanceTicket $ticket, Request $request, string $event, array $details = []): void
    {
        $history = $ticket->decision_history ?? [];
        $history[] = ['event' => $event, 'user_id' => $request->user()->id, 'name' => $request->user()->name, 'at' => now()->toIso8601String(), 'details' => $details];
        $ticket->update(['decision_history' => $history, 'decision_revision' => $ticket->decision_revision + 1]);
        if ($event !== 'Approved') $this->history($ticket->vehicle, $event, 'Ticket #' . $ticket->display_number . ': ' . $event, 'maintenance_tickets', $ticket->ticket_id, $request);
    }

    private function notifyTicketActors(MaintenanceTicket $ticket, string $title, string $message, string $type, ?int $except = null): void
    {
        $ids = $ticket->subIssues->flatMap(fn ($item) => [$item->assigned_mechanic_id, $item->external_handled_by, $item->external_received_by])->push($ticket->assigned_custodian_id)->filter()->unique();
        foreach ($ids as $id) if ((int) $id !== (int) $except) $this->notifyUser($id, $title, $message, $type, $ticket->ticket_id);
    }

    private function assertBelongsToTicket(MaintenanceTicket $ticket, TicketSubIssue $subIssue): void
    {
        abort_unless($subIssue->ticket_id === $ticket->ticket_id, 404, 'That sub-issue does not belong to this ticket.');
    }

    private function archiveCompleted(MaintenanceTicket $ticket, int $userId, ?string $finalStatus = null): void
    {
        $vehicle = $ticket->vehicle;

        TicketArchiveLog::create([
            'ticket_id'            => $ticket->ticket_id,
            'ticket_number'        => $ticket->barangay_number,
            'vehicle_id'           => $ticket->vehicle_id,
            'ticket_title'         => $ticket->ticket_title,
            'vehicle_name'         => $vehicle->vehicle_name,
            'plate_number'         => $vehicle->plate_number,
            'final_status'         => $finalStatus ?? $ticket->status,
            'maintenance_cost'     => $ticket->subIssues->contains(fn ($item) => $item->maintenance_cost === null) ? null : $ticket->subIssues->sum('maintenance_cost'),
            'full_ticket_snapshot' => $ticket->toArray(),
            'archived_by'          => $userId,
            'archived_at'          => now(),
        ]);
    }

    private function eagerLoads(): array
    {
        return [
            'vehicle',
            'vehicle.category',
            'issueReport',
            'createdBy',
            'assignedCustodian',
            'assignedMechanic',
            'inspectedBy',
            'closedBy',
            'recurrenceOf:ticket_id,barangay_number,ticket_title,closed_at',
            'originatingSchedule:schedule_id,resulting_ticket_id',
            'subIssues.assignedMechanic',
            'subIssues.returnedToAdminBy:id,name',
            'subIssues.externalTester:id,name',
            'subIssues.mechanicAssignedBy',
            'subIssues.verifiedBy',
            'subIssues.confirmedBy',
            'subIssues.reopenedBy',
            'subIssues.deferredBy',
            'subIssues.createdBy',
            'subIssues.verificationAssignedTo',
            'subIssues.sourceVehicle:vehicle_id,vehicle_name,plate_number',
            'subIssues.cannibalizationReviewedBy',
            'subIssues.donorParts.donorVehicle:vehicle_id,vehicle_name,plate_number',
            'subIssues.externalHandler:id,name',
            'subIssues.externalReceiver:id,name',
        ];
    }

    private function workEvent(TicketSubIssue $item, Request $request, string $event, array $details): void
    {
        $history = $item->work_history ?? [];
        $history[] = ['event' => $event, 'user_id' => $request->user()->id, 'name' => $request->user()->name, 'at' => now()->toIso8601String(), 'details' => $details];
        $item->update(['work_history' => $history]);
        $this->history($item->ticket->vehicle, $event, 'Ticket #' . $item->ticket->display_number . ': ' . $item->title . ' - ' . $event, 'ticket_sub_issues', $item->sub_issue_id, $request);
    }

    private function log(Request $request, string $action, string $details, $affectedRecordId = null): void
    {
        ActivityLog::create([
            'user_id' => $request->user()?->id,
            // The role this action was actually authorized under, when a
            // requireAbility() call ran earlier in this request — falls back
            // to the primary role for endpoints with no ability gate.
            'role'    => $request->attributes->get('vms_acted_as_role') ?? $request->user()?->role,
            'action'  => $action,
            'module'  => 'Maintenance Tickets',
            'affected_record_id' => $affectedRecordId,
            'details' => $details,
        ]);
    }

    /**
     * Final senior system review — ticket actions that change a vehicle's
     * status/condition (approve, triage, close, cancel) previously only
     * wrote an Activity Log entry, leaving zero trace on the vehicle's own
     * History tab despite being the biggest status/condition drivers in the
     * system. Mirrors FleetController::history() exactly (same table,
     * same fields) since that method is private to its own controller.
     */
    private function history(Vehicle $vehicle, string $activityType, string $description, string $relatedTable, int|string $relatedRecordId, Request $request): void
    {
        VehicleHistory::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'activity_type' => $activityType,
            'description' => $description,
            'related_table' => $relatedTable,
            'related_record_id' => (string) $relatedRecordId,
            'updated_by' => $request->user()?->id,
        ]);
    }

    private function notifyUser($userId, $title, $message, $type, $ticketId)
    {
        if (!$userId) return;
        \App\Models\Notification::create([
            'user_id'   => $userId,
            'title'     => $title,
            'message'   => $message,
            'type'      => $type,
            'ticket_id' => $ticketId,
        ]);
    }

    // User carries no global scope — pass the relevant vehicle's
    // barangay_id explicitly, or this would notify every barangay's
    // Admins about something that only happened in one of them.
    private function notifyAdmins($title, $message, $type, $ticketId, ?int $barangayId)
    {
        $admins = User::where('barangay_id', $barangayId)->havingRole('Admin')->get();
        foreach ($admins as $admin) {
            $this->notifyUser($admin->id, $title, $message, $type, $ticketId);
        }
    }
}
