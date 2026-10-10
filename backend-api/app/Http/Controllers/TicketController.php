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
 * another vehicle) takes a detour between Under Repair and For Inspection:
 *
 *   Under Repair -> Pending Approval -> [Admin approves] -> For Inspection
 *                                     -> [Admin rejects]  -> Under Repair
 *
 * The ticket's progress is X/N sub-issues Done. New sub-issues can be
 * appended for as long as the ticket is Active. Once an Admin explicitly
 * Closes the ticket (only allowed at N/N), it is permanently locked — no
 * further sub-issues, no reopening, ever.
 *
 * Phase 1: Admin creates ticket & assigns to Custodian   -> createTicket()
 * Phase 2: Custodian inspects, populates sub-issues       -> submitInspection()
 *          A new sub-issue can be added later             -> addSubIssue()
 * Phase 3: Admin assigns a mechanic per sub-issue          -> assignMechanic()
 *          Mechanic logs repair per sub-issue              -> logRepairs()
 *          Admin approves/rejects a cannibalized repair    -> approveCannibalization()/rejectCannibalization()
 * Phase 4: Custodian verifies a sub-issue (Tier 1)         -> verifyRepair()
 *          Admin confirms or reworks a sub-issue (Tier 2)  -> confirmSubIssue()
 * Phase 5: Admin explicitly closes the ticket (N/N only)   -> closeTicket()
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
                        ->orWhereHas('subIssues', fn ($q) => $q->where('assigned_mechanic_id', $user->id));
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

        return $query->latest('ticket_id')->get();
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
                    || $ticket->subIssues()->where('assigned_mechanic_id', $user->id)->exists());

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

    private function mechanicsWithWorkload(?int $barangayId)
    {
        $tickets = MaintenanceTicket::whereIn('status', ['Active', 'For Verification'])
            ->whereNotNull('assigned_mechanic_id')
            ->selectRaw('assigned_mechanic_id, COUNT(*) as n')
            ->groupBy('assigned_mechanic_id')->pluck('n', 'assigned_mechanic_id');
        $schedules = VehicleMaintenanceSchedule::where('status', 'Scheduled')
            ->whereNotNull('assigned_to')
            ->selectRaw('assigned_to, COUNT(*) as n')
            ->groupBy('assigned_to')->pluck('n', 'assigned_to');

        return User::where('barangay_id', $barangayId)->havingRole('Maintenance Personnel')->orderBy('name')
            ->get(['id', 'name', 'email'])
            ->each(function ($m) use ($tickets, $schedules) {
                $m->setAttribute('active_tickets', (int) ($tickets[$m->id] ?? 0));
                $m->setAttribute('scheduled_jobs', (int) ($schedules[$m->id] ?? 0));
            });
    }

    public function lookups(Request $request)
    {
        return response()->json([
            'vehicles'              => Vehicle::whereNotIn('status', ['Inactive', 'Decommissioned'])
                ->with('category:category_id,category_name')
                ->orderBy('vehicle_name')
                ->get(['vehicle_id', 'vehicle_name', 'plate_number', 'status', 'condition', 'photo_url', 'brand', 'model', 'category_id', 'current_location']),
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
            'external_reasons'      => self::EXTERNAL_REASONS,
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
            ->whereNotIn('status', ['Closed', 'Cancelled'])
            ->orderByDesc('ticket_id')
            ->get(['ticket_id', 'ticket_title', 'status', 'priority']);
    }

    public function archives(Request $request)
    {
        $this->requireAbility($request, 'ticket.view_archives');

        $query = TicketArchiveLog::with(['vehicle', 'archivedBy'])
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

    public function createTicket(Request $request)
    {
        $this->requireAbility($request, 'ticket.create');

        $data = $request->validate([
            'vehicle_id'            => ['required', 'exists:vehicles,vehicle_id'],
            'issue_report_id'       => ['nullable', 'exists:vehicle_issue_reports,issue_report_id'],
            'condition_check_id'    => ['nullable', 'exists:vehicle_condition_checks,condition_check_id'],
            'ticket_title'          => ['required', 'string', 'max:255'],
            'ticket_description'    => ['required', 'string'],
            'priority'              => ['required', Rule::in($this->priorities)],
            'assigned_custodian_id' => ['required', 'exists:users,id'],
            // #3 — when the vehicle actually became unavailable (may be backdated).
            'down_since'            => ['nullable', 'date'],
            // #1 — entry mode. 'inspection' = today's flow (Custodian diagnoses
            // first). The other three mean the problem AND how it'll be fixed
            // are already known, so the ticket is born Active with its
            // sub-issues and skips inspection — replaces the old generic
            // 'prediagnosed' value, since picking a specific repair type
            // already implies the issue is diagnosed.
            'entry_mode'            => ['nullable', Rule::in(['inspection', 'in_house', 'cannibalized', 'external'])],
            'sub_issues'                    => ['required_if:entry_mode,in_house,cannibalized,external', 'array', 'min:1'],
            'sub_issues.*.title'            => ['required_with:sub_issues', 'string', 'max:255'],
            'sub_issues.*.maintenance_type' => ['nullable', 'string', 'max:150'],
            // Only meaningful (and required) when the repair is already
            // known to use a part cannibalized from another vehicle.
            'source_vehicle_id'     => ['nullable', 'required_if:entry_mode,cannibalized', 'exists:vehicles,vehicle_id', 'different:vehicle_id'],
            // Only meaningful when already known to be going to an external
            // shop — the vendor may not be picked yet, so optional even then.
            'external_vendor'       => ['nullable', 'string', 'max:255'],
            'warranty_until'        => ['nullable', 'date'],
        ]);

        // Maintenance type is a growing catalog, not a fixed enum — a value
        // that doesn't exist yet is persisted here so it's offered as a real
        // option everywhere else next time.
        if (!empty($data['sub_issues'])) {
            foreach ($data['sub_issues'] as &$subIssueInput) {
                if (!empty($subIssueInput['maintenance_type'])) {
                    $subIssueInput['maintenance_type'] = MaintenanceType::resolve($subIssueInput['maintenance_type']);
                }
            }
            unset($subIssueInput);
        }

        $entryMode = $data['entry_mode'] ?? 'inspection';
        $preDiagnosed = $entryMode !== 'inspection';
        // Only set on sub-issues when the repair type is already known —
        // 'inspection' tickets genuinely don't know it yet, that's decided
        // later at the Log Repairs step.
        $repairType = $preDiagnosed ? $entryMode : null;

        // A retired/archived vehicle is out of the fleet — no new work on it.
        $vehicle = Vehicle::findOrFail($data['vehicle_id']);
        abort_if(
            in_array($vehicle->status, ['Inactive', 'Decommissioned'], true),
            422,
            'Cannot open a ticket on an archived or decommissioned vehicle.'
        );

        // The "no duplicate open Main Issue on this vehicle" check happens
        // again, for real, inside the transaction below under a row lock —
        // this is just a fast, friendly precheck so the common case gets an
        // immediate, well-formed error without waiting on a lock.
        $normalizedIncomingTitle = $this->normalizeTicketTitle($data['ticket_title']);
        $duplicateMainIssue = MaintenanceTicket::where('vehicle_id', $data['vehicle_id'])
            ->whereNotIn('status', ['Closed', 'Cancelled'])
            ->get(['ticket_id', 'ticket_title'])
            ->first(fn ($t) => $this->normalizeTicketTitle($t->ticket_title) === $normalizedIncomingTitle);

        if ($duplicateMainIssue) {
            return response()->json([
                'message' => "This vehicle already has an open ticket for \"{$data['ticket_title']}\" (Ticket #{$duplicateMainIssue->ticket_id}). Add this as a sub-issue on that ticket instead of opening a new one."
            ], 422);
        }

        $custodian = User::findOrFail($data['assigned_custodian_id']);
        abort_unless($custodian->hasRole('Custodian'), 422, 'The selected user is not a Custodian.');
        abort_unless($custodian->barangay_id === $vehicle->barangay_id, 422, 'The selected Custodian does not belong to this barangay.');

        // #9 — recurrence: how many times this same fault was already
        // fixed on this vehicle in the last 90 days — via a Closed ticket OR
        // a Completed Maintenance Record (a roadside/external-shop fix would
        // otherwise be invisible here). See ChecksRecurrence for matching.
        $maintenanceTypes = array_column($data['sub_issues'] ?? [], 'maintenance_type');
        $issueType = !empty($data['issue_report_id']) ? optional(VehicleIssueReport::find($data['issue_report_id']))->issue_type : null;
        $recurrenceInfo = $this->checkRecurrence((int) $data['vehicle_id'], $maintenanceTypes, $issueType, $data['ticket_title']);
        $recurrence = $recurrenceInfo['count'];
        $recurrenceLabel = implode(' / ', array_filter(array_unique($maintenanceTypes))) ?: ($issueType ?? $data['ticket_title']);

        $ticket = DB::transaction(function () use ($data, $request, $recurrence, $recurrenceInfo, $preDiagnosed, $repairType, $normalizedIncomingTitle, $recurrenceLabel) {
            // Lock the vehicle row first — serializes concurrent createTicket
            // calls for the SAME vehicle so two requests can't both pass the
            // "no duplicate Main Issue" check before either has inserted.
            // Same TOCTOU class, same fix, as AuthController::register()'s
            // Barangay lock: registrations/tickets for a DIFFERENT vehicle
            // lock a different row and proceed independently.
            $vehicle = Vehicle::where('vehicle_id', $data['vehicle_id'])->lockForUpdate()->first();

            $duplicateMainIssue = MaintenanceTicket::where('vehicle_id', $data['vehicle_id'])
                ->whereNotIn('status', ['Closed', 'Cancelled'])
                ->get(['ticket_id', 'ticket_title'])
                ->first(fn ($t) => $this->normalizeTicketTitle($t->ticket_title) === $normalizedIncomingTitle);

            abort_if(
                $duplicateMainIssue,
                422,
                "This vehicle already has an open ticket for \"{$data['ticket_title']}\" (Ticket #{$duplicateMainIssue?->ticket_id}). Add this as a sub-issue on that ticket instead of opening a new one."
            );

            $ticket = MaintenanceTicket::create([
                'vehicle_id'            => $data['vehicle_id'],
                'issue_report_id'       => $data['issue_report_id'] ?? null,
                'created_by'            => $request->user()->id,
                'ticket_title'          => $data['ticket_title'],
                'ticket_description'    => $data['ticket_description'],
                'priority'              => $data['priority'],
                // #1 — pre-diagnosed tickets are born Active (inspection skipped);
                // inspection-mode tickets start Open awaiting the Custodian.
                'status'                => $preDiagnosed ? 'Active' : 'Open',
                // #3 — pre-diagnosed means the vehicle is already down; default
                // the downtime clock to now unless a real (possibly backdated)
                // time was supplied.
                'down_since'            => $data['down_since'] ?? ($preDiagnosed ? now() : null),
                'assigned_custodian_id' => $data['assigned_custodian_id'],
                'assigned_at'           => now(),
                'recurrence_count'      => $recurrence,
                // #9 — the most recent prior occurrence, so "it broke again"
                // is a clickable link, not just a count. This FK only ever
                // points at another TICKET — when the last occurrence was a
                // Maintenance Record instead, there's nothing to link here,
                // but recurrence_count above still reflects it.
                'recurrence_of_ticket_id' => $recurrenceInfo['last_type'] === 'ticket' ? $recurrenceInfo['last_id'] : null,
            ]);

            if ($preDiagnosed) {
                // The problem is already known: record the sub-issues now and
                // stamp a skipped-inspection so the audit trail is honest.
                foreach ($data['sub_issues'] as $sub) {
                    TicketSubIssue::create([
                        'ticket_id'          => $ticket->ticket_id,
                        'created_by'         => $request->user()->id,
                        'title'              => $sub['title'],
                        'maintenance_type'   => $sub['maintenance_type'] ?? null,
                        'repair_type'        => $repairType,
                        'source_vehicle_id'  => $repairType === 'cannibalized' ? ($data['source_vehicle_id'] ?? null) : null,
                        'external_vendor'    => $repairType === 'external' ? ($data['external_vendor'] ?? null) : null,
                        'warranty_until'     => $repairType === 'external' ? ($data['warranty_until'] ?? null) : null,
                        'status'             => 'Open',
                    ]);
                }
                $ticket->update([
                    'inspection_result' => 'Needs Maintenance',
                    'inspection_notes'  => 'Pre-diagnosed at creation — inspection skipped (issue already known).',
                    'inspected_by'      => $request->user()->id,
                    'inspected_at'      => now(),
                ]);
                // Known problem => the vehicle is out of service immediately.
                $vehicle->update(['condition' => 'Needs Repair', 'status' => 'Under Maintenance']);
            }

            if (!empty($data['issue_report_id'])) {
                VehicleIssueReport::where('issue_report_id', $data['issue_report_id'])->update([
                    'status' => 'In Maintenance',
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

            $repairTypeLabels = ['in_house' => 'in-house repair', 'cannibalized' => 'cannibalized part', 'external' => 'external shop'];
            $repairTypeLabel = $repairTypeLabels[$repairType] ?? $repairType;
            $modeLabel = $preDiagnosed ? "pre-diagnosed as {$repairTypeLabel} (inspection skipped)" : 'assigned to custodian for inspection';
            $this->log($request, 'Create Ticket', "Ticket #{$ticket->ticket_id} ({$data['ticket_title']}) created for {$vehicle->vehicle_name} — {$modeLabel}.", $ticket->ticket_id);

            if ($preDiagnosed) {
                $this->notifyAdmins(
                    'Pre-Diagnosed Ticket Ready for Assignment',
                    "Ticket #{$ticket->ticket_id} ({$data['ticket_title']}) on {$vehicle->vehicle_name} is pre-diagnosed ({$repairTypeLabel}) and ready — assign a mechanic to each sub-issue.",
                    'ticket_prediagnosed',
                    $ticket->ticket_id,
                    $vehicle->barangay_id
                );
            } else {
                $this->notifyUser(
                    $ticket->assigned_custodian_id,
                    'New Inspection Assignment',
                    "Ticket #{$ticket->ticket_id} for {$vehicle->vehicle_name} has been assigned to you for physical inspection.",
                    'inspection_assigned',
                    $ticket->ticket_id
                );
            }

            // #9 — a repeat failure is worth flagging loudly, not hiding in a counter.
            if ($recurrence > 0) {
                $lastFixSource = $recurrenceInfo['last_type'] === 'record'
                    ? "Maintenance Record #{$recurrenceInfo['last_id']}"
                    : "Ticket #{$recurrenceInfo['last_id']}";
                // Was hardcoded "th" regardless of number ("3th time") — fixed
                // to the same ordinal-suffix pattern used in the ticket detail
                // page's own "Recurring — Nth time" badge.
                // Indexed by $recurrence directly (not -1) — same convention as
                // the ticket detail page's ['st','nd','rd'][ticket.recurrence_count].
                $ordinal = ['st', 'nd', 'rd'][$recurrence] ?? 'th';
                $this->notifyAdmins(
                    'Recurring Fault Detected',
                    "This is the " . ($recurrence + 1) . "{$ordinal} time \"" . $recurrenceLabel . "\" has been logged on {$vehicle->vehicle_name} in 90 days — last fixed via {$lastFixSource} (Ticket #{$ticket->ticket_id}). Consider a deeper fix or decommission review.",
                    'recurring_fault',
                    $ticket->ticket_id,
                    $vehicle->barangay_id
                );
            }

            return $ticket;
        });

        return response()->json($ticket->load($this->eagerLoads()), 201);
    }

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
            'external_reason'     => ['nullable', 'required_if:entry_mode,external', Rule::in(self::EXTERNAL_REASONS)],
            'external_work_scope' => ['nullable', 'required_if:entry_mode,external', 'string', 'max:5000'],
            'external_shop_contact'   => ['nullable', 'string', 'max:255'],
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
            abort_if(in_array($donor->status, ['Inactive', 'Decommissioned'], true), 422, 'The donor vehicle is archived or decommissioned.');
        }

        $maintenanceTypes = array_column($data['sub_issues'], 'maintenance_type');
        $issueType = !empty($data['issue_report_id']) ? optional(VehicleIssueReport::find($data['issue_report_id']))->issue_type : null;
        $issueSummary = collect($maintenanceTypes)->filter()->first() ?: ($issueType ?: ($data['sub_issues'][0]['title'] ?? 'Maintenance'));
        // Provisional (no number yet) — gets its MT-#### prefix once the row has an id.
        $data['ticket_title'] = "{$vehicle->vehicle_name} — {$issueSummary}";

        // Same "no duplicate open Main Issue on this vehicle" precheck
        // createTicket() does — a fast, friendly rejection before the real,
        // row-locked recheck inside the transaction below.
        $normalizedIncomingTitle = $this->normalizeTicketTitle($issueSummary);
        $duplicateMainIssue = MaintenanceTicket::where('vehicle_id', $data['vehicle_id'])
            ->whereNotIn('status', ['Closed', 'Cancelled'])
            ->get(['ticket_id', 'ticket_title'])
            ->first(fn ($t) => $this->normalizeSummaryForVehicle($t->ticket_title, $vehicle->vehicle_name) === $normalizedIncomingTitle);

        if ($duplicateMainIssue) {
            return response()->json([
                'message' => "This vehicle already has an open ticket for \"{$issueSummary}\" (Ticket #{$duplicateMainIssue->ticket_id}). Add this as a sub-issue on that ticket instead of proposing a new one."
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

            $duplicateMainIssue = MaintenanceTicket::where('vehicle_id', $data['vehicle_id'])
                ->whereNotIn('status', ['Closed', 'Cancelled'])
                ->get(['ticket_id', 'ticket_title'])
                ->first(fn ($t) => $this->normalizeSummaryForVehicle($t->ticket_title, $vehicle->vehicle_name) === $normalizedIncomingTitle);

            abort_if(
                $duplicateMainIssue,
                422,
                "This vehicle already has an open ticket for \"{$data['ticket_title']}\" (Ticket #{$duplicateMainIssue?->ticket_id}). Add this as a sub-issue on that ticket instead of proposing a new one."
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
                    'status'            => 'In Maintenance',
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
            $data['ticket_title'] = MaintenanceTicket::composeTitle($ticket->ticket_id, $vehicle->vehicle_name, $issueSummary);
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
                    'status' => 'In Maintenance',
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
                    "This is the " . ($recurrence + 1) . "{$ordinal} time \"" . $recurrenceLabel . "\" has been logged on {$vehicle->vehicle_name} in 90 days — last fixed via {$lastFixSource} (Ticket #{$ticket->ticket_id}). Consider a deeper fix or decommission review.",
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

        // A previously Declined proposal can be approved directly — Admin
        // doesn't have to undecline it first.
        abort_unless(
            in_array($ticket->status, ['Pending Approval', 'Declined'], true),
            422,
            "Only a Pending Approval or Declined ticket can be approved. Current: {$ticket->status}."
        );

        $data = $request->validate([
            'ticket_description'    => ['sometimes', 'string'],
            'priority'              => ['sometimes', Rule::in($this->priorities)],
            'assigned_custodian_id' => ['sometimes', 'exists:users,id'],
            'assigned_mechanic_id'  => ['required', 'exists:users,id'],
            'sub_issues'                        => ['nullable', 'array'],
            'sub_issues.*.sub_issue_id'          => ['required_with:sub_issues', 'exists:ticket_sub_issues,sub_issue_id'],
            'sub_issues.*.title'                 => ['nullable', 'string', 'max:255'],
            'sub_issues.*.maintenance_type'      => ['nullable', 'string', 'max:150'],
            'sub_issues.*.suggested_mechanic_id' => ['nullable', 'exists:users,id'],
        ]);

        if (isset($data['assigned_custodian_id'])) {
            $newCustodian = User::findOrFail($data['assigned_custodian_id']);
            abort_unless($newCustodian->hasRole('Custodian'), 422, 'The selected user is not a Custodian.');
            abort_unless($newCustodian->barangay_id === $ticket->vehicle->barangay_id, 422, 'The selected Custodian does not belong to this barangay.');
        }

        $assignedMechanic = User::findOrFail($data['assigned_mechanic_id']);
        abort_unless($assignedMechanic->hasRole('Maintenance Personnel'), 422, 'The selected user is not Maintenance Personnel.');
        abort_unless($assignedMechanic->barangay_id === $ticket->vehicle->barangay_id, 422, 'The selected mechanic does not belong to this barangay.');

        abort_if(
            in_array($ticket->vehicle->status, ['Inactive', 'Decommissioned'], true),
            422,
            'This vehicle has been archived or decommissioned since it was proposed — decline the proposal instead.'
        );
        abort_if($ticket->subIssues()->count() === 0, 422, 'A proposal needs at least one sub-issue before it can be approved.');

        $ticket = DB::transaction(function () use ($ticket, $data, $request, $assignedMechanic) {
            // Serialize against a concurrent approve/decline of the same proposal.
            $locked = MaintenanceTicket::where('ticket_id', $ticket->ticket_id)->lockForUpdate()->first();
            abort_unless($locked && in_array($locked->status, ['Pending Approval', 'Declined'], true), 422, 'This proposal was already approved.');

            $ticket->update(array_intersect_key($data, array_flip([
                'ticket_description', 'priority', 'assigned_custodian_id', 'assigned_mechanic_id',
            ])));

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
            $this->history($vehicle, 'Ticket Approved', "Ticket #{$ticket->ticket_id} (\"{$ticket->ticket_title}\") was approved — {$vehicle->vehicle_name} moved to Under Maintenance.", 'maintenance_tickets', $ticket->ticket_id, $request);

            $dispatchedMechanics = [];
            $ticket->subIssues()->update([
                'status'               => 'Under Repair',
                'assigned_mechanic_id' => $assignedMechanic->id,
                'mechanic_assigned_at' => now(),
                'mechanic_assigned_by' => $request->user()->id,
            ]);
            $dispatchedMechanics[] = $assignedMechanic;
            /* Legacy suggested-mechanic dispatch is deliberately skipped:
             * approval now assigns the ticket, and all of its line items,
             * to the one mechanic selected above.
             */
            /*
            foreach ($ticket->subIssues()->get() as $subIssue) {
                if (!$subIssue->suggested_mechanic_id) {
                    continue;
                }
                $mechanic = User::find($subIssue->suggested_mechanic_id);
                if (!$mechanic || !$mechanic->hasRole('Maintenance Personnel') || $mechanic->barangay_id !== $vehicle->barangay_id) {
                    // The suggestion is no longer valid (e.g. the account was
                    // deactivated or reassigned barangays since it was
                    // proposed) — leave the sub-issue Open for a manual
                    // assignMechanic() instead of silently dispatching to it.
                    continue;
                }

                $subIssue->update([
                    'status'               => 'Under Repair',
                    'assigned_mechanic_id' => $mechanic->id,
                    'mechanic_assigned_at' => now(),
                    'mechanic_assigned_by' => $request->user()->id,
                ]);
                $dispatchedMechanics[] = $mechanic;
            }

            */
            $this->log($request, 'Approve Ticket', "Ticket #{$ticket->ticket_id} ({$ticket->ticket_title}) proposal approved and assigned to {$assignedMechanic->name}.", $ticket->ticket_id);

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
                    "You have been assigned Ticket #{$ticket->ticket_id} ({$vehicle->vehicle_name}).",
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

        abort_unless(
            in_array($ticket->status, ['Active', 'For Verification'], true),
            422,
            "The mechanic can only be reassigned while the ticket is Active or For Verification. Current: {$ticket->status}."
        );

        $data = $request->validate([
            'assigned_mechanic_id' => ['required', 'exists:users,id'],
            'reassign_reason'      => ['required', 'string'],
        ]);

        $newMechanic = User::findOrFail($data['assigned_mechanic_id']);
        abort_unless($newMechanic->hasRole('Maintenance Personnel'), 422, 'The selected user is not Maintenance Personnel.');
        abort_unless($newMechanic->barangay_id === $ticket->vehicle->barangay_id, 422, 'The selected mechanic does not belong to this barangay.');
        abort_if((int) $newMechanic->id === (int) $ticket->assigned_mechanic_id, 422, 'That mechanic is already assigned to this ticket.');

        DB::transaction(function () use ($ticket, $newMechanic, $data, $request) {
            $locked = MaintenanceTicket::where('ticket_id', $ticket->ticket_id)->lockForUpdate()->first();
            abort_unless(in_array($locked->status, ['Active', 'For Verification'], true), 422, 'This ticket was already changed.');

            $previousMechanicId = $locked->assigned_mechanic_id;
            $previousName = $previousMechanicId ? (User::find($previousMechanicId)?->name ?? 'the previous mechanic') : 'the previous mechanic';

            $locked->update(['assigned_mechanic_id' => $newMechanic->id]);

            foreach ($ticket->subIssues()->get() as $subIssue) {
                $priorIds = $subIssue->prior_mechanic_ids ?? [];
                if ($subIssue->assigned_mechanic_id && !in_array($subIssue->assigned_mechanic_id, $priorIds, true)) {
                    $priorIds[] = $subIssue->assigned_mechanic_id;
                }
                $subIssue->update([
                    'assigned_mechanic_id' => $newMechanic->id,
                    'mechanic_assigned_at' => now(),
                    'mechanic_assigned_by' => $request->user()->id,
                    'prior_mechanic_ids'   => $priorIds,
                ]);
            }

            // A mechanic swap after repairs were already submitted means the
            // attribution changed — back the ticket up to Active so the new
            // mechanic's own work is what actually gets verified.
            if ($locked->status === 'For Verification') {
                $locked->update(['status' => 'Active']);
            }

            $vehicleName = $ticket->vehicle->vehicle_name;
            $this->log(
                $request,
                'Ticket Mechanic Reassigned',
                "Ticket #{$ticket->ticket_id} reassigned from {$previousName} to {$newMechanic->name}. Reason: {$data['reassign_reason']}",
                $ticket->ticket_id
            );

            $this->notifyUser(
                $newMechanic->id,
                'Ticket Reassigned to You',
                "You have been assigned Ticket #{$ticket->ticket_id} ({$vehicleName}).",
                'ticket_assigned',
                $ticket->ticket_id
            );
            if ($previousMechanicId) {
                $this->notifyUser(
                    $previousMechanicId,
                    'Ticket Reassigned',
                    "Ticket #{$ticket->ticket_id} ({$vehicleName}) was reassigned to {$newMechanic->name}.",
                    'ticket_reassigned',
                    $ticket->ticket_id
                );
            }
        });

        return response()->json($ticket->fresh($this->eagerLoads()));
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
            (int) $ticket->assigned_mechanic_id === (int) $request->user()->id,
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
        $notReady = $ticket->subIssues->reject(fn ($s) => $s->status === 'For Inspection');
        abort_if(
            $notReady->isNotEmpty(),
            422,
            'Every sub-issue needs its repair logged before the ticket can go to verification: ' . $notReady->pluck('title')->implode(', ')
        );

        DB::transaction(function () use ($ticket, $request) {
            $locked = MaintenanceTicket::where('ticket_id', $ticket->ticket_id)->lockForUpdate()->first();
            abort_unless($locked && $locked->status === 'Active', 422, 'This ticket was already submitted or changed.');

            $locked->update(['status' => 'For Verification']);

            $this->log(
                $request,
                'Submitted for Verification',
                "Ticket #{$ticket->ticket_id} ({$ticket->ticket_title}) submitted for Custodian verification.",
                $ticket->ticket_id
            );

            $this->notifyRepairReadyForVerification($ticket);
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
        $locked = MaintenanceTicket::where('ticket_id', $ticket->ticket_id)->lockForUpdate()->first();
        if (!$locked || $locked->status !== 'Active') {
            return false;
        }

        $subIssues = TicketSubIssue::where('ticket_id', $ticket->ticket_id)->get();
        if ($subIssues->isEmpty() || $subIssues->contains(fn ($s) => $s->status !== 'For Inspection')) {
            return false;
        }

        $locked->update(['status' => 'For Verification']);

        $this->log(
            $request,
            'Submitted for Verification',
            "Ticket #{$ticket->ticket_id} ({$ticket->ticket_title}) — every repair logged; sent to the Custodian for verification.",
            $ticket->ticket_id
        );
        $this->notifyRepairReadyForVerification($ticket);

        return true;
    }

    // One wording for "this ticket is now waiting on you", whichever path
    // got it there (automatic advance or the manual fallback button). Links
    // to the ticket, which is where the Custodian's Verify section lives.
    private function notifyRepairReadyForVerification(MaintenanceTicket $ticket): void
    {
        $this->notifyUser(
            $ticket->assigned_custodian_id,
            'Repair Ready for Verification',
            "Ticket #{$ticket->ticket_id} — {$ticket->vehicle->vehicle_name}: the repair has been submitted and is ready for your verification.",
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

        // Verification is a real functional test: the Custodian operates the
        // vehicle against its vehicle-type checklist (the frontend's
        // functionalTestChecklist()), then either approves — with the
        // attestation — or returns it for repair. Every guard above applies
        // to both outcomes. No verdict = Approved, so an attestation-only
        // request (the original contract) still works unchanged.
        $data = $request->validate([
            'verification_verdict'     => ['nullable', Rule::in(['Approved', 'Rejected'])],
            'verification_notes'       => ['nullable', 'string', 'max:5000'],
            'functional_test'          => ['nullable', 'array'],
            'functional_test.*.item'   => ['required', 'string', 'max:255'],
            'functional_test.*.passed' => ['required', 'boolean'],
            'test_attested'            => ['nullable', 'boolean'],
        ]);
        $approved = ($data['verification_verdict'] ?? 'Approved') === 'Approved';
        $functionalTest = $data['functional_test'] ?? null;
        $failedChecks = collect($functionalTest ?? [])->reject(fn ($i) => $i['passed'])->pluck('item');

        if ($approved) {
            abort_unless(
                $request->boolean('test_attested'),
                422,
                'Before approving, you must attest that you personally operated and tested the vehicle.'
            );
            // The server re-checks the checklist itself rather than trusting
            // the verdict: a failed check can never be approved.
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
            $locked = MaintenanceTicket::where('ticket_id', $ticket->ticket_id)->lockForUpdate()->first();
            abort_unless($locked && $locked->status === 'For Verification', 422, 'This ticket was already verified or changed.');

            $ticket->load('subIssues');
            foreach ($ticket->subIssues as $subIssue) {
                if ($subIssue->status === 'Done') {
                    continue;
                }
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
                VehicleIssueReport::where('issue_report_id', $ticket->issue_report_id)->update(['status' => 'Resolved']);
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

            $this->recomputeVehicleStatus($ticket->vehicle_id, $request);

            $this->log(
                $request,
                'Ticket Verified & Closed',
                "Ticket #{$ticket->ticket_id} ({$ticket->ticket_title}) verified by Custodian and closed.",
                $ticket->ticket_id
            );

            $vehicleName = $ticket->vehicle->vehicle_name;
            $this->notifyUser(
                $ticket->assigned_mechanic_id,
                'Repair Verified & Closed',
                "Your repair work on Ticket #{$ticket->ticket_id} ({$vehicleName}) was verified and the ticket is now closed.",
                'ticket_verified',
                $ticket->ticket_id
            );
        });

        return response()->json($ticket->fresh($this->eagerLoads()));
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
            $locked = MaintenanceTicket::where('ticket_id', $ticket->ticket_id)->lockForUpdate()->first();
            abort_unless($locked && $locked->status === 'For Verification', 422, 'This ticket was already verified or changed.');

            $notes = $data['verification_notes'] ?? null;
            foreach (TicketSubIssue::where('ticket_id', $ticket->ticket_id)->where('status', 'For Inspection')->get() as $subIssue) {
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
                "Ticket #{$ticket->ticket_id} ({$ticket->ticket_title}) failed Custodian verification and was returned for repair. {$reason}",
                $ticket->ticket_id
            );

            $this->notifyUser(
                $ticket->assigned_mechanic_id,
                'Repair Returned for Rework',
                "{$request->user()->name} returned Ticket #{$ticket->ticket_id} ({$ticket->vehicle->vehicle_name}) for repair after verification. {$reason}",
                'repairs_rejected',
                $ticket->ticket_id
            );
        });

        return response()->json($ticket->fresh($this->eagerLoads()));
    }

    /**
     * Admin declines a proposal — it stays as a visible, reversible status
     * (not deleted) so the Custodian who proposed it sees exactly what
     * happened, and Admin can change their mind later: undecline() puts it
     * back to Pending Approval, or approveTicket() can approve it directly
     * from Declined without undeclining first.
     */
    public function declineTicket(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.decline');

        abort_unless($ticket->status === 'Pending Approval', 422, "Only a Pending Approval ticket can be declined. Current: {$ticket->status}.");

        $data = $request->validate([
            'decline_reason' => ['required', 'string'],
        ]);

        DB::transaction(function () use ($ticket, $data) {
            // The proposal flipped its linked Issue Report to In Maintenance;
            // put it back so the report doesn't look handled while nothing
            // is actually happening with it.
            $this->resetLinkedIssueReports($ticket, 'Pending');
            $ticket->update([
                'status' => 'Declined',
                'decline_reason' => $data['decline_reason'],
            ]);
        });

        $this->log(
            $request,
            'Decline Ticket',
            "Ticket #{$ticket->ticket_id} (\"{$ticket->ticket_title}\") declined. Reason: {$data['decline_reason']}",
            $ticket->ticket_id
        );

        $this->notifyUser(
            $ticket->assigned_custodian_id,
            'Ticket Proposal Declined',
            "Your proposed ticket \"{$ticket->ticket_title}\" for {$ticket->vehicle->vehicle_name} was declined. Reason: {$data['decline_reason']}",
            'ticket_declined',
            $ticket->ticket_id
        );

        return response()->json($ticket->fresh($this->eagerLoads()));
    }

    /**
     * Admin changes their mind about a decline — puts the proposal back
     * exactly where it was (Pending Approval), for the Custodian to see
     * it's live again or for Admin to revise and approve it properly.
     */
    public function undeclineTicket(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.decline');

        abort_unless($ticket->status === 'Declined', 422, "Only a Declined ticket can be undeclined. Current: {$ticket->status}.");

        DB::transaction(function () use ($ticket) {
            $this->resetLinkedIssueReports($ticket, 'In Maintenance');
            $ticket->update([
                'status' => 'Pending Approval',
                'decline_reason' => null,
            ]);
        });

        $this->log($request, 'Undecline Ticket', "Ticket #{$ticket->ticket_id} (\"{$ticket->ticket_title}\") restored to Pending Approval.", $ticket->ticket_id);

        $this->notifyUser(
            $ticket->assigned_custodian_id,
            'Ticket Proposal Reconsidered',
            "Your proposed ticket \"{$ticket->ticket_title}\" for {$ticket->vehicle->vehicle_name} is back under review.",
            'ticket_proposed',
            $ticket->ticket_id
        );

        return response()->json($ticket->fresh($this->eagerLoads()));
    }

    // ===================================================================
    // PHASE 2 — Custodian: Submit Inspection, Populate Sub-Issues
    // ===================================================================

    public function submitInspection(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.inspect');

        abort_unless($ticket->assigned_custodian_id === $request->user()->id, 403, 'This ticket is not assigned to you.');
        abort_unless($ticket->status === 'Open', 422, "Inspection can only be submitted when the ticket is Open. Current status: {$ticket->status}.");

        $data = $request->validate([
            'inspection_result'             => ['required', Rule::in(['Needs Maintenance', 'No Issues'])],
            'inspection_notes'               => ['nullable', 'string'],
            'sub_issues'                     => ['required_if:inspection_result,Needs Maintenance', 'array', 'min:1'],
            'sub_issues.*.title'             => ['required_with:sub_issues', 'string', 'max:255'],
            'sub_issues.*.maintenance_type'  => ['nullable', 'string', 'max:150'],
        ]);

        if (!empty($data['sub_issues'])) {
            foreach ($data['sub_issues'] as &$subIssueInput) {
                if (!empty($subIssueInput['maintenance_type'])) {
                    $subIssueInput['maintenance_type'] = MaintenanceType::resolve($subIssueInput['maintenance_type']);
                }
            }
            unset($subIssueInput);
        }

        DB::transaction(function () use ($ticket, $data, $request) {
            $ticket->update([
                'status'            => 'Active',
                'inspection_result' => $data['inspection_result'],
                'inspection_notes'  => $data['inspection_notes'] ?? null,
                'inspected_by'      => $request->user()->id,
                'inspected_at'      => now(),
            ]);

            if ($data['inspection_result'] === 'Needs Maintenance') {
                foreach ($data['sub_issues'] as $subIssue) {
                    TicketSubIssue::create([
                        'ticket_id'        => $ticket->ticket_id,
                        'created_by'       => $request->user()->id,
                        'title'            => $subIssue['title'],
                        'maintenance_type' => $subIssue['maintenance_type'] ?? null,
                        'status'           => 'Open',
                    ]);
                }
                // Status and condition move together — the moment the
                // Custodian confirms a real problem, the vehicle is no
                // longer available for dispatch, regardless of whether a
                // mechanic has been assigned yet.
                $ticket->vehicle->update([
                    'condition' => 'Needs Repair',
                    'status'    => 'Under Maintenance',
                ]);
                $this->history($ticket->vehicle, 'Ticket Inspected', "Ticket #{$ticket->ticket_id} inspection confirmed a real problem — {$ticket->vehicle->vehicle_name} moved to Under Maintenance.", 'maintenance_tickets', $ticket->ticket_id, $request);
            } else {
                if ($ticket->vehicle->condition !== 'Good') {
                    // "No Issues" clears whatever flagged this vehicle for
                    // inspection in the first place — don't leave it reading
                    // Needs Inspection after it's just been cleared.
                    $ticket->vehicle->update(['condition' => 'Good']);
                    $this->history($ticket->vehicle, 'Ticket Inspected', "Ticket #{$ticket->ticket_id} inspection found no issues — {$ticket->vehicle->vehicle_name} condition cleared.", 'maintenance_tickets', $ticket->ticket_id, $request);
                }
                // Nothing was wrong, so the Issue Report that triggered this
                // inspection is settled too — not left stuck In Maintenance.
                if ($ticket->issue_report_id) {
                    VehicleIssueReport::where('issue_report_id', $ticket->issue_report_id)->update(['status' => 'Resolved']);
                }
            }

            $count = $data['inspection_result'] === 'Needs Maintenance' ? count($data['sub_issues']) : 0;
            $this->log($request, 'Inspection Submitted', "Ticket #{$ticket->ticket_id} inspected. Result: {$data['inspection_result']}" . ($count ? " ({$count} sub-issue(s) logged)." : '.'), $ticket->ticket_id);

            $vehicleName = $ticket->vehicle->vehicle_name;
            $custodianName = $request->user()->name;
            $this->notifyAdmins(
                'Inspection Submitted',
                "Custodian {$custodianName} submitted inspection for Ticket #{$ticket->ticket_id} ({$vehicleName}). Result: {$data['inspection_result']}.",
                'inspection_submitted',
                $ticket->ticket_id,
                $ticket->vehicle->barangay_id
            );
        });

        return $ticket->fresh($this->eagerLoads());
    }

    // ===================================================================
    // PHASE 3 — Admin: Assign Mechanic to a Sub-Issue (Work Order)
    // ===================================================================

    public function assignMechanic(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireAbility($request, 'subissue.assign_mechanic');
        $this->assertBelongsToTicket($ticket, $subIssue);

        abort_unless($ticket->status === 'Active', 422, "Work orders can only be dispatched while the ticket is Active. Current status: {$ticket->status}.");
        abort_unless($subIssue->status === 'Open', 422, "A mechanic can only be assigned when the sub-issue is Open. Current: {$subIssue->status}.");

        $data = $request->validate([
            'assigned_mechanic_id' => ['required', 'exists:users,id'],
            'maintenance_type'     => ['required', 'string', 'max:150'],
            'work_order_notes'     => ['nullable', 'string'],
        ]);

        $data['maintenance_type'] = MaintenanceType::resolve($data['maintenance_type']);

        $mechanic = User::findOrFail($data['assigned_mechanic_id']);
        abort_unless($mechanic->hasRole('Maintenance Personnel'), 422, 'The selected user is not Maintenance Personnel.');
        abort_unless($mechanic->barangay_id === $ticket->vehicle->barangay_id, 422, 'The selected mechanic does not belong to this barangay.');

        // Not blocked — a small barangay may genuinely have no one else to
        // assign — but the eventual verifier is already knowable here: it's
        // whoever logRepairs()/verifyRepair() will later stamp/require,
        // i.e. this ticket's current Custodian (see reassignCustodian's
        // docblock for that cascade). If they match, this mechanic won't be
        // able to verify their own work — verifyRepair() enforces that;
        // this just tells the Admin up front instead of them discovering it
        // when the sub-issue gets stuck at For Inspection.
        $selfVerificationWarning = $mechanic->id === $ticket->assigned_custodian_id
            ? "{$mechanic->name} is also this ticket's Custodian — they won't be able to verify their own repair. Reassign the ticket to a different Custodian before it reaches verification."
            : null;

        DB::transaction(function () use ($ticket, $subIssue, $data, $request, $selfVerificationWarning) {
            // Lock the sub-issue row for the duration of this assignment so
            // two concurrent work-order dispatches on the same sub-issue
            // serialize instead of racing.
            TicketSubIssue::where('sub_issue_id', $subIssue->sub_issue_id)->lockForUpdate()->first();

            $subIssue->update([
                'status'               => 'Under Repair',
                'assigned_mechanic_id' => $data['assigned_mechanic_id'],
                'maintenance_type'     => $data['maintenance_type'],
                'work_order_notes'     => $data['work_order_notes'] ?? null,
                'mechanic_assigned_at' => now(),
                'mechanic_assigned_by' => $request->user()->id,
            ]);

            $this->recomputeVehicleStatus($ticket->vehicle_id, $request);

            $this->log(
                $request,
                'Mechanic Assigned',
                "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" assigned to mechanic ID {$data['assigned_mechanic_id']}."
                . ($selfVerificationWarning ? " ⚠ {$selfVerificationWarning}" : ''),
                $ticket->ticket_id
            );

            $vehicleName = $ticket->vehicle->vehicle_name;
            $this->notifyUser(
                $data['assigned_mechanic_id'],
                'New Work Order Assigned',
                "You have been assigned to \"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}).",
                'work_order_assigned',
                $ticket->ticket_id
            );
        });

        $response = $subIssue->fresh()->toArray();
        if ($selfVerificationWarning) {
            $response['warning'] = $selfVerificationWarning;
        }

        return $response;
    }

    /**
     * PUT /tickets/:ticket/sub-issues/:subIssue/reassign-mechanic — hand an
     * in-progress work order to a different mechanic (e.g. the assigned one is
     * out sick), so a repair on the only ambulance is never frozen. Only while
     * Under Repair; the reason and both mechanics are recorded.
     */
    public function reassignMechanic(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireAbility($request, 'subissue.reassign_mechanic');
        $this->assertBelongsToTicket($ticket, $subIssue);

        abort_unless($ticket->status === 'Active', 422, "Work orders can only be reassigned while the ticket is Active. Current status: {$ticket->status}.");
        abort_unless($subIssue->status === 'Under Repair', 422, "A work order can only be reassigned while it is Under Repair. Current: {$subIssue->status}.");

        $data = $request->validate([
            'assigned_mechanic_id' => ['required', 'exists:users,id'],
            'reassign_reason'      => ['required', 'string'],
        ]);

        $newMechanic = User::findOrFail($data['assigned_mechanic_id']);
        abort_unless($newMechanic->hasRole('Maintenance Personnel'), 422, 'The selected user is not Maintenance Personnel.');
        abort_unless($newMechanic->barangay_id === $ticket->vehicle->barangay_id, 422, 'The selected mechanic does not belong to this barangay.');
        abort_if($newMechanic->id === $subIssue->assigned_mechanic_id, 422, 'That mechanic is already assigned to this work order.');

        $previousMechanicId = $subIssue->assigned_mechanic_id;

        // Final senior system review — closes a self-verification gap: the
        // outgoing mechanic may have already logged real repair work before
        // being reassigned away, so their ID has to survive here even though
        // assigned_mechanic_id is about to point at someone else.
        $priorMechanicIds = $subIssue->prior_mechanic_ids ?? [];
        if ($previousMechanicId && !in_array($previousMechanicId, $priorMechanicIds, true)) {
            $priorMechanicIds[] = $previousMechanicId;
        }

        DB::transaction(function () use ($ticket, $subIssue, $data, $request, $newMechanic, $previousMechanicId, $priorMechanicIds) {
            $previousName = $previousMechanicId ? (User::find($previousMechanicId)?->name ?? 'the previous mechanic') : 'the previous mechanic';

            $subIssue->update([
                'assigned_mechanic_id' => $data['assigned_mechanic_id'],
                'mechanic_assigned_at' => now(),
                'mechanic_assigned_by' => $request->user()->id,
                'prior_mechanic_ids'   => $priorMechanicIds,
            ]);

            $vehicleName = $ticket->vehicle->vehicle_name;
            $this->log($request, 'Work Order Reassigned', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" reassigned from {$previousName} to {$newMechanic->name}. Reason: {$data['reassign_reason']}", $ticket->ticket_id);

            // Let the new mechanic know they're now on it...
            $this->notifyUser(
                $newMechanic->id,
                'Work Order Reassigned to You',
                "You have been assigned to \"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}).",
                'work_order_assigned',
                $ticket->ticket_id
            );
            // ...and the previous mechanic that it's off their plate.
            if ($previousMechanicId) {
                $this->notifyUser(
                    $previousMechanicId,
                    'Work Order Reassigned',
                    "\"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}) was reassigned to {$newMechanic->name}.",
                    'work_order_reassigned',
                    $ticket->ticket_id
                );
            }
        });

        return $subIssue->fresh();
    }

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
        abort_unless($newCustodian->hasRole('Custodian'), 422, 'The selected user is not a Custodian.');
        abort_unless($newCustodian->barangay_id === $ticket->vehicle->barangay_id, 422, 'The selected Custodian does not belong to this barangay.');
        abort_if($newCustodian->id === $ticket->assigned_custodian_id, 422, 'That Custodian is already assigned to this ticket.');

        $previousCustodianId = $ticket->assigned_custodian_id;

        // Not blocked, same reasoning as assignMechanic()'s equivalent
        // check — but checked the other way around: does the incoming
        // Custodian already have a still-open work order of their own on
        // THIS ticket? 'Done' is excluded — that repair is already
        // verified, so there's no self-verification risk left to warn about.
        $conflictingSubIssueTitles = $ticket->subIssues()
            ->where('assigned_mechanic_id', $newCustodian->id)
            ->where('status', '!=', 'Done')
            ->pluck('title');
        $selfVerificationWarning = $conflictingSubIssueTitles->isNotEmpty()
            ? "{$newCustodian->name} is also the assigned mechanic on: {$conflictingSubIssueTitles->implode(', ')}. They won't be able to verify their own repair there — reassign those sub-issues to a different mechanic, or this ticket to a different Custodian."
            : null;

        DB::transaction(function () use ($ticket, $data, $request, $newCustodian, $previousCustodianId, $selfVerificationWarning) {
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
                "Ticket #{$ticket->ticket_id} — Custodian reassigned from {$previousName} to {$newCustodian->name}."
                . ($cascaded > 0 ? " {$cascaded} pending verification(s) moved with it." : '')
                . " Reason: {$data['reassign_reason']}"
                . ($selfVerificationWarning ? " ⚠ {$selfVerificationWarning}" : ''),
                $ticket->ticket_id
            );

            $this->notifyUser(
                $newCustodian->id,
                'Ticket Reassigned to You',
                "You are now the Custodian for Ticket #{$ticket->ticket_id} ({$vehicleName})."
                . ($cascaded > 0 ? " {$cascaded} repair(s) are awaiting your verification." : ''),
                'ticket_reassigned',
                $ticket->ticket_id
            );

            if ($previousCustodianId) {
                $this->notifyUser(
                    $previousCustodianId,
                    'Ticket Reassigned',
                    "Ticket #{$ticket->ticket_id} ({$vehicleName}) was reassigned to {$newCustodian->name}.",
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
     * Admin may do this on any ticket; a Custodian only on their own.
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
        ]);

        // The ticket is already dispatched to one mechanic by the time it's
        // Active (approveTicket() bulk-assigns every sub-issue at approval) —
        // a line item added afterwards is simply more work for that same
        // mechanic, not a fresh "Open, needs dispatching" item nobody can
        // ever pick up now that per-sub-issue assignment is gone.
        $subIssue = TicketSubIssue::create([
            'ticket_id' => $ticket->ticket_id,
            'created_by' => $request->user()->id,
            'title' => $data['title'],
            'maintenance_type' => !empty($data['maintenance_type']) ? MaintenanceType::resolve($data['maintenance_type']) : null,
            'status' => $ticket->assigned_mechanic_id ? 'Under Repair' : 'Open',
            'assigned_mechanic_id' => $ticket->assigned_mechanic_id,
            'mechanic_assigned_at' => $ticket->assigned_mechanic_id ? now() : null,
            'mechanic_assigned_by' => $ticket->assigned_mechanic_id ? $request->user()->id : null,
        ]);
        $this->log($request, 'Sub-issue Added', "Ticket #{$ticket->ticket_id} — added sub-issue \"{$subIssue->title}\".", $ticket->ticket_id);

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
        $this->log($request, 'Sub-issue Edited', "Ticket #{$ticket->ticket_id} — sub-issue \"{$old}\" updated to \"{$subIssue->title}\".", $ticket->ticket_id);

        return $subIssue->fresh();
    }

    public function deleteSubIssue(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->authorizeSubIssueEdit($request, $ticket);
        $this->assertBelongsToTicket($ticket, $subIssue);
        abort_unless(in_array($subIssue->status, ['Open', 'Under Repair'], true), 422, 'Only a sub-issue that has not had repairs logged yet can be removed.');
        abort_if(TicketSubIssue::where('ticket_id', $ticket->ticket_id)->count() <= 1, 422, 'A ticket needs at least one sub-issue. Cancel the ticket instead.');

        $this->log($request, 'Sub-issue Removed', "Ticket #{$ticket->ticket_id} — removed sub-issue \"{$subIssue->title}\".", $ticket->ticket_id);
        $subIssue->delete();

        return response()->json(['message' => 'Sub-issue removed.']);
    }

    /** The mechanic hands the vehicle (or part) to an outside shop. */
    public function markExternalSent(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireAbility($request, 'subissue.log_repair');
        $this->assertBelongsToTicket($ticket, $subIssue);
        abort_unless($subIssue->assigned_mechanic_id === $request->user()->id, 403, 'This work order is not assigned to you.');
        abort_unless($subIssue->status === 'Under Repair', 422, "Only an Under Repair sub-issue can be sent out. Current: {$subIssue->status}.");
        abort_if($subIssue->external_sent_at, 422, 'This repair has already been sent out.');

        $data = $request->validate([
            'external_vendor' => ['required', 'string', 'max:255'],
            'external_reason' => ['required', 'string', 'max:255'],
            'external_work_scope' => ['required', 'string'],
            'external_shop_contact' => ['nullable', 'string', 'max:255'],
            'external_contact_person' => ['nullable', 'string', 'max:255'],
            'external_estimated_cost' => ['nullable', 'numeric', 'min:0'],
        ]);

        $subIssue->update($data + [
            'repair_type' => 'external',
            'external_sent_at' => now(),
            'external_sent_by' => $request->user()->id,
        ]);
        $this->log($request, 'Sent Out', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" sent to {$data['external_vendor']}.", $ticket->ticket_id);

        return $subIssue->fresh();
    }

    /** The shop returns it; the mechanic records the outcome before writing up the repair. */
    public function markExternalReturned(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireAbility($request, 'subissue.log_repair');
        $this->assertBelongsToTicket($ticket, $subIssue);
        abort_unless($subIssue->assigned_mechanic_id === $request->user()->id, 403, 'This work order is not assigned to you.');
        abort_unless($subIssue->external_sent_at, 422, 'This repair has not been sent out yet.');
        abort_if($subIssue->external_returned_at, 422, 'This repair has already been marked returned.');

        $data = $request->validate([
            'external_return_notes' => ['required', 'string'],
            'external_actual_cost' => ['nullable', 'numeric', 'min:0'],
            'warranty_until' => ['nullable', 'date'],
        ]);

        $subIssue->update($data + ['external_returned_at' => now()]);
        $this->log($request, 'Returned From Shop', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" returned from {$subIssue->external_vendor}.", $ticket->ticket_id);

        return $subIssue->fresh();
    }

    public function logRepairs(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireAbility($request, 'subissue.log_repair');
        $this->assertBelongsToTicket($ticket, $subIssue);

        abort_unless($subIssue->assigned_mechanic_id === $request->user()->id, 403, 'This work order is not assigned to you.');
        abort_unless($ticket->status === 'Active', 422, "Repairs can only be logged while the ticket is Active. Current status: {$ticket->status}.");
        abort_unless($subIssue->status === 'Under Repair', 422, "Repairs can only be logged when the sub-issue is Under Repair. Current: {$subIssue->status}.");

        $data = $request->validate([
            'repair_logs'           => ['required', 'string'],
            'parts_used'            => ['nullable', 'string'],
            'photo'                 => ['nullable', 'file', 'mimes:jpg,jpeg,png,pdf,doc,docx', 'max:8192'],
            'repair_started_at'     => ['nullable', 'date'],
            'repair_completed_at'   => ['nullable', 'date'],
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
        ]);

        $effectiveRepairType = $data['repair_type'] ?? $subIssue->repair_type;

        // Once a repair has been sent out to a shop it can't be written up as
        // done until the vehicle is marked back (markExternalReturned()).
        abort_if(
            $effectiveRepairType === 'external' && $subIssue->external_sent_at && !$subIssue->external_returned_at,
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
            abort_if(in_array($donor->status, ['Inactive', 'Decommissioned'], true), 422, 'The donor vehicle is archived or decommissioned.');
        }

        // A cannibalized repair is really two actions in one — fixing this
        // vehicle by un-fixing another — so it doesn't go straight to
        // Custodian verification like an in_house/external repair does. It
        // parks at Pending Approval for an Admin to sign off first
        // (approveCannibalization()/rejectCannibalization() below).
        $needsCannibalizationApproval = $effectiveRepairType === 'cannibalized'
            && ($data['source_vehicle_id'] ?? $subIssue->source_vehicle_id);

        DB::transaction(function () use ($ticket, $subIssue, $data, $request, $effectiveRepairType, $needsCannibalizationApproval) {
            $existingLogs = $subIssue->repair_logs ? $subIssue->repair_logs . "\n\n" : '';

            $subIssue->update([
                'status'                    => $needsCannibalizationApproval ? 'Pending Approval' : 'For Inspection',
                'verification_assigned_to'  => $ticket->assigned_custodian_id,
                'repair_logs'               => $existingLogs . '[' . now()->format('Y-m-d H:i') . '] ' . $data['repair_logs'],
                'parts_used'                => $data['parts_used'] ?? $subIssue->parts_used,
                'attachment_url'            => $request->hasFile('photo')
                    ? $this->storeUploadedImage($request->file('photo'), 'repair-attachments')
                    : $subIssue->attachment_url,
                'repair_started_at'         => $data['repair_started_at'] ?? $subIssue->repair_started_at,
                'repair_completed_at'       => $data['repair_completed_at'] ?? null,
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
                'cannibalization_status'            => $needsCannibalizationApproval ? 'Pending' : null,
                'cannibalization_rejection_reason'  => null,
                'cannibalization_reviewed_by'       => null,
                'cannibalization_reviewed_at'       => null,
            ]);

            if (array_key_exists('estimated_return_date', $data) && $data['estimated_return_date']) {
                $ticket->vehicle->update(['estimated_return_date' => $data['estimated_return_date']]);
            }

            $this->log($request, 'Repairs Logged', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" repair logs submitted.", $ticket->ticket_id);

            $mechanicName = $request->user()->name;
            $vehicleName = $ticket->vehicle->vehicle_name;

            if ($needsCannibalizationApproval) {
                $this->notifyAdmins(
                    'Cannibalized Repair Needs Approval',
                    "Mechanic {$mechanicName} logged a cannibalized repair for \"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}), using a part from another vehicle. Please review before it goes to verification.",
                    'cannibalization_pending',
                    $ticket->ticket_id,
                    $ticket->vehicle->barangay_id
                );
            } else {
                // Previously this told the Custodian "Please verify" on every
                // individual log, while the ticket was still Active and so not
                // yet verifiable. Now the ticket advances (and the Custodian
                // is notified, once) only when the last repair is logged.
                $this->advanceToVerificationIfReady($ticket, $request);
            }
        });

        return $subIssue->fresh();
    }

    /**
     * Admin approves a cannibalized repair — releases the sub-issue to
     * Custodian verification (same handoff logRepairs() does for every
     * other repair type) and records the donor vehicle's side of the
     * trade: an Issue Report so "this vehicle is now missing a part" is
     * never invisible, and a readiness recompute so that shows up
     * immediately, not just whenever someone next inspects it.
     */
    public function approveCannibalization(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireAbility($request, 'repair.approve_cannibalized');
        $this->assertBelongsToTicket($ticket, $subIssue);

        abort_unless($ticket->status === 'Active', 422, "A cannibalized repair can only be approved while the ticket is Active. Current status: {$ticket->status}.");
        abort_unless($subIssue->status === 'Pending Approval' && $subIssue->cannibalization_status === 'Pending', 422, 'This sub-issue is not awaiting cannibalization approval.');

        $donorVehicle = Vehicle::findOrFail($subIssue->source_vehicle_id);
        $vehicleName = $ticket->vehicle->vehicle_name;

        DB::transaction(function () use ($ticket, $subIssue, $request, $donorVehicle, $vehicleName) {
            // Re-read under a lock so a double-click (or an approve racing a
            // reject) can't run this twice and create two donor reports.
            $fresh = TicketSubIssue::where('sub_issue_id', $subIssue->sub_issue_id)->lockForUpdate()->first();
            abort_unless(
                $fresh && $fresh->status === 'Pending Approval' && $fresh->cannibalization_status === 'Pending',
                422,
                'This sub-issue is not awaiting cannibalization approval.'
            );

            // A rejected-then-resubmitted repair to the SAME donor already has
            // its donor report from the earlier approval — don't add another.
            $existing = $subIssue->cannibalization_issue_report_id
                ? VehicleIssueReport::where('issue_report_id', $subIssue->cannibalization_issue_report_id)
                    ->where('vehicle_id', $donorVehicle->vehicle_id)->first()
                : null;

            $issue = $existing ?? VehicleIssueReport::create([
                'vehicle_id'        => $donorVehicle->vehicle_id,
                'issue_type'        => 'Other',
                'issue_description' => "Part removed for use on {$vehicleName} (Ticket #{$ticket->ticket_id}: \"{$subIssue->title}\").",
                'severity_level'    => 'Medium',
                'reported_by'       => $request->user()->id,
                'status'            => 'Pending',
                'remarks'           => 'Auto-created when a cannibalized repair using this vehicle\'s part was approved.',
            ]);

            if (!$existing) {
                $donorVehicle->update(['condition' => 'Needs Inspection']);

                VehicleHistory::create([
                    'vehicle_id'         => $donorVehicle->vehicle_id,
                    'activity_type'      => 'Issue Reported',
                    'description'        => "A part was removed from {$donorVehicle->vehicle_name} for use on {$vehicleName} (Ticket #{$ticket->ticket_id}).",
                    'related_table'      => 'vehicle_issue_reports',
                    'related_record_id'  => (string) $issue->issue_report_id,
                    'updated_by'         => $request->user()->id,
                ]);
            }

            $subIssue->update([
                // Re-stamp to the ticket's CURRENT custodian — the Custodian
                // may have been reassigned while this sat awaiting approval.
                'verification_assigned_to'     => $ticket->assigned_custodian_id,
                'status'                       => 'For Inspection',
                'cannibalization_status'       => 'Approved',
                'cannibalization_reviewed_by'  => $request->user()->id,
                'cannibalization_reviewed_at'  => now(),
                'cannibalization_issue_report_id' => $issue->issue_report_id,
            ]);

            $this->log(
                $request,
                'Cannibalization Approved',
                "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" cannibalized repair approved. Donor: {$donorVehicle->vehicle_name} ({$donorVehicle->plate_number}).",
                $ticket->ticket_id
            );

            $adminName = $request->user()->name;
            $this->notifyUser(
                $subIssue->assigned_mechanic_id,
                'Cannibalization Approved',
                "{$adminName} approved the cannibalized repair for \"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}).",
                'cannibalization_approved',
                $ticket->ticket_id
            );
            // Approval releases this line item to For Inspection — if it was
            // the last one outstanding, the whole ticket goes to the
            // Custodian now (same rule as logRepairs()).
            $this->advanceToVerificationIfReady($ticket, $request);
        });

        return $subIssue->fresh();
    }

    /**
     * Admin rejects a cannibalized repair — sends it back to the mechanic
     * (Under Repair) instead of on to verification. No donor-vehicle side
     * effects happen at all: nothing was actually removed from another
     * vehicle on a rejection, so there's nothing to record there.
     */
    public function rejectCannibalization(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireAbility($request, 'repair.reject_cannibalized');
        $this->assertBelongsToTicket($ticket, $subIssue);

        abort_unless($ticket->status === 'Active', 422, "A cannibalized repair can only be rejected while the ticket is Active. Current status: {$ticket->status}.");
        abort_unless($subIssue->status === 'Pending Approval' && $subIssue->cannibalization_status === 'Pending', 422, 'This sub-issue is not awaiting cannibalization approval.');

        $data = $request->validate([
            'cannibalization_rejection_reason' => ['required', 'string'],
        ], [
            'cannibalization_rejection_reason.required' => 'A reason is required so the mechanic knows what to do instead.',
        ]);

        DB::transaction(function () use ($ticket, $subIssue, $data, $request) {
            $fresh = TicketSubIssue::where('sub_issue_id', $subIssue->sub_issue_id)->lockForUpdate()->first();
            abort_unless(
                $fresh && $fresh->status === 'Pending Approval' && $fresh->cannibalization_status === 'Pending',
                422,
                'This sub-issue is not awaiting cannibalization approval.'
            );

            $subIssue->update([
                'status'                            => 'Under Repair',
                'cannibalization_status'            => 'Rejected',
                'cannibalization_rejection_reason'  => $data['cannibalization_rejection_reason'],
                'cannibalization_reviewed_by'       => $request->user()->id,
                'cannibalization_reviewed_at'       => now(),
            ]);

            $this->log(
                $request,
                'Cannibalization Rejected',
                "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" cannibalized repair rejected. Reason: {$data['cannibalization_rejection_reason']}",
                $ticket->ticket_id
            );

            $adminName = $request->user()->name;
            $vehicleName = $ticket->vehicle->vehicle_name;
            $this->notifyUser(
                $subIssue->assigned_mechanic_id,
                'Cannibalization Rejected',
                "{$adminName} rejected the cannibalized repair for \"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}). Reason: {$data['cannibalization_rejection_reason']}",
                'cannibalization_rejected',
                $ticket->ticket_id
            );
        });

        return $subIssue->fresh();
    }

    // ===================================================================
    // PHASE 4 Tier 1 — Custodian: Verify a Sub-Issue's Repair
    // ===================================================================

    public function verifyRepair(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireAbility($request, 'subissue.verify');
        $this->assertBelongsToTicket($ticket, $subIssue);

        // Production-readiness audit finding #2 — Tier-1 verification is a
        // Custodian-only action; Admin no longer holds subissue.verify at
        // all (config/permissions.php), so this unconditionally requires
        // being the SPECIFIC verifier this sub-issue was assigned to. If
        // that Custodian is unavailable, the correct fix is reassigning the
        // ticket to a different Custodian (reassignCustodian(), which
        // already carries verification_assigned_to to the new one) — not an
        // Admin quietly standing in for the Custodian's own check.
        abort_unless($subIssue->verification_assigned_to === $request->user()->id, 403, "This verification is assigned to {$subIssue->verificationAssignedTo?->name}.");

        // Independent check is the entire point of this step — "don't grade
        // your own homework." A dual-role (Custodian + Maintenance
        // Personnel) account that logged this repair can never be the one
        // who signs off on it, even if they're also this sub-issue's
        // assigned verifier — the ticket's Custodian has to be reassigned to
        // someone else entirely for it to proceed. Also checks
        // prior_mechanic_ids, not just the current assigned_mechanic_id — a
        // mechanic reassigned away mid-repair may have already logged real
        // work on this exact sub-issue before handing it off.
        abort_if(
            $subIssue->assigned_mechanic_id === $request->user()->id
                || in_array($request->user()->id, $subIssue->prior_mechanic_ids ?? [], true),
            403,
            'You performed repair work on this sub-issue — it must be verified by a different Custodian. Reassign this ticket to another Custodian.'
        );

        abort_unless($ticket->status === 'Active', 422, "Verification can only be submitted while the ticket is Active. Current status: {$ticket->status}.");
        abort_unless($subIssue->status === 'For Inspection', 422, "Verification can only be submitted when the sub-issue is For Inspection. Current: {$subIssue->status}.");

        // Problem 2 — verification is now a real functional test ("UAT"):
        // the Custodian operates the vehicle against a checklist and attests
        // to it. This is deliberately the CUSTODIAN's gate, not the mechanic's
        // — the tester must be independent of whoever did the repair
        // ("don't grade your own homework"). A failed check cannot be
        // Approved; rejecting bounces the sub-issue back to Under Repair.
        $data = $request->validate([
            'verification_verdict'     => ['required', Rule::in(['Approved', 'Rejected'])],
            'verification_notes'       => ['nullable', 'string'],
            'functional_test'          => ['required', 'array', 'min:1'],
            'functional_test.*.item'   => ['required', 'string', 'max:255'],
            'functional_test.*.passed' => ['required', 'boolean'],
            'test_attested'            => ['boolean'],
        ]);

        $approved = $data['verification_verdict'] === 'Approved';

        if ($approved) {
            abort_unless(
                $request->boolean('test_attested'),
                422,
                'Before approving, you must attest that you actually operated and tested the vehicle.'
            );
            $anyFailed = collect($data['functional_test'])->contains(fn ($i) => !$i['passed']);
            abort_if(
                $anyFailed,
                422,
                'This functional test has a failed check — it cannot be Approved. Reject it so the mechanic can redo the work.'
            );
        }

        DB::transaction(function () use ($ticket, $subIssue, $data, $request, $approved) {
            // Lock the sub-issue row for the duration of this verification
            // so it can't race a concurrent verify/confirm on the same
            // sub-issue.
            TicketSubIssue::where('sub_issue_id', $subIssue->sub_issue_id)->lockForUpdate()->first();

            $subIssue->update([
                'status'               => $approved ? 'For Confirmation' : 'Under Repair',
                'verification_verdict' => $data['verification_verdict'],
                'verification_notes'   => $data['verification_notes'] ?? null,
                'verified_by'          => $request->user()->id,
                'verified_at'          => now(),
                'repair_completed_at'  => $approved ? $subIssue->repair_completed_at : null,
                'functional_test'      => $data['functional_test'],
                'test_attested'        => $request->boolean('test_attested'),
            ]);

            $this->log($request, 'Repair Verified', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" verification: {$data['verification_verdict']}.", $ticket->ticket_id);

            $custodianName = $request->user()->name;
            $vehicleName = $ticket->vehicle->vehicle_name;
            if ($approved) {
                $this->notifyAdmins(
                    'Repairs Approved by Custodian',
                    "Custodian {$custodianName} approved \"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}). Please give final confirmation.",
                    'repairs_approved',
                    $ticket->ticket_id,
                    $ticket->vehicle->barangay_id
                );
            } else {
                $this->notifyUser(
                    $subIssue->assigned_mechanic_id,
                    'Work Order Rejected',
                    "Custodian {$custodianName} rejected \"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}). Please re-perform repairs.",
                    'repairs_rejected',
                    $ticket->ticket_id
                );
            }
        });

        return $subIssue->fresh();
    }

    // ===================================================================
    // PHASE 4 Tier 2 — Admin: Confirm (or Rework) a Sub-Issue
    // ===================================================================

    public function confirmSubIssue(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireAbility($request, 'subissue.confirm');
        $this->assertBelongsToTicket($ticket, $subIssue);

        // Defense-in-depth alongside verifyRepair()'s self-verification
        // block — confirm is Admin-only, so this only bites a dual-role
        // (Admin + Maintenance Personnel) account confirming their own
        // repair. Tier 1 (verifyRepair) already keeps a self-repairing
        // Custodian out of this stage, but Admin isn't exempt from that
        // same "don't grade your own homework" rule just because it's the
        // final tier instead of the first. Also checks prior_mechanic_ids
        // for the same mid-repair-reassignment reason as verifyRepair().
        abort_if(
            $subIssue->assigned_mechanic_id === $request->user()->id
                || in_array($request->user()->id, $subIssue->prior_mechanic_ids ?? [], true),
            403,
            'You performed repair work on this sub-issue — another Admin needs to give the final confirmation.'
        );

        abort_unless($ticket->status === 'Active', 422, "A sub-issue can only be confirmed while the ticket is Active. Current status: {$ticket->status}.");
        abort_unless($subIssue->status === 'For Confirmation', 422, "A sub-issue can only be confirmed when it is For Confirmation. Current: {$subIssue->status}.");

        $data = $request->validate([
            'confirmation_verdict' => ['required', Rule::in(['Confirmed', 'Reopened'])],
            'confirmation_notes'   => ['nullable', 'string'],
        ]);

        DB::transaction(function () use ($ticket, $subIssue, $data, $request) {
            // Lock the sub-issue row for the duration of this confirmation
            // so it can't race a concurrent confirm/reopen on the same
            // sub-issue (e.g. closeTicket() finalizing it at the same time).
            $lockedSub = TicketSubIssue::where('sub_issue_id', $subIssue->sub_issue_id)->lockForUpdate()->first();
            abort_unless($lockedSub && $lockedSub->status === 'For Confirmation', 422, 'This sub-issue was already confirmed or changed.');

            $confirmed = $data['confirmation_verdict'] === 'Confirmed';
            $vehicleName = $ticket->vehicle->vehicle_name;

            if ($confirmed) {
                $this->finalizeConfirmedSubIssue($ticket, $subIssue, $request->user()->id, $data['confirmation_notes'] ?? null);

                $progress = $ticket->fresh()->progress;
                $this->log($request, 'Sub-Issue Confirmed', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" confirmed Done. Progress {$progress['done']}/{$progress['total']}.", $ticket->ticket_id);

                $this->notifyUser(
                    $ticket->assigned_custodian_id,
                    'Sub-Issue Confirmed',
                    "\"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}) has been confirmed Done ({$progress['done']}/{$progress['total']}).",
                    'sub_issue_confirmed',
                    $ticket->ticket_id
                );

                if ($progress['done'] === $progress['total']) {
                    $this->notifyAdmins(
                        'Ticket Ready to Close',
                        "All sub-issues on Ticket #{$ticket->ticket_id} ({$vehicleName}) are Done ({$progress['done']}/{$progress['total']}). You may now close the ticket.",
                        'ticket_ready_to_close',
                        $ticket->ticket_id,
                        $ticket->vehicle->barangay_id
                    );
                }
            } else {
                // Rework loop — the sub-issue isn't actually done yet, so
                // this is not the "reopen a Closed ticket" case at all.
                $subIssue->update([
                    'status'               => 'Under Repair',
                    'confirmation_verdict' => 'Reopened',
                    'confirmation_notes'   => $data['confirmation_notes'] ?? null,
                    'confirmed_by'         => $request->user()->id,
                    'confirmed_at'         => now(),
                    'verification_verdict' => null,
                    'verification_notes'   => null,
                    'verified_by'          => null,
                    'verified_at'          => null,
                    'repair_completed_at'  => null,
                ]);

                $this->log($request, 'Sub-Issue Sent Back', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" sent back to Under Repair by Admin.", $ticket->ticket_id);

                $this->notifyUser(
                    $subIssue->assigned_mechanic_id,
                    'Work Order Sent Back',
                    "\"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}) was sent back by Admin. Please re-perform repairs.",
                    'work_order_reopened',
                    $ticket->ticket_id
                );
            }
        });

        return $subIssue->fresh();
    }

    public function reopenConfirmedSubIssue(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireAbility($request, 'subissue.reopen_confirmed');
        $this->assertBelongsToTicket($ticket, $subIssue);

        abort_unless($subIssue->status === 'Done', 422, "Only Done sub-issues can be unconfirmed. Current status: {$subIssue->status}.");
        abort_unless($subIssue->confirmation_verdict === 'Confirmed', 422, "Only confirmed sub-issues can be unconfirmed.");
        abort_unless($ticket->status === 'Active', 422, "Ticket must be Active to unconfirm a sub-issue.");

        $data = $request->validate([
            'reopen_reason' => ['nullable', 'string'],
        ]);

        $data['reopen_reason'] = $data['reopen_reason'] ?? null;

        DB::transaction(function () use ($ticket, $subIssue, $data, $request) {
            // Unconfirming voids the ledger line that confirming wrote —
            // otherwise re-confirming adds a second record and the repair's
            // cost is counted twice. Matched on the exact confirmation stamp
            // finalizeConfirmedSubIssue() copied onto the record.
            VehicleMaintenanceRecord::where('vehicle_id', $ticket->vehicle_id)
                ->where('confirmed_by', $subIssue->confirmed_by)
                ->where('confirmed_at', $subIssue->confirmed_at)
                ->where('problem_reason', $ticket->ticket_title . ': ' . $subIssue->title)
                ->delete();
            if ($subIssue->issue_report_id) {
                VehicleIssueReport::where('issue_report_id', $subIssue->issue_report_id)->update(['status' => 'In Maintenance']);
            }

            $subIssue->update([
                'status'                   => 'For Inspection',
                // Re-stamp to the ticket's CURRENT custodian — not whoever
                // was custodian back when this sub-issue first reached
                // Done. Without this, a custodian reassigned off the
                // ticket while a sub-issue sat Done/Confirmed leaves that
                // stale id here, and verifyRepair() checks only against
                // verification_assigned_to, so the real current custodian
                // gets blocked from re-verifying (see reassignCustodian(),
                // which cascades the same field for pending 'For
                // Inspection' sub-issues at reassignment time).
                'verification_assigned_to' => $ticket->assigned_custodian_id,
                'verification_verdict'     => null,
                'verification_notes'       => null,
                'verified_by'              => null,
                'verified_at'              => null,
                'confirmation_verdict'     => null,
                'confirmation_notes'       => $data['reopen_reason'] ?? null,
                'confirmed_by'             => null,
                'confirmed_at'             => null,
                'reopened_by'              => $request->user()->id,
                'reopened_at'              => now(),
            ]);

            $this->log($request, 'Confirmed Sub-Issue Reopened', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" reopened by Admin. Reason: {$data['reopen_reason']}", $ticket->ticket_id);

            $vehicleName = $ticket->vehicle->vehicle_name;
            $adminName = $request->user()->name;
            $reason = $data['reopen_reason'] ? "Reason: {$data['reopen_reason']}" : 'Admin request for re-verification.';

            $this->notifyUser(
                $ticket->assigned_custodian_id,
                'Repair Re-Verification Required',
                "Admin {$adminName} has reopened \"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}) for re-verification. {$reason}",
                'repair_reopened_for_verification',
                $ticket->ticket_id
            );
        });

        return $subIssue->fresh();
    }

    // ===================================================================
    // PHASE 5 — Admin: Explicit Ticket Closure (only at N/N)
    // ===================================================================

    public function closeTicket(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.close');

        abort_unless($ticket->status === 'Active', 422, "Only an Active ticket can be closed. Current: {$ticket->status}.");

        $ticket->load('subIssues');

        $data = $request->validate([
            'closing_notes'       => ['nullable', 'string'],
            'deferral_reason'     => ['nullable', 'string'],
            'returned_to_service' => ['nullable', 'boolean'],
        ]);

        // A "decision-close" is any close made while sub-issues are still
        // unfinished (not Done, not already Deferred). The Admin is choosing
        // to end the ticket anyway — so the leftovers become Deferred, and
        // the Admin must justify it AND make the fit-for-service call.
        //
        // A sub-issue already sitting at For Confirmation is NOT part of
        // that "unfinished" bucket: the Custodian already ran the
        // functional test and Approved it (that's the only way to reach
        // this status — see verifyRepair()), so there's nothing left to
        // decide. Closing the ticket finalizes it exactly like an Admin
        // hitting "Confirm" would — see finalizeConfirmedSubIssue(). Only
        // genuinely open/in-progress sub-issues get deferred.
        $unresolved = $ticket->unresolvedSubIssues();
        $toFinalize = $unresolved->filter(fn ($s) => $s->status === 'For Confirmation');
        $toDefer = $unresolved->reject(fn ($s) => $s->status === 'For Confirmation');
        $isDecisionClose = $toDefer->isNotEmpty();

        if ($isDecisionClose) {
            abort_if(
                blank($data['deferral_reason'] ?? null),
                422,
                'This ticket still has unfinished sub-issues. To close it now, provide a reason — they will be recorded as Deferred.'
            );
            abort_unless(
                array_key_exists('returned_to_service', $data) && $data['returned_to_service'] !== null,
                422,
                'You must state whether the vehicle is fit to return to service before closing with unfinished work.'
            );
        }

        // A clean close (everything already Done/Deferred) returns the
        // vehicle to service as before; a decision-close honours the
        // Admin's explicit fit-for-service answer.
        // (An explicit answer is honoured on a clean close too — e.g. the
        // only thing left was a For Confirmation item the Admin still judged
        // unsafe — and only defaults to "fit" when none was given.)
        $returnToService = array_key_exists('returned_to_service', $data) && $data['returned_to_service'] !== null
            ? (bool) $data['returned_to_service']
            : true;

        DB::transaction(function () use ($ticket, $data, $request, $toDefer, $toFinalize, $returnToService, $isDecisionClose) {
            // Lock the ticket row for the duration of this close so a
            // concurrent action on the same ticket (another close, a
            // confirm, a defer) serializes behind this one instead of
            // racing it.
            $lockedTicket = MaintenanceTicket::where('ticket_id', $ticket->ticket_id)->lockForUpdate()->first();
            abort_unless($lockedTicket && $lockedTicket->status === 'Active', 422, 'This ticket was already closed or changed.');

            $vehicleName = $ticket->vehicle->vehicle_name;

            // Already-verified-and-approved sub-issues finalize exactly like
            // an explicit Confirm would — see the comment above.
            foreach ($toFinalize as $subIssue) {
                $this->finalizeConfirmedSubIssue($ticket, $subIssue, $request->user()->id, $data['closing_notes'] ?? null);
            }

            // Sweep every still-unfinished (and non-confirmable) sub-issue
            // into Deferred, each with the shared reason and its own
            // forget-me-not breadcrumb.
            $deferredReportIds = [];
            foreach ($toDefer as $subIssue) {
                $rid = $this->deferOneSubIssue($ticket, $subIssue, $data['deferral_reason'], $request->user()->id);
                if ($rid) {
                    $deferredReportIds[] = $rid;
                }
            }

            $ticket->update([
                'status'              => 'Closed',
                'closed_by'           => $request->user()->id,
                'closed_at'           => now(),
                'closing_notes'       => $data['closing_notes'] ?? null,
                'returned_to_service' => $returnToService,
                'archived_at'         => now(),
            ]);

            // Resolve the ticket's originating report only on a fit-for-service
            // close, and never if that same report was just deferred instead.
            if ($ticket->issue_report_id && !in_array($ticket->issue_report_id, $deferredReportIds, true)) {
                // Fit for service: the report is resolved. Not fit: it goes back
                // to Pending so the still-unsafe vehicle isn't left with a report
                // stuck In Maintenance and no open ticket behind it.
                VehicleIssueReport::where('issue_report_id', $ticket->issue_report_id)
                    ->update(['status' => $returnToService ? 'Resolved' : 'Pending']);
            }

            $ticket->refresh()->load('subIssues');
            $this->archiveCompleted($ticket, $request->user()->id, 'Closed');

            // A ticket that was auto-created from a due Maintenance Schedule
            // finishes that schedule too — otherwise it stays "Scheduled"
            // forever (counted overdue) and a recurring service never
            // seeds its next occurrence.
            $this->completeLinkedSchedule($ticket, $request->user()->id);

            // Single choke point + fit-for-service gate: closing frees the
            // vehicle ONLY if the Admin judged it fit. If not, the ticket is
            // closed but the vehicle stays flagged out of service (the
            // deferred defect lives on as its breadcrumb Issue Report).
            if ($returnToService) {
                $this->recomputeVehicleStatus($ticket->vehicle_id, $request);
            } else {
                Vehicle::where('vehicle_id', $ticket->vehicle_id)->update([
                    'status'    => 'Under Maintenance',
                    'condition' => 'Needs Repair',
                ]);
                $this->history($ticket->vehicle, 'Ticket Closed', "Ticket #{$ticket->ticket_id} ({$vehicleName}) was closed but judged not fit for service — kept Under Maintenance.", 'maintenance_tickets', $ticket->ticket_id, $request);
            }

            $progress = $ticket->progress;
            $summary = $isDecisionClose
                ? "Decision-close: {$progress['deferred']} sub-issue(s) deferred. Fit for service: " . ($returnToService ? 'Yes' : 'No') . '.'
                : "Progress: {$progress['done']}/{$progress['total']}.";
            $this->log($request, 'Ticket Closed', "Ticket #{$ticket->ticket_id} ({$vehicleName}) closed by Admin. {$summary}", $ticket->ticket_id);

            $this->notifyUser(
                $ticket->assigned_custodian_id,
                'Ticket Closed',
                "Ticket #{$ticket->ticket_id} ({$vehicleName}) has been closed by Admin." . ($isDecisionClose ? ' Some sub-issues were deferred.' : ''),
                'ticket_closed',
                $ticket->ticket_id
            );
            foreach ($ticket->subIssues->pluck('assigned_mechanic_id')->filter()->unique() as $mechanicId) {
                $this->notifyUser($mechanicId, 'Ticket Closed', "Ticket #{$ticket->ticket_id} ({$vehicleName}) has been closed by Admin.", 'ticket_closed', $ticket->ticket_id);
            }
        });

        return $ticket->fresh($this->eagerLoads());
    }

    /**
     * PUT /tickets/:ticket/sub-issues/:subIssue/defer — Admin records a
     * decision NOT to fix a single sub-issue now (no budget, part on
     * back-order, etc.). It becomes Deferred (a terminal, "resolved" state)
     * with a mandatory reason, and a breadcrumb Issue Report is opened so
     * the unfixed defect isn't forgotten. Available while the ticket is
     * Active and the sub-issue hasn't already ended.
     */
    public function deferSubIssue(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireAbility($request, 'subissue.defer');
        $this->assertBelongsToTicket($ticket, $subIssue);

        abort_unless($ticket->status === 'Active', 422, "Sub-issues can only be deferred while the ticket is Active. Current: {$ticket->status}.");
        abort_if($subIssue->isResolved(), 422, "This sub-issue is already {$subIssue->status} and cannot be deferred.");
        // For Confirmation means the Custodian already verified the repair
        // works — there's nothing left to "decide not to fix". Confirm or
        // Reopen is the only choice that still makes sense at that point.
        abort_if($subIssue->status === 'For Confirmation', 422, 'This sub-issue has already been repaired and verified — confirm or reopen it instead of deferring.');

        $data = $request->validate([
            'deferred_reason' => ['required', 'string'],
        ]);

        DB::transaction(function () use ($ticket, $subIssue, $data, $request) {
            $this->deferOneSubIssue($ticket, $subIssue, $data['deferred_reason'], $request->user()->id);
            $this->recomputeVehicleStatus($ticket->vehicle_id, $request);

            $this->log($request, 'Sub-Issue Deferred', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" deferred: {$data['deferred_reason']}", $ticket->ticket_id);

            $this->notifyUser(
                $ticket->assigned_custodian_id,
                'Sub-Issue Deferred',
                "\"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$ticket->vehicle->vehicle_name}) was deferred by Admin. A follow-up issue report was opened so it isn't forgotten.",
                'sub_issue_deferred',
                $ticket->ticket_id
            );
        });

        return $subIssue->fresh();
    }

    /**
     * PUT /tickets/:ticket/cancel — Admin cancels a ticket at any stage
     * before it's Closed.
     */
    public function cancelTicket(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.cancel');

        abort_unless(!in_array($ticket->status, ['Closed', 'Cancelled'], true), 422, 'This ticket is already closed and cannot be cancelled.');
        abort_if(in_array($ticket->status, ['Pending Approval', 'Declined'], true), 422, 'A proposal awaiting review cannot be cancelled — approve, decline, or undecline it instead.');

        // Every sub-issue already resolved (fixed or deferred) — this is
        // real, confirmed repair work on record, not something to void.
        // Close it instead; cancel is for abandoning a ticket, not for
        // discarding finished work.
        abort_if(
            $ticket->subIssues->isNotEmpty() && $ticket->unresolvedSubIssues()->isEmpty(),
            422,
            'This ticket\'s repairs are already complete — close it instead of cancelling.'
        );

        $data = $request->validate([
            'closing_notes' => ['nullable', 'string'],
        ]);

        DB::transaction(function () use ($ticket, $data, $request) {
            $ticket->update([
                'status'        => 'Cancelled',
                'closing_notes' => $data['closing_notes'] ?? null,
            ]);

            $this->resetLinkedIssueReports($ticket, 'Pending');
            // The job the schedule asked for was abandoned with the ticket.
            VehicleMaintenanceSchedule::where('resulting_ticket_id', $ticket->ticket_id)
                ->where('status', 'Scheduled')->update(['status' => 'Cancelled']);
            $this->recomputeVehicleStatus($ticket->vehicle_id, $request);

            $this->log($request, 'Ticket Cancelled', "Ticket #{$ticket->ticket_id} was cancelled by admin.", $ticket->ticket_id);
        });

        return $ticket->fresh($this->eagerLoads());
    }

    /**
     * PUT /tickets/:ticket/uncancel — Admin restores a cancelled ticket.
     * Cancelling is not the same as Closing, so this remains available —
     * it only ever targets a ticket that was never actually completed.
     */
    public function uncancelTicket(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.uncancel');

        abort_unless($ticket->status === 'Cancelled', 422, 'Only cancelled tickets can be restored.');

        $restoredStatus = $ticket->inspected_at ? 'Active' : 'Open';

        DB::transaction(function () use ($ticket, $restoredStatus, $request) {
            $ticket->update([
                'status'        => $restoredStatus,
                'closing_notes' => null,
            ]);

            $this->resetLinkedIssueReports($ticket, 'In Maintenance');
            VehicleMaintenanceSchedule::where('resulting_ticket_id', $ticket->ticket_id)
                ->where('status', 'Cancelled')->update(['status' => 'Scheduled']);
            $this->recomputeVehicleStatus($ticket->vehicle_id, $request);

            $this->log($request, 'Ticket Restored', "Ticket #{$ticket->ticket_id} was restored back to '{$restoredStatus}' by Admin.", $ticket->ticket_id);
        });

        return $ticket->fresh($this->eagerLoads());
    }

    /**
     * DELETE /tickets/:ticket — Admin deletes a ticket completely.
     *
     * A ticket that never had any real progress (no sub-issue ever reached
     * Done) is just discarded, same as always. But a ticket that already
     * had at least one sub-issue confirmed Done represents real completed
     * work — deleting that is exactly the "accidental click on unfinished
     * work" case reopening exists for, so it's archived as "Deleted" and
     * recoverable via Reopen (same safety net Cancel/Uncancel already has).
     * A ticket the Admin has explicitly Closed is a separate, permanent
     * action — see closeTicket() — and is never reachable from here.
     */
    public function deleteTicket(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.delete');

        abort_if($ticket->status === 'Closed', 422, 'A closed ticket is permanent and cannot be deleted.');

        DB::transaction(function () use ($ticket, $request) {
            $vehicleId = $ticket->vehicle_id;
            $ticket->load('subIssues');
            $hadProgress = $ticket->subIssues->contains(fn (TicketSubIssue $s) => $s->status === 'Done');

            $this->resetLinkedIssueReports($ticket, 'Pending');

            if ($hadProgress) {
                $this->archiveCompleted($ticket, $request->user()->id, 'Deleted');
            }

            $ticket->delete(); // cascades to ticket_sub_issues

            $this->recomputeVehicleStatus($vehicleId, $request);

            $this->log($request, 'Delete Ticket', "Ticket #{$ticket->ticket_id} was deleted by Admin." . ($hadProgress ? ' Archived as recoverable — it had at least one completed sub-issue.' : ''), $ticket->ticket_id);
        });

        return response()->json(['message' => 'Ticket deleted successfully.'], 200);
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
            ->whereNotIn('status', ['Closed', 'Cancelled'])
            ->get(['ticket_title'])
            ->contains(fn ($t) => $this->normalizeTicketTitle($t->ticket_title) === $normalizedSnapshotTitle);

        abort_if($duplicateMainIssue, 422, 'This vehicle already has an open ticket for this Main Issue — cannot reopen a duplicate.');

        $ticket = DB::transaction(function () use ($snapshot, $archive, $request) {
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
                'inspection_notes'      => $snapshot['inspection_notes'] ?? null,
                'inspection_result'     => $snapshot['inspection_result'] ?? null,
                'inspected_by'          => $snapshot['inspected_by'] ?? null,
                'inspected_at'          => $snapshot['inspected_at'] ?? null,
            ]);

            $subIssueFields = [
                'issue_report_id', 'created_by', 'title', 'status', 'assigned_mechanic_id',
                'maintenance_type', 'work_order_notes', 'mechanic_assigned_at', 'mechanic_assigned_by',
                'repair_logs', 'parts_used', 'repair_started_at', 'repair_completed_at', 'maintenance_cost',
                'verification_verdict', 'verification_notes', 'verified_by', 'verified_at',
                'confirmation_verdict', 'confirmation_notes', 'confirmed_by', 'confirmed_at',
                'deferred_reason', 'deferred_by', 'deferred_at', 'deferred_issue_report_id',
            ];

            foreach ($snapshot['sub_issues'] ?? [] as $si) {
                TicketSubIssue::create([
                    'ticket_id' => $ticket->ticket_id,
                    ...array_intersect_key($si, array_flip($subIssueFields)),
                ]);

                if (!empty($si['issue_report_id'])) {
                    VehicleIssueReport::where('issue_report_id', $si['issue_report_id'])->update(['status' => 'In Maintenance']);
                }
            }

            if ($ticket->issue_report_id) {
                VehicleIssueReport::where('issue_report_id', $ticket->issue_report_id)->update(['status' => 'In Maintenance']);
            }

            $this->recomputeVehicleStatus($ticket->vehicle_id, $request);

            $archive->delete();

            $this->log($request, 'Ticket Reopened', "Deleted Ticket #{$snapshot['ticket_id']} was reopened by Admin as new Ticket #{$ticket->ticket_id}.", $ticket->ticket_id);

            $this->notifyUser($ticket->assigned_custodian_id, 'Ticket Reopened', "A deleted ticket for {$archive->vehicle_name} was reopened by Admin as Ticket #{$ticket->ticket_id}.", 'ticket_reopened', $ticket->ticket_id);

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
        // Only an Active ticket means work is really under way. A Pending
        // Approval proposal or an Open ticket still awaiting inspection has
        // not put the vehicle out of service yet (approveTicket() and
        // submitInspection() are what do that), so they must not either.
        $stillOpen = MaintenanceTicket::where('vehicle_id', $vehicleId)
            ->whereIn('status', ['Active', 'For Verification'])
            ->exists();

        $vehicle = Vehicle::where('vehicle_id', $vehicleId)->first();
        // A retired vehicle stays retired.
        if (!$vehicle || in_array($vehicle->status, ['Inactive', 'Decommissioned'], true)) {
            return;
        }

        if ($stillOpen) {
            // Only a real transition is worth a History entry — this gets
            // called on nearly every sub-issue action while a ticket is
            // Active, and the vehicle is almost always already Under
            // Maintenance by then.
            if ($vehicle->status !== 'Under Maintenance') {
                $vehicle->update(['status' => 'Under Maintenance']);
                $this->history($vehicle, 'Ticket Updated', "{$vehicle->vehicle_name} moved to Under Maintenance — an active ticket is open on it.", 'vehicles', $vehicle->vehicle_id, $request);
            }
        } elseif ($vehicle->status === 'Under Maintenance') {
            // Release only a vehicle that a ticket had actually taken out of
            // service — don't overwrite the condition of one that was never
            // down (e.g. a cancelled proposal on an Available vehicle).
            $vehicle->update([
                'status'                => 'Available',
                'condition'             => 'Good',
                'estimated_return_date' => null,
            ]);
            $this->history($vehicle, 'Ticket Closed', "{$vehicle->vehicle_name} returned to Available — no more active tickets on it.", 'vehicles', $vehicle->vehicle_id, $request);
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
            VehicleIssueReport::where('issue_report_id', $subIssue->issue_report_id)->update(['status' => 'Resolved']);
        }

        // Unify ledger: every confirmed sub-issue is a line in the
        // single complete maintenance history, same as before.
        if ($subIssue->assigned_mechanic_id) {
            VehicleMaintenanceRecord::create([
                'vehicle_id'               => $ticket->vehicle_id,
                'issue_report_id'          => $subIssue->issue_report_id,
                'maintenance_type'         => $subIssue->maintenance_type ?? 'Repair',
                'problem_reason'           => $ticket->ticket_title . ': ' . $subIssue->title,
                'date_started'             => $subIssue->repair_started_at,
                'date_completed'           => $subIssue->repair_completed_at ?? now()->toDateString(),
                'maintenance_personnel_id' => $subIssue->assigned_mechanic_id,
                'action_taken'             => $subIssue->repair_logs ?? 'No logs provided.',
                'parts_used'               => $subIssue->parts_used,
                'maintenance_cost'         => $subIssue->maintenance_cost,
                'progress_status'          => 'Completed',
                'remarks'                  => $subIssue->confirmation_notes ?? "Confirmed through Ticket #{$ticket->ticket_id}",
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
     * Mark one sub-issue Deferred (a recorded decision not to fix it now)
     * and leave a breadcrumb so the defect stays visible. Returns the id of
     * the breadcrumb Issue Report (or null if none was linkable).
     */
    private function deferOneSubIssue(MaintenanceTicket $ticket, TicketSubIssue $subIssue, string $reason, int $userId): ?int
    {
        $breadcrumbId = $this->createDeferralBreadcrumb($ticket, $subIssue, $reason, $userId);

        $subIssue->update([
            'status'                   => 'Deferred',
            'deferred_reason'          => $reason,
            'deferred_by'              => $userId,
            'deferred_at'              => now(),
            'deferred_issue_report_id' => $breadcrumbId,
        ]);

        return $breadcrumbId;
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
                'remarks' => "Deferred from Ticket #{$ticket->ticket_id}: {$reason}",
            ]);

            return $subIssue->issue_report_id;
        }

        $report = VehicleIssueReport::create([
            'vehicle_id'        => $ticket->vehicle_id,
            'issue_type'        => 'Other',
            'issue_description' => "[Deferred from Ticket #{$ticket->ticket_id}] {$subIssue->title}",
            'severity_level'    => 'Medium',
            'reported_by'       => $userId,
            'status'            => 'Pending',
            'remarks'           => "Auto-created when this repair was deferred. Reason: {$reason}. Re-open a ticket when it can be addressed.",
        ]);

        return $report->issue_report_id;
    }

    private function resetLinkedIssueReports(MaintenanceTicket $ticket, string $status): void
    {
        $ids = $ticket->subIssues()->pluck('issue_report_id')
            ->push($ticket->issue_report_id)
            ->filter()
            ->unique();

        if ($ids->isNotEmpty()) {
            VehicleIssueReport::whereIn('issue_report_id', $ids)->update(['status' => $status]);
        }
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
            'vehicle_id'           => $ticket->vehicle_id,
            'ticket_title'         => $ticket->ticket_title,
            'vehicle_name'         => $vehicle->vehicle_name,
            'plate_number'         => $vehicle->plate_number,
            'final_status'         => $finalStatus ?? $ticket->status,
            'maintenance_cost'     => $ticket->subIssues->sum('maintenance_cost'),
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
            'recurrenceOf:ticket_id,ticket_title,closed_at',
            'subIssues.assignedMechanic',
            'subIssues.mechanicAssignedBy',
            'subIssues.verifiedBy',
            'subIssues.confirmedBy',
            'subIssues.reopenedBy',
            'subIssues.deferredBy',
            'subIssues.createdBy',
            'subIssues.verificationAssignedTo',
            'subIssues.sourceVehicle:vehicle_id,vehicle_name,plate_number',
            'subIssues.cannibalizationReviewedBy',
        ];
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
