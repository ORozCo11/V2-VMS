<?php

namespace Tests\Feature;

use App\Models\Barangay;
use App\Models\City;
use App\Models\MaintenanceTicket;
use App\Models\Province;
use App\Models\TicketSubIssue;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use App\Models\VehicleMaintenanceSchedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * VMS-IMPROVEMENT-PLAN.md Phase B5 — deactivating a user with open assigned
 * work (an open ticket as its Custodian, an unresolved sub-issue as its
 * mechanic, or a Scheduled maintenance schedule) is blocked until it's
 * reassigned. Deliberately does NOT cover "custodian of a vehicle" — no such
 * column exists yet (that's Phase D11); see GuardsOpenWorkOnDeactivation's
 * docblock.
 */
class PhaseB5DeactivationGuardTest extends TestCase
{
    use RefreshDatabase;

    private int $barangayId;
    private User $admin;
    private User $custodian;
    private User $mechanic;

    protected function setUp(): void
    {
        parent::setUp();
        $province = Province::create(['code' => 'TST', 'name' => 'Test Province']);
        $city = City::create(['province_id' => $province->id, 'code' => 'TSTC', 'name' => 'Test City']);
        $this->barangayId = Barangay::create(['name' => 'Test Barangay', 'city_id' => $city->id])->id;

        $this->admin = $this->user('Admin');
        $this->custodian = $this->user('Custodian');
        $this->mechanic = $this->user('Maintenance Personnel');
    }

    private function user(string $role): User
    {
        return User::factory()->create([
            'role' => $role, 'roles' => [$role], 'barangay_id' => $this->barangayId, 'is_active' => true,
        ]);
    }

    private function vehicle(): Vehicle
    {
        $category = VehicleCategory::create([
            'category_name' => 'Ambulance ' . uniqid(),
            'description' => 'For testing',
        ]);

        return Vehicle::create([
            'vehicle_name' => 'Test Ambulance',
            'plate_number' => 'TST ' . random_int(1000, 9999),
            'category_id' => $category->category_id,
            'brand' => 'Toyota',
            'model' => 'HiAce',
            'year_model' => 2022,
            'capacity' => '1000 kg',
            'vehicle_color' => 'White',
            'current_location' => 'Main Depot',
            'barangay_id' => $this->barangayId,
        ]);
    }

    // =======================================================================
    // Blocked cases
    // =======================================================================

    #[Test]
    public function cannot_deactivate_a_custodian_who_is_assigned_to_an_open_ticket(): void
    {
        $ticket = MaintenanceTicket::create([
            'vehicle_id' => $this->vehicle()->vehicle_id,
            'created_by' => $this->admin->id,
            'ticket_title' => 'Overheating',
            'ticket_description' => 'Runs hot.',
            'assigned_custodian_id' => $this->custodian->id,
            'status' => 'Open',
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $response = $this->putJson("/api/users/{$this->custodian->id}/deactivate")
            ->assertStatus(422);

        $this->assertStringContainsString((string) $ticket->ticket_id, $response->json('open_work.0'));
        $this->assertTrue($this->custodian->fresh()->is_active);
    }

    #[Test]
    public function cannot_deactivate_a_mechanic_assigned_to_an_unresolved_sub_issue(): void
    {
        $ticket = MaintenanceTicket::create([
            'vehicle_id' => $this->vehicle()->vehicle_id,
            'created_by' => $this->admin->id,
            'ticket_title' => 'Brake noise',
            'ticket_description' => 'Squeaking.',
        ]);
        TicketSubIssue::create([
            'ticket_id' => $ticket->ticket_id,
            'created_by' => $this->admin->id,
            'title' => 'Worn pads',
            'assigned_mechanic_id' => $this->mechanic->id,
            'status' => 'Under Repair',
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/users/{$this->mechanic->id}/deactivate")->assertStatus(422);
        $this->assertTrue($this->mechanic->fresh()->is_active);
    }

    #[Test]
    public function cannot_deactivate_someone_assigned_to_a_scheduled_maintenance_entry(): void
    {
        VehicleMaintenanceSchedule::create([
            'vehicle_id' => $this->vehicle()->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => now()->addWeek()->toDateString(),
            'created_by' => $this->admin->id,
            'assigned_to' => $this->mechanic->id,
            'status' => 'Scheduled',
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/users/{$this->mechanic->id}/deactivate")->assertStatus(422);
        $this->assertTrue($this->mechanic->fresh()->is_active);
    }

    #[Test]
    public function a_deferred_sub_issue_does_not_block_deactivation(): void
    {
        $ticket = MaintenanceTicket::create([
            'vehicle_id' => $this->vehicle()->vehicle_id,
            'created_by' => $this->admin->id,
            'ticket_title' => 'Brake noise',
            'ticket_description' => 'Squeaking.',
        ]);
        TicketSubIssue::create([
            'ticket_id' => $ticket->ticket_id,
            'created_by' => $this->admin->id,
            'title' => 'Worn pads',
            'assigned_mechanic_id' => $this->mechanic->id,
            'status' => 'Deferred',
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/users/{$this->mechanic->id}/deactivate")->assertOk();
        $this->assertFalse($this->mechanic->fresh()->is_active);
    }

    #[Test]
    public function super_admin_deactivation_is_blocked_by_the_same_open_work_guard(): void
    {
        $ticket = MaintenanceTicket::create([
            'vehicle_id' => $this->vehicle()->vehicle_id,
            'created_by' => $this->admin->id,
            'ticket_title' => 'Overheating',
            'ticket_description' => 'Runs hot.',
            'assigned_custodian_id' => $this->custodian->id,
            'status' => 'Open',
        ]);

        $superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin']]);
        Sanctum::actingAs($superAdmin, ['*']);
        // A Super Admin manages Barangay Admins only; staff accounts belong to the barangay Admin.
        $this->putJson("/api/superadmin/users/{$this->custodian->id}/deactivate")->assertNotFound();
        $this->assertTrue($this->custodian->fresh()->is_active);
    }

    // =======================================================================
    // The unblock path — reassignSchedule()
    // =======================================================================

    #[Test]
    public function admin_can_reassign_a_scheduled_entry_then_deactivate_the_original_assignee(): void
    {
        $otherMechanic = $this->user('Maintenance Personnel');
        $schedule = VehicleMaintenanceSchedule::create([
            'vehicle_id' => $this->vehicle()->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => now()->addWeek()->toDateString(),
            'created_by' => $this->admin->id,
            'assigned_to' => $this->mechanic->id,
            'status' => 'Scheduled',
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}/reassign", [
            'assigned_to' => $otherMechanic->id,
        ])->assertOk();

        $this->assertSame($otherMechanic->id, $schedule->fresh()->assigned_to);

        $this->putJson("/api/users/{$this->mechanic->id}/deactivate")->assertOk();
        $this->assertFalse($this->mechanic->fresh()->is_active);
    }

    #[Test]
    public function a_custodian_cannot_reassign_a_schedule(): void
    {
        $otherMechanic = $this->user('Maintenance Personnel');
        $schedule = VehicleMaintenanceSchedule::create([
            'vehicle_id' => $this->vehicle()->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => now()->addWeek()->toDateString(),
            'created_by' => $this->admin->id,
            'assigned_to' => $this->mechanic->id,
            'status' => 'Scheduled',
        ]);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}/reassign", [
            'assigned_to' => $otherMechanic->id,
        ])->assertForbidden();
    }
}
