<?php

namespace Tests\Feature;

use App\Models\MaintenanceTicket;
use App\Models\TicketArchiveLog;
use App\Models\TicketSubIssue;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use App\Models\VehicleConditionCheck;
use App\Models\VehicleIssueReport;
use App\Models\VehicleMaintenanceRecord;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * WORKFLOW GUARD TESTS — streamlined ticket workflow (2026-10-12).
 *
 * A ticket is now one job: ONE assigned mechanic for every sub-issue on it,
 * and ONE plain verification by the assigned Custodian that closes the
 * whole ticket at once. There is no more per-sub-issue mechanic dispatch,
 * no per-sub-issue verify/confirm, and no Admin "close" step — a ticket
 * reaches Active only via a Custodian's proposal that an Admin approves
 * (which also dispatches the one mechanic), and it reaches Closed only via
 * the assigned Custodian's single attestation (TicketController::
 * verifyTicket()), which finalizes every sub-issue in the same transaction.
 *
 * These tests prove: who may act at each step (propose -> approve ->
 * log repairs -> submit for verification -> verify), that the old
 * per-sub-issue lifecycle endpoints (assign/reassign mechanic, verify,
 * confirm, defer, close) are now permanently unreachable by anyone, that
 * self-verification is blocked at the ticket level (including across a
 * mechanic reassignment), and that a vehicle only returns to service once
 * none of its tickets are still open.
 */
class TicketWorkflowTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;
    private User $custodian;
    private User $mechanic;
    private User $mechanic2;

    protected function setUp(): void
    {
        parent::setUp();
        $this->admin = User::factory()->create(['role' => 'Admin']);
        $this->custodian = User::factory()->create(['role' => 'Custodian']);
        $this->mechanic = User::factory()->create(['role' => 'Maintenance Personnel']);
        $this->mechanic2 = User::factory()->create(['role' => 'Maintenance Personnel']);
    }

    private function vehicle(array $overrides = []): Vehicle
    {
        $category = VehicleCategory::create([
            'category_name' => 'Ambulance ' . uniqid(),
            'description' => 'For testing',
        ]);

        return Vehicle::create(array_merge([
            'vehicle_name' => 'Test Ambulance',
            'plate_number' => 'TST ' . random_int(1000, 9999),
            'category_id' => $category->category_id,
            'brand' => 'Toyota',
            'model' => 'HiAce',
            'year_model' => 2022,
            'capacity' => '1000 kg',
            'vehicle_color' => 'White',
            'current_location' => 'Main Depot',
        ], $overrides));
    }

    /**
     * Pure test scaffolding — builds an Open ticket directly (bypassing
     * HTTP) exactly like the old createTicket() endpoint's default
     * 'inspection' entry mode used to. That endpoint is gated by
     * ticket.create, which no role holds any more (nobody can create a
     * ticket directly; only propose+approve), so tests that just need "a
     * ticket exists, never touched" build one straight via the model
     * instead of depending on a permission this suite is itself proving
     * is gone.
     */
    private function createTicket(Vehicle $vehicle, string $title = 'Overheating'): MaintenanceTicket
    {
        return MaintenanceTicket::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'created_by' => $this->admin->id,
            'ticket_title' => $title,
            'ticket_description' => 'Engine runs hot after 10 minutes.',
            'priority' => 'High',
            'status' => 'Open',
            'assigned_custodian_id' => $this->custodian->id,
            'assigned_at' => now(),
        ]);
    }

    /**
     * Pure test scaffolding for a ticket in the ONLY way it can now reach
     * Active — a Custodian's proposal (ticket.propose), approved by an
     * Admin (ticket.approve) with a single assigned_mechanic_id.
     * TicketController::approveTicket() bulk-dispatches EVERY sub-issue to
     * that one mechanic (status 'Under Repair'), replacing the old
     * per-sub-issue assignMechanic() dispatch. Returns the fresh ticket
     * with its sub-issues loaded.
     */
    private function activeTicket(Vehicle $vehicle, array $titles, ?User $mechanic = null, ?User $custodian = null): MaintenanceTicket
    {
        $mechanic ??= $this->mechanic;
        $custodian ??= $this->custodian;

        Sanctum::actingAs($custodian, ['*']);
        $ticketId = $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_description' => 'Engine runs hot after 10 minutes.',
            'priority' => 'High',
            'sub_issues' => array_map(fn ($t) => ['title' => $t], $titles),
        ])->assertCreated()->json('ticket_id');

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/approve", [
            'assigned_mechanic_id' => $mechanic->id,
        ])->assertOk();

        return MaintenanceTicket::with('subIssues')->findOrFail($ticketId);
    }

    /** The ticket's assigned mechanic logs a repair on every sub-issue. */
    private function logRepairsForEverySubIssue(MaintenanceTicket $ticket, ?User $mechanic = null): void
    {
        $mechanic ??= $this->mechanic;

        Sanctum::actingAs($mechanic, ['*']);
        foreach ($ticket->subIssues()->get() as $subIssue) {
            $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", ['tested_ok' => true, 
                'repair_logs' => 'Fixed it.',
            ])->assertOk();
        }
    }

    /** Mechanic submits the ticket for verification; Custodian attests and closes it. */
    private function submitAndVerify(MaintenanceTicket $ticket, ?User $mechanic = null, ?User $custodian = null): void
    {
        $mechanic ??= $this->mechanic;
        $custodian ??= $this->custodian;

        Sanctum::actingAs($mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertOk();

        Sanctum::actingAs($custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['verification_verdict' => 'Approved', 'test_attested' => true])->assertOk();
    }

    /** Full happy path: log repairs on every sub-issue, submit, verify -> Closed. */
    private function driveTicketToClosed(MaintenanceTicket $ticket, ?User $mechanic = null, ?User $custodian = null): MaintenanceTicket
    {
        $this->logRepairsForEverySubIssue($ticket, $mechanic);
        $this->submitAndVerify($ticket, $mechanic, $custodian);

        return $ticket->fresh(['subIssues']);
    }

    #[Test]
    public function archived_tickets_can_be_deleted_and_restored_without_reopening_closed_work(): void
    {
        $ticket = $this->driveTicketToClosed($this->activeTicket($this->vehicle(), ['Worn belt']));
        $archive = TicketArchiveLog::where('ticket_id', $ticket->ticket_id)->firstOrFail();
        $snapshot = $archive->full_ticket_snapshot;
        Sanctum::actingAs($this->admin, ['*']);

        $this->deleteJson("/api/ticket-archives/{$archive->archive_id}")->assertOk();
        $this->assertSoftDeleted('ticket_archive_logs', ['archive_id' => $archive->archive_id]);
        $this->getJson('/api/ticket-archives')->assertOk()->assertJsonFragment(['archive_id' => $archive->archive_id]);
        $this->putJson("/api/ticket-archives/{$archive->archive_id}/restore")->assertOk();
        $this->assertSame($snapshot, $archive->fresh()->full_ticket_snapshot);
        $this->assertNull($archive->fresh()->deleted_at);
        $this->assertSame('Closed', $ticket->fresh()->status);
        $this->putJson("/api/ticket-archives/{$archive->archive_id}/reopen")->assertUnprocessable();
    }

    #[Test]
    public function staff_cannot_delete_or_restore_archives(): void
    {
        $ticket = $this->driveTicketToClosed($this->activeTicket($this->vehicle(), ['Worn belt']));
        $archive = TicketArchiveLog::where('ticket_id', $ticket->ticket_id)->firstOrFail();
        foreach ([$this->custodian, $this->mechanic] as $user) {
            Sanctum::actingAs($user, ['*']);
            $this->deleteJson("/api/ticket-archives/{$archive->archive_id}")->assertForbidden();
        }
        Sanctum::actingAs($this->admin, ['*']);
        $this->deleteJson("/api/ticket-archives/{$archive->archive_id}")->assertOk();
        foreach ([$this->custodian, $this->mechanic] as $user) {
            Sanctum::actingAs($user, ['*']);
            $this->putJson("/api/ticket-archives/{$archive->archive_id}/restore")->assertForbidden();
        }
    }

    #[Test]
    public function repair_logs_accept_multiple_evidence_files_without_parts_or_cost(): void
    {
        Storage::fake('supabase');
        $ticket = $this->activeTicket($this->vehicle(), ['Worn belt']);
        $sub = $ticket->subIssues->first();
        Sanctum::actingAs($this->mechanic, ['*']);
        $this->post("/api/tickets/{$ticket->ticket_id}/sub-issues/{$sub->sub_issue_id}/log-repairs", ['tested_ok' => true, 
            '_method' => 'PUT',
            'repair_logs' => 'Adjusted belt tension. No replacement parts needed.',
            'photos' => [UploadedFile::fake()->image('belt.jpg'), UploadedFile::fake()->create('report.pdf', 20, 'application/pdf')],
        ], ['Accept' => 'application/json'])->assertOk();
        $files = $sub->fresh()->attachment_files;
        $this->assertCount(2, $files);
        $this->assertSame('belt.jpg', $files[0]['name']);
        $this->assertSame('report.pdf', $files[1]['name']);
        $this->assertSame($this->mechanic->name, $files[0]['added_by']);
        $this->assertNull($sub->fresh()->maintenance_cost);
        $this->assertNull($sub->fresh()->parts_used);
        $this->getJson("/api/tickets/{$ticket->ticket_id}")->assertOk()->assertJsonFragment(['name' => 'report.pdf']);
    }

    #[Test]
    public function repair_evidence_rejects_oversized_or_unsupported_files(): void
    {
        Storage::fake('supabase');
        $ticket = $this->activeTicket($this->vehicle(), ['Worn belt']);
        $sub = $ticket->subIssues->first();
        Sanctum::actingAs($this->mechanic, ['*']);
        $this->post("/api/tickets/{$ticket->ticket_id}/sub-issues/{$sub->sub_issue_id}/log-repairs", ['tested_ok' => true, 
            '_method' => 'PUT', 'repair_logs' => 'Adjusted belt tension.',
            'photos' => [UploadedFile::fake()->create('large.pdf', 8193, 'application/pdf'), UploadedFile::fake()->create('script.exe', 1)],
        ], ['Accept' => 'application/json'])->assertUnprocessable()->assertJsonValidationErrors(['photos.0', 'photos.1']);
        $this->assertSame('Under Repair', $sub->fresh()->status);
        $this->assertNull($sub->fresh()->attachment_files);
    }

    #[Test]
    public function nobody_can_create_a_ticket_directly_any_more(): void
    {
        // The direct-create route is gone — every ticket originates as a Custodian's
        // proposal (see the propose/approve tests below) that an Admin reviews and approves.
        $vehicle = $this->vehicle();
        $payload = [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Nope',
            'ticket_description' => 'Nobody can open a ticket directly.',
            'priority' => 'Low',
            'assigned_custodian_id' => $this->custodian->id,
        ];

        Sanctum::actingAs($this->custodian, ['*']);
        $this->assertContains($this->postJson('/api/tickets', $payload)->getStatusCode(), [404, 405]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->assertContains($this->postJson('/api/tickets', $payload)->getStatusCode(), [404, 405]);
    }

    #[Test]
    public function nobody_can_submit_an_inspection_any_more(): void
    {
        // The inspection route is gone — the inspection phase (Open -> Active) no longer exists.
        // A proposal always states what's wrong and how it'll be fixed up front.
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);

        foreach ([$this->custodian, $this->admin, $this->mechanic] as $user) {
            Sanctum::actingAs($user, ['*']);
            $this->assertContains($this->putJson("/api/tickets/{$ticket->ticket_id}/inspect", [
                'inspection_result' => 'No Issues',
            ])->getStatusCode(), [404, 405]);
        }
    }

    #[Test]
    public function the_old_per_sub_issue_verify_confirm_close_and_defer_endpoints_are_now_unreachable_by_anyone(): void
    {
        // The per-sub-issue verify, confirm and defer routes and the Admin close route were removed.
        // The ticket-level replacements (submit-for-verification, verify) have their own tests below.
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

        foreach ([$this->admin, $this->custodian, $this->mechanic] as $user) {
            Sanctum::actingAs($user, ['*']);

            $this->assertContains($this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/verify", [
                'verification_verdict' => 'Approved',
                'test_attested'        => true,
                'functional_test'      => [['item' => 'Engine starts', 'passed' => true]],
            ])->getStatusCode(), [404, 405]);

            $this->assertContains($this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/confirm", [
                'confirmation_verdict' => 'Confirmed',
            ])->getStatusCode(), [404, 405]);

            $this->assertContains($this->putJson("/api/tickets/{$ticket->ticket_id}/close", [])->getStatusCode(), [404, 405]);

            $this->assertContains($this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/defer", [
                'deferred_reason' => 'trying to defer',
            ])->getStatusCode(), [404, 405]);
        }
    }

    #[Test]
    public function nobody_can_assign_or_reassign_a_mechanic_on_an_individual_sub_issue_any_more(): void
    {
        // The per-sub-issue assign and reassign routes were removed — mechanics are chosen in
        // approveTicket() and changed only through assignTicketMechanic() (see the tests below).
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

        foreach ([$this->admin, $this->custodian, $this->mechanic] as $user) {
            Sanctum::actingAs($user, ['*']);

            $this->assertContains($this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
                'assigned_mechanic_id' => $this->mechanic2->id,
                'maintenance_type' => 'Engine Repair',
            ])->getStatusCode(), [404, 405]);

            $this->assertContains($this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/reassign-mechanic", [
                'assigned_mechanic_id' => $this->mechanic2->id,
                'reassign_reason' => 'x',
            ])->getStatusCode(), [404, 405]);
        }
    }

    #[Test]
    public function verifying_needs_the_ticket_at_for_verification_and_closes_it_on_approve(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);
        $this->logRepairsForEverySubIssue($ticket);

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertOk();

        Sanctum::actingAs($this->custodian, ['*']);

        // Approve is a single click — no checklist or attestation gate any more.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['verification_verdict' => 'Approved', 'test_attested' => true])->assertOk();
        $this->assertSame('Closed', $ticket->fresh()->status);
    }

    #[Test]
    public function a_valid_attestation_closes_the_ticket_and_finalizes_every_sub_issue(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level', 'Faulty radiator']);
        $this->driveTicketToClosed($ticket);

        $fresh = $ticket->fresh(['subIssues']);
        $this->assertSame('Closed', $fresh->status);
        $this->assertSame($this->custodian->id, $fresh->closed_by);
        $this->assertNotNull($fresh->closed_at);
        $this->assertTrue($fresh->returned_to_service);
        $this->assertNotNull($fresh->archived_at);

        foreach ($fresh->subIssues as $subIssue) {
            $this->assertSame('Done', $subIssue->status);
            $this->assertSame('Approved', $subIssue->verification_verdict);
            $this->assertSame($this->custodian->id, $subIssue->verified_by);
            $this->assertNotNull($subIssue->verified_at);
            $this->assertSame('Confirmed', $subIssue->confirmation_verdict);
        }

        $this->assertSame(2, VehicleMaintenanceRecord::where('vehicle_id', $vehicle->vehicle_id)->where('progress_status', 'Completed')->count());
    }

    #[Test]
    public function approving_a_proposal_pulls_the_vehicle_out_of_service_immediately(): void
    {
        $vehicle = $this->vehicle();
        $this->assertSame('Available', $vehicle->fresh()->status);

        Sanctum::actingAs($this->custodian, ['*']);
        $ticketId = $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_description' => 'Overheating.',
            'priority' => 'High',
            'sub_issues' => [['title' => 'Low coolant level']],
        ])->assertCreated()->json('ticket_id');

        // Still available — a Pending Approval proposal has not taken the
        // vehicle out of service yet.
        $this->assertSame('Available', $vehicle->fresh()->status);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/approve", [
            'assigned_mechanic_id' => $this->mechanic->id,
        ])->assertOk();

        // Approval dispatches the mechanic AND pulls the vehicle out of
        // service in the same atomic step — there is no separate "mechanic
        // assignment" step any more for this to lag behind.
        $this->assertSame('Under Maintenance', $vehicle->fresh()->status);
        $this->assertSame('Needs Repair', $vehicle->fresh()->condition);
    }

    #[Test]
    public function a_mechanic_can_attach_a_photo_or_document_when_logging_repairs(): void
    {
        Storage::fake('supabase');

        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->put("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", ['tested_ok' => true, 
            'repair_logs' => 'Topped up coolant.',
            'photo' => UploadedFile::fake()->create('receipt.pdf', 100, 'application/pdf'),
        ])->assertOk();

        $subIssue->refresh();
        $this->assertNotNull($subIssue->attachment_url);
    }

    #[Test]
    public function the_same_main_issue_cannot_be_proposed_twice_while_one_is_still_active(): void
    {
        // Duplicate-Main-Issue guard used to live only in createTicket();
        // proposeTicket() now carries the same check since it's the only
        // way a ticket comes into existence.
        $vehicle = $this->vehicle();
        $this->createTicket($vehicle, 'Overheating');

        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_description' => 'Reported again.',
            'priority' => 'Medium',
            // Same Main Issue = same issue summary (here the maintenance type),
            // matched case-insensitively against the legacy 'Overheating' title.
            'sub_issues' => [['title' => 'overheating', 'maintenance_type' => 'overheating']],
        ])->assertUnprocessable();
    }

    #[Test]
    public function a_different_main_issue_can_be_proposed_concurrently_on_the_same_vehicle(): void
    {
        $vehicle = $this->vehicle();
        $this->createTicket($vehicle, 'Overheating');

        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Flat Tire',
            'ticket_description' => 'Rear right tire is flat.',
            'priority' => 'Medium',
            'sub_issues' => [['title' => 'Replace rear right tire']],
        ])->assertCreated();

        $this->assertSame(2, MaintenanceTicket::where('vehicle_id', $vehicle->vehicle_id)->count());
    }

    #[Test]
    public function proposing_a_ticket_from_an_issue_report_links_them_both_ways(): void
    {
        $vehicle = $this->vehicle();
        $issue = VehicleIssueReport::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'issue_type' => 'Engine Problem',
            'issue_description' => 'Overheating on long drives.',
            'severity_level' => 'High',
            'reported_by' => $this->custodian->id,
            'status' => 'Pending',
        ]);

        Sanctum::actingAs($this->custodian, ['*']);
        $ticketId = $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Engine Problem',
            'ticket_description' => $issue->issue_description,
            'priority' => 'High',
            'issue_report_id' => $issue->issue_report_id,
            'sub_issues' => [['title' => 'Overheating on long drives']],
        ])->assertCreated()->json('ticket_id');

        // The issue moves out of Pending as soon as it's proposed, not only
        // once an Admin approves — same timing createTicket() used to have.
        $this->assertSame('Under Review', $issue->fresh()->status);

        // ...and the /issues listing exposes the link back to that ticket, so
        // the Issue Report detail page can show "Linked Ticket".
        $listed = collect($this->getJson('/api/issues')->assertOk()->json())
            ->firstWhere('issue_report_id', $issue->issue_report_id);
        $this->assertNotNull($listed['maintenance_ticket'] ?? null);
        $this->assertSame($ticketId, $listed['maintenance_ticket']['ticket_id']);
    }

    #[Test]
    public function only_admin_can_change_sub_issues_on_an_active_ticket(): void
    {
        $ticket = $this->activeTicket($this->vehicle(), ['Low coolant level']);

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->postJson("/api/tickets/{$ticket->ticket_id}/sub-issues", ['title' => 'Another problem'])->assertForbidden();

        Sanctum::actingAs($this->custodian, ['*']);
        $sub = $ticket->subIssues()->first();
        $this->postJson("/api/tickets/{$ticket->ticket_id}/sub-issues", ['title' => 'Another problem'])->assertForbidden();
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$sub->sub_issue_id}", ['title' => 'Changed'])->assertForbidden();
        $this->deleteJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$sub->sub_issue_id}")->assertForbidden();
        $this->putJson("/api/tickets/{$ticket->ticket_id}/cancel", ['closing_notes' => 'Work cancelled for this test scenario.'])->assertForbidden();
        Sanctum::actingAs($this->admin, ['*']);
        $response = $this->postJson("/api/tickets/{$ticket->ticket_id}/sub-issues", ['title' => 'Another problem'])->assertCreated();
        // The ticket already has one assigned mechanic by the time it's
        // Active — a line item added afterwards is simply more work for
        // that same mechanic (per-sub-issue dispatch no longer exists to
        // pick it up), not a fresh unassigned 'Open' item.
        $this->assertSame('Under Repair', $response->json('status'));
        $this->assertSame($this->mechanic->id, $response->json('assigned_mechanic_id'));
        $this->assertSame(2, $ticket->fresh()->subIssues()->count());
    }

    #[Test]
    public function a_sub_issue_can_be_edited_or_removed_any_time_before_its_repair_is_logged(): void
    {
        $ticket = $this->activeTicket($this->vehicle(), ['Low coolant level', 'Faulty radiator']);
        [$coolant, $radiator] = $ticket->subIssues;

        // Already 'Under Repair' (auto-dispatched at approval) — still
        // editable/removable, since its repair hasn't been logged yet.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$coolant->sub_issue_id}", [
            'title' => 'Low coolant level (confirmed)',
        ])->assertOk();

        // Once a repair is logged (-> 'For Inspection'), it's locked.
        $this->logRepairsForEverySubIssue($ticket->fresh(['subIssues']));
        $radiator->refresh();
        $coolant->refresh();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$coolant->sub_issue_id}", [
            'title' => 'Too late',
        ])->assertUnprocessable();
        $this->deleteJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$radiator->sub_issue_id}")->assertUnprocessable();
    }

    #[Test]
    public function a_ticket_exposes_its_age_in_days(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);

        // Freshly created -> 0 whole days old, and the attribute is exposed.
        $this->assertSame(0, $ticket->fresh()->days_open);
    }

    // =======================================================================
    // Ticket-level mechanic assignment/reassignment (assignTicketMechanic)
    // =======================================================================

    #[Test]
    public function only_admin_can_reassign_the_tickets_mechanic(): void
    {
        $ticket = $this->activeTicket($this->vehicle(), ['Low coolant level']);

        foreach ([$this->custodian, $this->mechanic] as $user) {
            Sanctum::actingAs($user, ['*']);
            $this->putJson("/api/tickets/{$ticket->ticket_id}/assign-mechanic", [
                'assigned_mechanic_id' => $this->mechanic2->id,
                'reassign_reason' => 'trying to reassign',
            ])->assertForbidden();
        }

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic2->id,
            'reassign_reason' => 'Original mechanic is out sick.',
        ])->assertOk();

        $fresh = $ticket->fresh(['subIssues']);
        $this->assertSame($this->mechanic2->id, $fresh->assigned_mechanic_id);
        foreach ($fresh->subIssues as $subIssue) {
            $this->assertSame($this->mechanic2->id, $subIssue->assigned_mechanic_id);
            $this->assertSame([$this->mechanic->id], $subIssue->prior_mechanic_ids);
        }
    }

    #[Test]
    public function the_tickets_mechanic_cannot_be_reassigned_unless_active_or_for_verification(): void
    {
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->custodian, ['*']);
        $ticketId = $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_description' => 'Overheating.',
            'priority' => 'High',
            'sub_issues' => [['title' => 'Low coolant level']],
        ])->assertCreated()->json('ticket_id');

        // Still Pending Approval — no assigned_mechanic_id to reassign yet.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic->id,
            'reassign_reason' => 'too early',
        ])->assertUnprocessable();

        $this->putJson("/api/tickets/{$ticketId}/approve", ['assigned_mechanic_id' => $this->mechanic->id])->assertOk();

        $ticket = MaintenanceTicket::findOrFail($ticketId);
        $this->driveTicketToClosed($ticket);

        // Now Closed — can no longer be reassigned.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic2->id,
            'reassign_reason' => 'too late',
        ])->assertUnprocessable();
    }

    #[Test]
    public function submitted_repairs_cannot_be_reset_by_mechanic_reassignment(): void
    {
        $ticket = $this->activeTicket($this->vehicle(), ['Low coolant level']);
        $this->logRepairsForEverySubIssue($ticket);

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertOk();
        $this->assertSame('For Verification', $ticket->fresh()->status);

        // Return a failed item for rework before transferring responsibility.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic2->id,
            'reassign_reason' => 'Swapping mechanics after submission.',
        ])->assertUnprocessable();

        $this->assertSame('For Verification', $ticket->fresh()->status);
    }

    #[Test]
    public function prior_mechanic_ids_accumulate_across_ticket_level_reassignments_without_duplicates(): void
    {
        $ticket = $this->activeTicket($this->vehicle(), ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();
        $third = User::factory()->create(['role' => 'Maintenance Personnel']);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic2->id,
            'reassign_reason' => 'first handoff',
        ])->assertOk();

        $this->putJson("/api/tickets/{$ticket->ticket_id}/assign-mechanic", [
            'assigned_mechanic_id' => $third->id,
            'reassign_reason' => 'second handoff',
        ])->assertOk();

        $this->assertSame([$this->mechanic->id, $this->mechanic2->id], $subIssue->fresh()->prior_mechanic_ids);
    }

    #[Test]
    public function a_ticket_with_every_sub_issue_already_resolved_cannot_be_cancelled(): void
    {
        // Real, confirmed repair work is on record here — cancelling would
        // void it instead of just abandoning an unstarted/unfinished ticket.
        // Simulated as pre-existing (legacy-style) progress via direct model
        // update, since under the new flow a sub-issue reaching Done always
        // closes the whole ticket in the same transaction (verifyTicket()) —
        // there's no live path that leaves a ticket Active with every
        // sub-issue already Done, but this guard still protects historical
        // data left in that shape.
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);
        $ticket->subIssues->first()->update(['status' => 'Done']);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/cancel", ['closing_notes' => 'Work cancelled for this test scenario.'])->assertUnprocessable();

        $this->assertSame('Active', $ticket->fresh()->status);
    }

    #[Test]
    public function proposing_a_ticket_from_a_condition_check_links_it_and_stays_live(): void
    {
        $vehicle = $this->vehicle();
        $condition = VehicleConditionCheck::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'condition_result' => 'Needs Repair',
            'observations' => 'Brakes feel soft.',
            'checked_by' => $this->custodian->id,
        ]);

        Sanctum::actingAs($this->custodian, ['*']);
        $response = $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Condition Check: Needs Repair',
            'ticket_description' => 'From condition check.',
            'priority' => 'High',
            'condition_check_id' => $condition->condition_check_id,
            'sub_issues' => [['title' => 'Brakes feel soft.']],
        ])->assertCreated();
        $ticketId = $response->json('ticket_id');

        // The link is set once, immediately at proposal time...
        $this->assertSame($ticketId, $condition->fresh()->resulting_ticket_id);

        // ...and stays 'Pending Approval' until an Admin approves it.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/approve", ['assigned_mechanic_id' => $this->mechanic->id])->assertOk();

        // ...and the listing endpoint reads the ticket's LIVE status through
        // it, not a snapshot — no change to the condition check itself.
        Sanctum::actingAs($this->admin, ['*']);
        $listed = $this->getJson('/api/conditions')->assertOk()->json();
        $row = collect($listed)->firstWhere('condition_check_id', $condition->condition_check_id);
        $this->assertSame($ticketId, $row['resulting_ticket']['ticket_id']);
        $this->assertSame('Active', $row['resulting_ticket']['status']);
        // The historical entry is untouched by any of this.
        $this->assertSame('Needs Repair', $row['condition_result']);
        $this->assertSame('Brakes feel soft.', $row['observations']);

        // Close the ticket — the SAME condition check row now reflects the
        // new status automatically, no extra step.
        $ticket = MaintenanceTicket::findOrFail($ticketId);
        $this->driveTicketToClosed($ticket);

        $listedAfterClose = $this->getJson('/api/conditions')->assertOk()->json();
        $rowAfterClose = collect($listedAfterClose)->firstWhere('condition_check_id', $condition->condition_check_id);
        $this->assertSame('Closed', $rowAfterClose['resulting_ticket']['status']);
        $this->assertSame('Needs Repair', $rowAfterClose['condition_result']);
    }

    #[Test]
    public function closed_tickets_are_permanently_locked(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);
        $this->driveTicketToClosed($ticket);

        // ...it cannot be cancelled/uncancelled either — Closed is final.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/cancel", ['closing_notes' => 'Work cancelled for this test scenario.'])->assertUnprocessable();

        // ...nor deleted — that would create a SECOND, reopenable "Deleted"
        // archive row alongside the permanent "Closed" one, defeating the
        // "closed tickets can never be reopened" guarantee.
        $this->deleteJson("/api/tickets/{$ticket->ticket_id}")->assertUnprocessable();
        $this->assertTrue(MaintenanceTicket::where('ticket_id', $ticket->ticket_id)->exists());
        $this->assertSame(1, TicketArchiveLog::where('ticket_id', $ticket->ticket_id)->count());
    }

    #[Test]
    public function an_approved_ticket_cannot_be_deleted_before_repairs_either(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);

        Sanctum::actingAs($this->admin, ['*']);
        $this->deleteJson("/api/tickets/{$ticket->ticket_id}")->assertUnprocessable();

        $this->assertTrue(MaintenanceTicket::where('ticket_id', $ticket->ticket_id)->exists());
        $this->assertFalse(TicketArchiveLog::where('ticket_id', $ticket->ticket_id)->exists());
    }

    #[Test]
    public function deleting_a_ticket_with_real_progress_is_rejected_and_evidence_retained(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level', 'Faulty radiator']);
        $ticket->subIssues[0]->update(['status' => 'Done']);
        Sanctum::actingAs($this->admin, ['*']);
        $this->deleteJson("/api/tickets/{$ticket->ticket_id}")->assertUnprocessable();
        $this->assertNotNull($ticket->fresh());
        $this->assertSame(2, $ticket->subIssues()->count());
        $this->assertFalse(TicketArchiveLog::where('ticket_id', $ticket->ticket_id)->exists());
        $this->assertSame('Under Maintenance', $vehicle->fresh()->status);
    }

    #[Test]
    public function legacy_deleted_archives_can_still_recover_historical_work(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level', 'Faulty radiator']);
        $ticket->subIssues[0]->update(['status' => 'Done']);
        $ticket->load('subIssues');
        $archive = TicketArchiveLog::create([
            'ticket_id' => $ticket->ticket_id, 'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => $ticket->ticket_title, 'vehicle_name' => $vehicle->vehicle_name,
            'plate_number' => $vehicle->plate_number, 'final_status' => 'Deleted',
            'full_ticket_snapshot' => $ticket->toArray(), 'archived_by' => $this->admin->id,
            'archived_at' => now(),
        ]);
        $ticket->delete(); // Prepare an archive produced by the older application.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/ticket-archives/{$archive->archive_id}/reopen", [])->assertCreated();
        $reopened = MaintenanceTicket::where('vehicle_id', $vehicle->vehicle_id)->firstOrFail();
        $this->assertSame(2, $reopened->subIssues()->count());
        $this->assertSame(1, $reopened->subIssues()->where('status', 'Done')->count());
    }

    #[Test]
    public function a_closed_archive_entry_can_never_be_reopened(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);
        $this->driveTicketToClosed($ticket);
        $archive = TicketArchiveLog::where('ticket_id', $ticket->ticket_id)->firstOrFail();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/ticket-archives/{$archive->archive_id}/reopen", [])->assertUnprocessable();
    }

    #[Test]
    public function the_vehicle_only_returns_to_service_once_every_open_ticket_is_closed(): void
    {
        $vehicle = $this->vehicle();

        $overheating = $this->activeTicket($vehicle, ['Low coolant level']);
        $flatTire = $this->activeTicket($vehicle, ['Replace rear right tire']);

        // Close the Flat Tire ticket first — Overheating is still open.
        $this->driveTicketToClosed($flatTire);

        $this->assertSame('Under Maintenance', $vehicle->fresh()->status, 'Overheating ticket is still open — vehicle must not be marked Available yet.');

        // Now close Overheating too — only now should the vehicle free up.
        $this->driveTicketToClosed($overheating->fresh());

        $this->assertSame('Available', $vehicle->fresh()->status);
        $this->assertSame('Good', $vehicle->fresh()->condition);
    }

    #[Test]
    public function dashboard_badge_counts_reflect_assignment_and_verification(): void
    {
        // Verification is now a ticket-level step (one Custodian attestation
        // closes the whole job), so 'ticketVerifications' counts TICKETS at
        // For Verification, not sub-issues — 'ticketWorkOrders' is still per
        // sub-issue (FleetController::dashboard()).
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->getJson('/api/dashboard')->assertOk()->assertJsonPath('badge_counts.ticketWorkOrders', 1);

        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", ['tested_ok' => true, 
            'repair_logs' => 'Topped up coolant.',
        ])->assertOk();
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertOk();

        Sanctum::actingAs($this->custodian, ['*']);
        $this->getJson('/api/dashboard')->assertOk()->assertJsonPath('badge_counts.ticketVerifications', 1);
    }

    #[Test]
    public function a_mechanic_cannot_create_a_standalone_maintenance_record_at_all(): void
    {
        // Phase B4 — standalone Maintenance Records are now an Admin-only
        // manual/historical ledger; a Maintenance Personnel account has no
        // create/edit access to them whatsoever (they log real repairs
        // through a ticket sub-issue instead).
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->postJson('/api/maintenance-records', [
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'problem_reason' => 'Routine oil change',
            'progress_status' => 'Under Repair',
        ])->assertForbidden();
    }

    #[Test]
    public function double_booking_a_vehicle_warns_instead_of_blocking_and_a_confirm_proceeds(): void
    {
        // Spec §19 (2026-10-06) moved schedule.create from Admin to
        // Custodian — see config/permissions.php. This test is about the
        // double-booking rule itself, which used to be a hard 422 and is now
        // a warning the caller can confirm past (see FleetController::
        // checkScheduleConflicts()).
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson('/api/maintenance-schedules', [
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => '2026-08-01',
        ])->assertCreated();

        $unconfirmed = $this->postJson('/api/maintenance-schedules', [
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Tire Rotation',
            'scheduled_date' => '2026-08-01',
        ])->assertStatus(409);
        $this->assertTrue($unconfirmed->json('same_vehicle_conflict'));
        $this->assertDatabaseCount('vehicle_maintenance_schedules', 1);

        $this->postJson('/api/maintenance-schedules', [
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Tire Rotation',
            'scheduled_date' => '2026-08-01',
            'confirm_conflicts' => true,
        ])->assertCreated();
        $this->assertDatabaseCount('vehicle_maintenance_schedules', 2);
    }

    #[Test]
    public function a_cancelled_ticket_blocks_every_subsequent_ticket_level_action(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level', 'Faulty radiator']);

        // Cancel while both sub-issues are still mid-flight (neither Done
        // nor Deferred, so cancelTicket() allows it).
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/cancel", ['closing_notes' => 'Work cancelled for this test scenario.'])->assertOk();
        $this->assertSame('Cancelled', $ticket->fresh()->status);

        $subIssue = $ticket->subIssues->first();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", ['tested_ok' => true, 
            'repair_logs' => 'Should be blocked.',
        ])->assertUnprocessable();
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertUnprocessable();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic2->id,
            'reassign_reason' => 'testing',
        ])->assertUnprocessable();

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['verification_verdict' => 'Approved', 'test_attested' => true])->assertUnprocessable();
    }

    // =======================================================================
    // Self-verification is blocked at the TICKET level, even across a
    // mechanic reassignment and for a dual-role account.
    // =======================================================================

    #[Test]
    public function a_mechanic_who_also_holds_the_verifying_custodians_account_cannot_approve_their_own_repair(): void
    {
        $vehicle = $this->vehicle();

        // $this->custodian is this ticket's assigned Custodian/verifier —
        // give them the Maintenance Personnel hat too, then assign the
        // ticket's repair work to themself.
        $this->custodian->update(['roles' => ['Custodian', 'Maintenance Personnel']]);
        $ticket = $this->activeTicket($vehicle, ['Low coolant level'], $this->custodian, $this->custodian);
        $this->logRepairsForEverySubIssue($ticket, $this->custodian);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertOk();

        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['verification_verdict' => 'Approved', 'test_attested' => true])
            ->assertForbidden()
            ->assertJsonFragment(['message' => 'You performed repair work on this ticket — it must be verified by a different Custodian. Reassign this ticket to another Custodian.']);

        $this->assertSame('For Verification', $ticket->fresh()->status);
    }

    #[Test]
    public function a_mechanic_reassigned_away_mid_repair_who_is_also_the_custodian_still_cannot_verify_their_own_earlier_work(): void
    {
        // Closes a self-verification gap: the guard must check EVERY
        // sub-issue's prior_mechanic_ids, not just the ticket's CURRENT
        // assigned_mechanic_id — a mechanic who did real repair work and was
        // then reassigned away before the ticket reached verification must
        // still be blocked, even though assignTicketMechanic() now names
        // someone else entirely.
        $vehicle = $this->vehicle();
        $this->custodian->update(['roles' => ['Custodian', 'Maintenance Personnel']]);

        $ticket = $this->activeTicket($vehicle, ['Low coolant level'], $this->custodian, $this->custodian);

        // Reassigned away before the custodian-mechanic ever submits repair
        // logs for their own work.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic->id,
            'reassign_reason' => 'Reassigning mid-repair for testing.',
        ])->assertOk();

        $subIssue = $ticket->subIssues->first();
        $this->assertSame([$this->custodian->id], $subIssue->fresh()->prior_mechanic_ids);

        // A different mechanic finishes and submits the paperwork.
        $this->logRepairsForEverySubIssue($ticket->fresh(['subIssues']), $this->mechanic);

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertOk();

        // The original mechanic — now only wearing the Custodian hat on
        // paper, but who actually did earlier repair work on this ticket —
        // still cannot verify it, even though assigned_mechanic_id now
        // names someone else entirely.
        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['verification_verdict' => 'Approved', 'test_attested' => true])
            ->assertForbidden()
            ->assertJsonFragment(['message' => 'You performed repair work on this ticket — it must be verified by a different Custodian. Reassign this ticket to another Custodian.']);
    }

    #[Test]
    public function an_admin_cannot_verify_a_repair_even_as_a_fallback_and_must_reassign_the_custodian_instead(): void
    {
        // Production-readiness audit finding #2 — Admin was previously a
        // general Tier-1 verification fallback. That's removed: verification
        // is Custodian-only, full stop (ticket.verify's ability grant is
        // ['Custodian']). An unavailable Custodian is handled by reassigning
        // the ticket, not by Admin quietly standing in for the check.
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);
        $this->logRepairsForEverySubIssue($ticket);

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertOk();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['verification_verdict' => 'Approved', 'test_attested' => true])->assertForbidden();

        // The actual, correct fix: reassign the ticket to a different
        // Custodian, who can then verify it normally.
        $standInCustodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/reassign-custodian", [
            'assigned_custodian_id' => $standInCustodian->id,
            'reassign_reason' => 'Original custodian unavailable.',
        ])->assertOk();

        Sanctum::actingAs($standInCustodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['verification_verdict' => 'Approved', 'test_attested' => true])->assertOk();

        $this->assertSame('Closed', $ticket->fresh()->status);
        $this->assertSame($standInCustodian->id, $ticket->fresh()->closed_by);
    }

    #[Test]
    public function a_maintenance_personnel_only_account_still_cannot_call_verify_at_all(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);
        $this->logRepairsForEverySubIssue($ticket);

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertOk();
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['verification_verdict' => 'Approved', 'test_attested' => true])->assertForbidden();
    }

    #[Test]
    public function reassigning_the_custodian_to_the_subissues_own_mechanic_warns_but_does_not_block(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level'], $this->mechanic);

        // $this->mechanic is about to become the ticket's Custodian while
        // also still being this ticket's assigned mechanic.
        $this->mechanic->update(['roles' => ['Maintenance Personnel', 'Custodian']]);
        $subIssue = $ticket->subIssues->first();

        Sanctum::actingAs($this->admin, ['*']);
        $response = $this->putJson("/api/tickets/{$ticket->ticket_id}/reassign-custodian", [
            'assigned_custodian_id' => $this->mechanic->id,
            'reassign_reason' => 'Original custodian is out.',
        ])->assertOk();

        $response->assertJsonPath(
            'warning',
            "{$this->mechanic->name} has performed or handled repair work on: {$subIssue->title}. They won't be able to verify their own repair there — reassign those sub-issues to a different mechanic, or this ticket to a different Custodian."
        );
        $this->assertSame($this->mechanic->id, $ticket->fresh()->assigned_custodian_id, 'The conflict is a warning, not a block.');
    }

    #[Test]
    public function reassigning_the_custodian_ignores_a_conflict_on_an_already_done_sub_issue(): void
    {
        // A Done sub-issue is already verified — no conflict left to warn
        // about. Simulated as pre-existing progress via direct model update
        // (see the cancellation guard test above for why).
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level'], $this->mechanic);
        $this->mechanic->update(['roles' => ['Maintenance Personnel', 'Custodian']]);
        $ticket->subIssues->first()->update(['status' => 'Done']);

        Sanctum::actingAs($this->admin, ['*']);
        $response = $this->putJson("/api/tickets/{$ticket->ticket_id}/reassign-custodian", [
            'assigned_custodian_id' => $this->mechanic->id,
            'reassign_reason' => 'Original custodian is out.',
        ])->assertOk();

        $this->assertArrayNotHasKey('warning', $response->json(), 'A Done sub-issue is already verified — no conflict left to warn about.');
    }

    // =======================================================================
    // VMS-IMPROVEMENT-PLAN.md Phase A3 — a cannibalized repair needs an
    // Admin's sign-off, and approving one opens an Issue Report on the
    // donor vehicle instead of the "part just vanished" it used to be.
    // Unaffected by the ticket-workflow simplification other than the
    // mechanic already being dispatched to every sub-issue at approval.
    // =======================================================================

    private function logCannibalizedRepair(MaintenanceTicket $ticket, TicketSubIssue $subIssue, Vehicle $donorVehicle, ?User $mechanic = null)
    {
        $mechanic ??= $this->mechanic;

        Sanctum::actingAs($mechanic, ['*']);

        return $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", ['tested_ok' => true, 
            'repair_logs' => 'Swapped in a part from another vehicle.',
            'repair_type' => 'cannibalized', 'part_needed' => 'Alternator', 'part_quantity' => 1,
            'source_vehicle_id' => $donorVehicle->vehicle_id,
        ]);
    }

    #[Test]
    public function an_in_house_repair_is_unaffected_and_still_goes_straight_to_inspection(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Loose bolt']);
        $subIssue = $ticket->subIssues->first();

        $this->logRepairsForEverySubIssue($ticket);

        $subIssue->refresh();
        $this->assertSame('For Inspection', $subIssue->status);
        $this->assertNull($subIssue->cannibalization_status);
    }

    // ---- Ticketing-process review fixes -----------------------------------

    private function pendingIssue(Vehicle $vehicle, string $status = 'Pending'): VehicleIssueReport
    {
        return VehicleIssueReport::create([
            'vehicle_id' => $vehicle->vehicle_id, 'issue_type' => 'Engine Problem',
            'issue_description' => 'Overheating.', 'severity_level' => 'High',
            'reported_by' => $this->custodian->id, 'status' => $status,
        ]);
    }

    private function propose(Vehicle $vehicle, array $extra = []): \Illuminate\Testing\TestResponse
    {
        Sanctum::actingAs($this->custodian, ['*']);

        return $this->postJson('/api/tickets/propose', array_merge([
            'vehicle_id' => $vehicle->vehicle_id, 'ticket_title' => 'Engine Problem',
            'ticket_description' => 'Overheating.', 'priority' => 'High',
            'sub_issues' => [['title' => 'Overheating']],
        ], $extra));
    }

    #[Test]
    public function declining_a_proposal_puts_its_linked_issue_report_back_to_pending(): void
    {
        $vehicle = $this->vehicle();
        $issue = $this->pendingIssue($vehicle);
        $ticketId = $this->propose($vehicle, ['issue_report_id' => $issue->issue_report_id])->assertCreated()->json('ticket_id');
        $this->assertSame('Under Review', $issue->fresh()->status);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/decline", ['decline_reason' => 'Not needed.'])->assertOk();

        $this->assertSame('Pending', $issue->fresh()->status);
    }

    #[Test]
    public function a_proposal_awaiting_approval_cannot_be_cancelled(): void
    {
        $ticketId = $this->propose($this->vehicle())->assertCreated()->json('ticket_id');

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/cancel", ['closing_notes' => 'Work cancelled for this test scenario.'])->assertStatus(422);
        $this->assertSame('Pending Approval', MaintenanceTicket::find($ticketId)->status);
    }

    #[Test]
    public function a_proposal_cannot_link_another_vehicles_issue_or_an_already_handled_one(): void
    {
        $vehicle = $this->vehicle();
        $other = $this->vehicle();

        $this->propose($vehicle, ['issue_report_id' => $this->pendingIssue($other)->issue_report_id])->assertStatus(422);
        $this->propose($vehicle, ['issue_report_id' => $this->pendingIssue($vehicle, 'In Maintenance')->issue_report_id])->assertStatus(422);
    }

    #[Test]
    public function a_pending_proposal_does_not_hold_a_vehicle_out_of_service_when_another_ticket_ends(): void
    {
        $vehicle = $this->vehicle();
        $activeId = $this->propose($vehicle, ['sub_issues' => [['title' => 'Brakes']]])->assertCreated()->json('ticket_id');
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$activeId}/approve", ['assigned_mechanic_id' => $this->mechanic->id])->assertOk();
        $this->assertSame('Under Maintenance', $vehicle->fresh()->status);

        // A second, still-unapproved proposal on the same vehicle.
        $this->propose($vehicle, ['sub_issues' => [['title' => 'Radio']]])->assertCreated();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$activeId}/cancel", ['closing_notes' => 'Work cancelled for this test scenario.'])->assertOk();

        $this->assertSame('Available', $vehicle->fresh()->status);
        $this->getJson('/api/dashboard')->assertOk();
        $this->assertSame('Available', $vehicle->fresh()->status);
    }

    #[Test]
    public function an_unrelated_ticket_ending_does_not_touch_a_vehicle_that_was_never_taken_out_of_service(): void
    {
        $vehicle = $this->vehicle(['status' => 'Available', 'condition' => 'Needs Repair']);
        $ticket = $this->createTicket($vehicle); // Open, never touched

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/cancel", ['closing_notes' => 'Work cancelled for this test scenario.'])->assertOk();

        $this->assertSame('Needs Repair', $vehicle->fresh()->condition);
    }

    #[Test]
    public function a_clean_close_always_returns_the_vehicle_to_service(): void
    {
        // The old "close with an explicit not-fit-for-service answer" option
        // is gone — verifyTicket() is a single plain attestation with only
        // "approve" (see its docblock); a repair that didn't actually work
        // is handled by reassigning the mechanic or cancelling the ticket,
        // not by closing it anyway and leaving the vehicle flagged down.
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Loose bolt']);
        $this->driveTicketToClosed($ticket);

        $this->assertSame('Available', $vehicle->fresh()->status);
        $this->assertTrue($ticket->fresh()->returned_to_service);
    }

    #[Test]
    public function a_cannibalized_repair_cannot_use_its_own_vehicle_as_the_donor(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Alternator']);
        $subIssue = $ticket->subIssues->first();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", ['tested_ok' => true, 
            'repair_logs' => 'Swapped it.', 'repair_type' => 'cannibalized', 'source_vehicle_id' => $vehicle->vehicle_id,
        ])->assertStatus(422);
    }

    #[Test]
    public function reassigning_the_custodian_also_moves_a_repair_awaiting_cannibalization_approval(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Alternator']);
        $subIssue = $ticket->subIssues->first();
        $this->logCannibalizedRepair($ticket, $subIssue, $this->vehicle(['status' => 'Decommissioned']));

        $newCustodian = User::factory()->create(['role' => 'Custodian']);
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/reassign-custodian", [
            'assigned_custodian_id' => $newCustodian->id, 'reassign_reason' => 'Left the barangay.',
        ])->assertOk();

        $this->assertSame($newCustodian->id, $subIssue->fresh()->verification_assigned_to);
    }

    #[Test]
    public function a_donor_part_goes_straight_to_verification_with_no_admin_approval(): void
    {
        $vehicle = $this->vehicle();
        $donor = $this->vehicle(['vehicle_name' => 'Donor Vehicle', 'status' => 'Decommissioned']);
        $ticket = $this->activeTicket($vehicle, ['Broken alternator']);
        $subIssue = $ticket->subIssues->first();

        $this->logCannibalizedRepair($ticket, $subIssue, $donor)->assertOk();

        $subIssue->refresh();
        $this->assertSame('For Inspection', $subIssue->status);
        $this->assertSame($donor->vehicle_id, $subIssue->source_vehicle_id);
        $this->assertSame('For Verification', $ticket->fresh()->status);

        // The donor's side is still visible: the part shows as missing on its profile, with no separate issue report.
        $this->assertNull($subIssue->cannibalization_issue_report_id);
        $this->assertDatabaseMissing('vehicle_issue_reports', ['vehicle_id' => $donor->vehicle_id]);
        Sanctum::actingAs($this->admin, ['*']);
        $this->assertNotEmpty($this->getJson("/api/vehicles/{$donor->vehicle_id}/missing-parts")->assertOk()->json());

        // …and the Custodian can verify and close it.
        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['verification_verdict' => 'Approved', 'test_attested' => true])->assertOk();
        $this->assertSame('Closed', $ticket->fresh()->status);
    }

    #[Test]
    public function a_donor_part_only_job_needs_no_repair_narrative_but_a_repair_still_does(): void
    {
        $vehicle = $this->vehicle();
        $donor = $this->vehicle(['vehicle_name' => 'Donor Vehicle', 'status' => 'Decommissioned']);
        $ticket = $this->activeTicket($vehicle, ['Broken alternator', 'Loose bolt']);
        [$partOnly, $repairOnly] = $ticket->subIssues->all();

        // Donor part only — no repair_logs sent at all.
        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$partOnly->sub_issue_id}/log-repairs", ['tested_ok' => true, 
            'repair_type' => 'cannibalized', 'part_needed' => 'Gearbox',  'source_vehicle_id' => $donor->vehicle_id,
        ])->assertOk();
        $this->assertStringContainsString('Donor Vehicle', $partOnly->fresh()->repair_logs);

        // A plain repair with no narrative is still refused.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$repairOnly->sub_issue_id}/log-repairs", [])->assertUnprocessable();

        // Repair + donor part together is fine too.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$repairOnly->sub_issue_id}/log-repairs", ['tested_ok' => true, 
            'repair_logs' => 'Fitted the part and re-torqued.', 'repair_type' => 'cannibalized', 'part_needed' => 'Hose',  'source_vehicle_id' => $donor->vehicle_id,
        ])->assertOk();
        $this->assertSame('For Verification', $ticket->fresh()->status);
    }

    #[Test]
    public function closing_a_ticket_notifies_admins_and_counts_in_their_tickets_badge(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Loose bolt']);

        Sanctum::actingAs($this->admin, ['*']);
        $before = $this->getJson('/api/dashboard')->json('badge_counts.tickets');

        $this->driveTicketToClosed($ticket);

        $this->assertTrue(\App\Models\Notification::where('user_id', $this->admin->id)
            ->where('type', 'ticket_closed')->where('ticket_id', $ticket->ticket_id)->exists());
        Sanctum::actingAs($this->admin, ['*']);
        $this->assertSame($before + 1, $this->getJson('/api/dashboard')->json('badge_counts.tickets'));
    }
}
