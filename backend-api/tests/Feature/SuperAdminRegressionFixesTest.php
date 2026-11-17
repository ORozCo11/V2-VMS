<?php

namespace Tests\Feature;

use App\Models\{ActivityLog, Barangay, City, MaintenanceTicket, Province, TicketSubIssue, User, Vehicle, VehicleCategory, VehicleMaintenanceSchedule};
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class SuperAdminRegressionFixesTest extends TestCase
{
    use RefreshDatabase;

    private User $superAdmin;
    private Barangay $barangay;

    protected function setUp(): void
    {
        parent::setUp();
        $province = Province::create(['code' => 'QA', 'name' => 'QA Province']);
        $city = City::create(['code' => 'QA-CITY', 'name' => 'QA City', 'province_id' => $province->id]);
        $this->barangay = Barangay::create(['name' => 'QA Barangay', 'city_id' => $city->id, 'psgc_code' => '9999900001']);
        $this->superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin'], 'barangay_id' => null]);
        Sanctum::actingAs($this->superAdmin, ['*']);
    }

    private function user(array $roles): User
    {
        return User::factory()->create(['role' => $roles[0], 'roles' => $roles, 'barangay_id' => $this->barangay->id, 'approved_at' => now()]);
    }

    private function vehicle(): Vehicle
    {
        $category = VehicleCategory::create(['category_name' => 'QA Ambulance']);
        return Vehicle::create(['vehicle_name' => 'QA Ambulance', 'plate_number' => 'QA-1001', 'category_id' => $category->category_id,
            'brand' => 'Toyota', 'model' => 'HiAce', 'year_model' => 2022, 'capacity' => '12 pax', 'vehicle_color' => 'White',
            'current_location' => 'QA Depot', 'barangay_id' => $this->barangay->id]);
    }

    public function test_provisioned_reference_is_visible_after_reload_even_without_boundary_code_or_users(): void
    {
        $this->getJson('/api/superadmin/barangays')->assertOk()->assertJsonCount(0);
        $payload = ['city_id' => $this->barangay->city_id, 'barangay_id' => $this->barangay->id];
        $this->postJson('/api/superadmin/barangays', $payload)->assertCreated();
        $stamp = $this->barangay->fresh()->provisioned_at;
        $this->assertNotNull($stamp);
        $this->getJson('/api/superadmin/barangays')->assertOk()->assertJsonPath('0.id', $this->barangay->id);
        $this->travel(1)->days();
        $this->postJson('/api/superadmin/barangays', $payload)->assertCreated();
        $this->assertTrue($stamp->equalTo($this->barangay->fresh()->provisioned_at));
    }

    public function test_provision_and_refresh_preserve_reviewed_status_and_real_staff_counts(): void
    {
        $this->user(['Admin']);
        $geometry = ['type' => 'Polygon', 'coordinates' => [[[123, 10], [124, 10], [124, 11], [123, 10]]]];
        $this->barangay->update(['boundary' => $geometry, 'boundary_status' => 'verified', 'boundary_source' => 'uploaded_reference: QA survey', 'boundary_verified_by' => $this->superAdmin->id]);
        $this->postJson('/api/superadmin/barangays', ['city_id' => $this->barangay->city_id, 'barangay_id' => $this->barangay->id])
            ->assertCreated()->assertJsonPath('staff_count', 1)->assertJsonPath('has_active_admin', true)->assertJsonPath('boundary_status', 'verified');
        $this->postJson("/api/superadmin/barangays/{$this->barangay->id}/boundary/refresh")->assertOk()->assertJsonPath('boundary_status', 'verified');
    }

    public function test_role_change_cannot_strand_schedule_but_can_retain_its_required_role(): void
    {
        $mechanic = $this->user(['Custodian', 'Maintenance Personnel']);
        $schedule = VehicleMaintenanceSchedule::create(['vehicle_id' => $this->vehicle()->vehicle_id, 'maintenance_type' => 'Oil Change', 'scheduled_date' => now()->addWeek()->toDateString(), 'created_by' => $mechanic->id, 'assigned_to' => $mechanic->id, 'status' => 'Scheduled']);
        $url = "/api/superadmin/users/{$mechanic->id}/role";
        $this->putJson($url, ['role' => 'Custodian'])->assertUnprocessable()->assertJsonCount(1, 'open_work');
        $this->assertSame(['Custodian', 'Maintenance Personnel'], $mechanic->fresh()->roles);
        $this->assertSame($mechanic->id, $schedule->fresh()->assigned_to);
        $this->putJson($url, ['role' => 'Maintenance Personnel'])->assertOk();
        $this->assertSame(['Maintenance Personnel'], $mechanic->fresh()->roles);
    }

    public function test_role_change_protects_ticket_custodian_and_sub_issue_mechanic(): void
    {
        $custodian = $this->user(['Custodian']);
        $mechanic = $this->user(['Maintenance Personnel']);
        $ticket = MaintenanceTicket::create(['vehicle_id' => $this->vehicle()->vehicle_id, 'created_by' => $custodian->id, 'ticket_title' => 'QA ticket', 'ticket_description' => 'QA assigned-work regression', 'assigned_custodian_id' => $custodian->id, 'status' => 'Open']);
        TicketSubIssue::create(['ticket_id' => $ticket->ticket_id, 'created_by' => $custodian->id, 'title' => 'QA repair', 'assigned_mechanic_id' => $mechanic->id, 'status' => 'Under Repair']);
        $this->putJson("/api/superadmin/users/{$custodian->id}/role", ['role' => 'Maintenance Personnel'])->assertUnprocessable();
        $this->putJson("/api/superadmin/users/{$mechanic->id}/role", ['role' => 'Admin'])->assertUnprocessable();
        $this->assertSame('Custodian', $custodian->fresh()->role);
        $this->assertSame('Maintenance Personnel', $mechanic->fresh()->role);
    }

    public function test_tenant_admin_cannot_bypass_work_guard_by_editing_roles(): void
    {
        $admin = $this->user(['Admin']);
        $mechanic = $this->user(['Maintenance Personnel']);
        VehicleMaintenanceSchedule::create(['vehicle_id' => $this->vehicle()->vehicle_id, 'maintenance_type' => 'Oil Change', 'scheduled_date' => now()->addWeek()->toDateString(), 'created_by' => $admin->id, 'assigned_to' => $mechanic->id, 'status' => 'Scheduled']);
        Sanctum::actingAs($admin, ['*']);
        $this->putJson("/api/users/{$mechanic->id}", ['roles' => ['Custodian']])->assertUnprocessable();
        // One role per account: a second role is rejected, and keeping the same role is fine.
        $this->putJson("/api/users/{$mechanic->id}", ['roles' => ['Custodian', 'Maintenance Personnel']])->assertUnprocessable();
        $this->putJson("/api/users/{$mechanic->id}", ['roles' => ['Maintenance Personnel']])->assertOk();
    }

    public function test_primary_role_can_be_retained_while_secondary_role_is_removed_when_no_open_work(): void
    {
        $user = $this->user(['Custodian', 'Maintenance Personnel']);
        $this->putJson("/api/superadmin/users/{$user->id}/role", ['role' => 'Custodian'])->assertOk();
        $this->assertSame(['Custodian'], $user->fresh()->roles);
    }

    public function test_paginated_activity_search_covers_older_entries_and_excludes_fleet_details(): void
    {
        for ($i = 0; $i < 205; $i++) ActivityLog::create(['user_id' => $this->superAdmin->id, 'role' => 'Super Admin', 'action' => 'Edit', 'module' => 'Super Admin', 'details' => "QA history {$i}"]);
        ActivityLog::create(['user_id' => $this->superAdmin->id, 'role' => 'Admin', 'action' => 'Edit', 'module' => 'Maintenance Tickets', 'details' => 'QA history 0']);
        $this->getJson('/api/superadmin/activity-log?paginate=1&per_page=100&page=3')->assertOk()->assertJsonPath('total', 205)->assertJsonCount(5, 'data')->assertJsonPath('data.4.details', 'QA history 0');
        $this->getJson('/api/superadmin/activity-log?paginate=1&q=QA%20history%200')->assertOk()->assertJsonPath('total', 1)->assertJsonPath('data.0.details', 'QA history 0');
        $this->getJson('/api/superadmin/activity-log?paginate=1&scope=superadmin')->assertOk()->assertJsonPath('total', 205);
        $this->getJson('/api/superadmin/activity-log?paginate=1&per_page=1000')->assertUnprocessable();
        $this->getJson('/api/superadmin/activity-log?paginate=1&page=0')->assertUnprocessable();
    }

    public function test_activity_search_preserves_literal_case_insensitive_substring_behavior(): void
    {
        ActivityLog::create(['user_id' => $this->superAdmin->id, 'role' => 'Super Admin', 'action' => 'Edit', 'module' => 'Super Admin', 'details' => 'QA marker 10%_ready!']);
        ActivityLog::create(['user_id' => $this->superAdmin->id, 'role' => 'Super Admin', 'action' => 'Edit', 'module' => 'Super Admin', 'details' => 'QA marker 10XXready']);
        $this->getJson('/api/superadmin/activity-log?paginate=1&q='.urlencode('MARKER 10%_READY!'))->assertOk()->assertJsonPath('total', 1)->assertJsonPath('data.0.details', 'QA marker 10%_ready!');
    }

    public function test_pending_schedule_assignment_is_protected_before_approval(): void
    {
        $mechanic = $this->user(['Maintenance Personnel']);
        VehicleMaintenanceSchedule::create(['vehicle_id' => $this->vehicle()->vehicle_id, 'maintenance_type' => 'Oil Change', 'scheduled_date' => now()->addWeek()->toDateString(), 'created_by' => $mechanic->id, 'assigned_to' => $mechanic->id, 'status' => 'Pending Approval']);
        $this->putJson("/api/superadmin/users/{$mechanic->id}/role", ['role' => 'Custodian'])->assertUnprocessable();
        $this->putJson("/api/superadmin/users/{$mechanic->id}/deactivate")->assertNotFound(); // staff accounts are the barangay Admin's, not the Super Admin's
        $this->assertSame(['Maintenance Personnel'], $mechanic->fresh()->roles);
    }

    public function test_orphan_recovery_preserves_roles_needed_for_open_work(): void
    {
        $custodian = $this->user(['Custodian']);
        MaintenanceTicket::create(['vehicle_id' => $this->vehicle()->vehicle_id, 'created_by' => $custodian->id, 'ticket_title' => 'QA ticket', 'ticket_description' => 'QA recovery regression', 'assigned_custodian_id' => $custodian->id, 'status' => 'Open']);
        $this->putJson("/api/superadmin/users/{$custodian->id}/role", ['role' => 'Admin'])->assertUnprocessable();
        $this->putJson("/api/superadmin/users/{$custodian->id}/role", ['role' => 'Admin', 'preserve_roles' => true])->assertOk();
        $this->assertSame('Admin', $custodian->fresh()->role);
        $this->assertEqualsCanonicalizing(['Custodian', 'Admin'], $custodian->fresh()->roles);
        $this->getJson('/api/superadmin/barangays')->assertOk()->assertJsonPath('0.has_active_admin', true);
    }
}
