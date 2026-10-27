<?php

namespace App\Http\Controllers;

use App\Http\Controllers\Concerns\AuthorizesAbilities;
use App\Http\Controllers\Concerns\ChecksRecurrence;
use App\Http\Controllers\Concerns\GuardsLastAdmin;
use App\Http\Controllers\Concerns\UploadsImages;
use App\Models\ActivityLog;
use App\Models\FaultCategory;
use App\Models\IssueReportAttachment;
use App\Models\MaintenanceTicket;
use App\Models\MaintenanceType;
use App\Models\ReportedPerson;
use App\Models\TicketSubIssue;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use App\Models\VehicleConditionCheck;
use App\Models\VehicleDocument;
use App\Models\VehicleHistory;
use App\Models\VehicleHub;
use App\Models\VehicleIssueReport;
use App\Models\VehicleLocation;
use App\Models\VehicleMaintenanceRecord;
use App\Models\VehicleMaintenanceSchedule;
use App\Models\VehicleReadinessCheck;
use App\Models\VehicleTypeField;
use App\Rules\NumberOnly;
use App\Rules\TextOnly;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

class FleetController extends Controller
{
    use UploadsImages;
    use ChecksRecurrence;
    use GuardsLastAdmin;
    use AuthorizesAbilities;

    private const CRITICALITY_LEVELS = ['Critical', 'High', 'Normal'];

    private const HULL_MATERIAL_OPTIONS = ['Fiberglass', 'Aluminum', 'Steel', 'Wood', 'Rubber/Inflatable'];

    // Gap A — a passed readiness check is only "fresh" for this many hours;
    // older than this and the vehicle reads "stale — needs re-check".
    private const READINESS_FRESHNESS_HOURS = 24;

    public function lookups(Request $request)
    {
        $this->syncVehicleStatuses();
        // User carries no global scope (see BelongsToBarangay's docblock),
        // so every person-lookup below has to filter by barangay by hand —
        // otherwise a Custodian could assign a mechanic from a different
        // barangay onto their own ticket.
        $barangayId = $request->user()->barangay_id;
        return response()->json([
            'categories' => VehicleCategory::with('fields')->orderBy('category_name')->get(),
            'vehicles' => Vehicle::with(['category', 'custodian:id,name'])->withExists([
                'tickets as has_open_maintenance_ticket' => fn ($query) => $query->whereNotIn('status', ['Closed', 'Cancelled', 'Declined']),
            ])->orderBy('vehicle_name')->get(),
            'issue_reports' => VehicleIssueReport::with('vehicle')
                ->whereNot('status', 'Resolved')
                ->latest('issue_report_id')
                ->get(),
            'custodians' => User::where('barangay_id', $barangayId)
                ->havingRole('Custodian')
                ->orderBy('name')
                ->get(['id', 'name']),
            'maintenance_personnel' => User::where('barangay_id', $barangayId)
                ->havingRole('Maintenance Personnel')
                ->orderBy('name')
                ->get(['id', 'name', 'email', 'role']),
            // Distinct from maintenance_personnel above (which stays scoped to
            // dispatchable mechanics for ticket/schedule assignment) — this one
            // powers "who actually performed this repair" on a Maintenance
            // Record, which can legitimately be anyone: a Custodian or Admin
            // sometimes does the work themselves, not just Maintenance Personnel.
            'maintenance_performers' => User::where('barangay_id', $barangayId)
                ->orderBy('name')
                ->get(['id', 'name', 'email', 'role']),
            'issue_types' => FaultCategory::orderBy('name')->pluck('name'),
            'maintenance_types' => MaintenanceType::orderBy('name')->pluck('name'),
            'severity_levels' => ['Low', 'Medium', 'High'],
            'vehicle_statuses' => ['Available', 'Under Maintenance', 'Inactive', 'Decommissioned'],
            // "Needs Inspection" removed per product direction — a Custodian
            // filing a condition check now records either Good or Needs
            // Repair, nothing in between. Historical checks already
            // recorded as Needs Inspection are untouched.
            'condition_results' => ['Good', 'Needs Repair'],
            'issue_statuses' => ['Pending', 'Under Review', 'In Maintenance', 'Resolved'],
            'maintenance_statuses' => ['Assigned', 'Under Repair', 'On Hold - Awaiting Parts', 'For Verification', 'Completed'],
            'schedule_statuses' => ['Pending Approval', 'Declined', 'Scheduled', 'Completed', 'Cancelled'],
        ]);
    }

    public function dashboard(Request $request)
    {
        $this->syncVehicleStatuses();
        $user = $request->user();
        $latestChecks = $this->latestReadinessChecks();
        $activeIssues = VehicleIssueReport::whereNot('status', 'Resolved')
            ->whereHas('vehicle', fn ($q) => $q->whereNotIn('status', ['Inactive', 'Decommissioned']))
            ->count();
        $upcomingMaintenance = VehicleMaintenanceSchedule::where('status', 'Scheduled')
            ->whereDate('scheduled_date', '>=', now()->toDateString())
            ->count();
        $overdueMaintenance = VehicleMaintenanceSchedule::where('status', 'Scheduled')
            ->whereNull('resulting_ticket_id')
            ->whereDate('scheduled_date', '<', now('Asia/Manila')->toDateString())
            ->count();

        $metrics = [
            ['label' => 'Total Vehicles', 'value' => Vehicle::count()],
            ['label' => 'Available Vehicles', 'value' => Vehicle::where('status', 'Available')->count()],
            ['label' => 'Vehicles Under Maintenance', 'value' => Vehicle::where('status', 'Under Maintenance')->count()],
        ];

        if ($user->hasRole('Admin')) {
            $metrics[] = ['label' => 'Inactive Vehicles', 'value' => Vehicle::where('status', 'Inactive')->count()];
            $metrics[] = ['label' => 'Reported Issues', 'value' => $activeIssues];
            $metrics[] = ['label' => 'Upcoming Maintenance', 'value' => $upcomingMaintenance];
            $metrics[] = ['label' => 'Overdue Maintenance', 'value' => $overdueMaintenance];

            // Maintenance Records already include every confirmed sub-issue's cost
            // (auto-copied the moment Admin confirms it Done), so records + still
            // not-yet-Done sub-issues covers all expenses exactly once.
            $totalExpenses = VehicleMaintenanceRecord::sum('maintenance_cost')
                + TicketSubIssue::where('status', '!=', 'Done')->sum('maintenance_cost');
            $metrics[] = [
                'label' => 'Total Maintenance Expenses',
                'value' => '₱' . number_format($totalExpenses, 2)
            ];
        }

        if ($user->hasRole('Custodian')) {
            $metrics[] = ['label' => 'Reported Issues', 'value' => $activeIssues];
            $metrics[] = [
                'label' => 'My Reported Issues',
                'value' => VehicleIssueReport::where('reported_by', $request->user()->id)->count(),
            ];
        }

        if ($user->hasRole('Maintenance Personnel')) {
            // Append to (not replace) the base $metrics array — it already carries
            // Total/Available/Under Maintenance vehicle counts, which the Fleet
            // Status donut and Operations Queue panels below rely on regardless
            // of role. Replacing the array here was zeroing those panels out.
            $metrics[] = ['label' => 'Reported Issues', 'value' => $activeIssues];
            $metrics[] = ['label' => 'Maintenance Records', 'value' => VehicleMaintenanceRecord::count()];
            $metrics[] = ['label' => 'Upcoming Maintenance', 'value' => $upcomingMaintenance];
            $metrics[] = ['label' => 'Overdue Maintenance', 'value' => $overdueMaintenance];
            $metrics[] = [
                'label' => 'Recently Completed Maintenance',
                'value' => VehicleMaintenanceRecord::where('progress_status', 'Completed')
                    ->whereDate('updated_at', '>=', now()->subDays(30)->toDateString())
                    ->count(),
            ];
            $metrics[] = [
                'label' => 'Vehicles Needing Attention',
                'value' => Vehicle::whereIn('condition', ['Needs Inspection', 'Needs Repair'])
                    ->whereNotIn('status', ['Inactive', 'Decommissioned'])
                    ->count(),
            ];
        }

        // A multi-hat user (e.g. Custodian + Maintenance) can accumulate the
        // same metric from two blocks — keep the first of each label.
        $seenLabels = [];
        $metrics = array_values(array_filter($metrics, function ($m) use (&$seenLabels) {
            if (isset($seenLabels[$m['label']])) {
                return false;
            }
            $seenLabels[$m['label']] = true;
            return true;
        }));

        return response()->json([
            'metrics' => $metrics,
            'badge_counts' => [
                // Match the badge to what the module list actually shows: a
                // Custodian's issue list is scoped to their OWN reports, so
                // the badge counts their own unresolved issues (not fleet-wide
                // — that would count other people's reports and breadcrumbs).
                'issues' => ($user->hasRole('Custodian') && !$user->hasRole('Admin'))
                    ? VehicleIssueReport::where('reported_by', $user->id)
                        ->whereNot('status', 'Resolved')
                        ->whereHas('vehicle', fn ($q) => $q->whereNotIn('status', ['Inactive', 'Decommissioned']))
                        ->count()
                    : $activeIssues,
                // Admin: what needs a look — proposals awaiting a decision plus
                // tickets a Custodian closed in the last 14 days (so a closure
                // shows up here without anyone telling them). Everyone else
                // keeps the open-ticket count.
                'tickets' => $user->hasRole('Admin')
                    ? MaintenanceTicket::where('status', 'Pending Approval')->count()
                        + MaintenanceTicket::where('status', 'Closed')->where('closed_at', '>=', now()->subDays(14))->count()
                    : MaintenanceTicket::whereNotIn('status', ['Closed', 'Cancelled'])->count(),
                'conditions' => VehicleConditionCheck::whereIn('condition_result', ['Needs Inspection', 'Needs Repair'])
                    ->whereHas('vehicle', fn ($q) => $q->whereNotIn('status', ['Inactive', 'Decommissioned']))
                    ->count(),
                // A mechanic's own badge only counts THEIR upcoming work, not
                // the whole fleet's — same personalization pattern as the
                // Custodian 'issues' badge above (own reports, not everyone's).
                'schedules' => ($user->hasRole('Maintenance Personnel') && !$user->hasRole('Admin'))
                    ? VehicleMaintenanceSchedule::where('status', 'Scheduled')
                        ->where('assigned_to', $user->id)
                        ->count()
                    : $upcomingMaintenance + $overdueMaintenance,
                // Maintenance Records waiting on someone's check — the same
                // "For Verification" list the Records page filters to.
                'maintenance' => ($user->hasRole('Admin') || $user->hasRole('Custodian'))
                    ? VehicleMaintenanceRecord::where('progress_status', 'For Verification')->count()
                    : 0,
                // Admin only: self-registrations still waiting for approval.
                'users' => $user->hasRole('Admin')
                    ? User::whereNull('approved_at')->where('is_active', false)->where('barangay_id', $user->barangay_id)->count()
                    : 0,
                'ticketInspections' => MaintenanceTicket::where('assigned_custodian_id', $request->user()->id)
                    ->where('status', 'Open')
                    ->count(),
                // Verification is now a ticket-level step (one Custodian
                // attestation closes the whole job) — the badge counts
                // TICKETS at For Verification, not sub-issues. Work-order
                // assignment is still per line item, so that badge is
                // unchanged below.
                'ticketVerifications' => MaintenanceTicket::where('status', 'For Verification')
                    ->where('assigned_custodian_id', $request->user()->id)
                    ->count(),
                // Work orders are counted per ticket, the same way the page's
                // Pending card is: tickets still Active in this mechanic's
                // hands (a two-sub-issue ticket is one work order, not two).
                'ticketWorkOrders' => MaintenanceTicket::where(fn ($query) => $query->where('assigned_mechanic_id', $request->user()->id)
                        ->orWhereHas('subIssues', fn ($subs) => $subs->where('assigned_mechanic_id', $request->user()->id)))
                    ->where('status', 'Active')
                    ->count(),
                // Admin's queue of Custodian-proposed tickets awaiting
                // approve/decline (TicketController::proposeTicket).
                'ticketProposals' => $user->hasRole('Admin')
                    ? MaintenanceTicket::where('status', 'Pending Approval')->count()
                    : 0,
            ],
            'vehicles_by_type' => Vehicle::query()
                ->join('vehicle_categories', 'vehicles.category_id', '=', 'vehicle_categories.category_id')
                ->selectRaw('vehicle_categories.category_name as label, count(*) as value')
                ->groupBy('vehicle_categories.category_name')
                ->orderBy('vehicle_categories.category_name')
                ->get(),
            'vehicles_by_location' => Vehicle::query()
                ->selectRaw('current_location as label, count(*) as value')
                ->groupBy('current_location')
                ->orderBy('current_location')
                ->get(),
            // Fleet health (Good/Needs Inspection/Needs Repair) — a
            // different signal than the status counts (Available/Under
            // Maintenance/Inactive) already shown as their own KPI tiles,
            // ordered by severity rather than alphabetically.
            'vehicles_by_condition' => Vehicle::query()
                ->selectRaw('condition as label, count(*) as value')
                ->groupBy('condition')
                ->orderByRaw("CASE condition
                    WHEN 'Good' THEN 1
                    WHEN 'Needs Inspection' THEN 2
                    WHEN 'Needs Repair' THEN 3
                    ELSE 4 END")
                ->get(),
            'recent_updates' => VehicleHistory::with(['vehicle', 'updatedBy'])
                ->latest('history_id')
                ->limit(8)
                ->get(),
            // Availability Forecast — which vehicles are out and when they are
            // expected back, so availability can be read as a forecast, not just
            // a "right now" snapshot.
            'availability_forecast' => [
                'available_now' => Vehicle::where('status', 'Available')->count(),
                'under_maintenance' => Vehicle::where('status', 'Under Maintenance')
                    // Vehicles with a known return date first (soonest first),
                    // then the ones still awaiting an estimate.
                    ->orderByRaw('estimated_return_date IS NULL, estimated_return_date ASC')
                    ->get(['vehicle_id', 'vehicle_name', 'plate_number', 'estimated_return_date']),
            ],
            'overdue_schedules' => VehicleMaintenanceSchedule::with('vehicle:vehicle_id,vehicle_name,plate_number')
                ->where('status', 'Scheduled')
                ->whereNull('resulting_ticket_id')
                ->whereDate('scheduled_date', '<', now('Asia/Manila')->toDateString())
                ->orderBy('scheduled_date')
                ->get(['schedule_id', 'vehicle_id', 'maintenance_type', 'scheduled_date']),

            // Gap 1 — Readiness/Coverage: don't ask "is this vehicle up?", ask
            // "for each emergency function, do we have a ready unit?". Now also
            // reports "verified ready" (Gap A) alongside merely "available".
            'readiness' => $this->fleetReadiness($latestChecks),

            // #12 — one fleet-wide headline: "X of Y emergency vehicles ready
            // right now", plus a hard alert when any category has zero ready
            // units (no_coverage). Answers "can we respond at all?" at a glance.
            'fleet_readiness_summary' => $this->fleetReadinessSummary($latestChecks),

            // Gap 2 — Preventive maintenance with teeth: overdue/due-soon PM is
            // surfaced as an at-risk signal instead of a silent calendar list.
            'preventive_watch' => $this->preventiveWatch(),

            // Gap A — available vehicles whose readiness check is stale, failed,
            // or never done: "available" but not verified ready to respond.
            'readiness_watch' => $this->readinessWatch($latestChecks),
            'criticality_watch' => $this->criticalityWatch($latestChecks),

            // Gap B — standing single-point-of-failure risk, visible even while
            // the lone unit is still healthy.
            'fragility' => $this->fragility(),

            // Final feature pass — Fleet Capability & Readiness Impact: the
            // same readiness/criticality signals above, rolled up to "which
            // emergency capability is at risk right now" per Vehicle Type.
            'capability_impact' => $this->capabilityImpact(),

            // Gap C — what's breaking most across the whole fleet (12 months).
            'failure_patterns' => $this->failurePatterns(),

            // Action Queue — the dashboard's job is to answer "what needs me
            // right now", not just "what's currently true". Pulls everything
            // waiting on an Admin decision from across the whole system
            // (issues, tickets, readiness, schedules) into one ranked list,
            // instead of five separate modules someone has to remember to
            // check. Admin-only: every item here is an Admin action.
            'action_queue' => $user->hasRole('Admin') ? $this->actionQueue($latestChecks) : [],

            // My Scheduled Work — a mechanic's personal task list, so being
            // assigned a schedule means something shows up on THEIR dashboard,
            // not just on the shared fleet-wide schedule table. No cron: this
            // is computed fresh on every dashboard load, same as everything
            // else here.
            'my_scheduled_work' => $user->hasRole('Maintenance Personnel')
                ? VehicleMaintenanceSchedule::with('vehicle:vehicle_id,vehicle_name,plate_number')
                    ->where('status', 'Scheduled')
                    ->whereNull('resulting_ticket_id')
                    ->where('assigned_to', $user->id)
                    ->orderBy('scheduled_date')
                    ->get(['schedule_id', 'vehicle_id', 'maintenance_type', 'scheduled_date', 'scheduled_time', 'status'])
                : [],

            // VMS-IMPROVEMENT-PLAN.md Phase A4 — surfaces the same
            // condition GuardsLastAdmin blocks from being CREATED, so an
            // Admin sees "you're one departure away from an orphaned
            // barangay" before it becomes a Super Admin recovery case.
            'sole_active_admin' => $user->hasRole('Admin') && $this->isLastActiveAdminForBarangay($user),
        ]);
    }

    /**
     * Builds the Action Queue: every item currently waiting on an Admin
     * decision, ranked so the highest-value/most-urgent items surface first.
     * A "not_ready" readiness state on an emergency vehicle outranks
     * everything (safety); a ticket that's already fully resolved and just
     * needs one click to close outranks a routine pending issue review.
     */
    private function actionQueue($latestChecks): array
    {
        $items = [];

        foreach (VehicleIssueReport::where('status', 'Pending')->with('vehicle')->latest('issue_report_id')->get() as $issue) {
            $items[] = [
                'type'         => 'issue_pending',
                'id'           => $issue->issue_report_id,
                'label'        => "Review reported issue: {$issue->issue_type}",
                'vehicle_name' => $issue->vehicle->vehicle_name ?? null,
                'severity'     => $issue->severity_level,
            ];
        }

        foreach (TicketSubIssue::where('status', 'For Confirmation')->with(['ticket.vehicle'])->get() as $subIssue) {
            $items[] = [
                'type'         => 'ticket_confirm',
                'id'           => $subIssue->ticket_id,
                'label'        => "Confirm repair: {$subIssue->title}",
                'vehicle_name' => $subIssue->ticket->vehicle->vehicle_name ?? null,
                'severity'     => null,
            ];
        }

        // A sub-issue lands here the moment it's created — either a
        // Custodian's inspection findings or a Pre-Diagnosed ticket — and
        // stays invisible to the Admin otherwise: the one-time "Inspection
        // Submitted" / "Pre-Diagnosed Ticket Ready" bell notification is
        // easy to miss or dismiss, and nothing else ever points back at it.
        // Surfacing it here keeps "needs a mechanic assigned" visible for as
        // long as it's actually true, not just for the moment it happened.
        foreach (TicketSubIssue::where('status', 'Open')->whereNull('assigned_mechanic_id')->with(['ticket.vehicle'])->get() as $subIssue) {
            $items[] = [
                'type'         => 'subissue_needs_mechanic',
                'id'           => $subIssue->ticket_id,
                'label'        => "Assign a mechanic: {$subIssue->title}",
                'vehicle_name' => $subIssue->ticket->vehicle->vehicle_name ?? null,
                'severity'     => null,
            ];
        }

        $activeTickets = MaintenanceTicket::where('status', 'Active')->with(['subIssues', 'vehicle'])->get();
        foreach ($activeTickets as $ticket) {
            if ($ticket->isEligibleToClose()) {
                $items[] = [
                    'type'         => 'ticket_close',
                    'id'           => $ticket->ticket_id,
                    'label'        => "Ready to close: {$ticket->ticket_title}",
                    'vehicle_name' => $ticket->vehicle->vehicle_name ?? null,
                    'severity'     => null,
                ];
            }
        }

        foreach ($this->readinessWatch($latestChecks) as $r) {
            $reason = $r['state'] === 'unchecked' ? 'never checked' : ($r['state'] === 'stale' ? 'check is stale' : 'failed last check');
            $items[] = [
                'type'         => 'readiness_check',
                'id'           => $r['vehicle_id'],
                'label'        => "Verify readiness — {$reason}",
                'vehicle_name' => $r['vehicle_name'],
                'severity'     => $r['state'] === 'not_ready' ? 'Critical' : null,
            ];
        }

        foreach ($this->preventiveWatch() as $s) {
            if ($s['state'] === 'overdue') {
                $items[] = [
                    'type'         => 'schedule_overdue',
                    'id'           => $s['schedule_id'],
                    'label'        => "Overdue maintenance: {$s['maintenance_type']}",
                    'vehicle_name' => $s['vehicle_name'],
                    'severity'     => 'High',
                ];
            }
        }

        // #9 — recurrence_count is stamped on the ticket at creation and never
        // revisited. A 3rd-time-in-90-days fault (recurrence_count >= 2, since
        // it counts PRIOR occurrences) is exactly the case the creation-time
        // notification already tells Admin to "consider a deeper fix or
        // decommission review" — but that advice had nowhere to live
        // afterward. This keeps it visible for as long as the ticket is
        // still open, instead of it evaporating once the notification is read.
        foreach (MaintenanceTicket::whereIn('status', ['Open', 'Active'])->where('recurrence_count', '>=', 2)->with('vehicle')->get() as $ticket) {
            $items[] = [
                'type'         => 'recurring_fault_review',
                'id'           => $ticket->ticket_id,
                'label'        => 'Recurring fault (' . ($ticket->recurrence_count + 1) . "x): {$ticket->ticket_title} — consider a deeper fix",
                'vehicle_name' => $ticket->vehicle->vehicle_name ?? null,
                'severity'     => 'High',
            ];
        }

        $rank = function (array $item): int {
            if (($item['severity'] ?? null) === 'Critical') {
                return 0;
            }
            return match ($item['type']) {
                'ticket_close'             => 1,
                // A vehicle sitting with a diagnosed problem and no mechanic
                // working on it yet is more urgent than paperwork on repairs
                // already underway or done — nothing progresses on it until
                // an Admin acts.
                'subissue_needs_mechanic'  => 2,
                'ticket_confirm'           => 3,
                'recurring_fault_review'   => 4,
                'issue_pending'            => 5,
                'readiness_check'          => 6,
                'schedule_overdue'         => 7,
                default                    => 7,
            };
        };
        usort($items, fn ($a, $b) => $rank($a) <=> $rank($b));

        return $items;
    }

    /** Latest readiness check per vehicle, keyed by vehicle_id. */
    private function latestReadinessChecks()
    {
        return VehicleReadinessCheck::orderByDesc('checked_at')
            ->get()
            ->unique('vehicle_id')
            ->keyBy('vehicle_id');
    }

    /**
     * Gap A — a vehicle's "ready to respond" state. "Available" is necessary
     * but not sufficient: only a recent passing check makes it verified ready.
     */
    private function responseReadinessState(Vehicle $vehicle, $latest): string
    {
        if (in_array($vehicle->status, ['Inactive', 'Decommissioned'], true)) {
            return 'retired';
        }
        if ($vehicle->status !== 'Available') {
            return 'in_maintenance';
        }
        // Deliberately NOT gated on condition here — a vehicle can be
        // Available with a lingering "Needs Repair" condition (see
        // markVehicleAvailable's override for the emergency-dispatch case);
        // whether it's actually ready to respond right now is decided by
        // the readiness check itself, below.
        if (!$latest) {
            return 'unchecked';
        }
        if ($vehicle->readiness_invalidated_at && $latest->checked_at->lte($vehicle->readiness_invalidated_at)) {
            return 'stale';
        }
        if (!$latest->all_passed) {
            return 'not_ready';
        }

        return $latest->checked_at->gte(now()->subHours(self::READINESS_FRESHNESS_HOURS))
            ? 'ready'
            : 'stale';
    }

    /**
     * Gap 1 — coverage grouped by vehicle type. A category whose ready count
     * hits zero is a NO-COVERAGE alarm (e.g. the only ambulance is down).
     */
    /**
     * #12 — fleet-wide readiness roll-up across all operational vehicles.
     * verified_ready = Available AND passed a fresh readiness check. The
     * no_coverage alert fires when at least one category has zero ready units
     * (derived from the same per-category readiness the dashboard already shows).
     */
    private function fleetReadinessSummary($latestChecks = null): array
    {
        $latestChecks = $latestChecks ?? $this->latestReadinessChecks();
        $categories = $this->fleetReadiness($latestChecks);

        $operational = array_sum(array_column($categories, 'total'));
        $available = array_sum(array_column($categories, 'ready'));
        $verifiedReady = array_sum(array_column($categories, 'verified_ready'));
        $categoriesNoCoverage = array_values(array_filter(
            $categories,
            fn ($c) => $c['no_coverage']
        ));

        return [
            'operational_total' => $operational,
            'available'         => $available,
            'verified_ready'    => $verifiedReady,
            'down'              => $operational - $available,
            // Hard alert: a category with no ready unit means we cannot answer
            // a call for that emergency function right now.
            'coverage_alert'    => count($categoriesNoCoverage) > 0,
            'categories_without_coverage' => array_column($categoriesNoCoverage, 'category'),
        ];
    }

    private function fleetReadiness($latestChecks = null): array
    {
        $latestChecks = $latestChecks ?? $this->latestReadinessChecks();

        return Vehicle::with('category')
            ->whereNotIn('status', ['Inactive', 'Decommissioned'])
            ->get()
            ->groupBy(fn ($v) => $v->category?->category_name ?? 'Uncategorized')
            ->map(function ($group, $name) use ($latestChecks) {
                $total = $group->count();
                $ready = $group->where('status', 'Available')->count();
                // "Verified ready" = Available AND passed a fresh readiness check.
                $verifiedReady = $group->filter(
                    fn ($v) => $this->responseReadinessState($v, $latestChecks->get($v->vehicle_id)) === 'ready'
                )->count();
                return [
                    'category'       => $name,
                    'ready'          => $ready,
                    'verified_ready' => $verifiedReady,
                    'down'           => $total - $ready,
                    'total'          => $total,
                    'no_coverage'    => $ready === 0 && $total > 0,
                ];
            })
            ->sortBy('category')
            ->values()
            ->all();
    }

    /**
     * Gap A — available vehicles that are NOT verified ready: their readiness
     * check is stale, failed, or was never done. "Available" but unproven.
     */
    private function readinessWatch($latestChecks): array
    {
        return Vehicle::with('category')
            ->where('status', 'Available')
            ->get()
            ->map(function ($v) use ($latestChecks) {
                $latest = $latestChecks->get($v->vehicle_id);
                return [
                    'vehicle_id'   => $v->vehicle_id,
                    'vehicle_name' => $v->vehicle_name,
                    'plate_number' => $v->plate_number,
                    'category'     => $v->category?->category_name,
                    'state'        => $this->responseReadinessState($v, $latest),
                    'last_checked' => $latest?->checked_at,
                    'criticality'  => $v->effectiveCriticality(),
                ];
            })
            ->filter(fn ($r) => in_array($r['state'], ['stale', 'not_ready', 'unchecked'], true))
            ->sortBy(fn ($r) => array_search($r['criticality'], self::CRITICALITY_LEVELS, true))
            ->values()
            ->all();
    }

    /**
     * Fleet Readiness & Criticality Watch — every operational vehicle that is
     * NOT currently verified ready (down for maintenance, or Available but
     * unproven), ranked Critical -> High -> Normal so the vehicles that
     * matter most surface first. Reuses responseReadinessState(), the one
     * place "ready" is decided.
     */
    private function criticalityWatch($latestChecks): array
    {
        $labels = ['in_maintenance' => 'In maintenance', 'not_ready' => 'Failed readiness check', 'unchecked' => 'Never checked', 'stale' => 'Check out of date'];

        return Vehicle::with('category')
            ->whereNotIn('status', ['Inactive', 'Decommissioned'])
            ->get()
            ->map(fn ($v) => [
                'vehicle_id'   => $v->vehicle_id,
                'vehicle_name' => $v->vehicle_name,
                'plate_number' => $v->plate_number,
                'category'     => $v->category?->category_name,
                'criticality'  => $v->effectiveCriticality(),
                'state'        => $this->responseReadinessState($v, $latestChecks->get($v->vehicle_id)),
            ])
            ->filter(fn ($r) => $r['state'] !== 'ready')
            ->map(fn ($r) => $r + ['reason' => $labels[$r['state']] ?? $r['state']])
            ->sortBy([
                fn ($a, $b) => array_search($a['criticality'], self::CRITICALITY_LEVELS, true) <=> array_search($b['criticality'], self::CRITICALITY_LEVELS, true),
                fn ($a, $b) => strcmp($a['vehicle_name'], $b['vehicle_name']),
            ])
            ->values()
            ->all();
    }

    /**
     * Gap B — single-point-of-failure map. A vehicle type with at most ONE
     * currently-READY unit is a standing risk (one breakdown from zero
     * coverage) — whether that's because only one unit exists at all, or
     * because several exist but all-but-one are already down for repair.
     * Keyed off `ready`, not the total fleet size, so a 3-ambulance category
     * with 2 in the shop still gets flagged.
     */
    private function fragility(): array
    {
        return Vehicle::with('category')
            ->whereNotIn('status', ['Inactive', 'Decommissioned'])
            ->get()
            ->groupBy(fn ($v) => $v->category?->category_name ?? 'Uncategorized')
            ->map(function ($group, $name) {
                $operational = $group->count();
                $ready = $group->where('status', 'Available')->count();
                return [
                    'category'          => $name,
                    'operational'       => $operational,
                    'ready'             => $ready,
                    'single_point'      => $ready <= 1,
                    // Worse: not just down to one, but down to zero ready units.
                    'critical'          => $ready === 0,
                ];
            })
            ->filter(fn ($r) => $r['single_point'])
            ->sortBy('category')
            ->values()
            ->all();
    }

    /** Every ticket still open (not Closed/Cancelled), one per vehicle (the most recent), keyed by vehicle_id. */
    private function activeTicketsByVehicle()
    {
        return MaintenanceTicket::whereNotIn('status', ['Closed', 'Cancelled'])
            ->orderByDesc('ticket_id')
            ->get(['ticket_id', 'vehicle_id'])
            ->unique('vehicle_id')
            ->keyBy('vehicle_id');
    }

    /**
     * Fleet Capability & Readiness Impact — final feature pass (2026-10-10).
     * Answers "what emergency capability is currently at risk?" at the
     * Vehicle Type level, rather than making someone mentally aggregate the
     * per-vehicle Criticality Watch themselves. Deliberately reuses
     * responseReadinessState() and effectiveCriticality() as the only two
     * primitives — no second readiness or criticality algorithm — and keeps
     * "ready" defined the same way fragility() already does (Available
     * status), so a type's coverage_state here always agrees with whether
     * fragility() already flagged it single_point/critical.
     */
    private function capabilityImpact(): array
    {
        $labels = ['in_maintenance' => 'In maintenance', 'not_ready' => 'Failed readiness check', 'unchecked' => 'Never checked', 'stale' => 'Check out of date'];
        $ticketsByVehicle = $this->activeTicketsByVehicle();

        return Vehicle::with('category')
            ->whereNotIn('status', ['Inactive', 'Decommissioned'])
            ->get()
            ->groupBy(fn ($v) => $v->category?->category_name ?? 'Uncategorized')
            ->map(function ($group, $name) use ($labels, $ticketsByVehicle) {
                $total = $group->count();
                $ready = $group->where('status', 'Available')->count();
                $down = $total - $ready;

                $coverageState = match (true) {
                    $ready === 0 => 'NO_COVERAGE',
                    $ready === 1 => 'AT_RISK',
                    $down > 0   => 'LIMITED',
                    default     => 'COVERED',
                };

                // The type's own criticality is the HIGHEST effective
                // criticality among its vehicles — one Critical ambulance in
                // an otherwise Normal fleet still makes that type's coverage
                // a Critical concern.
                $criticality = $group
                    ->map(fn ($v) => $v->effectiveCriticality())
                    ->sort(fn ($a, $b) => array_search($a, self::CRITICALITY_LEVELS, true) <=> array_search($b, self::CRITICALITY_LEVELS, true))
                    ->first() ?? 'Normal';

                $affected = $group
                    ->where('status', '!=', 'Available')
                    ->map(function ($v) use ($labels, $ticketsByVehicle) {
                        // Non-Available status short-circuits responseReadinessState()
                        // before it ever looks at the readiness check, so $latest
                        // can safely be null here.
                        $state = $this->responseReadinessState($v, null);
                        return [
                            'vehicle_id'       => $v->vehicle_id,
                            'vehicle_name'     => $v->vehicle_name,
                            'plate_number'     => $v->plate_number,
                            'state'            => $state,
                            'reason'           => $labels[$state] ?? 'Not available',
                            'active_ticket_id' => $ticketsByVehicle->get($v->vehicle_id)?->ticket_id,
                        ];
                    })
                    ->values();

                return [
                    'category'         => $name,
                    'criticality'      => $criticality,
                    'coverage_state'   => $coverageState,
                    'ready'            => $ready,
                    'down'             => $down,
                    'total'            => $total,
                    'primary_reason'   => $affected->first()['reason'] ?? null,
                    'affected_vehicles' => $affected->all(),
                ];
            })
            ->filter(fn ($r) => $r['coverage_state'] !== 'COVERED')
            ->sortBy([
                fn ($a, $b) => array_search($a['criticality'], self::CRITICALITY_LEVELS, true) <=> array_search($b['criticality'], self::CRITICALITY_LEVELS, true),
                fn ($a, $b) => strcmp($a['category'], $b['category']),
            ])
            ->values()
            ->all();
    }

    /**
     * Gap C — what's breaking most across the WHOLE fleet in the last 12
     * months, so a systemic cause (bad roads, a bad supplier) surfaces instead
     * of hiding as unrelated one-off tickets.
     */
    private function failurePatterns(): array
    {
        return VehicleMaintenanceRecord::where('created_at', '>=', now()->subMonths(12))
            ->get()
            ->groupBy(fn ($r) => $r->maintenance_type ?? 'Other')
            ->map(fn ($group, $type) => ['type' => $type, 'count' => $group->count()])
            ->sortByDesc('count')
            ->values()
            ->all();
    }

    /**
     * Gap 2 — vehicles whose preventive maintenance is overdue or due within
     * 7 days, so prevention is visible BEFORE a breakdown, not after.
     */
    private function preventiveWatch(): array
    {
        $soon = now()->addDays(7)->toDateString();
        $today = now()->toDateString();

        return VehicleMaintenanceSchedule::with('vehicle:vehicle_id,vehicle_name,plate_number,status')
            ->where('status', 'Scheduled')
            ->whereNull('resulting_ticket_id')
            ->whereDate('scheduled_date', '<=', $soon)
            ->orderBy('scheduled_date')
            ->get()
            ->filter(fn ($s) => $s->vehicle && !in_array($s->vehicle->status, ['Inactive', 'Decommissioned'], true))
            ->map(fn ($s) => [
                'schedule_id'      => $s->schedule_id,
                'vehicle_id'       => $s->vehicle_id,
                'vehicle_name'     => $s->vehicle->vehicle_name,
                'plate_number'     => $s->vehicle->plate_number,
                'maintenance_type' => $s->maintenance_type,
                'scheduled_date'   => $s->scheduled_date,
                'state'            => $s->scheduled_date < $today ? 'overdue' : 'due_soon',
            ])
            ->values()
            ->all();
    }

    /**
     * Gap 3 — per-vehicle reliability lens. Reads the vehicle's own ticket +
     * maintenance history back as actionable signals: how often it fails,
     * what it has cost, how long it sits, and whether it's chronic.
     */
    public function vehicleReliability(Request $request, Vehicle $vehicle)
    {
        $sixMonthsAgo = now()->subMonths(6);
        $twelveMonthsAgo = now()->subMonths(12);

        $tickets = MaintenanceTicket::where('vehicle_id', $vehicle->vehicle_id)
            ->whereNotIn('status', ['Cancelled'])
            ->get();

        $failures6 = $tickets->where('created_at', '>=', $sixMonthsAgo)->count();
        $failures12 = $tickets->where('created_at', '>=', $twelveMonthsAgo)->count();

        $closed = $tickets->whereNotNull('closed_at')->where('status', 'Closed');
        $avgDaysOut = $closed->isNotEmpty()
            ? round($closed->avg(fn ($t) => $t->created_at->diffInDays($t->closed_at)), 1)
            : null;

        // #10 — lifetime maintenance cost is the full picture: standalone
        // records plus unfinished ticket items. Done items already have a
        // ledger entry; adding them again would double-count closed repairs.
        $recordSpend = (float) VehicleMaintenanceRecord::where('vehicle_id', $vehicle->vehicle_id)->sum('maintenance_cost');
        $ticketSpend = (float) TicketSubIssue::where('status', '!=', 'Done')->whereHas('ticket', fn ($q) =>
            $q->where('vehicle_id', $vehicle->vehicle_id)->where('status', '!=', 'Cancelled')
        )->sum('maintenance_cost');
        $totalSpend = round($recordSpend + $ticketSpend, 2);

        // Chronic = 3+ tickets in the last 6 months, or any ticket that came
        // back as a recurrence of a previously-fixed issue.
        $hasRecurring = $tickets->contains(fn ($t) => ($t->recurrence_count ?? 0) > 0);
        $chronic = $failures6 >= 3 || $hasRecurring;

        // #10 — decommission signal: lifetime repair spend as a share of what
        // the vehicle is worth. Only computed when a value is on file; a
        // vehicle eating 60%+ of its own value in repairs is a real budget
        // conversation, not just a maintenance one.
        $costRatio = ($vehicle->acquisition_cost && $vehicle->acquisition_cost > 0)
            ? round($totalSpend / $vehicle->acquisition_cost, 4)
            : null;
        $decommissionSignal = $costRatio !== null && $costRatio >= 0.6;

        return response()->json([
            'failures_6mo'   => $failures6,
            'failures_12mo'  => $failures12,
            'avg_days_out'   => $avgDaysOut,
            'total_spend'    => $totalSpend,
            'record_spend'   => round($recordSpend, 2),
            'ticket_spend'   => round($ticketSpend, 2),
            'has_recurring'  => $hasRecurring,
            'chronic'        => $chronic,
            'acquisition_cost'     => $vehicle->acquisition_cost,
            'cost_ratio'           => $costRatio,
            'decommission_signal'  => $decommissionSignal,
        ]);
    }

    public function categories()
    {
        return VehicleCategory::with('fields')->withCount('vehicles')->orderBy('category_name')->get();
    }

    public function storeCategory(Request $request)
    {
        $this->requireAbility($request, 'vehicle_type.create');

        $data = $request->validate([
            'category_name' => ['required', 'string', 'max:255', 'unique:vehicle_categories,category_name'],
            'domain' => ['required', 'in:Land,Water'],
            'default_criticality' => ['sometimes', Rule::in(self::CRITICALITY_LEVELS)],
            'description' => ['nullable', 'string'],
        ]);

        $category = VehicleCategory::create($data);
        $this->log($request, 'Add', 'Vehicle Categories', $category->category_id, "Added vehicle type {$category->category_name}");

        return response()->json($category, 201);
    }

    public function updateCategory(Request $request, VehicleCategory $category)
    {
        $this->requireAbility($request, 'vehicle_type.edit');

        $data = $request->validate([
            'category_name' => [
                'required',
                'string',
                'max:255',
                Rule::unique('vehicle_categories', 'category_name')->ignore($category->category_id, 'category_id'),
            ],
            'domain' => ['required', 'in:Land,Water'],
            'default_criticality' => ['sometimes', Rule::in(self::CRITICALITY_LEVELS)],
            'description' => ['nullable', 'string'],
        ]);

        $category->update($data);
        $this->log($request, 'Edit', 'Vehicle Categories', $category->category_id, "Updated vehicle type {$category->category_name}");

        return $category;
    }

    public function deleteCategory(Request $request, VehicleCategory $category)
    {
        $this->requireAbility($request, 'vehicle_type.delete');

        // VehicleCategory is a global/shared table (categories.category_id
        // has a RESTRICT FK from vehicles.category_id), but Vehicle itself is
        // barangay-scoped — $category->vehicles()->exists() would only see
        // the CURRENT barangay's vehicles and let this delete through even
        // while another barangay's vehicle still references it, 500ing on
        // the FK constraint. Bypass the tenant scope for this existence
        // check since it's legitimately asking a global question.
        abort_if(
            Vehicle::withoutGlobalScopes()->where('category_id', $category->category_id)->exists(),
            422,
            'This category is still assigned to one or more vehicles.'
        );

        $this->log($request, 'Delete', 'Vehicle Categories', $category->category_id, "Deleted vehicle type {$category->category_name}");
        $category->delete();

        return response()->json(['message' => 'Vehicle category deleted.']);
    }

    public function vehicles(Request $request)
    {
        $this->syncVehicleStatuses();
        $user = $request->user();
        $query = Vehicle::with(['category', 'archivedBy', 'custodian:id,name']);

        // A pure Maintenance Personnel account only sees vehicles tied to
        // their own assigned sub-issues or schedules — not the whole
        // barangay fleet (VMS-IMPROVEMENT-PLAN.md Phase B3). No status filter on
        // the assignment itself: they should still see a vehicle's past
        // repairs after their work on it is done.
        if ($user->hasRole('Maintenance Personnel') && !$user->hasAnyRole(['Admin', 'Custodian'])) {
            $query->where(function ($scoped) use ($user) {
                $scoped->orWhereHas('tickets.subIssues', fn ($q) => $q->where('assigned_mechanic_id', $user->id))
                    ->orWhereHas('schedules', fn ($q) => $q->where('assigned_to', $user->id));
            });
        }

        if ($request->filled('q')) {
            $search = $request->string('q');
            $query->where(function ($nested) use ($search) {
                $nested->where('vehicle_name', 'like', "%{$search}%")
                    ->orWhere('plate_number', 'like', "%{$search}%")
                    ->orWhere('brand', 'like', "%{$search}%")
                    ->orWhere('model', 'like', "%{$search}%");
            });
        }

        $query->when($request->filled('category_id'), fn ($q) => $q->where('category_id', $request->category_id))
            ->when($request->filled('status'), fn ($q) => $q->where('status', $request->status))
            ->when($request->filled('location'), fn ($q) => $q->where('current_location', $request->location));

        $vehicles = $query->latest('vehicle_id')->get();

        // Gap A — surface each vehicle's "ready to respond" state in the list
        // itself (not just its own profile page), same rule the Dashboard uses.
        $latestChecks = $this->latestReadinessChecks();

        // "Under Maintenance" collapses two very different situations: a
        // mechanic actively working on it, versus a ticket that has nothing
        // left to do (every sub-issue Done or Deferred) sitting unclosed —
        // often because the last thing was deferred for an emergency and
        // nobody circled back to click Close. Flag the second case
        // separately so it doesn't look identical to genuine active repair.
        // Also lets Vehicle Management link straight to whatever ticket is
        // keeping a vehicle unavailable, instead of making Admin go find it.
        $openTicketsByVehicle = MaintenanceTicket::whereNotIn('status', ['Closed', 'Cancelled'])
            ->with('subIssues')
            ->orderByDesc('ticket_id')
            ->get()
            ->groupBy('vehicle_id');

        $vehicles->each(function (Vehicle $vehicle) use ($latestChecks, $openTicketsByVehicle) {
            $latest = $latestChecks->get($vehicle->vehicle_id);
            $vehicle->readiness_state = $this->responseReadinessState($vehicle, $latest);
            $vehicle->readiness_last_checked = $latest?->checked_at;

            $openTickets = $openTicketsByVehicle->get($vehicle->vehicle_id) ?? collect();
            $vehicle->readiness_block_reason = $this->readinessBlockReason($vehicle, $openTickets->contains(fn ($ticket) => in_array($ticket->status, ['Active', 'For Verification'], true)));
            $vehicle->can_confirm_readiness = $vehicle->readiness_block_reason === null;
            $vehicle->open_ticket_id = optional($openTickets->first())->ticket_id;
            $vehicle->open_ticket_number = optional($openTickets->first())->display_number;
            $vehicle->awaiting_closure = $vehicle->status !== 'Available'
                && $openTickets->contains(fn ($t) => $t->status === 'Active' && $t->isEligibleToClose());
        });

        return $vehicles;
    }

    public function storeVehicle(Request $request)
    {
        $this->requireAbility($request, 'vehicle.create');
        // Keep single registration and import aligned with role eligibility.
        abort_unless($request->user()->canRegisterVehicles(), 403, 'Your account cannot register vehicles.');

        $request->validate([
            'documents' => ['nullable', 'array'],
            'documents.*' => ['file', 'mimes:jpg,jpeg,png,pdf,doc,docx', 'max:10240'],
        ]);
        if ($request->hasFile('documents')) {
            $this->requireAbility($request, 'document.create');
        }
        $data = $this->validateVehicle($request);

        if ($request->hasFile('photo')) {
            $data['photo_url'] = $this->storeVehiclePhoto($request->file('photo'));
        }

        unset($data['photo']);

        $vehicle = DB::transaction(function () use ($data, $request) {
            $vehicle = Vehicle::create($data + [
                'status' => 'Available',
                'condition' => 'Good',
            ]);

            foreach ($request->file('documents', []) as $file) {
                $document = VehicleDocument::create([
                    'vehicle_id' => $vehicle->vehicle_id,
                    'added_by' => $request->user()->id,
                    'title' => mb_substr($file->getClientOriginalName(), 0, 255),
                    'file_url' => $this->storeUploadedImage($file, 'vehicle-documents'),
                ]);
                $this->history($vehicle, 'Document Added', "{$document->title} was added to {$vehicle->vehicle_name}'s file cabinet.", 'vehicle_documents', $document->document_id, $request);
                $this->log($request, 'Add', 'Vehicle Documents', $document->document_id, "Added document {$document->title}");
            }

            $this->history($vehicle, 'Vehicle Added', "{$vehicle->vehicle_name} was added to the system.", 'vehicles', $vehicle->vehicle_id, $request);
            $this->log($request, 'Add', 'Vehicle Management', $vehicle->vehicle_id, "Added vehicle {$vehicle->vehicle_name}");

            return $vehicle;
        });

        return response()->json($vehicle->load(['category', 'custodian:id,name']), 201);
    }

    public function updateVehicle(Request $request, Vehicle $vehicle)
    {
        $this->requireAbility($request, 'vehicle.edit');

        $data = $this->validateVehicle($request, $vehicle);

        if ($request->hasFile('photo')) {
            $data['photo_url'] = $this->storeVehiclePhoto($request->file('photo'));
        }

        unset($data['photo']);

        DB::transaction(function () use ($vehicle, $data, $request) {
            $previousLocation = $vehicle->current_location;

            $vehicle->update($data);
            $this->history($vehicle, 'Vehicle Information Updated', "{$vehicle->vehicle_name} information was updated.", 'vehicles', $vehicle->vehicle_id, $request);
            $this->log($request, 'Edit', 'Vehicle Management', $vehicle->vehicle_id, "Updated vehicle {$vehicle->vehicle_name}");

            // Editing current_location straight from the vehicle edit form
            // bypasses the dedicated POST /locations endpoint, so without
            // this the "Vehicle Location" history tab (which reads from
            // vehicle_locations) never learns about the change. Record the
            // same shape of VehicleLocation row storeLocation() creates, so
            // location history stays complete regardless of which form made
            // the change.
            if (isset($data['current_location']) && $data['current_location'] !== $previousLocation) {
                $location = VehicleLocation::create([
                    'vehicle_id' => $vehicle->vehicle_id,
                    'current_location' => $data['current_location'],
                    'updated_by' => $request->user()->id,
                ]);

                $this->history($vehicle, 'Location Updated', "{$vehicle->vehicle_name} current location was updated to {$data['current_location']}.", 'vehicle_locations', $location->location_record_id, $request);
                $this->log($request, 'Edit', 'Vehicle Location', $location->location_record_id, "Updated location for {$vehicle->vehicle_name}");
            }
        });

        return $vehicle->fresh(['category', 'custodian:id,name']);
    }

    public function archiveVehicle(Request $request, Vehicle $vehicle)
    {
        $this->requireAbility($request, 'vehicle.archive');

        $openTickets = MaintenanceTicket::where('vehicle_id', $vehicle->vehicle_id)
            ->whereNotIn('status', ['Closed', 'Cancelled'])
            ->get(['ticket_id', 'barangay_number', 'ticket_title']);
        if ($openTickets->isNotEmpty()) {
            abort(response()->json([
                'message' => 'Close or cancel this vehicle\'s open ticket(s) before deactivating it.',
                'open_tickets' => $openTickets->map(fn ($t) => ['ticket_id' => $t->ticket_id, 'barangay_number' => $t->barangay_number, 'ticket_title' => $t->ticket_title])->values(),
            ], 422));
        }

        $vehicle->update([
            'status' => 'Inactive',
            'archived_at' => now(),
            'archived_by' => $request->user()->id,
        ]);
        $this->history($vehicle, 'Vehicle Archived', "{$vehicle->vehicle_name} was marked inactive.", 'vehicles', $vehicle->vehicle_id, $request);
        $this->log($request, 'Archive', 'Vehicle Management', $vehicle->vehicle_id, "Archived vehicle {$vehicle->vehicle_name}");

        return response()->json(['message' => 'Vehicle archived.']);
    }

    public function restoreVehicle(Request $request, Vehicle $vehicle)
    {
        $this->requireAbility($request, 'vehicle.restore');

        // Restore reverses either a temporary archive OR a decommission (an
        // Admin undoing a mistaken write-off) — both bring the unit back to
        // active service and clear whichever end-state it was in.
        abort_unless(
            in_array($vehicle->status, ['Inactive', 'Decommissioned'], true),
            422,
            'Vehicle is not archived or decommissioned.'
        );

        $wasDecommissioned = $vehicle->status === 'Decommissioned';

        $vehicle->update([
            'status' => 'Available',
            'condition' => 'Good',
            'archived_at' => null,
            'archived_by' => null,
            'estimated_return_date' => null,
            'decommission_reason' => null,
            'decommissioned_by' => null,
            'decommissioned_at' => null,
        ]);

        \App\Services\VehicleOperationalState::refresh($vehicle, true);

        $verb = $wasDecommissioned ? 'recommissioned' : 'restored';
        $this->history($vehicle, 'Vehicle Restored', "{$vehicle->vehicle_name} was {$verb} to active service.", 'vehicles', $vehicle->vehicle_id, $request);
        $this->log($request, 'Restore', 'Vehicle Management', $vehicle->vehicle_id, ucfirst($verb) . " vehicle {$vehicle->vehicle_name}");

        return response()->json($vehicle->fresh(['category', 'archivedBy']));
    }

    /**
     * Gap 4 — retire a vehicle at end-of-life. Distinct from archiving: it's
     * a documented, reason-stamped write-off that pulls the unit out of the
     * readiness/coverage math for good (its history is kept). Open tickets
     * must be settled first — a beyond-repair vehicle's unfinishable ticket
     * is exactly what decision-close (Problem 1) exists for.
     */
    public function decommissionVehicle(Request $request, Vehicle $vehicle)
    {
        $this->requireAbility($request, 'vehicle.decommission');

        abort_if($vehicle->status === 'Decommissioned', 422, 'This vehicle is already decommissioned.');

        $openTickets = MaintenanceTicket::where('vehicle_id', $vehicle->vehicle_id)
            ->whereNotIn('status', ['Closed', 'Cancelled'])
            ->get(['ticket_id', 'barangay_number', 'ticket_title']);
        if ($openTickets->isNotEmpty()) {
            abort(response()->json([
                'message' => 'Close or cancel this vehicle\'s open ticket(s) before decommissioning it.',
                'open_tickets' => $openTickets->map(fn ($t) => ['ticket_id' => $t->ticket_id, 'barangay_number' => $t->barangay_number, 'ticket_title' => $t->ticket_title])->values(),
            ], 422));
        }

        $data = $request->validate([
            'decommission_reason' => ['required', 'string'],
        ]);

        $vehicle->update([
            'status' => 'Decommissioned',
            'condition' => 'Needs Repair',
            'estimated_return_date' => null,
            'decommission_reason' => $data['decommission_reason'],
            'decommissioned_by' => $request->user()->id,
            'decommissioned_at' => now(),
        ]);

        $this->history($vehicle, 'Vehicle Decommissioned', "{$vehicle->vehicle_name} was decommissioned (end of life): {$data['decommission_reason']}", 'vehicles', $vehicle->vehicle_id, $request);
        $this->log($request, 'Decommission', 'Vehicle Management', $vehicle->vehicle_id, "Decommissioned vehicle {$vehicle->vehicle_name}");

        return response()->json($vehicle->fresh(['category', 'decommissionedBy']));
    }

    /**
     * Gap A — record a pre-deployment readiness check. A vehicle is only
     * "verified ready to respond" after a recent passing check; this is the
     * proof that it will actually start, move, and do its job — not just that
     * it has no open repair.
     */
    public function storeReadinessCheck(Request $request, Vehicle $vehicle)
    {
        return DB::transaction(function () use ($request, $vehicle) {
            $vehicle = Vehicle::whereKey($vehicle->vehicle_id)->lockForUpdate()->firstOrFail();
            return $this->storeReadinessCheckLocked($request, $vehicle);
        });
    }

    private function readinessBlockReason(Vehicle $vehicle, bool $hasActiveTicket): ?string
    {
        if ($vehicle->status === 'Under Maintenance' || $hasActiveTicket) {
            return 'Readiness cannot be confirmed while maintenance is ongoing. Finish the maintenance work and have the assigned Custodian independently verify the repairs so all active tickets are closed or the maintenance record is verified. Then personally check and operate the vehicle before confirming readiness.';
        }
        if (in_array($vehicle->status, ['Inactive', 'Decommissioned'], true)) {
            return 'This vehicle is out of the fleet and cannot be readiness-checked.';
        }
        return null;
    }

    private function storeReadinessCheckLocked(Request $request, Vehicle $vehicle)
    {
        $this->requireAbility($request, 'vehicle.readiness_check');
        $blockedReason = $this->readinessBlockReason($vehicle, MaintenanceTicket::where('vehicle_id', $vehicle->vehicle_id)->whereIn('status', ['Active', 'For Verification'])->exists());
        abort_if($blockedReason !== null, 422, $blockedReason);

        // Simplified per product direction: the readiness check is a plain
        // attestation ("I confirm I personally checked and operated this
        // vehicle"), not a checklist to fill in — if something's actually
        // wrong, the Custodian proposes a maintenance ticket instead of
        // confirming readiness. The checklist/all_passed columns stay (both
        // for historical pre-simplification checks and because other code
        // reads them, e.g. responseReadinessState()) — a new check just
        // always writes one synthetic, passed item.
        $data = $request->validate([
            'confirmed' => ['required', 'accepted'],
            'notes'     => ['nullable', 'string'],
        ]);

        $vehicle->update(['readiness_invalidated_at' => null]);
        $check = VehicleReadinessCheck::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'checked_by' => $request->user()->id,
            'checklist'  => [['item' => 'Personally operated and confirmed ready to respond', 'passed' => true]],
            'all_passed' => true,
            'notes'      => $data['notes'] ?? null,
            'checked_at' => now(),
        ]);

        $this->history($vehicle, 'Readiness Check', 'Confirmed ready to respond.', 'vehicle_readiness_checks', $check->readiness_check_id, $request);
        $this->log($request, 'Readiness Check', 'Vehicle Management', $vehicle->vehicle_id, "Readiness confirmed for {$vehicle->vehicle_name}");

        // Offer the "mark Available now" shortcut unless the vehicle is
        // already Available or has an open ticket — a vehicle with an open
        // ticket must go back to Available through that ticket closing, not
        // through a readiness confirmation that never looked at the repair.
        $hasOpenTicket = MaintenanceTicket::where('vehicle_id', $vehicle->vehicle_id)
            ->whereNotIn('status', ['Closed', 'Cancelled'])
            ->exists();
        $canMarkAvailable = $vehicle->status !== 'Available' && !$hasOpenTicket;

        return response()->json([
            'check' => $check,
            'state' => $this->responseReadinessState($vehicle->fresh(), $check),
            'can_mark_available' => $canMarkAvailable,
        ], 201);
    }

    /**
     * The "all checks passed — mark it Available?" shortcut offered right
     * after a passing readiness check. Re-checks the same conditions
     * storeReadinessCheck used to decide whether to offer it — the vehicle
     * must still have no open ticket — since state could have changed
     * between that response and this follow-up call (e.g. a ticket opened
     * in another tab).
     */
    public function markVehicleAvailable(Request $request, Vehicle $vehicle)
    {
        $this->requireAbility($request, 'vehicle.mark_available');

        abort_if(
            in_array($vehicle->status, ['Inactive', 'Decommissioned'], true),
            422,
            'This vehicle is out of the fleet and cannot be marked Available.'
        );

        $hasOpenTicket = MaintenanceTicket::where('vehicle_id', $vehicle->vehicle_id)
            ->whereNotIn('status', ['Closed', 'Cancelled'])
            ->exists();
        abort_if($hasOpenTicket, 422, 'This vehicle still has an open ticket — close it to bring the vehicle back to Available.');

        $latestCheck = $vehicle->readinessChecks()->orderByDesc('checked_at')->first();
        abort_unless(
            $latestCheck && $latestCheck->all_passed && $latestCheck->checked_at->gte(now()->subHours(self::READINESS_FRESHNESS_HOURS)) && (!$vehicle->readiness_invalidated_at || $latestCheck->checked_at->gt($vehicle->readiness_invalidated_at)),
            422,
            'This vehicle needs a passing readiness check before it can be marked Available.'
        );

        // A "Needs Repair" condition deliberately does NOT block this: a
        // passing readiness check (fuel, lights, equipment — physically
        // confirmed right now) is what operational readiness actually means
        // for an emergency vehicle, even if a separate, not-yet-addressed
        // repair is still outstanding. The Condition column keeps showing
        // "Needs Repair" independently — it isn't cleared by this — so the
        // outstanding issue stays visible and doesn't get forgotten; it's
        // just not what's blocking the vehicle from responding right now.
        $wasOverridingRepairFlag = $vehicle->condition === 'Needs Repair';

        $vehicle->update(['status' => 'Available']);

        $historyNote = $wasOverridingRepairFlag
            ? "{$vehicle->vehicle_name} was marked Available after a passing readiness check, despite its condition still being Needs Repair — the repair remains outstanding."
            : "{$vehicle->vehicle_name} was marked Available after a passing readiness check.";
        $this->history($vehicle, 'Vehicle Marked Available', $historyNote, 'vehicles', $vehicle->vehicle_id, $request);
        $this->log($request, 'Edit', 'Vehicle Management', $vehicle->vehicle_id, "Marked {$vehicle->vehicle_name} Available");

        return $vehicle->fresh(['category']);
    }

    /**
     * Gap A — current "ready to respond" state + recent check history for a
     * single vehicle, for its profile page.
     */
    public function vehicleReadiness(Request $request, Vehicle $vehicle)
    {
        $latest = $vehicle->readinessChecks()->orderByDesc('checked_at')->first();

        // UI/UX pass — a vehicle profile previously showed "Under Maintenance"
        // with no visible link to WHY, forcing a separate hunt through
        // Maintenance Tickets. Reuses the same active-ticket lookup built for
        // the Fleet Capability Impact feature.
        $activeTicket = MaintenanceTicket::where('vehicle_id', $vehicle->vehicle_id)
            ->whereNotIn('status', ['Closed', 'Cancelled'])
            ->orderByDesc('ticket_id')
            ->get(['ticket_id', 'barangay_number', 'ticket_title', 'status']);
        $blockedReason = $this->readinessBlockReason($vehicle, $activeTicket->contains(fn ($ticket) => in_array($ticket->status, ['Active', 'For Verification'], true)));
        $activeTicket = $activeTicket->first();

        return response()->json([
            'can_confirm_readiness' => $blockedReason === null,
            'readiness_block_reason' => $blockedReason,
            'state'              => $this->responseReadinessState($vehicle, $latest),
            'last_checked'       => $latest?->checked_at,
            'latest_checklist'   => $latest?->checklist,
            'freshness_hours'    => self::READINESS_FRESHNESS_HOURS,
            'active_ticket_id'   => $activeTicket?->ticket_id,
            'active_ticket_number' => $activeTicket?->display_number,
            'active_ticket_title' => $activeTicket?->ticket_title,
            'history'            => $vehicle->readinessChecks()
                ->with('checkedBy:id,name')
                ->orderByDesc('checked_at')
                ->limit(5)
                ->get(),
        ]);
    }

    public function locations(Request $request)
    {
        $query = VehicleLocation::with(['vehicle.category', 'updatedBy']);

        if ($request->filled('q')) {
            $search = $request->string('q');
            $query->where(function ($nested) use ($search) {
                $nested->where('current_location', 'like', "%{$search}%")
                    ->orWhere('address_area', 'like', "%{$search}%");
            });
        }

        return $query->latest('location_record_id')->get();
    }

    public function storeLocation(Request $request)
    {
        $this->requireAbility($request, 'vehicle.update_location');

        $data = $request->validate([
            'vehicle_id' => ['required', 'exists:vehicles,vehicle_id'],
            'current_location' => ['required', 'string', 'max:255', Rule::in(VehicleHub::pluck('name'))],
            'address_area' => ['nullable', 'string', 'max:255'],
            'remarks' => ['nullable', 'string'],
        ]);

        $location = DB::transaction(function () use ($data, $request) {
            $vehicle = Vehicle::findOrFail($data['vehicle_id']);
            $location = VehicleLocation::create($data + ['updated_by' => $request->user()->id]);
            $vehicle->update(['current_location' => $data['current_location']]);

            $this->history($vehicle, 'Location Updated', "{$vehicle->vehicle_name} current location was updated to {$data['current_location']}.", 'vehicle_locations', $location->location_record_id, $request);
            $this->log($request, 'Edit', 'Vehicle Location', $location->location_record_id, "Updated location for {$vehicle->vehicle_name}");

            return $location;
        });

        return response()->json($location->load(['vehicle.category', 'updatedBy']), 201);
    }

    public function conditions(Request $request)
    {
        // Condition checks are an Admin/Custodian tool; Maintenance Personnel
        // never performs or needs to browse them (VMS-IMPROVEMENT-PLAN.md Phase B3).
        $user = $request->user();
        if ($user->hasRole('Maintenance Personnel') && !$user->hasAnyRole(['Admin', 'Custodian'])) {
            return collect();
        }

        $query = VehicleConditionCheck::with(['vehicle.category', 'checkedBy', 'resultingTicket:ticket_id,barangay_number,status,ticket_title']);

        $query->when($request->filled('vehicle_id'), fn ($q) => $q->where('vehicle_id', $request->vehicle_id))
            ->when($request->filled('condition_result'), fn ($q) => $q->where('condition_result', $request->condition_result));

        return $query->latest('condition_check_id')->get();
    }

    public function storeCondition(Request $request)
    {
        $this->requireAbility($request, 'condition.create');

        $data = $request->validate([
            'vehicle_id' => ['required', 'exists:vehicles,vehicle_id'],
            'condition_result' => ['required', Rule::in(['Good', 'Needs Repair'])],
            'observations' => ['nullable', 'string'],
        ]);

        $condition = DB::transaction(function () use ($data, $request) {
            $vehicle = Vehicle::whereKey($data['vehicle_id'])->lockForUpdate()->firstOrFail();
            abort_if(
                MaintenanceTicket::where('vehicle_id', $vehicle->vehicle_id)
                    ->whereNotIn('status', ['Closed', 'Cancelled', 'Declined'])->exists(),
                422,
                'This vehicle has an open maintenance ticket. Close the ticket before recording another condition check.'
            );
            $condition = VehicleConditionCheck::create($data + ['checked_by' => $request->user()->id]);

            // A vehicle already retired (Inactive/Decommissioned) must stay
            // that way — filing a condition check against it should never
            // silently un-retire it back to Available/Under Maintenance.
            if (!in_array($vehicle->status, ['Inactive', 'Decommissioned'], true)) {
                $vehicleStatus = $data['condition_result'] === 'Needs Repair'
                    ? 'Under Maintenance'
                    : $vehicle->status;

                $vehicle->update([
                    'condition' => $data['condition_result'],
                    'status' => $vehicleStatus,
                ]);
            }

            $this->history($vehicle, 'Condition Checked', "{$vehicle->vehicle_name} condition was marked {$data['condition_result']}.", 'vehicle_condition_checks', $condition->condition_check_id, $request);
            $this->log($request, 'Add', 'Vehicle Condition Monitoring', $condition->condition_check_id, "Recorded condition for {$vehicle->vehicle_name}");

            return $condition;
        });

        return response()->json($condition->load(['vehicle.category', 'checkedBy']), 201);
    }

    public function updateCondition(Request $request, VehicleConditionCheck $condition)
    {
        $this->requireAbility($request, 'condition.edit');

        // Custodian-only ability — and only the check they themselves performed.
        abort_unless($condition->checked_by === $request->user()->id, 403, 'You can only edit a condition check you performed yourself.');

        $data = $request->validate([
            'vehicle_id' => ['sometimes', 'exists:vehicles,vehicle_id'],
            'condition_result' => ['sometimes', Rule::in(['Good', 'Needs Repair'])],
            'observations' => ['nullable', 'string'],
        ]);

        DB::transaction(function () use ($condition, $data, $request) {
            $condition->update($data);

            // A vehicle already retired (Inactive/Decommissioned) must stay
            // that way — editing a condition check against it should never
            // silently un-retire it back to Available/Under Maintenance.
            if (isset($data['condition_result']) && !in_array($condition->vehicle->status, ['Inactive', 'Decommissioned'], true)) {
                $vehicle = $condition->vehicle;
                $vehicleStatus = $data['condition_result'] === 'Needs Repair'
                    ? 'Under Maintenance'
                    : $vehicle->status;

                $vehicle->update([
                    'condition' => $data['condition_result'],
                    'status' => $vehicleStatus,
                ]);
            }

            $this->history($condition->vehicle, 'Condition Check Updated', "Updated condition check #{$condition->condition_check_id} to {$condition->condition_result}.", 'vehicle_condition_checks', $condition->condition_check_id, $request);
            $this->log($request, 'Edit', 'Vehicle Condition Monitoring', $condition->condition_check_id, "Updated condition check for {$condition->vehicle->vehicle_name}");
        });

        return $condition->load(['vehicle.category', 'checkedBy']);
    }

    public function deleteCondition(Request $request, VehicleConditionCheck $condition)
    {
        $this->requireAbility($request, 'condition.delete');

        DB::transaction(function () use ($condition, $request) {
            $vehicle = $condition->vehicle;
            $condition->delete();

            // A vehicle already retired (Inactive/Decommissioned) must stay
            // that way — deleting a condition check against it should never
            // silently un-retire it back to Available/Under Maintenance.
            if (!in_array($vehicle->status, ['Inactive', 'Decommissioned'], true)) {
                // Revert vehicle condition to latest remaining check, if any
                $latestCheck = VehicleConditionCheck::where('vehicle_id', $vehicle->vehicle_id)
                    ->latest('condition_check_id')
                    ->first();

                if ($latestCheck) {
                    $vehicleStatus = $latestCheck->condition_result === 'Needs Repair'
                        ? 'Under Maintenance'
                        : $vehicle->status;

                    $vehicle->update([
                        'condition' => $latestCheck->condition_result,
                        'status' => $vehicleStatus,
                    ]);
                } else {
                    $vehicle->update([
                        'condition' => 'Good',
                    ]);
                }
            }

            $this->history($vehicle, 'Condition Check Deleted', "Deleted condition check record.", 'vehicles', $vehicle->vehicle_id, $request);
            $this->log($request, 'Delete', 'Vehicle Condition Monitoring', $condition->condition_check_id, "Deleted condition check for {$vehicle->vehicle_name}");
        });

        return response()->json(['message' => 'Condition check deleted.']);
    }

    /**
     * Single-issue fetch — deliberately not scoped to "mine" the way the list
     * endpoint can be. A Custodian following a "View" link from the
     * duplicate-issue warning needs to see a report FILED BY SOMEONE ELSE on
     * the same vehicle; that's the whole point of the warning.
     */
    public function showIssue(Request $request, VehicleIssueReport $issue)
    {
        $this->requireAbility($request, 'issue.view');

        // Same visibility rule as issues(), so a report hidden from the list
        // can't be opened just by its id.
        $user = $request->user();
        if (!$user->hasRole('Admin') && (int) $issue->reported_by !== (int) $user->id) {
            $filedByCustodian = (bool) $issue->reportedBy?->hasRole('Custodian');
            abort_unless($user->hasRole('Custodian') && !$filedByCustodian, 403, 'You can only view your own issue reports.');
        }

        return $issue->load(['vehicle.category', 'reportedBy', 'maintenanceTicket', 'attachments.uploadedBy']);
    }

    /**
     * On-demand recurrence check — the same detection createTicket() runs,
     * but callable BEFORE a ticket exists. Recurrence used to only surface
     * in a notification sent right after the ticket was already created,
     * which is one step too late to change anything: Admin had already
     * decided. This lets the Issue Report view and the New Ticket form show
     * "this fault came back a 3rd time" WHILE Admin is still deciding.
     */
    public function checkVehicleRecurrence(Request $request, Vehicle $vehicle)
    {
        $this->requireAbility($request, 'ticket.check_recurrence');

        $data = $request->validate([
            'maintenance_types'   => ['nullable', 'array'],
            'maintenance_types.*' => ['string'],
            'issue_type'          => ['nullable', 'string'],
            'title'               => ['required', 'string'],
        ]);

        return response()->json(
            $this->checkRecurrence($vehicle->vehicle_id, $data['maintenance_types'] ?? [], $data['issue_type'] ?? null, $data['title'])
        );
    }

    public function issues(Request $request)
    {
        $user = $request->user();

        // Maintenance Personnel can file a technical issue report (see
        // storeIssue()) and track it from their own "Vehicle Issues" sidebar
        // entry, but still have no reason to browse the whole barangay's
        // queue of everyone else's reports — that stays a Custodian/Admin
        // concern, so this scopes to reports THEY filed.
        if ($user->hasRole('Maintenance Personnel') && !$user->hasAnyRole(['Admin', 'Custodian'])) {
            return $this->withBarangayDisplayNumbers(VehicleIssueReport::with(['vehicle.category', 'reportedBy', 'maintenanceTicket', 'attachments'])
                ->where('reported_by', $user->id)
                ->whereHas('vehicle', fn ($q) => $q->whereNotIn('status', ['Inactive', 'Decommissioned']))
                ->latest('issue_report_id')
                ->get());
        }

        // Issues on retired (Inactive/Decommissioned) vehicles are excluded —
        // a retired vehicle is out of the fleet, so its reports shouldn't
        // clutter the list.
        $query = VehicleIssueReport::with(['vehicle.category', 'reportedBy', 'maintenanceTicket', 'attachments'])
            ->whereHas('vehicle', fn ($q) => $q->whereNotIn('status', ['Inactive', 'Decommissioned']));

        if ($request->boolean('mine')) {
            $query->where('reported_by', $request->user()->id);
        }

        // A Custodian sees their own reports, not another Custodian's. Reports
        // filed by Maintenance Personnel stay visible: those are routed to
        // every Custodian (see storeIssue()), who has to propose the ticket.
        if ($user->hasRole('Custodian') && !$user->hasRole('Admin')) {
            $query->where(function ($q) use ($user) {
                $q->where('reported_by', $user->id)
                    ->orWhereDoesntHave('reportedBy', fn ($r) => $r->havingRole('Custodian'));
            });
        }

        $query->when($request->filled('status'), fn ($q) => $q->where('status', $request->status))
            ->when($request->filled('severity_level'), fn ($q) => $q->where('severity_level', $request->severity_level))
            ->when($request->filled('issue_type'), fn ($q) => $q->where('issue_type', $request->issue_type));

        if ($request->filled('q')) {
            $search = $request->string('q');
            $query->where(function ($nested) use ($search) {
                $nested->where('issue_type', 'like', "%{$search}%")
                    ->orWhere('issue_description', 'like', "%{$search}%")
                    ->orWhereHas('vehicle', function ($vehicleQuery) use ($search) {
                        $vehicleQuery->where('vehicle_name', 'like', "%{$search}%")
                            ->orWhere('plate_number', 'like', "%{$search}%");
                    });
            });
        }

        return $this->withBarangayDisplayNumbers($query->latest('issue_report_id')->get());
    }

    /**
     * Public-facing report and ticket numbers restart in every barangay.
     * Their database primary keys intentionally remain global: routes,
     * foreign keys, notifications, and audit logs depend on those stable IDs.
     */
    private function withBarangayDisplayNumbers(Collection $issues): Collection
    {
        $barangayIds = $issues->pluck('vehicle.barangay_id')->filter()->unique()->values();
        if ($barangayIds->isEmpty()) {
            return $issues;
        }

        $issueNumbers = $this->barangaySequenceNumbers(
            VehicleIssueReport::withoutGlobalScopes()
                ->with('vehicle:vehicle_id,barangay_id')
                ->whereHas('vehicle', fn ($query) => $query->whereIn('barangay_id', $barangayIds))
                ->orderBy('issue_report_id')
                ->get(),
            'issue_report_id'
        );
        $ticketNumbers = $this->barangaySequenceNumbers(
            MaintenanceTicket::withoutGlobalScopes()
                ->with('vehicle:vehicle_id,barangay_id')
                ->whereHas('vehicle', fn ($query) => $query->whereIn('barangay_id', $barangayIds))
                ->orderBy('ticket_id')
                ->get(),
            'ticket_id'
        );

        $issues->each(function (VehicleIssueReport $issue) use ($issueNumbers, $ticketNumbers): void {
            $issue->setAttribute('display_issue_report_id', $issueNumbers[$issue->issue_report_id] ?? $issue->issue_report_id);

            if ($issue->maintenanceTicket) {
                $ticket = $issue->maintenanceTicket;
                $ticket->setAttribute('display_ticket_id', $ticketNumbers[$ticket->ticket_id] ?? $ticket->ticket_id);
            }
        });

        return $issues;
    }

    private function barangaySequenceNumbers(Collection $records, string $key): array
    {
        $numbers = [];

        $records->groupBy(fn ($record) => $record->vehicle?->barangay_id)
            ->each(function (Collection $barangayRecords) use (&$numbers, $key): void {
                $barangayRecords->values()->each(function ($record, int $index) use (&$numbers, $key): void {
                    $numbers[$record->getAttribute($key)] = $index + 1;
                });
            });

        return $numbers;
    }

    public function storeIssue(Request $request)
    {
        // Maintenance Personnel included so a mechanic can document the issue
        // they found themselves while self-filing a standalone maintenance
        // record (the emergency/field-repair path) — not a general-purpose
        // reporting permission for them elsewhere.
        $this->requireAbility($request, 'issue.create');

        $data = $request->validate([
            'vehicle_id' => ['required', 'exists:vehicles,vehicle_id'],
            'issue_type' => ['required', 'string', 'max:150'],
            'issue_description' => ['required', 'string'],
            'severity_level' => ['required', Rule::in(['Low', 'Medium', 'High'])],
            // Was a single 'photo' (image only) — now any number of files of
            // any common type, matching VehicleDocument's "file cabinet".
            'attachments' => ['nullable', 'array'],
            'attachments.*' => ['file', 'mimes:jpg,jpeg,png,pdf,doc,docx', 'max:10240'],
            'remarks' => ['nullable', 'string'],
        ]);

        $data['issue_type'] = FaultCategory::resolve($data['issue_type']);

        // A retired/archived vehicle is out of the fleet — no new reports on it.
        $reportedVehicle = Vehicle::findOrFail($data['vehicle_id']);
        abort_if(
            in_array($reportedVehicle->status, ['Inactive', 'Decommissioned'], true),
            422,
            'Cannot report an issue on an archived or decommissioned vehicle.'
        );

        $uploadedFiles = $request->file('attachments', []);
        unset($data['attachments']);

        $issue = DB::transaction(function () use ($data, $request, $uploadedFiles) {
            $vehicle = Vehicle::findOrFail($data['vehicle_id']);
            $issue = VehicleIssueReport::create($data + [
                'reported_by' => $request->user()->id,
                'status' => 'Pending',
            ]);

            foreach ($uploadedFiles as $file) {
                IssueReportAttachment::create([
                    'issue_report_id' => $issue->issue_report_id,
                    'file_url' => $this->storeUploadedImage($file, 'issue-attachments'),
                    'original_name' => $file->getClientOriginalName(),
                    'uploaded_by' => $request->user()->id,
                ]);
            }

            $vehicle->update([
                'condition' => 'Needs Inspection',
            ]);

            $this->history($vehicle, 'Issue Reported', "{$data['issue_type']} was reported for {$vehicle->vehicle_name}.", 'vehicle_issue_reports', $issue->issue_report_id, $request);
            $this->log($request, 'Add', 'Vehicle Issue Reports', $issue->issue_report_id, "Reported {$data['issue_type']} for {$vehicle->vehicle_name}");

            $this->notifyAdmins(
                'New Vehicle Issue Reported',
                "{$request->user()->name} reported {$data['issue_type']} for {$vehicle->vehicle_name}.",
                'issue_reported',
                $vehicle->barangay_id,
                ['issue_report_id' => $issue->issue_report_id]
            );

            // A mechanic's technical finding isn't a ticket by itself — it
            // has to go through a Custodian's propose-ticket workflow, so the
            // Custodian needs to actually hear about it to act on it.
            if ($request->user()->hasRole('Maintenance Personnel') && !$request->user()->hasAnyRole(['Admin', 'Custodian'])) {
                $this->notifyCustodians(
                    'Technical Issue Reported by Maintenance',
                    "{$request->user()->name} reported {$data['issue_type']} for {$vehicle->vehicle_name} — review it and propose a ticket if it needs one.",
                    'issue_reported',
                    $vehicle->barangay_id,
                    ['issue_report_id' => $issue->issue_report_id]
                );
            }

            return $issue;
        });

        return response()->json($issue->load(['vehicle.category', 'reportedBy', 'attachments']), 201);
    }

    public function updateIssue(Request $request, VehicleIssueReport $issue)
    {
        $this->requireAbility($request, 'issue.edit');

        if ($request->user()->hasRole('Custodian') && !$request->user()->hasAnyRole(['Admin', 'Maintenance Personnel'])) {
            abort_unless($issue->reported_by === $request->user()->id, 403, 'You can only edit your own issue reports.');
            abort_unless($issue->status === 'Pending', 422, 'This issue has already been reviewed and can no longer be edited.');

            $data = $request->validate([
                'issue_type' => ['sometimes', 'string', 'max:150'],
                'issue_description' => ['sometimes', 'string'],
                'severity_level' => ['sometimes', Rule::in(['Low', 'Medium', 'High'])],
                'attachments' => ['nullable', 'array'],
                'attachments.*' => ['file', 'mimes:jpg,jpeg,png,pdf,doc,docx', 'max:10240'],
                'remarks' => ['nullable', 'string'],
            ]);

            if (isset($data['issue_type'])) {
                $data['issue_type'] = FaultCategory::resolve($data['issue_type']);
            }

            $uploadedFiles = $request->file('attachments', []);
            unset($data['attachments']);

            $issue->update($data);
            foreach ($uploadedFiles as $file) {
                IssueReportAttachment::create([
                    'issue_report_id' => $issue->issue_report_id,
                    'file_url' => $this->storeUploadedImage($file, 'issue-attachments'),
                    'original_name' => $file->getClientOriginalName(),
                    'uploaded_by' => $request->user()->id,
                ]);
            }
            $this->log($request, 'Edit', 'Vehicle Issue Reports', $issue->issue_report_id, "Updated issue report #{$issue->issue_report_id}");

            return $issue->fresh(['vehicle.category', 'reportedBy', 'attachments']);
        }

        $data = $request->validate([
            'status' => ['sometimes', Rule::in(['Pending', 'Under Review', 'In Maintenance', 'Resolved'])],
            'remarks' => ['nullable', 'string'],
            'issue_type' => ['sometimes', 'string', 'max:150'],
            'issue_description' => ['sometimes', 'string'],
            'severity_level' => ['sometimes', Rule::in(['Low', 'Medium', 'High'])],
        ]);

        if (isset($data['issue_type'])) {
            $data['issue_type'] = FaultCategory::resolve($data['issue_type']);
        }

        DB::transaction(function () use ($issue, $data, $request) {
            $issue->update($data);

            // A vehicle already retired (Inactive/Decommissioned) must stay
            // that way — resolving/updating an old issue report against it
            // should never silently un-retire it back to Available/Under
            // Maintenance.
            if (isset($data['status']) && !in_array($issue->vehicle->status, ['Inactive', 'Decommissioned'], true)) {
                $status = $data['status'];
                $vehicleUpdates = [];

                if ($status === 'In Maintenance') {
                    $vehicleUpdates['status'] = 'Under Maintenance';
                    $vehicleUpdates['condition'] = 'Needs Repair';
                } elseif ($status === 'Resolved') {
                    $vehicleUpdates['status'] = 'Available';
                    $vehicleUpdates['condition'] = 'Good';
                } elseif ($status === 'Pending' || $status === 'Under Review') {
                    $vehicleUpdates['status'] = 'Available';
                    $vehicleUpdates['condition'] = 'Needs Inspection';
                }

                if (!empty($vehicleUpdates)) {
                    $issue->vehicle->update($vehicleUpdates);
                }
            }

            $this->history($issue->vehicle, 'Issue Updated', "Issue #{$issue->issue_report_id} was updated to {$issue->status}.", 'vehicle_issue_reports', $issue->issue_report_id, $request);
            $this->log($request, 'Edit', 'Vehicle Issue Reports', $issue->issue_report_id, "Updated issue #{$issue->issue_report_id}");
        });

        return $issue->fresh(['vehicle.category', 'reportedBy']);
    }

    /**
     * Admin closes an open issue report that doesn't need a ticket — not a
     * real problem, or already handled. A reason is required and goes to the
     * reporter. Deliberately does NOT touch the vehicle's status (unlike the
     * generic status edit), since nothing about the vehicle changed.
     */
    public function dismissIssue(Request $request, VehicleIssueReport $issue)
    {
        $this->requireAbility($request, 'issue.dismiss');

        abort_unless(in_array($issue->status, ['Pending', 'Under Review'], true), 422, "This issue is already {$issue->status} and can't be dismissed.");
        abort_if($issue->maintenanceTicket()->exists(), 422, 'A ticket exists for this issue — close or cancel the ticket instead.');

        $data = $request->validate([
            'dismiss_reason' => ['required', 'string', 'max:1000'],
        ]);

        DB::transaction(function () use ($issue, $data, $request) {
            $issue->update([
                'status'  => 'Resolved',
                'remarks' => "Dismissed by {$request->user()->name}: {$data['dismiss_reason']}",
            ]);

            if ($issue->reported_by && (int) $issue->reported_by !== (int) $request->user()->id) {
                $this->notifyUser(
                    $issue->reported_by,
                    'Issue Report Dismissed',
                    "Your report \"{$issue->issue_type}\" on {$issue->vehicle->vehicle_name} was dismissed. Reason: {$data['dismiss_reason']}",
                    'issue_dismissed',
                    ['issue_report_id' => $issue->issue_report_id]
                );
            }

            $this->log($request, 'Edit', 'Vehicle Issue Reports', $issue->issue_report_id, "Dismissed issue report #{$issue->issue_report_id}: {$data['dismiss_reason']}");
        });

        return $issue->fresh(['vehicle.category', 'reportedBy', 'maintenanceTicket', 'attachments']);
    }

    public function destroyIssue(Request $request, VehicleIssueReport $issue)
    {
        $user = $request->user();

        if ($user->hasRole('Custodian') && !$user->hasAnyRole(['Admin', 'Maintenance Personnel'])) {
            abort_unless($issue->reported_by === $user->id, 403, 'You can only delete your own issue reports.');
            abort_unless($issue->status === 'Pending', 422, 'This issue has already been reviewed and can no longer be deleted.');
        } else {
            $this->requireAbility($request, 'issue.delete');
        }

        $this->log($request, 'Delete', 'Vehicle Issue Reports', $issue->issue_report_id, "Deleted issue report #{$issue->issue_report_id}");
        $issue->delete();

        return response()->json(['message' => 'Issue report deleted.']);
    }

    /**
     * Remove one file from an issue report's attachment list — same
     * ownership rule as editing the report itself (own, still Pending,
     * unless Admin/Maintenance Personnel).
     */
    public function destroyIssueAttachment(Request $request, IssueReportAttachment $attachment)
    {
        $user = $request->user();
        $issue = $attachment->issueReport;

        if ($user->hasRole('Custodian') && !$user->hasAnyRole(['Admin', 'Maintenance Personnel'])) {
            abort_unless($issue->reported_by === $user->id, 403, 'You can only edit your own issue reports.');
            abort_unless($issue->status === 'Pending', 422, 'This issue has already been reviewed and can no longer be edited.');
        } else {
            $this->requireAbility($request, 'issue.edit');
        }

        $this->log($request, 'Delete', 'Vehicle Issue Reports', $issue->issue_report_id, "Removed attachment \"{$attachment->original_name}\" from issue report #{$issue->issue_report_id}");
        $attachment->delete();

        return response()->json(['message' => 'Attachment removed.']);
    }

    /**
     * #7 — duplicate-report aid: every currently-open (non-Resolved) issue
     * report already on a vehicle. The Report Issue form calls this once a
     * vehicle is picked and shows a non-blocking warning, so two people
     * reporting the same fault don't silently open two reports.
     */
    public function openIssuesForVehicle(Request $request, Vehicle $vehicle)
    {
        $this->requireAbility($request, 'issue.view');

        return VehicleIssueReport::where('vehicle_id', $vehicle->vehicle_id)
            ->whereNot('status', 'Resolved')
            ->with('reportedBy:id,name')
            ->orderByDesc('issue_report_id')
            ->get(['issue_report_id', 'issue_type', 'severity_level', 'status', 'reported_by', 'created_at']);
    }

    // File cabinet on a vehicle's profile page — deliberately separate from
    // `photo_url` (the vehicle's own cover photo, shown elsewhere) so this
    // list is only ever what a user explicitly uploaded here: receipts,
    // registration papers, insurance, etc.
    public function vehicleDocuments(Request $request, Vehicle $vehicle)
    {
        $this->requireAbility($request, 'document.view');

        return VehicleDocument::where('vehicle_id', $vehicle->vehicle_id)
            ->with('addedBy:id,name')
            ->orderByDesc('document_id')
            ->get();
    }

    public function storeVehicleDocument(Request $request, Vehicle $vehicle)
    {
        $this->requireAbility($request, 'document.create');

        $data = $request->validate([
            'title' => ['required', 'string', 'max:255'],
            'category' => ['nullable', 'string', 'max:100'],
            'file' => ['required', 'file', 'mimes:jpg,jpeg,png,pdf,doc,docx', 'max:10240'],
        ]);

        $data['file_url'] = $this->storeUploadedImage($request->file('file'), 'vehicle-documents');
        unset($data['file']);

        $document = DB::transaction(function () use ($data, $vehicle, $request) {
            $document = VehicleDocument::create($data + [
                'vehicle_id' => $vehicle->vehicle_id,
                'added_by' => $request->user()->id,
            ]);

            $this->history($vehicle, 'Document Added', "{$data['title']} was added to {$vehicle->vehicle_name}'s file cabinet.", 'vehicle_documents', $document->document_id, $request);
            $this->log($request, 'Add', 'Vehicle Documents', $document->document_id, "Added document {$data['title']}");

            return $document;
        });

        return response()->json($document->load('addedBy:id,name'), 201);
    }

    public function updateVehicleDocument(Request $request, VehicleDocument $document)
    {
        $this->requireAbility($request, 'document.edit');

        // Phase B4 — Admin edits any document; a Custodian may only edit
        // the one they themselves uploaded.
        if (!$request->user()->hasRole('Admin')) {
            abort_unless($document->added_by === $request->user()->id, 403, 'You can only edit a document you uploaded yourself.');
        }

        $data = $request->validate([
            'title' => ['sometimes', 'string', 'max:255'],
            'category' => ['nullable', 'string', 'max:100'],
            'file' => ['nullable', 'file', 'mimes:jpg,jpeg,png,pdf,doc,docx', 'max:10240'],
        ]);

        if ($request->hasFile('file')) {
            $data['file_url'] = $this->storeUploadedImage($request->file('file'), 'vehicle-documents');
            \App\Models\ManagedFile::removeReference($document->file_url);
        }
        unset($data['file']);

        $document->update($data);
        $this->log($request, 'Edit', 'Vehicle Documents', $document->document_id, "Updated document #{$document->document_id}");

        return $document->fresh()->load('addedBy:id,name');
    }

    public function destroyVehicleDocument(Request $request, VehicleDocument $document)
    {
        $this->requireAbility($request, 'document.delete');

        $this->log($request, 'Delete', 'Vehicle Documents', $document->document_id, "Deleted document \"{$document->title}\"");
        \App\Models\ManagedFile::removeReference($document->file_url);
        $document->delete();

        return response()->json(['message' => 'Document deleted.']);
    }

    public function maintenanceRecords(Request $request)
    {
        $user = $request->user();

        $query = VehicleMaintenanceRecord::with([
            'vehicle.category',
            'sourceVehicle',
            'issueReport',
            'maintenancePersonnel',
            'verifiedBy',
            'confirmedBy',
            'originatingSchedule',
            'ticketSubIssue.ticket.originatingSchedule',
        ]);

        // The ledger includes all repair sources within the vehicle's barangay.
        // Personal history remains available through the explicit mine filter.
        if ($request->boolean('mine')) {
            $query->where('maintenance_personnel_id', $user->id);
        }

        if ($request->boolean('history')) {
            $query->where('progress_status', 'Completed');
        }

        if ($request->boolean('for_verification')) {
            $query->where('progress_status', 'For Verification');
        }

        $query->when($request->filled('progress_status'), fn ($q) => $q->where('progress_status', $request->progress_status))
            ->when($request->filled('maintenance_type'), fn ($q) => $q->where('maintenance_type', $request->maintenance_type));

        if ($request->filled('q')) {
            $search = $request->string('q');
            $query->where(function ($nested) use ($search) {
                $nested->where('maintenance_type', 'like', "%{$search}%")
                    ->orWhere('problem_reason', 'like', "%{$search}%")
                    ->orWhereHas('vehicle', function ($vehicleQuery) use ($search) {
                        $vehicleQuery->where('vehicle_name', 'like', "%{$search}%")
                            ->orWhere('plate_number', 'like', "%{$search}%");
                    });
            });
        }

        return $query->latest('maintenance_id')->get();
    }

    public function showMaintenanceRecord(Request $request, VehicleMaintenanceRecord $record)
    {
        return $record->load(['vehicle.category', 'sourceVehicle', 'issueReport', 'maintenancePersonnel', 'verifiedBy', 'confirmedBy', 'originatingSchedule', 'ticketSubIssue.ticket.originatingSchedule']);
    }

    public function storeMaintenanceRecord(Request $request)
    {
        $this->requireAbility($request, 'record.create');

        $data = $request->validate([
            'vehicle_id' => ['required', 'exists:vehicles,vehicle_id'],
            // Vehicle cannibalization: a part removed from another vehicle
            // rather than newly acquired. Optional — only set when that's
            // actually what happened.
            'source_vehicle_id' => ['nullable', 'exists:vehicles,vehicle_id', 'different:vehicle_id'],
            'part_name' => ['nullable', 'string', 'max:255'],
            'issue_report_id' => ['nullable', 'exists:vehicle_issue_reports,issue_report_id'],
            'maintenance_type' => ['required', 'string', 'max:150'],
            'problem_reason' => ['required', 'string'],
            'date_started' => ['nullable', 'date'],
            'date_completed' => ['nullable', 'date', 'before_or_equal:' . now('Asia/Manila')->toDateString()],
            'maintenance_personnel_id' => ['nullable', 'exists:users,id'],
            // Free-text fallback for someone outside the system entirely
            // (a volunteer, an outside helper) — mutually exclusive with
            // maintenance_personnel_id, never both set at once.
            'performed_by_other' => ['nullable', 'string', 'max:255'],
            'is_external' => ['nullable', 'boolean'],
            'external_vendor' => ['nullable', 'string', 'max:255'],
            'warranty_until' => ['nullable', 'date'],
            'receipt' => ['nullable', 'file', 'mimes:jpg,jpeg,png,pdf', 'max:8192'],
            'action_taken' => ['nullable', 'string'],
            'parts_used' => ['nullable', 'string'],
            'maintenance_cost' => ['nullable', 'numeric', 'min:0'],
            'progress_status' => ['nullable', Rule::in(['Assigned', 'Under Repair', 'On Hold - Awaiting Parts', 'For Verification', 'Completed'])],
            'remarks' => ['nullable', 'string'],
        ], [
            'source_vehicle_id.different' => 'A vehicle cannot be the source of its own part.',
        ]);

        $data['maintenance_type'] = MaintenanceType::resolve($data['maintenance_type']);

        if ($request->hasFile('receipt')) {
            $data['receipt_url'] = $this->storeUploadedImage($request->file('receipt'), 'maintenance-receipts');
        }
        unset($data['receipt']);

        // A pure mechanic (or now, a Custodian logging their own field fix)
        // logs work as themselves; only Admin keeps the ability to assign
        // someone else — a registered user or, via performed_by_other,
        // someone outside the system — as the one who actually performed it.
        if (!$request->user()->hasRole('Admin')) {
            $data['maintenance_personnel_id'] = $request->user()->id;
            $data['performed_by_other'] = null;
        }

        abort_if(
            empty($data['maintenance_personnel_id']) && empty($data['performed_by_other']),
            422,
            'Please select who performed the repair.'
        );

        // Production-readiness audit (2026-10-05, P0) — a receipt or photo is
        // supporting evidence, never a substitute for independent Custodian
        // verification. Removed the old "Admin + proof attached = instantly
        // Completed, self-certified" shortcut; a record claimed as already
        // done now always lands at For Verification for a Custodian to
        // actually check, exactly like every other maintenance path. The
        // receipt/photo itself can still be attached — it just doesn't skip
        // the check anymore.
        if (($data['progress_status'] ?? null) === 'Completed') {
            $data['progress_status'] = 'For Verification';
        }

        $record = DB::transaction(function () use ($data, $request) {
            $vehicle = Vehicle::findOrFail($data['vehicle_id']);

            $createPayload = $data;
            $createPayload['progress_status'] = $data['progress_status'] ?? 'Assigned';

            $record = VehicleMaintenanceRecord::create($createPayload);

            \App\Services\VehicleOperationalState::hold($vehicle);

            if (! empty($data['issue_report_id'])) {
                VehicleIssueReport::where('issue_report_id', $data['issue_report_id'])->update([
                    'status' => 'In Maintenance',
                ]);
            }

            $recordedNote = "{$data['maintenance_type']} was recorded for {$vehicle->vehicle_name}.";
            $this->history($vehicle, 'Maintenance Recorded', $recordedNote, 'vehicle_maintenance_records', $record->maintenance_id, $request);
            $this->log($request, 'Add', 'Vehicle Maintenance Records', $record->maintenance_id, "Added maintenance record for {$vehicle->vehicle_name}");

            // Cannibalization: log the loss on the DONOR vehicle's own
            // history so it's visible from that vehicle's side too, instead
            // of only existing as a mention buried in this record. Deliberately
            // does NOT touch the donor's status/condition — whether a missing
            // part actually makes it undeployable is a human judgment call,
            // not something this action should silently decide on its own.
            if (! empty($data['source_vehicle_id'])) {
                $sourceVehicle = Vehicle::find($data['source_vehicle_id']);
                if ($sourceVehicle) {
                    $partDescription = $data['parts_used'] ?: 'A part';
                    $this->history(
                        $sourceVehicle,
                        'Part Removed (Cannibalized)',
                        "{$partDescription} was removed from {$sourceVehicle->vehicle_name} for use on {$vehicle->vehicle_name} — see Maintenance Record #{$record->maintenance_id}.",
                        'vehicle_maintenance_records',
                        $record->maintenance_id,
                        $request
                    );
                }
            }

            // A mechanic self-filing a standalone record (no ticket, no Admin
            // gate first) is exactly the emergency/field-repair path — Admin
            // wasn't in the loop when this started, so make sure they're not
            // left finding out about it by accident.
            if (! $request->user()->hasRole('Admin')) {
                $this->notifyAdmins(
                    'Maintenance Record Filed',
                    "{$request->user()->name} logged a {$data['maintenance_type']} record for {$vehicle->vehicle_name}: {$data['problem_reason']}",
                    'maintenance_recorded',
                    $vehicle->barangay_id
                );
            }

            return $record;
        });

        return response()->json($record->load(['vehicle.category', 'sourceVehicle', 'issueReport', 'maintenancePersonnel']), 201);
    }

    public function updateMaintenanceRecord(Request $request, VehicleMaintenanceRecord $record)
    {
        return DB::transaction(function () use ($request, $record) {
            $record = VehicleMaintenanceRecord::whereKey($record->getKey())->lockForUpdate()->firstOrFail();
            return $this->updateMaintenanceRecordLocked($request, $record);
        });
    }

    private function updateMaintenanceRecordLocked(Request $request, VehicleMaintenanceRecord $record)
    {
        $this->requireAbility($request, 'record.edit');

        $data = $request->validate([
            'source_vehicle_id' => ['nullable', 'exists:vehicles,vehicle_id', 'different:vehicle_id'],
            'part_name' => ['nullable', 'string', 'max:255'],
            'issue_report_id' => ['nullable', 'exists:vehicle_issue_reports,issue_report_id'],
            'maintenance_type' => ['sometimes', 'string', 'max:150'],
            'problem_reason' => ['sometimes', 'string'],
            'date_started' => ['nullable', 'date'],
            'date_completed' => ['nullable', 'date', 'before_or_equal:' . now('Asia/Manila')->toDateString()],
            'maintenance_personnel_id' => ['nullable', 'exists:users,id'],
            'performed_by_other' => ['nullable', 'string', 'max:255'],
            'is_external' => ['nullable', 'boolean'],
            'external_vendor' => ['nullable', 'string', 'max:255'],
            'warranty_until' => ['nullable', 'date'],
            'receipt' => ['nullable', 'file', 'mimes:jpg,jpeg,png,pdf', 'max:8192'],
            'action_taken' => ['nullable', 'string'],
            'parts_used' => ['nullable', 'string'],
            'maintenance_cost' => ['nullable', 'numeric', 'min:0'],
            'progress_status' => ['nullable', Rule::in(['Assigned', 'Under Repair', 'On Hold - Awaiting Parts', 'For Verification', 'Completed'])],
            'remarks' => ['nullable', 'string'],
        ], [
            'source_vehicle_id.different' => 'A vehicle cannot be the source of its own part.',
        ]);

        if (!empty($data['source_vehicle_id'])) {
            $donor = Vehicle::findOrFail($data['source_vehicle_id']);
            abort_if($donor->vehicle_id === $record->vehicle_id, 422, 'A vehicle cannot donate a part to itself.');
        }
        if (!empty($data['issue_report_id'])) {
            $issue = VehicleIssueReport::findOrFail($data['issue_report_id']);
            abort_unless($issue->vehicle_id === $record->vehicle_id, 422, 'The issue must belong to this maintenance record vehicle.');
        }
        if (!empty($data['maintenance_personnel_id'])) {
            $person = User::findOrFail($data['maintenance_personnel_id']);
            abort_unless($person->barangay_id === $record->vehicle->barangay_id, 422, 'The repair performer must belong to this barangay.');
        }

        if (isset($data['maintenance_type'])) {
            $data['maintenance_type'] = MaintenanceType::resolve($data['maintenance_type']);
        }

        if ($request->hasFile('receipt')) {
            $data['receipt_url'] = $this->storeUploadedImage($request->file('receipt'), 'maintenance-receipts');
        }
        unset($data['receipt']);

        // Only log the donor-vehicle history the moment source_vehicle_id is
        // newly set or changed to a different vehicle — not on every
        // unrelated edit to this record, which would spam that vehicle's
        // history with duplicate entries.
        $previousSourceVehicleId = $record->source_vehicle_id;

        if (($data['progress_status'] ?? null) === 'Completed' && $request->user()->hasRole('Maintenance Personnel') && !$request->user()->hasRole('Admin')) {
            $data['progress_status'] = 'For Verification';
            $data['date_completed'] = null;
            $data['test_attested'] = false;
            $data['verification_result'] = null;
            $data['verification_notes'] = null;
            $data['verified_by'] = null;
            $data['verified_at'] = null;
        }

        // Production-readiness audit (2026-10-05, P0) — removed the
        // "receipt/photo attached = instantly Completed, no Custodian check"
        // shortcut entirely. Completing a record is confirmMaintenance()'s
        // job (record.confirm), which already correctly requires a passed
        // Custodian verification and stamps confirmed_by/confirmed_at/vehicle
        // status — this generic edit endpoint no longer sets 'Completed'
        // directly, so it can't produce a "Completed" record with none of
        // that bookkeeping. A receipt/photo can still be attached here as
        // evidence; it just doesn't finalize anything by itself anymore.
        if (($data['progress_status'] ?? null) === 'Completed') {
            abort(422, 'Use the Confirm action to complete a maintenance record, not a direct edit — it needs to have passed Custodian verification first.');
        }

        // #13 — edit-trail: capture a field-level before/after diff on the
        // sensitive fields (dates, cost, status, external vendor/warranty).
        // Backdating and cost edits are now allowed, so "who changed what from
        // what to what" must be on the record, not just "it was edited".
        $tracked = ['date_started', 'date_completed', 'maintenance_cost', 'progress_status', 'is_external', 'external_vendor', 'warranty_until'];
        $changes = [];
        foreach ($tracked as $field) {
            if (array_key_exists($field, $data)) {
                $before = $record->getOriginal($field);
                $after = $data[$field];
                if ((string) $before !== (string) $after) {
                    $changes[] = "{$field}: '" . ($before ?? '—') . "' -> '" . ($after ?? '—') . "'";
                }
            }
        }

        $record->fill($data);
        $repairFields = ['source_vehicle_id', 'part_name', 'issue_report_id', 'maintenance_type', 'problem_reason', 'maintenance_personnel_id', 'performed_by_other', 'is_external', 'external_vendor', 'receipt_url', 'action_taken', 'parts_used', 'progress_status'];
        $repairChanged = $record->isDirty($repairFields);
        abort_if($record->getOriginal('progress_status') === 'Completed' && $repairChanged, 422, 'Completed repair work is locked. Only administrative details may be corrected.');
        if ($repairChanged && $record->verification_result !== null) {
            $record->fill(['test_attested' => false, 'verification_result' => null, 'verification_notes' => null, 'verified_by' => null, 'verified_at' => null, 'confirmed_by' => null, 'confirmed_at' => null]);
            if (!array_key_exists('progress_status', $data)) $record->progress_status = 'For Verification';
        }
        $record->save();

        if ($record->issue_report_id) {
            $record->issueReport()->update([
                'status' => $record->progress_status === 'Completed' ? 'Resolved' : 'In Maintenance',
            ]);
        }

        $this->history($record->vehicle, 'Maintenance Updated', "Maintenance #{$record->maintenance_id} was updated to {$record->progress_status}.", 'vehicle_maintenance_records', $record->maintenance_id, $request);
        $detail = "Updated maintenance #{$record->maintenance_id}" . (count($changes) ? ' — ' . implode('; ', $changes) : '');
        $this->log($request, 'Edit', 'Vehicle Maintenance Records', $record->maintenance_id, $detail);

        // Same cannibalization history as on create — only fires when
        // source_vehicle_id is newly set or changed, not on unrelated edits.
        if (array_key_exists('source_vehicle_id', $data) && $data['source_vehicle_id'] && (int) $data['source_vehicle_id'] !== (int) $previousSourceVehicleId) {
            $sourceVehicle = Vehicle::find($data['source_vehicle_id']);
            if ($sourceVehicle) {
                $partDescription = $record->parts_used ?: 'A part';
                $this->history(
                    $sourceVehicle,
                    'Part Removed (Cannibalized)',
                    "{$partDescription} was removed from {$sourceVehicle->vehicle_name} for use on {$record->vehicle->vehicle_name} — see Maintenance Record #{$record->maintenance_id}.",
                    'vehicle_maintenance_records',
                    $record->maintenance_id,
                    $request
                );
            }
        }

        return $record->fresh(['vehicle.category', 'sourceVehicle', 'issueReport', 'maintenancePersonnel', 'verifiedBy', 'confirmedBy']);
    }

    public function verifyMaintenance(Request $request, VehicleMaintenanceRecord $record)
    {
        return DB::transaction(function () use ($request, $record) {
            $record = VehicleMaintenanceRecord::whereKey($record->getKey())->lockForUpdate()->firstOrFail();
            return $this->verifyMaintenanceLocked($request, $record);
        });
    }

    private function verifyMaintenanceLocked(Request $request, VehicleMaintenanceRecord $record)
    {
        $this->requireAbility($request, 'record.verify');

        abort_unless(
            $record->progress_status === 'For Verification',
            422,
            'This maintenance record is not awaiting verification.'
        );

        // A Pass leaves progress_status at 'For Verification' (Admin still
        // has to Confirm) — without this guard, a second Custodian (or the
        // same one again) could submit another verdict in that window and
        // silently overwrite the first one, with no trace it ever happened.
        // Only one verdict counts; if it genuinely needs redoing, Admin
        // must Reopen it first, which clears this back to null.
        abort_unless(
            $record->verification_result === null,
            409,
            'This record has already been verified. An Admin needs to Reopen it before it can be re-verified.'
        );

        // Independent check is the entire point of this step — a Custodian
        // who also performed the repair (dual-role accounts can) can't be
        // the one who signs off on their own work. Someone else with the
        // Custodian hat, or Admin via the fast-close path, has to instead.
        abort_if(
            $record->maintenance_personnel_id === $request->user()->id,
            403,
            'You performed this repair — another Custodian needs to verify it.'
        );

        $data = $request->validate([
            'verification_result' => ['required', Rule::in(['Passed', 'Failed'])],
            'verification_notes' => ['required_if:verification_result,Failed', 'nullable', 'string'],
            'test_attested' => ['required_if:verification_result,Passed', 'accepted_if:verification_result,Passed'],
        ]);

        DB::transaction(function () use ($record, $data, $request) {
            $passed = $data['verification_result'] === 'Passed';

            $record->update([
                'progress_status' => $passed ? 'For Verification' : 'Under Repair',
                'verification_result' => $data['verification_result'],
                'verification_notes' => $data['verification_notes'] ?? null,
                'test_attested' => $passed && $request->boolean('test_attested'),
                'verified_by' => $request->user()->id,
                'verified_at' => now(),
            ]);

            if ($record->issueReport) {
                $record->issueReport->update([
                    'status' => $passed ? 'In Maintenance' : 'Under Review',
                ]);
            }

            \App\Services\VehicleOperationalState::hold($record->vehicle, $passed ? 'Needs Inspection' : 'Needs Repair');

            $activity = $passed ? 'Repair Verification Passed' : 'Repair Verification Failed';
            $this->history($record->vehicle, $activity, "Custodian marked maintenance #{$record->maintenance_id} as {$data['verification_result']}.", 'vehicle_maintenance_records', $record->maintenance_id, $request);
            $this->log($request, 'Edit', 'Vehicle Maintenance Records', $record->maintenance_id, "{$activity} for maintenance #{$record->maintenance_id}");
        });

        return $record->fresh(['vehicle.category', 'issueReport', 'maintenancePersonnel', 'verifiedBy', 'confirmedBy']);
    }

    public function confirmMaintenance(Request $request, VehicleMaintenanceRecord $record)
    {
        return DB::transaction(function () use ($request, $record) {
            $record = VehicleMaintenanceRecord::whereKey($record->getKey())->lockForUpdate()->firstOrFail();
            return $this->confirmMaintenanceLocked($request, $record);
        });
    }

    private function confirmMaintenanceLocked(Request $request, VehicleMaintenanceRecord $record)
    {
        $this->requireAbility($request, 'record.confirm');

        abort_unless(
            $record->progress_status === 'For Verification' && $record->verification_result === 'Passed',
            422,
            'This maintenance record has not passed Custodian verification yet.'
        );
        abort_if($record->verified_by !== null && (int) $record->verified_by === (int) $record->maintenance_personnel_id, 422, 'Repair work must be verified by someone other than the performer.');

        $data = $request->validate([
            'confirmed' => ['required', 'boolean'],
            'remarks' => ['nullable', 'string'],
        ]);

        DB::transaction(function () use ($record, $data, $request) {
            if ($data['confirmed']) {
                $record->update([
                    'progress_status' => 'Completed',
                    'date_completed' => $record->date_completed ?? now()->toDateString(),
                    'confirmed_by' => $request->user()->id,
                    'confirmed_at' => now(),
                    'remarks' => $data['remarks'] ?? $record->remarks,
                ]);

                if ($record->issueReport) {
                    $record->issueReport->update(['status' => 'Resolved']);
                }
                \App\Services\VehicleOperationalState::refresh($record->vehicle, true);

                $this->history($record->vehicle, 'Ticket Closed', "Maintenance #{$record->maintenance_id} was confirmed and closed.", 'vehicle_maintenance_records', $record->maintenance_id, $request);
                $this->log($request, 'Edit', 'Vehicle Maintenance Records', $record->maintenance_id, "Confirmed maintenance #{$record->maintenance_id}");

                return;
            }

            $record->update([
                'progress_status' => 'Under Repair',
                // Clear the old verdict — otherwise it lingers as "Passed"
                // forever and verifyMaintenance()'s re-verification guard
                // would permanently block a fresh check once the rework is
                // actually done and this comes back to 'For Verification'.
                'test_attested' => false, 'verification_result' => null,
                'verification_notes' => null,
                'verified_by' => null,
                'verified_at' => null,
                'remarks' => $data['remarks'] ?? $record->remarks,
            ]);

            \App\Services\VehicleOperationalState::hold($record->vehicle);

            if ($record->issueReport) {
                $record->issueReport->update(['status' => 'Under Review']);
            }

            $this->history($record->vehicle, 'Ticket Reopened', "Maintenance #{$record->maintenance_id} was reopened for more work.", 'vehicle_maintenance_records', $record->maintenance_id, $request);
            $this->log($request, 'Edit', 'Vehicle Maintenance Records', $record->maintenance_id, "Reopened maintenance #{$record->maintenance_id}");
        });

        return $record->fresh(['vehicle.category', 'issueReport', 'maintenancePersonnel', 'verifiedBy', 'confirmedBy']);
    }

    /**
     * Decision-close — the Maintenance Record counterpart to the ticket
     * workflow's decision-close (TicketController::closeTicket). Admin ends
     * the record NOW without waiting for Custodian verification, but on the
     * same two conditions tickets already impose:
     *
     *   1. a mandatory reason — the record must say WHY it skipped verification
     *   2. an explicit fit-for-service call — Admin decides whether the
     *      vehicle actually goes back into rotation, rather than it being
     *      assumed just because the paperwork closed
     *
     * verification_result is deliberately left NULL. A decision-close must
     * never masquerade as a passed verification — "Completed with no
     * verification result" is exactly how the UI spots and flags one.
     */
    public function decisionCloseMaintenance(Request $request, VehicleMaintenanceRecord $record)
    {
        return DB::transaction(function () use ($request, $record) {
            $record = VehicleMaintenanceRecord::whereKey($record->getKey())->lockForUpdate()->firstOrFail();
            return $this->decisionCloseMaintenanceLocked($request, $record);
        });
    }

    private function decisionCloseMaintenanceLocked(Request $request, VehicleMaintenanceRecord $record)
    {
        $this->requireAbility($request, 'record.decision_close');

        abort_if(
            $record->progress_status === 'Completed',
            422,
            'This maintenance record is already completed.'
        );

        // A record that already PASSED verification has nothing to skip — it
        // should go through the normal confirm path so the pass is honoured
        // instead of being overwritten by an "unverified" close.
        abort_if(
            $record->verification_result === 'Passed',
            422,
            'This record already passed Custodian verification — use Confirm instead.'
        );

        $data = $request->validate([
            'closure_reason'      => ['required', 'string'],
            'returned_to_service' => ['required', 'boolean'],
        ], [
            'closure_reason.required' => 'A reason is required to close this without Custodian verification.',
            'returned_to_service.required' => 'State whether the vehicle is fit to return to service before closing.',
        ]);

        DB::transaction(function () use ($record, $data, $request) {
            $returnToService = (bool) $data['returned_to_service'];

            $record->update([
                'progress_status' => 'Completed',
                'date_completed'  => $record->date_completed ?? now()->toDateString(),
                'closure_reason'  => $data['closure_reason'],
                // Admin confirmed the DECISION, not the workmanship — stamping
                // this keeps "who ended this and when" answerable, while
                // verification_result staying null keeps it honest about the
                // fact nobody independently checked the work.
                'confirmed_by'    => $request->user()->id,
                'confirmed_at'    => now(),
            ]);

            // Only resolve the originating report if the vehicle was actually
            // judged fit — otherwise the problem still stands and the report
            // must stay visible instead of quietly closing with the record.
            if ($record->issueReport) {
                $record->issueReport->update(['status' => $returnToService ? 'Resolved' : 'Under Review']);
            }
            if ($returnToService) {
                \App\Services\VehicleOperationalState::refresh($record->vehicle, true);
            } else {
                \App\Services\VehicleOperationalState::hold($record->vehicle);
            }

            // The Custodians had this in their Pending Verifications queue.
            // Setting progress_status to Completed drops it out of that list
            // on its own, but they'd never know why it vanished.
            $this->notifyCustodians(
                'Verification No Longer Needed',
                "Admin closed maintenance #{$record->maintenance_id} ({$record->vehicle->vehicle_name}) without verification. Reason: {$data['closure_reason']}",
                'maintenance_verification_withdrawn',
                $record->vehicle->barangay_id
            );

            $serviceNote = $returnToService ? 'Vehicle returned to service.' : 'Vehicle kept out of service.';
            $this->history(
                $record->vehicle,
                'Maintenance Closed Without Verification',
                "Maintenance #{$record->maintenance_id} was closed by Admin without Custodian verification. Reason: {$data['closure_reason']} {$serviceNote}",
                'vehicle_maintenance_records',
                $record->maintenance_id,
                $request
            );
            $this->log($request, 'Edit', 'Vehicle Maintenance Records', $record->maintenance_id, "Decision-closed maintenance #{$record->maintenance_id} without verification — {$data['closure_reason']}");
        });

        return $record->fresh(['vehicle.category', 'sourceVehicle', 'issueReport', 'maintenancePersonnel', 'verifiedBy', 'confirmedBy']);
    }

    public function schedules(Request $request)
    {
        $user = $request->user();
        $query = VehicleMaintenanceSchedule::with([
            'vehicle.category',
            'createdBy',
            'assignedToUser',
            // Nested so the "View Maintenance Record" detail modal has full
            // info (vehicle, personnel, verifier) without a second fetch.
            'resultingTicket:ticket_id,barangay_number,ticket_title,status',
            'resultingMaintenance.vehicle',
            'resultingMaintenance.sourceVehicle',
            'resultingMaintenance.maintenancePersonnel',
            'resultingMaintenance.verifiedBy',
            'resultingMaintenance.confirmedBy',
        ]);

        // A pure Maintenance Personnel account only sees schedules assigned
        // to them — Admin and Custodian keep the full barangay-wide list
        // (VMS-IMPROVEMENT-PLAN.md Phase B3). A Pending Approval/Declined
        // schedule isn't really "theirs" yet (nothing's confirmed — see
        // storeSchedule()'s deferred assignee notification), so it's held
        // back until Admin approves it, same as the notification itself.
        if ($user->hasRole('Maintenance Personnel') && !$user->hasAnyRole(['Admin', 'Custodian'])) {
            $query->where('assigned_to', $user->id)->whereNotIn('status', ['Pending Approval', 'Declined']);
        }

        $query->when($request->filled('status'), fn ($q) => $q->where('status', $request->status))
            ->when($request->filled('maintenance_type'), fn ($q) => $q->where('maintenance_type', $request->maintenance_type));

        if ($request->filled('from')) {
            $query->whereDate('scheduled_date', '>=', $request->from);
        }

        if ($request->filled('to')) {
            $query->whereDate('scheduled_date', '<=', $request->to);
        }

        return $query->orderBy('scheduled_date')->orderBy('scheduled_time')->get();
    }

    // A Custodian's nudge that a vehicle is due for preventive maintenance.
    // Books nothing — Admin owns the calendar and decides whether to schedule it.
    public function suggestSchedule(Request $request)
    {
        $this->requireAbility($request, 'schedule.suggest');

        $data = $request->validate([
            'vehicle_id' => ['required', 'integer'],
            'maintenance_type' => ['required', 'string', 'max:150'],
            'scheduled_date' => ['nullable', 'date'],
            'notes' => ['nullable', 'string', 'max:1000'],
        ]);

        // Vehicle carries the barangay scope, so another barangay's id 404s.
        $vehicle = Vehicle::findOrFail($data['vehicle_id']);
        $who = $request->user()->name;
        $when = !empty($data['scheduled_date']) ? ' around ' . \Illuminate\Support\Carbon::parse($data['scheduled_date'])->format('M j, Y') : '';
        $notes = !empty($data['notes']) ? " Note: {$data['notes']}" : '';

        $this->notifyAdmins(
            'Maintenance Schedule Suggested',
            "{$who} suggests scheduling {$data['maintenance_type']} for {$vehicle->vehicle_name}{$when}.{$notes}",
            'schedule_suggested',
            $vehicle->barangay_id,
            ['vehicle_id' => $vehicle->vehicle_id]
        );
        $this->log($request, 'Suggest Schedule', 'Maintenance Schedule', $vehicle->vehicle_id, "Suggested {$data['maintenance_type']} for {$vehicle->vehicle_name}.");

        return response()->json(['message' => 'Suggestion sent to Admin.'], 201);
    }

    // Admin suspects a problem but may not report or ticket it themselves —
    // this asks the Custodians to go look, and opens the vehicle for them.
    public function requestInspection(Request $request, Vehicle $vehicle)
    {
        $this->requireAbility($request, 'vehicle.request_inspection');

        $data = $request->validate(['note' => ['nullable', 'string', 'max:1000']]);

        $hasCustodian = User::where('barangay_id', $vehicle->barangay_id)->havingRole('Custodian')->where('is_active', true)->exists();
        abort_unless($hasCustodian, 422, 'There is no active Custodian in this barangay to notify.');

        $note = !empty($data['note']) ? " Note: {$data['note']}" : '';
        $this->notifyCustodians(
            'Inspection Requested',
            "{$request->user()->name} asks you to physically inspect {$vehicle->vehicle_name} ({$vehicle->plate_number}).{$note}",
            'inspection_requested',
            $vehicle->barangay_id,
            ['vehicle_id' => $vehicle->vehicle_id]
        );
        $this->log($request, 'Request Inspection', 'Vehicles', $vehicle->vehicle_id, "Requested a Custodian inspection of {$vehicle->vehicle_name}.");

        return response()->json(['message' => 'Custodians notified.'], 201);
    }

    // Maintenance Personnel can't open a ticket, but a technical finding often
    // warrants one — this points the Custodians at the exact issue to do it.
    public function recommendTicket(Request $request, VehicleIssueReport $issue)
    {
        $this->requireAbility($request, 'issue.recommend_ticket');

        abort_unless(
            in_array($issue->status, ['Pending', 'Under Review'], true) && !$issue->maintenanceTicket,
            422,
            'This issue already has a ticket or is no longer open.'
        );

        $data = $request->validate(['note' => ['nullable', 'string', 'max:1000']]);
        $vehicle = $issue->vehicle;
        $note = !empty($data['note']) ? " Note: {$data['note']}" : '';

        $this->notifyCustodians(
            'Maintenance Ticket Recommended',
            "{$request->user()->name} recommends a maintenance ticket for {$vehicle->vehicle_name} — {$issue->issue_type}.{$note}",
            'ticket_recommended',
            $vehicle->barangay_id,
            ['issue_report_id' => $issue->issue_report_id]
        );
        $this->log($request, 'Recommend Ticket', 'Issue Reports', $issue->issue_report_id, "Recommended a maintenance ticket for issue #{$issue->issue_report_id}.");

        return response()->json(['message' => 'Custodians notified.'], 201);
    }

    public function storeSchedule(Request $request)
    {
        // Admin owns the maintenance calendar (spec §19, 2026-10-06). A
        // Custodian who spots something due uses suggestSchedule() instead.
        $this->requireAbility($request, 'schedule.create');

        $data = $request->validate([
            'vehicle_id' => ['required', 'exists:vehicles,vehicle_id'],
            'maintenance_type' => ['required', 'string', 'max:150'],
            'scheduled_date' => ['required', 'date'],
            'scheduled_time' => ['nullable', 'date_format:H:i'],
            'service_location' => ['nullable', 'string', 'max:255'],
            'notes' => ['nullable', 'string'],
            'assigned_to' => ['nullable', 'exists:users,id'],
            // null/absent = one-time; otherwise the interval (months) to auto-
            // schedule the next service when this one is completed.
            'recurrence_months' => ['nullable', 'integer', 'min:1', 'max:60'],
            // A confirmed decision to proceed despite checkScheduleConflicts()
            // below — the whole point is this NEVER blocks outright, only
            // asks for an explicit yes once the conflict is shown.
            'confirm_conflicts' => ['nullable', 'boolean'],
        ]);

        $data['maintenance_type'] = MaintenanceType::resolve($data['maintenance_type']);

        $vehicle = Vehicle::findOrFail($data['vehicle_id']);
        abort_if(in_array($vehicle->status, ['Inactive', 'Decommissioned'], true), 422, 'Cannot schedule a retired vehicle.');
        $this->validateScheduleAssignee($data['assigned_to'] ?? null, $vehicle);

        $conflicts = $this->checkScheduleConflicts($vehicle, $data['scheduled_date']);
        if ($conflicts && !$request->boolean('confirm_conflicts')) {
            return response()->json($conflicts, 409);
        }

        $schedule = DB::transaction(function () use ($data, $request, $vehicle) {
            // A Custodian's schedule parks at Pending Approval until an Admin
            // reviews it — same propose/approve/decline shape as a ticket
            // proposal (see approveSchedule()/declineSchedule() below).
            // Scheduled is only ever reached via approveSchedule() now;
            // Completed/Cancelled are still only reached via
            // completeSchedule()/deleteSchedule(). Any assignee isn't
            // notified yet — nothing is confirmed until Admin approves.
            $schedule = VehicleMaintenanceSchedule::create($data + [
                'created_by' => $request->user()->id,
                'status' => 'Pending Approval',
            ]);

            $this->history($vehicle, 'Maintenance Schedule Proposed', "{$data['maintenance_type']} was proposed for {$vehicle->vehicle_name}, awaiting Admin approval.", 'vehicle_maintenance_schedules', $schedule->schedule_id, $request);
            $this->log($request, 'Add', 'Vehicle Maintenance Schedule', $schedule->schedule_id, "Proposed {$data['maintenance_type']} for {$vehicle->vehicle_name}, submitted for Admin review.");

            $this->notifyAdmins(
                'New Maintenance Schedule Awaiting Approval',
                "{$request->user()->name} scheduled {$data['maintenance_type']} for {$vehicle->vehicle_name} ({$data['scheduled_date']}). Review, then approve or decline.",
                'schedule_proposed',
                $vehicle->barangay_id,
                ['schedule_id' => $schedule->schedule_id]
            );

            return $schedule;
        });

        return response()->json($schedule->load(['vehicle.category', 'createdBy', 'assignedToUser']), 201);
    }

    /**
     * Warning-not-a-block for a new/moved schedule date: a same-vehicle
     * same-day conflict, and/or the barangay's daily volume crossing
     * config('scheduling.daily_volume_warning_threshold'). Returns null when
     * there's nothing to flag; otherwise the caller re-submits with
     * confirm_conflicts=true to proceed anyway. Deliberately never aborts —
     * the whole point is the decision stays with the person booking it.
     */
    private function checkScheduleConflicts(Vehicle $vehicle, string $date, ?int $excludeScheduleId = null): ?array
    {
        // Pending Approval counts as a real conflict too, not just Scheduled
        // (approved) — a Custodian's own just-booked entry hasn't been
        // reviewed yet, but it's still a genuine intent to use the vehicle
        // that day, same as an already-approved one.
        $conflictStatuses = ['Scheduled', 'Pending Approval'];

        $sameVehicleConflict = VehicleMaintenanceSchedule::where('vehicle_id', $vehicle->vehicle_id)
            ->whereDate('scheduled_date', $date)
            ->whereIn('status', $conflictStatuses)
            ->when($excludeScheduleId, fn ($q) => $q->where('schedule_id', '!=', $excludeScheduleId))
            ->exists();

        $dailyCount = VehicleMaintenanceSchedule::whereHas('vehicle', fn ($q) => $q->where('barangay_id', $vehicle->barangay_id))
            ->whereDate('scheduled_date', $date)
            ->whereIn('status', $conflictStatuses)
            ->when($excludeScheduleId, fn ($q) => $q->where('schedule_id', '!=', $excludeScheduleId))
            ->count();

        $threshold = config('scheduling.daily_volume_warning_threshold');
        $busyDay = $dailyCount >= $threshold;

        if (!$sameVehicleConflict && !$busyDay) {
            return null;
        }

        $messages = [];
        if ($sameVehicleConflict) {
            $messages[] = "{$vehicle->vehicle_name} already has a maintenance schedule on that date.";
        }
        if ($busyDay) {
            $messages[] = "This barangay already has {$dailyCount} maintenance schedules on that date.";
        }

        return [
            'warning' => true,
            'same_vehicle_conflict' => $sameVehicleConflict,
            'daily_volume_count' => $dailyCount,
            'daily_volume_threshold' => $threshold,
            'message' => implode(' ', $messages) . ' Are you sure you want to add another?',
        ];
    }

    /**
     * Admin reviews a Pending Approval schedule and approves it — the
     * schedule goes live (status Scheduled) and, if an assignee was picked
     * at creation, that person finally gets notified (deferred from
     * storeSchedule() — nothing was confirmed until now). Mirrors
     * TicketController::approveTicket()'s shape, minus the mechanic
     * (re)assignment step tickets need — a schedule's assignee was already
     * picked by the Custodian and doesn't change here.
     */
    public function approveSchedule(Request $request, VehicleMaintenanceSchedule $schedule)
    {
        return DB::transaction(function () use ($request, $schedule) {
            $schedule = VehicleMaintenanceSchedule::whereKey($schedule->getKey())->lockForUpdate()->firstOrFail();
            return $this->approveScheduleLocked($request, $schedule);
        });
    }

    private function approveScheduleLocked(Request $request, VehicleMaintenanceSchedule $schedule)
    {
        $this->requireAbility($request, 'schedule.approve');

        // A previously Declined schedule can be approved directly — Admin
        // doesn't have to undecline it first (same as a ticket proposal).
        abort_unless(
            in_array($schedule->status, ['Pending Approval', 'Declined'], true),
            422,
            "Only a Pending Approval or Declined schedule can be approved. Current: {$schedule->status}."
        );

        $this->validateScheduleAssignee($schedule->assigned_to, $schedule->vehicle);
        abort_if(in_array($schedule->vehicle->status, ['Inactive', 'Decommissioned'], true), 422, 'Cannot approve maintenance for a retired vehicle.');
        $schedule = DB::transaction(function () use ($schedule, $request) {
            $locked = VehicleMaintenanceSchedule::where('schedule_id', $schedule->schedule_id)->lockForUpdate()->first();
            abort_unless($locked && in_array($locked->status, ['Pending Approval', 'Declined'], true), 422, 'This schedule was already reviewed.');

            $schedule->update(['status' => 'Scheduled', 'decline_reason' => null]);

            $vehicle = $schedule->vehicle;
            $this->history($vehicle, 'Maintenance Schedule Approved', "Schedule #{$schedule->schedule_id} ({$schedule->maintenance_type}) was approved.", 'vehicle_maintenance_schedules', $schedule->schedule_id, $request);
            $this->log($request, 'Approve Schedule', 'Vehicle Maintenance Schedule', $schedule->schedule_id, "Approved schedule #{$schedule->schedule_id} for {$vehicle->vehicle_name}.");

            $this->notifyUser(
                (int) $schedule->created_by,
                'Maintenance Schedule Approved',
                "Your scheduled {$schedule->maintenance_type} for {$vehicle->vehicle_name} was approved.",
                'schedule_approved',
                ['schedule_id' => $schedule->schedule_id]
            );
            if ($schedule->assigned_to) {
                $this->notifyUser(
                    (int) $schedule->assigned_to,
                    'Maintenance Assigned to You',
                    "You've been assigned {$schedule->maintenance_type} for {$vehicle->vehicle_name}, scheduled {$schedule->scheduled_date}.",
                    'schedule_assigned',
                    ['schedule_id' => $schedule->schedule_id]
                );
            }

            return $schedule;
        });

        return response()->json($schedule->fresh(['vehicle.category', 'createdBy', 'assignedToUser']));
    }

    /**
     * Admin declines a Pending Approval schedule with a reason — mirrors
     * TicketController::declineTicket() exactly: a visible, reversible
     * status (not a delete), the Custodian who booked it can see why and
     * either let it sit or ask Admin to reconsider.
     */
    public function declineSchedule(Request $request, VehicleMaintenanceSchedule $schedule)
    {
        return DB::transaction(function () use ($request, $schedule) {
            $schedule = VehicleMaintenanceSchedule::whereKey($schedule->getKey())->lockForUpdate()->firstOrFail();
            return $this->declineScheduleLocked($request, $schedule);
        });
    }

    private function declineScheduleLocked(Request $request, VehicleMaintenanceSchedule $schedule)
    {
        $this->requireAbility($request, 'schedule.decline');

        abort_unless($schedule->status === 'Pending Approval', 422, "Only a Pending Approval schedule can be declined. Current: {$schedule->status}.");

        $data = $request->validate([
            'decline_reason' => ['required', 'string'],
        ]);

        $schedule->update([
            'status' => 'Declined',
            'decline_reason' => $data['decline_reason'],
        ]);

        $this->history($schedule->vehicle, 'Maintenance Schedule Declined', "Schedule #{$schedule->schedule_id} ({$schedule->maintenance_type}) was declined.", 'vehicle_maintenance_schedules', $schedule->schedule_id, $request);
        $this->log($request, 'Decline Schedule', 'Vehicle Maintenance Schedule', $schedule->schedule_id, "Declined schedule #{$schedule->schedule_id}. Reason: {$data['decline_reason']}");

        $this->notifyUser(
            (int) $schedule->created_by,
            'Maintenance Schedule Declined',
            "Your scheduled {$schedule->maintenance_type} for {$schedule->vehicle->vehicle_name} was declined. Reason: {$data['decline_reason']}",
            'schedule_declined',
            ['schedule_id' => $schedule->schedule_id]
        );

        return response()->json($schedule->fresh(['vehicle.category', 'createdBy', 'assignedToUser']));
    }

    /**
     * Admin changes their mind about a decline — puts the schedule back at
     * Pending Approval for the Custodian to see it's live again, or for
     * Admin to approve it properly. Mirrors TicketController::undeclineTicket().
     */
    public function undeclineSchedule(Request $request, VehicleMaintenanceSchedule $schedule)
    {
        return DB::transaction(function () use ($request, $schedule) {
            $schedule = VehicleMaintenanceSchedule::whereKey($schedule->getKey())->lockForUpdate()->firstOrFail();
            return $this->undeclineScheduleLocked($request, $schedule);
        });
    }

    private function undeclineScheduleLocked(Request $request, VehicleMaintenanceSchedule $schedule)
    {
        $this->requireAbility($request, 'schedule.decline');

        abort_unless($schedule->status === 'Declined', 422, "Only a Declined schedule can be undeclined. Current: {$schedule->status}.");

        $schedule->update(['status' => 'Pending Approval', 'decline_reason' => null]);

        $this->log($request, 'Undecline Schedule', 'Vehicle Maintenance Schedule', $schedule->schedule_id, "Restored schedule #{$schedule->schedule_id} to Pending Approval.");

        $this->notifyUser(
            (int) $schedule->created_by,
            'Maintenance Schedule Reconsidered',
            "Your scheduled {$schedule->maintenance_type} for {$schedule->vehicle->vehicle_name} is back under review.",
            'schedule_proposed',
            ['schedule_id' => $schedule->schedule_id]
        );

        return response()->json($schedule->fresh(['vehicle.category', 'createdBy', 'assignedToUser']));
    }

    public function updateSchedule(Request $request, VehicleMaintenanceSchedule $schedule)
    {
        return DB::transaction(function () use ($request, $schedule) {
            $schedule = VehicleMaintenanceSchedule::whereKey($schedule->getKey())->lockForUpdate()->firstOrFail();
            return $this->updateScheduleLocked($request, $schedule);
        });
    }

    private function updateScheduleLocked(Request $request, VehicleMaintenanceSchedule $schedule)
    {
        $this->requireAbility($request, 'schedule.edit');
        abort_unless((int) $schedule->created_by === (int) $request->user()->id, 403, 'Only the Custodian who booked this schedule may edit it.');
        $this->abortUnlessOwnBarangaySchedule($schedule);
        $this->assertSchedulePlanEditable($schedule);

        $data = $request->validate([
            'vehicle_id' => ['sometimes', 'exists:vehicles,vehicle_id'],
            'maintenance_type' => ['sometimes', 'string', 'max:150'],
            'scheduled_date' => ['sometimes', 'date'],
            'scheduled_time' => ['nullable', 'date_format:H:i'],
            'service_location' => ['nullable', 'string', 'max:255'],
            'notes' => ['nullable', 'string'],
            'assigned_to' => ['nullable', 'exists:users,id'],
            // Completed is deliberately NOT a valid value here — marking a
            // schedule done must go through completeSchedule(), which also
            // creates the proof-of-work maintenance record and, if recurring,
            // seeds the next occurrence. Setting status directly would
            // silently skip both.
            'status' => ['sometimes', Rule::in(['Cancelled'])],
            'recurrence_months' => ['nullable', 'integer', 'min:1', 'max:60'],
            'confirm_conflicts' => ['nullable', 'boolean'],
        ]);

        if (isset($data['status'])) return $this->deleteSchedule($request, $schedule);

        $targetVehicle = isset($data['vehicle_id']) ? Vehicle::findOrFail($data['vehicle_id']) : $schedule->vehicle;
        abort_if(in_array($targetVehicle->status, ['Inactive', 'Decommissioned'], true), 422, 'Cannot schedule a retired vehicle.');
        if (array_key_exists('assigned_to', $data)) {
            $this->validateScheduleAssignee($data['assigned_to'], $targetVehicle);
            abort_if($schedule->status === 'Scheduled' && (int) $data['assigned_to'] !== (int) $schedule->assigned_to,
                403, 'Only Admin may reassign an approved schedule.');
        } else {
            $this->validateScheduleAssignee($schedule->assigned_to, $targetVehicle);
        }
        if (isset($data['maintenance_type'])) {
            $data['maintenance_type'] = MaintenanceType::resolve($data['maintenance_type']);
        }

        // Same warning-not-a-block guard as create, ignoring this schedule
        // itself — only re-checked when the vehicle or date actually moved.
        if (isset($data['vehicle_id']) || isset($data['scheduled_date'])) {
            $targetVehicle = isset($data['vehicle_id']) ? Vehicle::findOrFail($data['vehicle_id']) : $schedule->vehicle;
            $targetDate = $data['scheduled_date'] ?? $schedule->scheduled_date;

            $conflicts = $this->checkScheduleConflicts($targetVehicle, $targetDate, $schedule->schedule_id);
            if ($conflicts && !$request->boolean('confirm_conflicts')) {
                return response()->json($conflicts, 409);
            }
        }

        $previousAssignee = $schedule->assigned_to;

        unset($data['confirm_conflicts']);
        $schedule->fill($data);
        $needsReview = $schedule->isDirty();
        if ($needsReview) {
            $schedule->fill(['status' => 'Pending Approval', 'decline_reason' => null]);
        }
        $schedule->save();
        if ($needsReview) {
            $this->notifyAdmins('Maintenance Schedule Changed', "{$request->user()->name} updated schedule #{$schedule->schedule_id}; review the changed plan before it proceeds.", 'schedule_proposed', $schedule->vehicle->barangay_id, ['schedule_id' => $schedule->schedule_id]);
        }
        $this->history($schedule->vehicle, 'Maintenance Schedule Updated', "Maintenance schedule #{$schedule->schedule_id} was updated.", 'vehicle_maintenance_schedules', $schedule->schedule_id, $request);
        $this->log($request, 'Edit', 'Vehicle Maintenance Schedule', $schedule->schedule_id, "Updated schedule #{$schedule->schedule_id}");

        // Notify on assignment or reassignment so the (new) mechanic finds out
        // proactively instead of having to browse the shared schedule list.
        if ($schedule->status === 'Scheduled' && array_key_exists('assigned_to', $data) && $data['assigned_to'] && (int) $data['assigned_to'] !== (int) $previousAssignee) {
            $this->notifyUser(
                (int) $data['assigned_to'],
                'Maintenance Assigned to You',
                "You've been assigned {$schedule->maintenance_type} for {$schedule->vehicle->vehicle_name}, scheduled {$schedule->scheduled_date}.",
                'schedule_assigned',
                ['schedule_id' => $schedule->schedule_id]
            );
        }

        return $schedule->fresh(['vehicle.category', 'createdBy', 'assignedToUser']);
    }

    /**
     * Gap 2 — "close the loop" for a scheduled preventive maintenance in ONE
     * action: mark the schedule Completed, create the linked maintenance
     * record (so there's always proof of what was done), and — if the
     * schedule is recurring — auto-create the next due date. Prevents the
     * two old failure modes: a done PM stuck showing "overdue", and a
     * forgotten next service.
     */
    public function completeSchedule(Request $request, VehicleMaintenanceSchedule $schedule)
    {
        return DB::transaction(function () use ($request, $schedule) {
            $schedule = VehicleMaintenanceSchedule::whereKey($schedule->getKey())->lockForUpdate()->firstOrFail();
            return $this->completeScheduleLocked($request, $schedule);
        });
    }

    private function completeScheduleLocked(Request $request, VehicleMaintenanceSchedule $schedule)
    {
        $this->requireAbility($request, 'schedule.complete');
        abort_if(in_array($schedule->vehicle->status, ['Inactive', 'Decommissioned'], true), 422, 'Cannot complete a schedule for a retired vehicle.');

        abort_unless($schedule->status === 'Scheduled', 422, "Only a scheduled maintenance can be marked done. Current: {$schedule->status}.");

        // Once ConvertDueSchedulesToTickets has turned this into a real
        // ticket, THAT ticket is the live repair process — completing the
        // schedule directly here would create a second, disconnected
        // "proof of work" record for the same job. Close the ticket instead.
        abort_if(
            $schedule->resulting_ticket_id,
            422,
            "This schedule became Ticket #{$schedule->resulting_ticket_id} — complete the work there instead of on the schedule directly."
        );

        // A schedule is visible to every mechanic (it's a shared calendar), but
        // only ONE of them should ever be able to act on it — otherwise two
        // people can show up for the same job. Final senior system review
        // (2026-10-05, §2) — Admin no longer gets a blanket override here;
        // only the Maintenance Personnel this schedule is actually assigned
        // to can complete it. Reassigning (schedule.reassign, Admin-only)
        // changes who this check allows immediately, since it reads
        // assigned_to live — that's how Admin hands off a stuck schedule now,
        // instead of completing it themselves.
        abort_unless(
            $schedule->assigned_to && (int) $schedule->assigned_to === (int) $request->user()->id,
            403,
            $schedule->assigned_to
                ? 'This schedule is assigned to another mechanic.'
                : 'This schedule has no assigned mechanic yet — ask an Admin to assign it before marking it done.'
        );

        $data = $request->validate([
            'date_completed'           => ['nullable', 'date', 'before_or_equal:' . now('Asia/Manila')->toDateString()],
            'maintenance_cost'         => ['nullable', 'numeric', 'min:0'],
            'is_external'              => ['nullable', 'boolean'],
            'external_vendor'          => ['nullable', 'string', 'max:255'],
            'warranty_until'           => ['nullable', 'date'],
            'receipt'                  => ['nullable', 'file', 'mimes:jpg,jpeg,png,pdf', 'max:8192'],
            'notes'                    => ['nullable', 'string'],
        ]);

        if ($request->hasFile('receipt')) {
            $data['receipt_url'] = $this->storeUploadedImage($request->file('receipt'), 'maintenance-receipts');
        }
        unset($data['receipt']);

        $completedDate = $data['date_completed'] ?? now()->toDateString();
        // Only the assigned Maintenance Personnel can reach this point now
        // (see the abort_unless above) — they're always the performer, never
        // a stand-in named by someone else.
        $personnelId   = $request->user()->id;

        // A receipt (external shop) or a photo of the finished work
        // (in-house) can still be attached as evidence — it just never
        // substitutes for the independent Custodian verification every
        // maintenance path in this system requires (production-readiness
        // audit, 2026-10-05, P0 — the old "receipt attached = instantly
        // Completed" shortcut was removed here).
        $result = DB::transaction(function () use ($schedule, $data, $request, $completedDate, $personnelId) {
            $vehicle = $schedule->vehicle;

            // 1) The record — proof of the work, in the unified ledger.
            // Always goes to "For Verification", never straight to
            // "Completed" — every maintenance path in this system requires
            // an independent Custodian check before something counts as
            // done, regardless of what evidence is attached.
            $record = VehicleMaintenanceRecord::create([
                'vehicle_id'               => $schedule->vehicle_id,
                'maintenance_type'         => $schedule->maintenance_type,
                // Was a hardcoded identical string on every schedule-derived
                // record ("Scheduled preventive maintenance" x every row) —
                // use the reason this specific schedule was created for, so
                // it actually varies instead of just repeating maintenance_type
                // in sentence form. Falls back to something that at least
                // names the type when the schedule itself had no notes.
                'problem_reason'           => $schedule->notes ?: "Routine {$schedule->maintenance_type} per maintenance schedule #{$schedule->schedule_id}.",
                'date_started'             => $completedDate,
                'date_completed'           => null,
                'maintenance_personnel_id' => $personnelId,
                'is_external'              => !empty($data['is_external']),
                'external_vendor'          => $data['external_vendor'] ?? null,
                'warranty_until'           => $data['warranty_until'] ?? null,
                'receipt_url'              => $data['receipt_url'] ?? null,
                // Completion-time notes only — schedule->notes now belongs to
                // problem_reason above, so it's not duplicated in both columns.
                'action_taken'             => $data['notes'] ?? 'Preventive maintenance performed.',
                'maintenance_cost'         => $data['maintenance_cost'] ?? null,
                'progress_status'          => 'For Verification',
                'remarks'                  => "Completed from schedule #{$schedule->schedule_id} — awaiting Custodian verification.",
            ]);

            // Keep the vehicle's status/condition in lockstep with the
            // record, same as every other maintenance path
            // (storeMaintenanceRecord, verifyMaintenance, confirmMaintenance)
            // — a vehicle with a repair sitting in the Custodian's
            // verification queue should visibly show that, not look untouched.
            \App\Services\VehicleOperationalState::hold($vehicle, 'Needs Inspection');

            // 2) Close the schedule — the CALENDAR task is done regardless of
            // how long the paperwork verification takes; recurrence below
            // still fires on schedule, independent of that. Link to the
            // record it produced so a completed row can show real
            // completion detail and a "View Record" link instead of only
            // ever showing the original scheduled_date.
            $schedule->update(['status' => 'Completed', 'resulting_maintenance_id' => $record->maintenance_id]);

            $this->notifyCustodians(
                'Verification Required: Scheduled Maintenance',
                "{$schedule->maintenance_type} for {$vehicle->vehicle_name} was logged as done — please verify.",
                'maintenance_verification_needed',
                $vehicle->barangay_id
            );

            // 3) If recurring, seed the next one at completed date + interval.
            $next = $schedule->seedNextRecurrence($completedDate, $request->user()->id);

            $this->history($vehicle, 'Preventive Maintenance Completed', "{$schedule->maintenance_type} completed for {$vehicle->vehicle_name}." . ($next ? " Next due {$next->scheduled_date}." : ''), 'vehicle_maintenance_schedules', $schedule->schedule_id, $request);
            $this->log($request, 'Complete', 'Vehicle Maintenance Schedule', $schedule->schedule_id, "Completed schedule #{$schedule->schedule_id}" . ($next ? " (recurring — next #{$next->schedule_id})" : ''));

            return ['record' => $record, 'next' => $next];
        });

        return response()->json([
            'schedule' => $schedule->fresh(['vehicle.category', 'createdBy', 'assignedToUser', 'resultingMaintenance']),
            'record'   => $result['record'],
            'next'     => $result['next']?->load(['vehicle.category', 'createdBy', 'assignedToUser']),
        ]);
    }

    /**
     * VMS-IMPROVEMENT-PLAN.md Phase B5 — a purpose-built reassignment for
     * VehicleMaintenanceSchedule.assigned_to, the one assignment type that
     * previously had no dedicated "hand this off" endpoint at all (only the
     * generic Admin-only updateSchedule() could touch the field). Exists
     * mainly so GuardsOpenWorkOnDeactivation's block on deactivating someone
     * with a Scheduled assignment has somewhere to send the Admin.
     */
    public function reassignSchedule(Request $request, VehicleMaintenanceSchedule $schedule)
    {
        return DB::transaction(function () use ($request, $schedule) {
            $schedule = VehicleMaintenanceSchedule::whereKey($schedule->getKey())->lockForUpdate()->firstOrFail();
            return $this->reassignScheduleLocked($request, $schedule);
        });
    }

    private function reassignScheduleLocked(Request $request, VehicleMaintenanceSchedule $schedule)
    {
        $this->requireAbility($request, 'schedule.reassign');

        abort_unless($schedule->status === 'Scheduled', 422, "Only a Scheduled entry can be reassigned. Current status: {$schedule->status}.");

        $data = $request->validate([
            'assigned_to' => ['required', 'exists:users,id'],
        ]);

        $this->assertSchedulePlanEditable($schedule);
        $this->validateScheduleAssignee($data['assigned_to'], $schedule->vehicle);
        $newAssignee = User::findOrFail($data['assigned_to']);
        abort_if($newAssignee->id === $schedule->assigned_to, 422, 'That person is already assigned to this schedule.');

        $previousAssigneeId = $schedule->assigned_to;

        DB::transaction(function () use ($schedule, $data, $request, $newAssignee, $previousAssigneeId) {
            $schedule->update(['assigned_to' => $data['assigned_to']]);

            $vehicleName = $schedule->vehicle->vehicle_name;
            $this->history($schedule->vehicle, 'Maintenance Schedule Reassigned', "Schedule #{$schedule->schedule_id} ({$schedule->maintenance_type}) reassigned to {$newAssignee->name}.", 'vehicle_maintenance_schedules', $schedule->schedule_id, $request);
            $this->log($request, 'Edit', 'Vehicle Maintenance Schedule', $schedule->schedule_id, "Reassigned schedule #{$schedule->schedule_id} to {$newAssignee->name}");

            $this->notifyUser(
                $newAssignee->id,
                'Maintenance Assigned to You',
                "You've been assigned {$schedule->maintenance_type} for {$vehicleName}, scheduled {$schedule->scheduled_date}.",
                'schedule_assigned',
                ['schedule_id' => $schedule->schedule_id]
            );

            if ($previousAssigneeId) {
                $this->notifyUser(
                    $previousAssigneeId,
                    'Maintenance Reassigned',
                    "{$schedule->maintenance_type} for {$vehicleName} has been reassigned to someone else.",
                    'schedule_reassigned',
                    ['schedule_id' => $schedule->schedule_id]
                );
            }
        });

        return $schedule->fresh(['vehicle.category', 'createdBy', 'assignedToUser']);
    }

    // Schedules carry no barangay scope of their own, but their vehicle does
    // (BelongsToBarangay) — so a schedule whose vehicle isn't visible to this
    // user belongs to another barangay.
    private function abortUnlessOwnBarangaySchedule(VehicleMaintenanceSchedule $schedule): void
    {
        abort_unless($schedule->vehicle()->exists(), 404);
    }

    private function validateScheduleAssignee(?int $id, Vehicle $vehicle): void
    {
        if (!$id) return;
        $person = User::findOrFail($id);
        abort_unless($person->is_active && $person->hasRole('Maintenance Personnel') && $person->barangay_id === $vehicle->barangay_id,
            422, 'Choose active Maintenance Personnel from this barangay.');
    }

    private function assertSchedulePlanEditable(VehicleMaintenanceSchedule $schedule): void
    {
        abort_if($schedule->status === 'Completed' || $schedule->resulting_maintenance_id || $schedule->resulting_ticket_id,
            422, 'This schedule already has recorded work or a maintenance ticket. Manage that record instead; the schedule is locked.');
    }

    public function deleteSchedule(Request $request, VehicleMaintenanceSchedule $schedule)
    {
        return DB::transaction(function () use ($request, $schedule) {
            $schedule = VehicleMaintenanceSchedule::whereKey($schedule->getKey())->lockForUpdate()->firstOrFail();
            return $this->deleteScheduleLocked($request, $schedule);
        });
    }

    private function deleteScheduleLocked(Request $request, VehicleMaintenanceSchedule $schedule)
    {
        // Admin-only — cancelling a plan is a planning decision, same as
        // updateSchedule() above.
        $this->requireAbility($request, 'schedule.delete');
        $this->abortUnlessOwnBarangaySchedule($schedule);
        $this->assertSchedulePlanEditable($schedule);

        $schedule->update(['status' => 'Cancelled']);
        $this->history($schedule->vehicle, 'Maintenance Schedule Cancelled', "Maintenance schedule #{$schedule->schedule_id} was cancelled.", 'vehicle_maintenance_schedules', $schedule->schedule_id, $request);
        $this->log($request, 'Delete', 'Vehicle Maintenance Schedule', $schedule->schedule_id, "Cancelled schedule #{$schedule->schedule_id}");

        return response()->json(['message' => 'Maintenance schedule cancelled.']);
    }

    /**
     * Undo a cancellation — the counterpart to deleteSchedule(), which is a
     * soft cancel rather than a real delete (the row always survives). Mirrors
     * restoreVehicle(): same shape, same dedicated audit wording, so a restore
     * reads as a restore in the logs instead of a generic "edit".
     */
    public function restoreSchedule(Request $request, VehicleMaintenanceSchedule $schedule)
    {
        return DB::transaction(function () use ($request, $schedule) {
            $schedule = VehicleMaintenanceSchedule::whereKey($schedule->getKey())->lockForUpdate()->firstOrFail();
            return $this->restoreScheduleLocked($request, $schedule);
        });
    }

    private function restoreScheduleLocked(Request $request, VehicleMaintenanceSchedule $schedule)
    {
        // Admin-only — same reasoning as deleteSchedule()/updateSchedule().
        $this->requireAbility($request, 'schedule.restore');
        $this->abortUnlessOwnBarangaySchedule($schedule);
        $this->assertSchedulePlanEditable($schedule);

        abort_unless(
            $schedule->status === 'Cancelled',
            422,
            "Only a cancelled schedule can be restored. Current: {$schedule->status}."
        );

        // Same double-booking rule the create/edit paths enforce — a restore is
        // not exempt. Without this, reviving an old cancelled entry could
        // silently produce two active schedules on one vehicle for one date.
        $alreadyBooked = VehicleMaintenanceSchedule::where('vehicle_id', $schedule->vehicle_id)
            ->whereDate('scheduled_date', $schedule->scheduled_date)
            ->where('status', 'Scheduled')
            ->where('schedule_id', '!=', $schedule->schedule_id)
            ->exists();
        abort_if($alreadyBooked, 422, 'This vehicle already has an active schedule on that date — edit the date before restoring this one.');

        $schedule->update(['status' => 'Pending Approval', 'decline_reason' => null]);
        $this->notifyAdmins('Maintenance Schedule Restored for Review', "{$request->user()->name} restored schedule #{$schedule->schedule_id}; approval is required.", 'schedule_proposed', $schedule->vehicle->barangay_id, ['schedule_id' => $schedule->schedule_id]);

        $this->history($schedule->vehicle, 'Maintenance Schedule Restored', "Cancelled maintenance schedule #{$schedule->schedule_id} was restored for Admin approval.", 'vehicle_maintenance_schedules', $schedule->schedule_id, $request);
        $this->log($request, 'Restore', 'Vehicle Maintenance Schedule', $schedule->schedule_id, "Restored cancelled schedule #{$schedule->schedule_id}");

        // The assignee should know it's back on their plate — same reasoning as
        // the assignment notification in storeSchedule/updateSchedule.
        if ($schedule->status === 'Scheduled' && $schedule->assigned_to) {
            $this->notifyUser(
                (int) $schedule->assigned_to,
                'Maintenance Schedule Restored',
                "A cancelled {$schedule->maintenance_type} for {$schedule->vehicle->vehicle_name} ({$schedule->scheduled_date}) was restored and is assigned to you.",
                'schedule_restored',
                ['schedule_id' => $schedule->schedule_id]
            );
        }

        return $schedule->fresh(['vehicle.category', 'createdBy', 'assignedToUser', 'resultingMaintenance']);
    }

    public function histories(Request $request)
    {
        $this->requireAbility($request, 'vehicle.view_history');

        $query = VehicleHistory::with(['vehicle.category', 'updatedBy']);

        $query->when($request->filled('vehicle_id'), fn ($q) => $q->where('vehicle_id', $request->vehicle_id))
            ->when($request->filled('activity_type'), fn ($q) => $q->where('activity_type', $request->activity_type));

        return $query->latest('history_id')->get();
    }

    public function logs(Request $request)
    {
        $this->requireAbility($request, 'activity_log.view');

        $query = ActivityLog::with('user');

        $query->when($request->filled('module'), fn ($q) => $q->where('module', $request->module))
            ->when($request->filled('action'), fn ($q) => $q->where('action', $request->action));

        if ($request->filled('q')) {
            $search = $request->string('q');
            $query->where(function ($nested) use ($search) {
                $nested->where('details', 'like', "%{$search}%")
                    ->orWhere('module', 'like', "%{$search}%")
                    ->orWhereHas('user', fn ($userQuery) => $userQuery->where('name', 'like', "%{$search}%"));
            });
        }

        return $query->latest('log_id')->get();
    }

    public function reports(Request $request)
    {
        $this->requireAbility($request, 'report.generate');

        $data = $request->validate([
            'report_type' => ['required', 'string'],
            'from' => ['nullable', 'date'],
            'to' => ['nullable', 'date'],
            'category_id' => ['nullable', 'exists:vehicle_categories,category_id'],
            'location' => ['nullable', 'string'],
            'maintenance_type' => ['nullable', 'string'],
            'issue_type' => ['nullable', 'string'],
            'severity_level' => ['nullable', 'string'],
        ]);

        $rows = match ($data['report_type']) {
            'Vehicle Type Report' => Vehicle::query()
                ->with('category')
                ->when($request->filled('category_id'), fn ($q) => $q->where('category_id', $data['category_id']))
                ->get(),
            'Vehicle Location Report' => Vehicle::query()
                ->with('category')
                ->when($request->filled('location'), fn ($q) => $q->where('current_location', $data['location']))
                ->get(),
            'Vehicle Issue Report' => VehicleIssueReport::query()
                ->with(['vehicle.category', 'reportedBy'])
                ->when($request->filled('issue_type'), fn ($q) => $q->where('issue_type', $data['issue_type']))
                ->when($request->filled('severity_level'), fn ($q) => $q->where('severity_level', $data['severity_level']))
                ->when($request->filled('from'), fn ($q) => $q->whereDate('created_at', '>=', $data['from']))
                ->when($request->filled('to'), fn ($q) => $q->whereDate('created_at', '<=', $data['to']))
                ->get(),
            // Filtered by when the work actually happened, not when the row
            // was created — those diverge (e.g. a record created at
            // schedule-completion time can reflect older work). Falls back
            // to date_started for a record still in progress with no
            // date_completed yet.
            'Vehicle Maintenance Report' => VehicleMaintenanceRecord::query()
                ->with(['vehicle.category', 'maintenancePersonnel'])
                ->when($request->filled('maintenance_type'), fn ($q) => $q->where('maintenance_type', $data['maintenance_type']))
                ->when($request->filled('from'), fn ($q) => $q->whereDate(DB::raw('COALESCE(date_completed, date_started)'), '>=', $data['from']))
                ->when($request->filled('to'), fn ($q) => $q->whereDate(DB::raw('COALESCE(date_completed, date_started)'), '<=', $data['to']))
                ->get(),
            'Vehicle Maintenance Schedule Report' => VehicleMaintenanceSchedule::query()
                ->with(['vehicle.category', 'createdBy', 'assignedToUser'])
                ->when($request->filled('from'), fn ($q) => $q->whereDate('scheduled_date', '>=', $data['from']))
                ->when($request->filled('to'), fn ($q) => $q->whereDate('scheduled_date', '<=', $data['to']))
                ->get(),
            'Vehicle History Report' => VehicleHistory::with(['vehicle.category', 'updatedBy'])->latest('history_id')->get(),
            default => Vehicle::with('category')->get(),
        };

        $rows->each(function ($row) {
            $warnings = [];
            if ($row instanceof Vehicle && (!preg_match('/^\s*(\d+(?:\.\d+)?)/', $row->capacity, $quantity) || (float) $quantity[1] <= 0)) {
                $warnings[] = 'Invalid capacity: factual correction required';
            }
            if ($row instanceof VehicleMaintenanceRecord) {
                $today = now('Asia/Manila')->toDateString();
                if (($row->date_completed && substr($row->date_completed, 0, 10) > $today)
                    || ($row->date_started && substr($row->date_started, 0, 10) > $today && $row->originatingSchedule()->where('status', 'Completed')->exists())) {
                    $warnings[] = 'Future completed-work date: factual correction required';
                }
            }
            $row->setAttribute('data_quality_warnings', $warnings);
        });

        $this->log($request, 'Generate Report', 'Reports', null, "Generated {$data['report_type']}");

        return response()->json([
            'report_type' => $data['report_type'],
            'generated_by' => $request->user()->name,
            'generated_at' => now(),
            'rows' => $rows,
        ]);
    }

    /**
     * The Add/Edit Vehicle rules, shared with the spreadsheet import so a bulk
     * row is held to exactly what the form enforces. $domain is the chosen
     * Vehicle Type's domain (Land/Water).
     */
    public function vehicleRules(string $domain, ?Vehicle $vehicle = null, ?VehicleCategory $category = null): array
    {
        return VehicleTypeField::rulesFor($category?->fields ?? []) + [
            'vehicle_name' => ['required', 'string', 'max:255'],
            'plate_number' => [
                'required',
                'string',
                'max:10',
                // Shaped after actual PH plate series (LTO private/PUV "ABC 1234",
                // government "SNA 1234", EV "NBV 1234", diplomatic "001 1234",
                // motorcycle "123ABC"/"A 123 BC", temporary "AB 123 C") — 1-3
                // alphanumeric chunks of up to 4 characters, separated by an
                // optional space or dash, containing at least one digit (no real
                // PH plate is letters-only). Not locked to one single format so
                // legitimate variants across series still pass.
                'regex:/^(?=.*\d)[A-Za-z0-9]{1,4}(?:[\s-]?[A-Za-z0-9]{1,4}){1,2}$/',
                Rule::unique('vehicles', 'plate_number')->ignore($vehicle?->vehicle_id, 'vehicle_id'),
            ],
            'vehicle_domain' => ['sometimes', \Illuminate\Validation\Rule::in([$domain])],
            'category_id' => ['required', 'exists:vehicle_categories,category_id'],
            'brand' => ['required', 'string', 'max:255'],
            'model' => ['required', 'string', 'max:255'],
            'year_model' => ['required', new NumberOnly, 'integer', 'min:1900', 'max:' . now()->addYear()->year],
            'capacity' => ['required', 'string', 'max:255', function ($attribute, $value, $fail) {
                if (!preg_match('/^\s*(\d+(?:\.\d+)?)(?:\s*[\p{L}\p{N}\x{00B3}]+)?\s*$/u', $value, $match) || (float) $match[1] <= 0) {
                    $fail('Capacity must be a positive quantity, for example 5 kg or 10 pax.');
                }
            }],
            'acquisition_cost' => ['nullable', 'numeric', 'min:0'],
            'fuel_type' => ['required', 'string', 'max:255'],
            'hull_material' => [$domain === 'Water' ? 'required' : 'nullable', Rule::in(self::HULL_MATERIAL_OPTIONS)],
            'engine_type' => [$domain === 'Water' ? 'required' : 'nullable', 'string', 'max:255'],
            'vehicle_color' => ['required', 'string', 'max:255', new TextOnly],
            'current_location' => ['required', 'string', 'max:255', Rule::in(VehicleHub::pluck('name'))],
            'custodian_id' => ['nullable', 'integer'],
            'estimated_return_date' => ['nullable', 'date'],
            'photo' => ['nullable', 'image', 'max:4096'],
            'remarks' => ['nullable', 'string'],
            // Admin-only override of the Vehicle Type's default (stripped for anyone else).
            'criticality' => ['nullable', Rule::in([...self::CRITICALITY_LEVELS, 'Inherit'])],
        ];
    }

    public function vehicleRuleMessages(): array
    {
        return ['plate_number.regex' => 'Enter a valid plate number, e.g. ABC 1234 or ABC-1234.'];
    }

    private function validateVehicle(Request $request, ?Vehicle $vehicle = null): array
    {
        $category = VehicleCategory::with('fields')->find($request->input('category_id'));

        // Multipart forms post each custom field flat as cf_<key>; fold them
        // into custom_fields so JSON and multipart callers validate alike.
        $custom = (array) $request->input('custom_fields', []);
        foreach ($request->all() as $name => $value) {
            if (str_starts_with($name, 'cf_') && !is_array($value)) {
                // '__clear__' is how the edit form says "remove this value" (empty inputs are never sent).
                $custom[substr($name, 3)] = ($value === '' || $value === '__clear__') ? null : $value;
            }
        }
        $request->merge(['custom_fields' => $custom]);

        $data = $request->validate($this->vehicleRules($category?->domain ?? 'Land', $vehicle, $category), $this->vehicleRuleMessages());

        // A Custodian registering a vehicle is its custodian unless they pick another.
        if (!$vehicle && empty($data['custodian_id']) && $request->user()->hasRole('Custodian')) {
            $data['custodian_id'] = $request->user()->id;
        }
        // User carries no global scope — keep the custodian inside this barangay.
        if (!empty($data['custodian_id']) && !User::whereKey($data['custodian_id'])->where('barangay_id', $request->user()->barangay_id)->havingRole('Custodian')->exists()) {
            throw \Illuminate\Validation\ValidationException::withMessages(['custodian_id' => 'Choose a Custodian from your barangay.']);
        }

        // On edit, keep values for archived fields the form no longer shows.
        if (!$request->user()->hasRole('Admin')) {
            unset($data['criticality']);
        } elseif (($data['criticality'] ?? null) === 'Inherit') {
            $data['criticality'] = null; // back to the Vehicle Type default
        }

        // Merge over existing values, then drop cleared (null) entries.
        $values = array_filter(array_merge($vehicle?->custom_values ?? [], $data['custom_fields'] ?? []), fn ($v) => $v !== null);
        unset($data['custom_fields']);
        $data['custom_values'] = $values ?: null;

        return $data;
    }

    private function storeVehiclePhoto($file): string
    {
        return $this->storeUploadedImage($file, 'vehicles');
    }

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

    private function log(Request $request, string $action, string $module, int|string|null $affectedRecordId, ?string $details): void
    {
        ActivityLog::create([
            'user_id' => $request->user()?->id,
            // The role this action was actually authorized under, when a
            // requireAbility() call ran earlier in this request — falls back
            // to the primary role for endpoints with no ability gate.
            'role' => $request->attributes->get('vms_acted_as_role') ?? $request->user()?->role,
            'action' => $action,
            'module' => $module,
            'affected_record_id' => $affectedRecordId ? (string) $affectedRecordId : null,
            'details' => $details,
        ]);
    }

    // User carries no global scope — every "notify everyone with this role"
    // helper takes the relevant vehicle's barangay_id explicitly so it
    // never floods a different barangay's admins/custodians about
    // something that isn't theirs.
    // Production-readiness audit finding #10 — `$links` carries whichever of
    // ticket_id/issue_report_id/schedule_id this notification is actually
    // about, so clicking it can open that exact record instead of leaving
    // the user wherever they already were.
    private function notifyAdmins(string $title, string $message, string $type, ?int $barangayId, array $links = []): void
    {
        $admins = User::where('barangay_id', $barangayId)->havingRole('Admin')->get();
        foreach ($admins as $admin) {
            \App\Models\Notification::create(array_merge([
                'user_id'   => $admin->id,
                'title'     => $title,
                'message'   => $message,
                'type'      => $type,
                'ticket_id' => null,
            ], $links));
        }
    }

    private function notifyCustodians(string $title, string $message, string $type, ?int $barangayId, array $links = []): void
    {
        $custodians = User::where('barangay_id', $barangayId)->havingRole('Custodian')->get();
        foreach ($custodians as $custodian) {
            \App\Models\Notification::create(array_merge([
                'user_id'   => $custodian->id,
                'title'     => $title,
                'message'   => $message,
                'type'      => $type,
                'ticket_id' => null,
            ], $links));
        }
    }

    private function notifyUser(int $userId, string $title, string $message, string $type, array $links = []): void
    {
        \App\Models\Notification::create(array_merge([
            'user_id'   => $userId,
            'title'     => $title,
            'message'   => $message,
            'type'      => $type,
            'ticket_id' => null,
        ], $links));
    }

    private function syncVehicleStatuses()
    {
        $vehicles = Vehicle::whereNotIn('status', ['Inactive', 'Decommissioned'])->get();
        if ($vehicles->isEmpty()) {
            return;
        }

        // Batch everything up front (3 queries total) instead of 3 queries per
        // vehicle — this runs on every dashboard/vehicle-list request.
        $vehicleIds = $vehicles->pluck('vehicle_id');
        $maintenanceTicketVehicleIds = \App\Models\MaintenanceTicket::whereIn('vehicle_id', $vehicleIds)
            ->whereIn('status', ['Active', 'For Verification'])
            ->pluck('vehicle_id')
            ->flip();
        $activeRecordVehicleIds = VehicleMaintenanceRecord::whereIn('vehicle_id', $vehicleIds)
            ->whereNotIn('progress_status', ['Completed'])
            ->pluck('vehicle_id')
            ->flip();
        $latestIssues = VehicleIssueReport::with('maintenanceTicket:maintenance_tickets.ticket_id,maintenance_tickets.issue_report_id,maintenance_tickets.status')->whereIn('vehicle_id', $vehicleIds)
            ->orderByDesc('issue_report_id')
            ->get()
            ->unique('vehicle_id')
            ->keyBy('vehicle_id');
        $unresolvedIssueVehicleIds = VehicleIssueReport::whereIn('vehicle_id', $vehicleIds)
            ->whereNot('status', 'Resolved')
            ->pluck('vehicle_id')
            ->flip();

        foreach ($vehicles as $vehicle) {
            $hasActiveMaintenance = $activeRecordVehicleIds->has($vehicle->vehicle_id)
                || $maintenanceTicketVehicleIds->has($vehicle->vehicle_id);

            $latestIssue = $latestIssues->get($vehicle->vehicle_id);

            if ($latestIssue) {
                if ($latestIssue->status === 'In Maintenance' && ($hasActiveMaintenance || !$latestIssue->maintenanceTicket)) {
                    if ($vehicle->status !== 'Under Maintenance' || $vehicle->condition !== 'Needs Repair') {
                        $vehicle->update([
                            'status' => 'Under Maintenance',
                            'condition' => 'Needs Repair',
                        ]);
                    }
                } elseif (in_array($latestIssue->status, ['Pending', 'Under Review'], true) || ($latestIssue->status === 'In Maintenance' && $latestIssue->maintenanceTicket)) {
                    if (!$hasActiveMaintenance) {
                        if ($vehicle->status === 'Under Maintenance' || $vehicle->condition !== 'Needs Inspection') {
                            $vehicle->update([
                                'status' => 'Available',
                                'condition' => 'Needs Inspection',
                                'estimated_return_date' => null,
                            ]);
                        }
                    }
                } elseif ($latestIssue->status === 'Resolved') {
                    $hasOtherActiveIssues = $unresolvedIssueVehicleIds->has($vehicle->vehicle_id);

                    if (!$hasOtherActiveIssues && !$hasActiveMaintenance) {
                        if ($vehicle->status === 'Under Maintenance' || $vehicle->condition !== 'Good') {
                            $vehicle->update([
                                'status' => 'Available',
                                'condition' => 'Good',
                                'estimated_return_date' => null,
                            ]);
                        }
                    }
                }
            }
        }
    }
}
