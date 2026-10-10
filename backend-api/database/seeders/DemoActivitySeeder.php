<?php

namespace Database\Seeders;

use App\Models\ActivityLog;
use App\Models\Barangay;
use App\Models\MaintenanceTicket;
use App\Models\TicketArchiveLog;
use App\Models\TicketSubIssue;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleConditionCheck;
use App\Models\VehicleHistory;
use App\Models\VehicleIssueReport;
use App\Models\VehicleMaintenanceRecord;
use App\Models\VehicleMaintenanceSchedule;
use App\Models\VehicleReadinessCheck;
use App\Models\VehicleUsageLog;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Seeder;
use Illuminate\Support\Carbon;

/**
 * Demo data across every module, on top of MockDataSeeder's 15 vehicles:
 * issue reports, tickets in every stage, schedules, maintenance records,
 * usage trips, condition checks, readiness checks, vehicle history and the
 * activity log. Each vehicle's status/condition is set to match its story.
 *
 * Safe to re-run (php artisan db:seed --class=DemoActivitySeeder): rows are
 * matched on natural keys and updated in place, never duplicated. Readiness
 * checks only count as fresh for 24 hours, so re-running also refreshes them.
 * Times are stored in UTC (Philippine time is UTC+8).
 */
class DemoActivitySeeder extends Seeder
{
    private const READINESS_NOTE = 'Demo data — daily pre-shift check.';

    private int $barangayId;
    private User $admin;
    private User $custodian;
    private User $custodian2;
    private User $mechanic;

    public function run(): void
    {
        $barangayId = Barangay::where('name', 'Paknaan')->value('id');
        $admin = User::where('email', 'admin@barangay.gov')->first();
        $custodian = User::where('email', 'custodian@barangay.gov')->first();
        $custodian2 = User::where('email', 'custodian2@barangay.gov')->first() ?? $custodian;
        $mechanic = User::where('email', 'maintenance@barangay.gov')->first();

        if (!$barangayId || !$admin || !$custodian || !$mechanic) {
            $this->command?->error('Run UserSeeder and MockDataSeeder first.');
            return;
        }

        [$this->barangayId, $this->admin, $this->custodian, $this->custodian2, $this->mechanic]
            = [$barangayId, $admin, $custodian, $custodian2, $mechanic];

        $v = Vehicle::withoutGlobalScopes()->with('category')
            ->where('barangay_id', $barangayId)
            ->get()
            ->keyBy('vehicle_name');

        if ($v->count() < 15) {
            $this->command?->error('MockDataSeeder vehicles are missing — run it first.');
            return;
        }

        $this->seedTickets($v);
        $this->seedStandaloneIssues($v);
        $this->seedSchedules($v);
        $this->seedMaintenanceHistory($v);
        $this->seedUsageLogs($v);

        // Last, so they read the vehicle conditions set above.
        $operational = Vehicle::withoutGlobalScopes()->with('category')
            ->where('barangay_id', $barangayId)
            ->whereNotIn('status', ['Inactive', 'Decommissioned'])
            ->orderBy('vehicle_id')
            ->get();
        foreach ($operational as $i => $vehicle) {
            $this->seedConditionChecks($vehicle, $i);
            $this->seedReadinessCheck($vehicle, $i);
        }

        $this->command?->info('Demo data seeded: tickets, issues, schedules, records, trips, condition and readiness checks.');
    }

    // ---------------------------------------------------------------------
    // Tickets — one in every stage of the workflow
    // ---------------------------------------------------------------------

    private function seedTickets($v): void
    {
        $now = now();

        // Pending Approval — Custodian proposal from an issue report.
        $veh = $v['Barangay Fire Responder'];
        $this->setVehicle($veh, 'Available', 'Needs Inspection');
        $issue = $this->issue($veh, 'Water pump losing pressure', 'Pump pressure drops from 150 to about 90 psi after five minutes of continuous use.', 'High', $this->custodian, 'In Maintenance', $now->copy()->subDays(2));
        $t = $this->ticket($veh, $issue, 'Pump loses pressure under sustained use — needs inspection and repair before the next fire response.', 'High', 'Pending Approval', $now->copy()->subDays(1), [
            'created_by' => $this->custodian->id,
        ]);
        $this->subIssue($t, 'Water pump losing pressure', 'Engine Repair', 'Open', $now->copy()->subDays(1), ['suggested_mechanic_id' => $this->mechanic->id]);
        $this->history($veh, 'Issue Reported', 'Water pump losing pressure reported (High).', 'vehicle_issue_reports', $issue->issue_report_id, $this->custodian, $issue->created_at);
        $this->activity($this->custodian, 'Propose Ticket', $t->ticket_id, "Ticket proposal \"{$t->ticket_title}\" submitted for Admin review.", $t->created_at);

        // Declined — proposal turned down; its issue goes back to Pending.
        $veh = $v['Ladder Company 28'];
        $this->setVehicle($veh, 'Available', 'Needs Inspection');
        $issue = $this->issue($veh, 'Aerial ladder slow to extend', 'Ladder takes noticeably longer to extend fully during the weekly drill.', 'Medium', $this->custodian2, 'Pending', $now->copy()->subDays(5));
        $t = $this->ticket($veh, $issue, 'Aerial ladder hydraulics slow — request full hydraulic overhaul.', 'Medium', 'Declined', $now->copy()->subDays(4), [
            'created_by' => $this->custodian2->id,
            'decline_reason' => 'Hydraulic fluid was topped up during the last PMS. Book a schedule to re-test first; propose again if it is still slow.',
        ]);
        $this->subIssue($t, 'Aerial ladder hydraulics slow', 'Preventive Maintenance', 'Open', $now->copy()->subDays(4));
        $this->activity($this->admin, 'Decline Ticket', $t->ticket_id, "Ticket #{$t->ticket_id} proposal declined.", $now->copy()->subDays(3));

        // Active — one repair logged, one still in progress.
        $veh = $v['Highway Rescue Engine'];
        $this->setVehicle($veh, 'Under Maintenance', 'Needs Repair');
        $issue = $this->issue($veh, 'Overheating on long runs', 'Temperature gauge climbs past the red line after about 20 minutes of driving.', 'High', $this->custodian, 'In Maintenance', $now->copy()->subDays(4));
        $t = $this->ticket($veh, $issue, 'Engine overheats on long runs — cooling system and fan belt need repair.', 'High', 'Active', $now->copy()->subDays(4), [
            'created_by' => $this->custodian->id,
            'assigned_mechanic_id' => $this->mechanic->id,
            'assigned_at' => $now->copy()->subDays(3),
            'down_since' => $now->copy()->subDays(3),
        ]);
        $this->subIssue($t, 'Radiator leaking coolant', 'Engine Repair', 'For Inspection', $now->copy()->subDays(4), $this->logged($now->copy()->subDays(2), 'Replaced cracked radiator hose and flushed the cooling system.', 'Radiator hose, Coolant 6L', 2850));
        $this->subIssue($t, 'Worn fan belt', 'Engine Repair', 'Under Repair', $now->copy()->subDays(4), [
            'assigned_mechanic_id' => $this->mechanic->id,
            'mechanic_assigned_at' => $now->copy()->subDays(3),
            'mechanic_assigned_by' => $this->admin->id,
            'repair_started_at' => $now->copy()->subDays(1)->toDateString(),
        ]);
        $this->history($veh, 'Ticket Approved', "Ticket #{$t->ticket_id} approved and assigned to {$this->mechanic->name}.", 'maintenance_tickets', $t->ticket_id, $this->admin, $now->copy()->subDays(3));
        $this->activity($this->admin, 'Approve Ticket', $t->ticket_id, "Ticket #{$t->ticket_id} approved and assigned to {$this->mechanic->name}.", $now->copy()->subDays(3));

        // For Verification — every repair logged, waiting on the Custodian.
        $veh = $v['Aerial Ladder Unit'];
        $this->setVehicle($veh, 'Under Maintenance', 'Needs Repair');
        $issue = $this->issue($veh, 'Warning lights and siren failing', 'Light bar flickers and the siren cuts out intermittently.', 'Medium', $this->custodian, 'In Maintenance', $now->copy()->subDays(7));
        $t = $this->ticket($veh, $issue, 'Emergency light bar and siren fail intermittently — electrical fault.', 'Medium', 'For Verification', $now->copy()->subDays(7), [
            'created_by' => $this->custodian->id,
            'assigned_mechanic_id' => $this->mechanic->id,
            'assigned_at' => $now->copy()->subDays(6),
            'down_since' => $now->copy()->subDays(6),
        ]);
        $this->subIssue($t, 'Light bar flickering', 'Electrical Repair', 'For Inspection', $now->copy()->subDays(7), $this->logged($now->copy()->subDays(1), 'Replaced corroded light bar connector and re-sealed the harness.', 'Waterproof connector, Heat-shrink tubing', 1200));
        $this->subIssue($t, 'Siren cutting out', 'Electrical Repair', 'For Inspection', $now->copy()->subDays(7), $this->logged($now->copy()->subDays(1), 'Siren amplifier fuse holder was loose — replaced holder and fuse, tested for 10 minutes.', 'Fuse holder, 20A fuse', 450));
        $this->activity($this->mechanic, 'Submitted for Verification', $t->ticket_id, "Ticket #{$t->ticket_id} — every repair logged; sent to the Custodian for verification.", $now->copy()->subDays(1));

        // Closed — Custodian verified, archived, written to the ledger.
        $veh = $v['London Brigade Pumper'];
        $this->setVehicle($veh, 'Available', 'Good');
        $issue = $this->issue($veh, 'Brakes squealing', 'Loud squeal when braking at low speed.', 'Medium', $this->custodian, 'Resolved', $now->copy()->subDays(14));
        $closedAt = $now->copy()->subDays(9);
        $t = $this->ticket($veh, $issue, 'Brake pads worn — replace pads and inspect rotors.', 'Medium', 'Closed', $now->copy()->subDays(14), [
            'created_by' => $this->custodian->id,
            'assigned_mechanic_id' => $this->mechanic->id,
            'assigned_at' => $now->copy()->subDays(13),
            'closed_by' => $this->custodian->id,
            'closed_at' => $closedAt,
            'archived_at' => $closedAt,
            'returned_to_service' => true,
        ]);
        $test = [
            ['item' => 'Engine / power system starts normally', 'passed' => true],
            ['item' => 'No warning indicators or abnormal noise', 'passed' => true],
            ['item' => 'The reported problem no longer occurs', 'passed' => true],
            ['item' => 'Brakes respond properly', 'passed' => true],
            ['item' => 'Completed a short test drive', 'passed' => true],
        ];
        $sub = $this->subIssue($t, 'Worn front brake pads', 'Brake Repair', 'Done', $now->copy()->subDays(14), $this->logged($now->copy()->subDays(10), 'Replaced front brake pads, resurfaced rotors, bled the brake lines.', 'Brake pads (front set), Brake fluid DOT4 1L', 4200) + [
            'verification_verdict' => 'Approved',
            'verification_notes' => 'Test drive around the barangay — no squeal, firm pedal.',
            'verified_by' => $this->custodian->id,
            'verified_at' => $closedAt,
            'functional_test' => $test,
            'test_attested' => true,
        ]);
        TicketArchiveLog::updateOrCreate(['ticket_id' => $t->ticket_id], [
            'vehicle_id' => $veh->vehicle_id,
            'ticket_title' => $t->ticket_title,
            'vehicle_name' => $veh->vehicle_name,
            'plate_number' => $veh->plate_number,
            'final_status' => 'Closed',
            'maintenance_cost' => 4200,
            'full_ticket_snapshot' => json_encode($t->load('subIssues')->toArray()),
            'archived_by' => $this->custodian->id,
            'archived_at' => $closedAt,
        ]);
        $this->record($veh, 'Brake Repair', 'Worn front brake pads', 'Replaced front brake pads, resurfaced rotors, bled the brake lines.', 'Brake pads (front set), Brake fluid DOT4 1L', 4200, 'Completed', $now->copy()->subDays(11), $closedAt, ['issue_report_id' => $issue->issue_report_id, 'verification_result' => 'Passed', 'verified_by' => $this->custodian->id, 'verified_at' => $closedAt]);
        $this->history($veh, 'Ticket Closed', "Ticket #{$t->ticket_id} verified by Custodian and closed.", 'maintenance_tickets', $t->ticket_id, $this->custodian, $closedAt);
        $this->activity($this->custodian, 'Ticket Verified & Closed', $t->ticket_id, "Ticket #{$t->ticket_id} ({$t->ticket_title}) verified by Custodian and closed.", $closedAt);

        // Cancelled.
        $veh = $v['Engine 23'];
        $this->setVehicle($veh, 'Available', 'Good');
        $t = $this->ticket($veh, null, 'Replace cracked side mirror — turned out to be a loose mount, tightened on site.', 'Low', 'Cancelled', $now->copy()->subDays(20), [
            'created_by' => $this->custodian2->id,
            'assigned_mechanic_id' => $this->mechanic->id,
            'assigned_at' => $now->copy()->subDays(19),
        ], 'Side mirror loose');
        $this->subIssue($t, 'Side mirror loose', 'Body Repair', 'Under Repair', $now->copy()->subDays(20), ['assigned_mechanic_id' => $this->mechanic->id]);
        $this->activity($this->admin, 'Cancel Ticket', $t->ticket_id, "Ticket #{$t->ticket_id} cancelled — fixed on site, no repair needed.", $now->copy()->subDays(18));

        // Active, external — sent to an outside shop.
        $veh = $v['Desert Rose EMS'];
        $this->setVehicle($veh, 'Under Maintenance', 'Needs Repair');
        $issue = $this->issue($veh, 'Transmission slipping', 'Gears slip when climbing and the engine revs without accelerating.', 'High', $this->mechanic, 'In Maintenance', $now->copy()->subDays(6));
        $t = $this->ticket($veh, $issue, 'Automatic transmission slipping — needs shop equipment, sent to the dealer.', 'High', 'Active', $now->copy()->subDays(6), [
            'created_by' => $this->custodian->id,
            'assigned_mechanic_id' => $this->mechanic->id,
            'assigned_at' => $now->copy()->subDays(5),
            'down_since' => $now->copy()->subDays(5),
        ]);
        $this->subIssue($t, 'Transmission slipping', 'Engine Repair', 'Under Repair', $now->copy()->subDays(6), [
            'assigned_mechanic_id' => $this->mechanic->id,
            'mechanic_assigned_at' => $now->copy()->subDays(5),
            'mechanic_assigned_by' => $this->admin->id,
            'repair_type' => 'external',
            'external_reason' => 'Needs specialized shop equipment',
            'external_work_scope' => 'Diagnose and rebuild automatic transmission valve body.',
            'external_vendor' => 'Toyota Mandaue Service Center',
            'external_shop_contact' => '(032) 345-6789',
            'external_estimated_cost' => 28000,
            'external_sent_by' => $this->mechanic->name,
            'external_contact_person' => 'Service Advisor Ramon Cruz',
            'external_sent_at' => $now->copy()->subDays(4),
        ]);
        $this->history($veh, 'Sent to External Shop', 'Sent to Toyota Mandaue Service Center for transmission repair.', 'maintenance_tickets', $t->ticket_id, $this->mechanic, $now->copy()->subDays(4));
    }

    private function seedStandaloneIssues($v): void
    {
        $now = now();

        $veh = $v['QuickCare Ambulance'];
        $this->setVehicle($veh, 'Available', 'Needs Inspection');
        $i = $this->issue($veh, 'Rear door latch sticking', 'Rear patient door needs two tries to latch closed.', 'Low', $this->mechanic, 'Under Review', $now->copy()->subDays(1));
        $this->history($veh, 'Issue Reported', 'Rear door latch sticking reported (Low).', 'vehicle_issue_reports', $i->issue_report_id, $this->mechanic, $i->created_at);

        $veh = $v['Noida Express Ambulance'];
        $this->setVehicle($veh, 'Available', 'Needs Inspection');
        $i = $this->issue($veh, 'Siren intermittent', 'Siren stops for a second or two at a time during runs.', 'High', $this->custodian2, 'Pending', $now->copy()->subHours(5));
        $this->history($veh, 'Issue Reported', 'Siren intermittent reported (High).', 'vehicle_issue_reports', $i->issue_report_id, $this->custodian2, $i->created_at);
    }

    // ---------------------------------------------------------------------
    // Schedules, maintenance records, usage trips
    // ---------------------------------------------------------------------

    private function seedSchedules($v): void
    {
        $now = now();

        $this->schedule($v['Autumn Response Pumper'], 'Preventive Maintenance', $now->copy()->addDays(5), '08:00:00', 'Paknaan Brgy Hall', 'Pending Approval', $this->custodian, null, 'Quarterly PMS: oil, filters, pump service.', 3);
        $this->schedule($v['Firehouse Engine 15'], 'General Inspection', $now->copy()->addDays(2), '10:00:00', 'Paknaan Gymnasium', 'Declined', $this->custodian2, null, 'Pre-fiesta inspection.', null, ['decline_reason' => 'Already covered by the fleet-wide inspection on the 20th.']);
        $this->schedule($v['Noida Express Ambulance'], 'Oil Change', $now->copy()->subDays(3), '09:00:00', 'Twinbee Hub', 'Scheduled', $this->custodian, $this->mechanic, 'Overdue — 5,000 km oil change.', null);
        $this->schedule($v['INEM Portuguese Ambulance'], 'Preventive Maintenance', $now->copy()->addDays(12), '09:30:00', 'Twinbee Hub', 'Scheduled', $this->custodian, $this->mechanic, 'Monthly PMS for the front-line ambulance.', 1);
        $this->schedule($v['Desert Rose EMS'], 'Tire Replacement', $now->copy()->addDays(9), '13:00:00', 'Twinbee Hub', 'Cancelled', $this->custodian2, $this->mechanic, 'Cancelled — vehicle is at the dealer for transmission work.', null);

        $veh = $v['QuickCare Ambulance'];
        $record = $this->record($veh, 'Battery Replacement', 'Scheduled battery replacement (2 years old).', 'Replaced 12V battery and cleaned terminals.', '12V battery (NS70)', 6500, 'For Verification', $now->copy()->subDays(6), $now->copy()->subDays(6));
        $this->schedule($veh, 'Battery Replacement', $now->copy()->subDays(6), '08:30:00', 'Twinbee Hub', 'Completed', $this->custodian, $this->mechanic, 'Battery is two years old — replace before rainy season.', 24, ['resulting_maintenance_id' => $record->maintenance_id]);

        // A second and third mechanic with their own scheduled work, so the
        // mechanic pickers (which show each person's workload) have a real
        // spread to compare: Jake 2, Rohan 3, Mia 1 scheduled jobs.
        $rohan = User::where('email', 'maintenance2@barangay.gov')->first();
        $mia = User::where('email', 'maintenance3@barangay.gov')->first();
        if ($rohan && $mia) {
            $this->schedule($v['Engine 23'], 'Oil Change', $now->copy()->addDays(1), '08:00:00', 'Paknaan Brgy Hall', 'Scheduled', $this->custodian, $rohan, 'Demo workload — 5,000 km oil change.', null);
            $this->schedule($v['Metro EMS Ambulance'], 'Brake Service', $now->copy()->addDays(3), '10:00:00', 'Twinbee Hub', 'Scheduled', $this->custodian2, $rohan, 'Demo workload — brake pad check and fluid top-up.', null);
            $this->schedule($v['Firehouse Engine 15'], 'Preventive Maintenance', $now->copy()->addDays(6), '09:00:00', 'Paknaan Gymnasium', 'Scheduled', $this->custodian, $rohan, 'Demo workload — pump and hose inspection.', 3);
            $this->schedule($v['Engine 23'], 'Tire Replacement', $now->copy()->addDays(8), '13:30:00', 'Paknaan Brgy Hall', 'Scheduled', $this->custodian2, $mia, 'Demo workload — rotate and replace front tires.', null);
        }
    }

    private function seedMaintenanceHistory($v): void
    {
        $now = now();
        $done = ['verification_result' => 'Passed', 'verified_by' => $this->custodian->id];

        $this->record($v['Barangay Fire Responder'], 'Battery Replacement', 'Slow cranking on cold mornings.', 'Replaced battery and tested the alternator output.', '12V battery (N100)', 7800, 'Completed', $now->copy()->subDays(41), $now->copy()->subDays(40), $done + ['verified_at' => $now->copy()->subDays(40)]);
        $this->record($v['Firehouse Engine 15'], 'Oil Change', 'Scheduled 5,000 km oil change.', 'Changed engine oil and oil filter.', 'Engine oil 15W-40 (8L), Oil filter', 3100, 'Completed', $now->copy()->subDays(25), $now->copy()->subDays(25), $done + ['verified_at' => $now->copy()->subDays(24)]);
        $this->record($v['Engine 23'], 'Tire Replacement', 'Rear tires worn past the tread limit.', 'Replaced both rear tires and balanced the wheels.', 'Tires 11R22.5 x2', 24000, 'Completed', $now->copy()->subDays(61), $now->copy()->subDays(60), $done + ['verified_at' => $now->copy()->subDays(59)]);
        $this->record($v['Metro EMS Ambulance'], 'General Inspection', 'Quarterly inspection.', 'Full inspection — no defects found.', null, 1500, 'Completed', $now->copy()->subDays(30), $now->copy()->subDays(30), $done + ['verified_at' => $now->copy()->subDays(29)]);
    }

    private function seedUsageLogs($v): void
    {
        $now = now();
        $trips = [
            ['Metro EMS Ambulance', 'Patient transport', 'Mandaue City Hospital', 'Juan Dela Cruz', 2, 3, 41250, 41268],
            ['Metro EMS Ambulance', 'Medical standby', 'Paknaan Elementary School sports fest', 'Juan Dela Cruz', 5, 8, 41200, 41212],
            ['INEM Portuguese Ambulance', 'Patient transport', 'Vicente Sotto Memorial Medical Center', 'Mark Santos', 1, 2, 28870, 28901],
            ['Rescue Response Ambulance', 'Emergency response', 'Brgy. Paknaan Purok 3', 'Mark Santos', 3, 4, 15340, 15349],
            ['Barangay Fire Responder', 'Fire response', 'Purok 5 residential fire', 'Rey Villanueva', 4, 6, 9810, 9822],
            ['Noida Express Ambulance', 'Patient transport', 'Chong Hua Hospital Mandaue', 'Juan Dela Cruz', 6, 7, 52010, 52036],
        ];
        foreach ($trips as [$name, $purpose, $dest, $driver, $daysAgo, $hours, $odoStart, $odoEnd]) {
            $start = $now->copy()->subDays($daysAgo)->setTime(1 + $hours, 0);
            VehicleUsageLog::updateOrCreate(
                ['vehicle_id' => $v[$name]->vehicle_id, 'started_at' => $start],
                ['logged_by' => $this->custodian->id, 'purpose' => $purpose, 'destination' => $dest, 'driver_name' => $driver,
                 'ended_at' => $start->copy()->addHours(2), 'odometer_start' => $odoStart, 'odometer_end' => $odoEnd],
            );
        }

        // One vehicle out right now.
        $veh = $v['Metro EMS Ambulance'];
        $start = $now->copy()->subMinutes(40)->startOfMinute();
        VehicleUsageLog::where('vehicle_id', $veh->vehicle_id)->whereNull('ended_at')->where('notes', 'Demo data')->delete();
        VehicleUsageLog::create(['vehicle_id' => $veh->vehicle_id, 'logged_by' => $this->custodian->id, 'purpose' => 'Patient transport',
            'destination' => 'Mandaue City Hospital', 'driver_name' => 'Juan Dela Cruz', 'started_at' => $start, 'odometer_start' => 41268, 'notes' => 'Demo data']);
    }

    // ---------------------------------------------------------------------
    // Condition monitoring and readiness
    // ---------------------------------------------------------------------

    // An older routine check (always Good) plus a latest check that agrees
    // with the vehicle's current condition.
    private function seedConditionChecks(Vehicle $vehicle, int $i): void
    {
        $type = strtolower($vehicle->category?->category_name ?? '');
        $checkedBy = $i % 2 === 0 ? $this->custodian->id : $this->custodian2->id;

        $routine = str_contains($type, 'fire')
            ? 'Weekly check: pump primes, hoses and nozzles intact, water tank full, lights and siren working.'
            : (str_contains($type, 'ambulance')
                ? 'Weekly check: oxygen tanks full, stretcher locks secure, lights and siren working, tires at pressure.'
                : 'Weekly check: engine starts clean, no warning lights, tires and fluids OK.');

        $latest = match ($vehicle->condition) {
            'Needs Repair' => ['Needs Repair', str_contains($type, 'fire')
                ? 'Taken off the response roster — open repair ticket in progress.'
                : 'Not safe for response runs until the open repair is finished.'],
            'Needs Inspection' => ['Needs Inspection', 'Reported problem confirmed on walk-around — needs a mechanic to look at it.'],
            default => ['Good', 'Walk-around done: body, lights, tires and fluids all fine. Ready for duty.'],
        };

        // Drop any "latest" note this seeder wrote before that no longer fits
        // the vehicle (including wording from older versions of this seeder).
        VehicleConditionCheck::where('vehicle_id', $vehicle->vehicle_id)
            ->whereIn('observations', [
                'Taken off the response roster — open repair ticket in progress.',
                'Not safe for response runs until the open repair is finished.',
                'Reported problem confirmed on walk-around — needs a mechanic to look at it.',
                'Walk-around done: body, lights, tires and fluids all fine. Ready for duty.',
                'Pump loses pressure after a few minutes of use; not safe for a fire response.',
                'Brake pedal feels soft and stopping distance is long; keep off response runs until repaired.',
                'Slight vibration above 60 km/h and a faint grinding sound on turns — needs a mechanic to look at it.',
            ])
            ->where('observations', '!=', $latest[1])
            ->delete();

        // 00:15 / 00:30 UTC = morning checks in the Philippines.
        $this->upsertCondition($vehicle->vehicle_id, 'Good', $routine, $checkedBy, now()->subDays(9 + ($i % 4))->setTime(0, 30));
        $this->upsertCondition($vehicle->vehicle_id, $latest[0], $latest[1], $checkedBy, now()->subDays(1 + ($i % 3))->setTime(0, 15));
    }

    private function upsertCondition(int $vehicleId, string $result, string $observations, int $checkedBy, Carbon $at): void
    {
        $check = VehicleConditionCheck::updateOrCreate(
            ['vehicle_id' => $vehicleId, 'observations' => $observations],
            ['condition_result' => $result, 'checked_by' => $checkedBy],
        );
        $this->stamp($check, $at);
    }

    private function seedReadinessCheck(Vehicle $vehicle, int $i): void
    {
        VehicleReadinessCheck::updateOrCreate(
            ['vehicle_id' => $vehicle->vehicle_id, 'notes' => self::READINESS_NOTE],
            [
                'checked_by' => $i % 2 === 0 ? $this->custodian->id : $this->custodian2->id,
                'checklist' => [['item' => 'Personally operated and confirmed ready to respond', 'passed' => true]],
                'all_passed' => true,
                'checked_at' => now()->subHours(1 + ($i % 8)),
            ],
        );
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    private function setVehicle(Vehicle $vehicle, string $status, string $condition): void
    {
        $vehicle->forceFill([
            'status' => $status,
            'condition' => $condition,
            'estimated_return_date' => $status === 'Under Maintenance' ? now()->addDays(3)->toDateString() : null,
        ])->save();
    }

    private function issue(Vehicle $vehicle, string $type, string $description, string $severity, User $by, string $status, Carbon $at): VehicleIssueReport
    {
        $issue = VehicleIssueReport::updateOrCreate(
            ['vehicle_id' => $vehicle->vehicle_id, 'issue_type' => $type],
            ['issue_description' => $description, 'severity_level' => $severity, 'reported_by' => $by->id, 'status' => $status],
        );
        return $this->stamp($issue, $at);
    }

    private function ticket(Vehicle $vehicle, ?VehicleIssueReport $issue, string $description, string $priority, string $status, Carbon $at, array $extra, ?string $summary = null): MaintenanceTicket
    {
        $ticket = MaintenanceTicket::updateOrCreate(
            ['vehicle_id' => $vehicle->vehicle_id, 'ticket_description' => $description],
            $extra + [
                'issue_report_id' => $issue?->issue_report_id,
                'ticket_title' => 'pending',
                'priority' => $priority,
                'status' => $status,
                'assigned_custodian_id' => $extra['created_by'] ?? $this->custodian->id,
            ],
        );
        // Same title format the app composes: MT-0010 — Vehicle — Issue.
        $summary ??= $issue?->issue_type ?? 'Repair';
        $ticket->forceFill(['ticket_title' => sprintf('MT-%04d — %s — %s', $ticket->ticket_id, $vehicle->vehicle_name, $summary)])->save();
        return $this->stamp($ticket, $at);
    }

    private function subIssue(MaintenanceTicket $ticket, string $title, string $type, string $status, Carbon $at, array $extra = []): TicketSubIssue
    {
        $sub = TicketSubIssue::updateOrCreate(
            ['ticket_id' => $ticket->ticket_id, 'title' => $title],
            $extra + ['created_by' => $ticket->created_by, 'maintenance_type' => $type, 'status' => $status, 'issue_report_id' => $ticket->issue_report_id],
        );
        return $this->stamp($sub, $at);
    }

    // Fields a logged repair carries.
    private function logged(Carbon $at, string $log, string $parts, float $cost): array
    {
        return [
            'assigned_mechanic_id' => $this->mechanic->id,
            'mechanic_assigned_at' => $at->copy()->subDay(),
            'mechanic_assigned_by' => $this->admin->id,
            'repair_logs' => '[' . $at->format('Y-m-d H:i') . "] {$log}",
            'parts_used' => $parts,
            'repair_started_at' => $at->copy()->subDay()->toDateString(),
            'repair_completed_at' => $at->toDateString(),
            'maintenance_cost' => $cost,
        ];
    }

    private function schedule(Vehicle $vehicle, string $type, Carbon $date, string $time, string $location, string $status, User $by, ?User $assignee, string $notes, ?int $recurrenceMonths, array $extra = []): VehicleMaintenanceSchedule
    {
        $schedule = VehicleMaintenanceSchedule::updateOrCreate(
            ['vehicle_id' => $vehicle->vehicle_id, 'maintenance_type' => $type, 'notes' => $notes],
            $extra + [
                'scheduled_date' => $date->toDateString(),
                'scheduled_time' => $time,
                'service_location' => $location,
                'status' => $status,
                'created_by' => $by->id,
                'assigned_to' => $assignee?->id,
                'recurrence_months' => $recurrenceMonths,
            ],
        );
        return $this->stamp($schedule, $date->copy()->subDays(7)->min(now()));
    }

    private function record(Vehicle $vehicle, string $type, string $problem, string $action, ?string $parts, float $cost, string $progress, Carbon $started, Carbon $completed, array $extra = []): VehicleMaintenanceRecord
    {
        $record = VehicleMaintenanceRecord::updateOrCreate(
            ['vehicle_id' => $vehicle->vehicle_id, 'maintenance_type' => $type, 'problem_reason' => $problem],
            $extra + [
                'action_taken' => $action,
                'parts_used' => $parts,
                'maintenance_cost' => $cost,
                'maintenance_personnel_id' => $this->mechanic->id,
                'progress_status' => $progress,
                'date_started' => $started->toDateString(),
                'date_completed' => $completed->toDateString(),
            ],
        );
        return $this->stamp($record, $completed);
    }

    private function history(Vehicle $vehicle, string $type, string $description, string $table, int $recordId, User $by, Carbon $at): void
    {
        $row = VehicleHistory::updateOrCreate(
            ['vehicle_id' => $vehicle->vehicle_id, 'activity_type' => $type, 'related_table' => $table, 'related_record_id' => (string) $recordId],
            ['description' => $description, 'updated_by' => $by->id],
        );
        $this->stamp($row, $at);
    }

    private function activity(User $user, string $action, int $ticketId, string $details, Carbon $at): void
    {
        $row = ActivityLog::withoutGlobalScopes()->updateOrCreate(
            ['module' => 'Maintenance Tickets', 'action' => $action, 'affected_record_id' => (string) $ticketId],
            ['user_id' => $user->id, 'role' => $user->role, 'details' => $details, 'barangay_id' => $this->barangayId],
        );
        $this->stamp($row, $at);
    }

    private function stamp(Model $model, Carbon $at): Model
    {
        $model->timestamps = false;
        $model->forceFill(['created_at' => $at, 'updated_at' => $at])->save();
        $model->timestamps = true;
        return $model;
    }
}
