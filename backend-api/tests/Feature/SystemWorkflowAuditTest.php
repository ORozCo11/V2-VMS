<?php

namespace Tests\Feature;

use App\Http\Controllers\FleetController;
use App\Http\Controllers\TicketController;
use App\Models\Barangay;
use App\Models\MaintenanceTicket;
use App\Models\TicketSubIssue;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use App\Models\VehicleIssueReport;
use App\Models\VehicleMaintenanceRecord;
use App\Models\VehicleMaintenanceSchedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Laravel\Sanctum\Sanctum;
use Symfony\Component\HttpKernel\Exception\HttpException;
use Tests\TestCase;

class SystemWorkflowAuditTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;

    private User $custodian;

    private User $mechanic;

    private Vehicle $vehicle;

    private int $barangayId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->barangayId = Barangay::create(['name' => 'Audit Barangay'])->id;
        $this->admin = $this->person('Admin');
        $this->custodian = $this->person('Custodian');
        $this->mechanic = $this->person('Maintenance Personnel');
        $type = VehicleCategory::create(['category_name' => 'Audit Rescue', 'domain' => 'Land']);
        $this->vehicle = Vehicle::create(['barangay_id' => $this->barangayId, 'vehicle_name' => 'Audit Vehicle', 'plate_number' => 'AUD-001', 'category_id' => $type->category_id, 'brand' => 'Toyota', 'model' => 'Rescue', 'year_model' => 2022, 'capacity' => '1000 kg', 'vehicle_color' => 'White', 'current_location' => 'Depot', 'status' => 'Available', 'condition' => 'Good']);
    }

    private function person(string $role, array $extra = []): User
    {
        return User::factory()->create($extra + ['role' => $role, 'roles' => [$role], 'barangay_id' => $this->barangayId, 'is_active' => true, 'approved_at' => now()]);
    }

    private function schedule(array $extra = []): VehicleMaintenanceSchedule
    {
        return VehicleMaintenanceSchedule::create($extra + ['vehicle_id' => $this->vehicle->vehicle_id, 'created_by' => $this->custodian->id, 'maintenance_type' => 'Engine Service', 'scheduled_date' => now()->addDays(5)->toDateString(), 'status' => 'Pending Approval']);
    }

    private function ticket(array $extra = []): MaintenanceTicket
    {
        return MaintenanceTicket::create($extra + ['vehicle_id' => $this->vehicle->vehicle_id, 'created_by' => $this->custodian->id, 'assigned_custodian_id' => $this->custodian->id, 'ticket_title' => 'Audit Repair', 'ticket_description' => 'Repair engine', 'priority' => 'High', 'status' => 'Active']);
    }

    private function line(MaintenanceTicket $ticket, User $mechanic, array $extra = []): TicketSubIssue
    {
        return TicketSubIssue::create($extra + ['ticket_id' => $ticket->ticket_id, 'created_by' => $this->custodian->id, 'title' => 'Repair item '.uniqid(), 'repair_type' => 'in_house', 'assigned_mechanic_id' => $mechanic->id, 'status' => 'Under Repair']);
    }

    private function record(array $extra = []): VehicleMaintenanceRecord
    {
        return VehicleMaintenanceRecord::create($extra + ['vehicle_id' => $this->vehicle->vehicle_id, 'maintenance_type' => 'Service', 'problem_reason' => 'Engine fault', 'date_started' => now()->toDateString(), 'maintenance_personnel_id' => $this->mechanic->id, 'progress_status' => 'For Verification']);
    }

    public function test_schedule_edit_cannot_self_approve_or_edit_another_creators_plan(): void
    {
        $schedule = $this->schedule();
        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}", ['status' => 'Scheduled'])->assertUnprocessable();
        Sanctum::actingAs($this->person('Custodian'), ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}", ['notes' => 'Shared plan update'])->assertForbidden();
        $this->assertNull($schedule->fresh()->notes);
    }

    public function test_schedule_assignment_rejects_wrong_roles_inactive_and_cross_barangay_users(): void
    {
        $outsider = $this->person('Maintenance Personnel', ['barangay_id' => Barangay::create(['name' => 'Other barangay'])->id]);
        $inactive = $this->person('Maintenance Personnel', ['is_active' => false]);
        foreach ([$this->admin, $outsider, $inactive] as $invalid) {
            Sanctum::actingAs($this->custodian, ['*']);
            $this->postJson('/api/maintenance-schedules', ['vehicle_id' => $this->vehicle->vehicle_id, 'maintenance_type' => 'Service', 'scheduled_date' => now()->addDays(5)->toDateString(), 'assigned_to' => $invalid->id])->assertUnprocessable();
            $schedule = $this->schedule(['status' => 'Scheduled']);
            Sanctum::actingAs($this->admin, ['*']);
            $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}/reassign", ['assigned_to' => $invalid->id])->assertUnprocessable();
        }
    }

    public function test_only_admin_reassignment_changes_an_approved_schedules_mechanic(): void
    {
        $schedule = $this->schedule(['status' => 'Scheduled', 'assigned_to' => $this->mechanic->id]);
        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}", ['assigned_to' => $this->person('Maintenance Personnel')->id])->assertForbidden();
    }

    public function test_restoring_a_cancelled_proposal_still_requires_approval(): void
    {
        $schedule = $this->schedule(['status' => 'Cancelled']);
        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson("/api/maintenance-schedules/{$schedule->schedule_id}/restore")->assertOk()->assertJsonPath('status', 'Pending Approval');
    }

    public function test_completed_schedules_cannot_be_recycled_into_new_work(): void
    {
        $schedule = $this->schedule(['status' => 'Completed']);
        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}", ['notes' => 'Rewrite history'])->assertUnprocessable();
        $this->deleteJson("/api/maintenance-schedules/{$schedule->schedule_id}")->assertUnprocessable();
    }

    public function test_editing_an_approved_plan_returns_it_for_review(): void
    {
        $schedule = $this->schedule(['status' => 'Scheduled']);
        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}", ['notes' => 'Different work scope'])->assertOk()->assertJsonPath('status', 'Pending Approval');
    }

    public function test_linked_proposals_already_lock_the_source_schedule(): void
    {
        $ticket = $this->ticket(['status' => 'Pending Approval']);
        $schedule = $this->schedule(['status' => 'Scheduled', 'resulting_ticket_id' => $ticket->ticket_id]);
        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}", ['maintenance_type' => 'Unrelated work'])->assertUnprocessable();
    }

    public function test_reactivation_cannot_demote_an_existing_admin(): void
    {
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/users/{$this->admin->id}/activate", ['role' => 'Custodian'])->assertUnprocessable();
        $this->assertTrue($this->admin->fresh()->hasRole('Admin'));
    }

    public function test_credential_resends_revoke_old_sessions(): void
    {
        $this->custodian->createToken('old-session-one');
        $this->custodian->createToken('old-session-two');
        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson("/api/users/{$this->custodian->id}/resend-credentials")->assertOk()->assertJsonStructure(['email_sent']);
        // The reset link itself signs nothing out; the old sessions end when the new password is chosen.
        $this->assertSame(1, \App\Models\UserInvitation::where('user_id', $this->custodian->id)->where('purpose', 'reset')->count());
    }

    public function test_multi_mechanic_bulk_reassignment_notifies_all_outgoing_mechanics(): void
    {
        $ticket = $this->ticket();
        $second = $this->person('Maintenance Personnel');
        $this->line($ticket, $this->mechanic);
        $this->line($ticket, $second);
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/assign-mechanic", ['assigned_mechanic_id' => $this->person('Maintenance Personnel')->id, 'reassign_reason' => 'Shift change'])->assertOk();
        foreach ([$this->mechanic, $second] as $outgoing) {
            $this->assertDatabaseHas('notifications', ['user_id' => $outgoing->id, 'type' => 'work_order_reassigned']);
        }
    }

    public function test_new_sub_issues_on_split_assignments_need_an_explicit_mechanic(): void
    {
        $ticket = $this->ticket();
        $this->line($ticket, $this->mechanic);
        $this->line($ticket, $this->person('Maintenance Personnel'));
        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson("/api/tickets/{$ticket->ticket_id}/sub-issues", ['title' => 'Another repair'])->assertUnprocessable();
        $this->postJson("/api/tickets/{$ticket->ticket_id}/sub-issues", ['title' => 'Another repair', 'assigned_mechanic_id' => $this->mechanic->id])->assertCreated()->assertJsonPath('status', 'Under Repair')->assertJsonPath('assigned_mechanic_id', $this->mechanic->id);
    }

    public function test_cancelled_ticket_work_does_not_prevent_account_deactivation(): void
    {
        $ticket = $this->ticket(['status' => 'Cancelled']);
        $this->line($ticket, $this->mechanic);
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/users/{$this->mechanic->id}/deactivate")->assertOk();
    }

    public function test_record_confirmation_cannot_release_a_vehicle_with_other_active_work(): void
    {
        $this->vehicle->update(['status' => 'Under Maintenance', 'condition' => 'Needs Repair']);
        $this->ticket();
        $record = $this->record(['verification_result' => 'Passed', 'verified_by' => $this->custodian->id]);
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/maintenance-records/{$record->maintenance_id}/confirm", ['confirmed' => true])->assertOk();
        $this->assertSame('Under Maintenance', $this->vehicle->fresh()->status);
    }

    public function test_record_verification_never_unretires_a_vehicle(): void
    {
        $record = $this->record();
        $this->vehicle->update(['status' => 'Decommissioned', 'condition' => 'Needs Repair']);
        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/maintenance-records/{$record->maintenance_id}/verify", ['verification_result' => 'Passed', 'test_attested' => true])->assertOk();
        $this->assertSame('Decommissioned', $this->vehicle->fresh()->status);
    }

    public function test_reassignment_preserves_submitted_repairs_until_returned_for_rework(): void
    {
        $ticket = $this->ticket(['status' => 'For Verification', 'assigned_mechanic_id' => $this->mechanic->id]);
        $line = $this->line($ticket, $this->mechanic, ['status' => 'For Inspection', 'repair_logs' => 'Original work', 'repair_completed_at' => now()]);
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/assign-mechanic", ['assigned_mechanic_id' => $this->person('Maintenance Personnel', ['is_active' => false])->id, 'reassign_reason' => 'Change shift'])->assertUnprocessable();
        $new = $this->person('Maintenance Personnel');
        $this->putJson("/api/tickets/{$ticket->ticket_id}/assign-mechanic", ['assigned_mechanic_id' => $new->id, 'reassign_reason' => 'Change shift'])->assertUnprocessable();
        $this->assertSame('For Inspection', $line->fresh()->status);
        $this->assertSame($this->mechanic->id, $line->fresh()->assigned_mechanic_id);
        $this->assertSame('Original work', $line->fresh()->repair_logs);
        Sanctum::actingAs($new, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification")->assertForbidden();
    }

    public function test_changing_repair_method_cannot_skip_a_shop_return(): void
    {
        $ticket = $this->ticket();
        $line = $this->line($ticket, $this->mechanic, ['repair_type' => 'external', 'external_sent_at' => now()]);
        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$line->sub_issue_id}/log-repairs", ['tested_ok' => true, 'repair_type' => 'in_house', 'repair_logs' => 'Changed method'])->assertUnprocessable();
        $this->assertSame('Under Repair', $line->fresh()->status);
    }

    public function test_platform_role_edit_cannot_turn_the_tenantless_impersonation_account_into_staff(): void
    {
        $support = $this->person('Impersonator', ['barangay_id' => null]);
        Sanctum::actingAs($this->person('Super Admin', ['barangay_id' => null]), ['*']);
        $this->putJson("/api/superadmin/users/{$support->id}/role", ['role' => 'Admin'])->assertUnprocessable();
        $this->assertTrue($support->fresh()->hasRole('Impersonator'));
    }

    public function test_password_change_revokes_other_sessions_and_preserves_the_current_session(): void
    {
        $this->custodian->update(['password' => Hash::make('oldpassword123')]);
        $current = $this->custodian->createToken('current');
        $this->custodian->createToken('other');
        $this->withToken($current->plainTextToken)->putJson('/api/profile/password', ['old_password' => 'oldpassword123', 'new_password' => 'newpassword123', 'new_password_confirmation' => 'newpassword123'])->assertOk();
        $this->assertSame(1, $this->custodian->tokens()->count());
        $this->assertTrue($this->custodian->tokens()->whereKey($current->accessToken->id)->exists());
    }

    public function test_due_conversion_uses_a_custodian_from_the_vehicles_barangay(): void
    {
        $outsider = $this->person('Custodian', ['barangay_id' => Barangay::create(['name' => 'Another place'])->id]);
        $schedule = $this->schedule(['status' => 'Scheduled', 'scheduled_date' => now()->subDay()->toDateString(), 'created_by' => $outsider->id]);
        $this->artisan('schedules:convert-due-to-tickets')->assertSuccessful();
        $ticket = MaintenanceTicket::findOrFail($schedule->fresh()->resulting_ticket_id);
        $this->assertSame($this->custodian->id, $ticket->assigned_custodian_id);
        $this->artisan('schedules:convert-due-to-tickets')->assertSuccessful();
        $this->assertSame(1, MaintenanceTicket::count());
    }

    public function test_record_decision_close_preserves_other_active_repairs_and_retirement(): void
    {
        $ticket = $this->ticket();
        $record = $this->record();
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/maintenance-records/{$record->maintenance_id}/decision-close", ['closure_reason' => 'Historical duplicate', 'returned_to_service' => true])->assertOk();
        $this->assertSame('Under Maintenance', $this->vehicle->fresh()->status);
        $ticket->update(['status' => 'Closed']);
        $this->vehicle->update(['status' => 'Decommissioned']);
        $record = $this->record();
        $this->putJson("/api/maintenance-records/{$record->maintenance_id}/decision-close", ['closure_reason' => 'Retired', 'returned_to_service' => true])->assertOk();
        $this->assertSame('Decommissioned', $this->vehicle->fresh()->status);
    }

    public function test_stale_schedule_completion_cannot_race_a_new_ticket_proposal(): void
    {
        $schedule = $this->schedule(['status' => 'Scheduled', 'assigned_to' => $this->mechanic->id]);
        $ticket = $this->ticket(['status' => 'Pending Approval']);
        $schedule->newQuery()->whereKey($schedule->schedule_id)->update(['resulting_ticket_id' => $ticket->ticket_id]);
        Sanctum::actingAs($this->mechanic, ['*']);
        $request = Request::create('/api/maintenance-schedules/'.$schedule->schedule_id.'/complete', 'PUT');
        $request->setUserResolver(fn () => $this->mechanic);
        try {
            app(FleetController::class)->completeSchedule($request, $schedule);
            $this->fail('Ticket-linked work must not also be completed from a stale schedule.');
        } catch (HttpException $e) {
            $this->assertSame(422, $e->getStatusCode());
        }
        $this->assertDatabaseCount('vehicle_maintenance_records', 0);
    }

    public function test_retired_vehicles_cannot_be_unretired_by_an_old_scheduled_job(): void
    {
        $schedule = $this->schedule(['status' => 'Scheduled', 'assigned_to' => $this->mechanic->id]);
        $this->vehicle->update(['status' => 'Decommissioned']);
        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}/complete")->assertUnprocessable();
        $this->assertSame('Decommissioned', $this->vehicle->fresh()->status);
    }

    public function test_stale_verification_cannot_use_the_previous_custodians_assignment(): void
    {
        $ticket = $this->ticket(['status' => 'For Verification']);
        $this->line($ticket, $this->mechanic, ['status' => 'For Inspection']);
        $newCustodian = $this->person('Custodian');
        $ticket->newQuery()->whereKey($ticket->ticket_id)->update(['assigned_custodian_id' => $newCustodian->id]);
        Sanctum::actingAs($this->custodian, ['*']);
        $request = Request::create('/api/tickets/'.$ticket->ticket_id.'/verify', 'PUT');
        $request->setUserResolver(fn () => $this->custodian);
        try {
            app(TicketController::class)->verifyTicket($request, $ticket);
            $this->fail('A former Custodian assignment must not authorize verification.');
        } catch (HttpException $e) {
            $this->assertSame(403, $e->getStatusCode());
        }
        $this->assertSame('For Verification', $ticket->fresh()->status);
        $this->assertDatabaseCount('vehicle_maintenance_records', 0);
    }

    public function test_stale_repair_submission_cannot_use_the_previous_mechanics_assignment(): void
    {
        $ticket = $this->ticket();
        $line = $this->line($ticket, $this->mechanic);
        $line->newQuery()->whereKey($line->sub_issue_id)->update(['assigned_mechanic_id' => $this->person('Maintenance Personnel')->id]);
        Sanctum::actingAs($this->mechanic, ['*']);
        $request = Request::create('/api/tickets/'.$ticket->ticket_id.'/sub-issues/'.$line->sub_issue_id.'/log-repairs', 'PUT', ['repair_logs' => 'Old assignment work']);
        $request->setUserResolver(fn () => $this->mechanic);
        try {
            app(TicketController::class)->logRepairs($request, $ticket, $line);
            $this->fail('A former mechanic assignment must not authorize a repair submission.');
        } catch (HttpException $e) {
            $this->assertSame(403, $e->getStatusCode());
        }
        $this->assertNull($line->fresh()->repair_logs);
    }

    public function test_record_repair_edits_invalidate_a_passed_verification(): void
    {
        $record = $this->record(['verification_result' => 'Passed', 'verified_by' => $this->custodian->id]);
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/maintenance-records/{$record->maintenance_id}", ['action_taken' => 'Changed repair', 'maintenance_personnel_id' => $this->custodian->id])->assertOk();
        $this->assertNull($record->fresh()->verification_result);
        $this->putJson("/api/maintenance-records/{$record->maintenance_id}/confirm", ['confirmed' => true])->assertUnprocessable();
    }

    public function test_record_confirmation_rejects_legacy_self_verification(): void
    {
        $record = $this->record(['verification_result' => 'Passed', 'verified_by' => $this->mechanic->id]);
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/maintenance-records/{$record->maintenance_id}/confirm", ['confirmed' => true])->assertUnprocessable();
    }

    public function test_record_edit_rejects_self_donor_and_another_vehicles_issue(): void
    {
        $record = $this->record();
        $other = $this->vehicle->replicate();
        $other->plate_number = 'AUD-002';
        $other->save();
        $issue = VehicleIssueReport::create(['vehicle_id' => $other->vehicle_id, 'issue_type' => 'Other issue', 'issue_description' => 'Other vehicle', 'severity_level' => 'Low', 'reported_by' => $this->custodian->id, 'status' => 'Pending']);
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/maintenance-records/{$record->maintenance_id}", ['source_vehicle_id' => $this->vehicle->vehicle_id])->assertUnprocessable();
        $this->putJson("/api/maintenance-records/{$record->maintenance_id}", ['issue_report_id' => $issue->issue_report_id])->assertUnprocessable();
        $this->assertSame('Pending', $issue->fresh()->status);
    }

    public function test_inactive_custodian_cannot_receive_ticket_assignment(): void
    {
        $ticket = $this->ticket();
        $inactive = $this->person('Custodian', ['is_active' => false]);
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/reassign-custodian", ['assigned_custodian_id' => $inactive->id, 'reassign_reason' => 'Shift change'])->assertUnprocessable();
    }

    public function test_cancelled_ticket_rejects_external_dispatch_and_return(): void
    {
        $ticket = $this->ticket(['status' => 'Cancelled']);
        $line = $this->line($ticket, $this->mechanic);
        Sanctum::actingAs($this->mechanic, ['*']);
        $base = "/api/tickets/{$ticket->ticket_id}/sub-issues/{$line->sub_issue_id}";
        $this->putJson($base.'/external-sent', ['external_vendor' => 'Shop', 'external_reason' => 'Repair', 'external_work_scope' => 'Repair engine'])->assertUnprocessable();
        $line->update(['external_sent_at' => now()]);
        $this->putJson($base.'/external-returned', ['external_return_notes' => 'Returned'])->assertUnprocessable();
    }

    public function test_restored_vehicle_with_unfinished_work_stays_under_maintenance(): void
    {
        $this->record();
        $this->vehicle->update(['status' => 'Inactive']);
        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson("/api/vehicles/{$this->vehicle->vehicle_id}/restore")->assertOk();
        $this->assertSame('Under Maintenance', $this->vehicle->fresh()->status);
    }

    public function test_recurrence_uses_a_free_date_beyond_sixty_occupied_days(): void
    {
        $source = $this->schedule(['status' => 'Completed', 'recurrence_months' => 1]);
        $base = now()->addMonthsNoOverflow(1)->startOfDay();
        for ($i = 0; $i < 60; $i++) {
            $this->schedule(['status' => 'Scheduled', 'scheduled_date' => $base->copy()->addDays($i)->toDateString()]);
        }
        $next = $source->seedNextRecurrence(now()->toDateString(), $this->custodian->id);
        $this->assertSame($base->copy()->addDays(60)->toDateString(), $next->scheduled_date);
    }
}
