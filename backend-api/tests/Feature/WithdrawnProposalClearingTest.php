<?php

namespace Tests\Feature;

use App\Models\MaintenanceTicket;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use App\Models\VehicleIssueReport;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * QA-1112 / QA-001: a declined, cancelled or deleted repair proposal leaves its issue report open, which keeps the
 * vehicle Needs Repair and blocks its readiness. The Custodian clears it by recording a Good condition check and
 * confirming; without the confirmation nothing is closed.
 */
class WithdrawnProposalClearingTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;
    private User $custodian;
    private User $mechanic;
    private Vehicle $vehicle;

    protected function setUp(): void
    {
        parent::setUp();
        $this->admin = User::factory()->create(['role' => 'Admin']);
        $this->custodian = User::factory()->create(['role' => 'Custodian']);
        $this->mechanic = User::factory()->create(['role' => 'Maintenance Personnel']);
        $category = VehicleCategory::create(['category_name' => 'Fire Truck', 'description' => 't']);
        $this->vehicle = Vehicle::create([
            'vehicle_name' => 'Clearing Truck', 'plate_number' => 'CLR 1001', 'category_id' => $category->category_id,
            'brand' => 'Isuzu', 'model' => 'FTR', 'year_model' => 2019, 'capacity' => '5000 L', 'vehicle_color' => 'Red', 'current_location' => 'Depot',
        ]);
    }

    /** Needs Repair check -> linked proposal, as the screens do it. Returns the ticket id. */
    private function proposalFromNeedsRepairCheck(): int
    {
        Sanctum::actingAs($this->custodian, ['*']);
        $checkId = $this->postJson('/api/conditions', ['vehicle_id' => $this->vehicle->vehicle_id, 'condition_result' => 'Needs Repair', 'observations' => 'soft brake'])
            ->assertCreated()->json('condition_check_id');

        return $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $this->vehicle->vehicle_id, 'ticket_description' => 'Brake', 'priority' => 'High', 'entry_mode' => 'in_house',
            'condition_check_id' => $checkId, 'sub_issues' => [['title' => 'Brake job']],
        ])->assertCreated()->json('ticket_id');
    }

    private function vehicleRow(): array
    {
        return collect($this->getJson('/api/vehicles')->assertOk()->json())->firstWhere('vehicle_id', $this->vehicle->vehicle_id);
    }

    #[Test]
    public function after_a_decline_a_good_check_asks_for_confirmation_then_clears_the_vehicle(): void
    {
        $id = $this->proposalFromNeedsRepairCheck();
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$id}/decline", ['decline_reason' => 'Not needed'])->assertOk();

        Sanctum::actingAs($this->custodian, ['*']);
        $row = $this->vehicleRow();
        $this->assertSame('Needs Repair', $row['condition']);
        $this->assertNotNull($row['readiness_block_reason']);

        // Without the confirmation nothing is closed and no check is saved.
        $checks = \App\Models\VehicleConditionCheck::count();
        $res = $this->postJson('/api/conditions', ['vehicle_id' => $this->vehicle->vehicle_id, 'condition_result' => 'Good'])->assertStatus(409);
        $res->assertJsonPath('requires_confirmation', true)->assertJsonCount(1, 'open_reports');
        $this->assertSame($checks, \App\Models\VehicleConditionCheck::count());
        $this->assertSame('Needs Repair', $this->vehicleRow()['condition']);

        // With the confirmation the report closes and the vehicle can become Ready.
        $this->postJson('/api/conditions', ['vehicle_id' => $this->vehicle->vehicle_id, 'condition_result' => 'Good', 'confirm_clear_reports' => true])->assertCreated();
        $row = $this->vehicleRow();
        $this->assertSame('Good', $row['condition']);
        $this->assertSame('Available', $row['status']);
        $this->assertNull($row['readiness_block_reason']);
        $this->assertSame(0, VehicleIssueReport::where('vehicle_id', $this->vehicle->vehicle_id)->whereIn('status', ['Pending', 'Under Review', 'In Maintenance'])->count());
        $this->postJson("/api/vehicles/{$this->vehicle->vehicle_id}/readiness-check", ['confirmed' => true])->assertSuccessful();
    }

    #[Test]
    public function the_same_applies_after_a_proposal_is_deleted(): void
    {
        $id = $this->proposalFromNeedsRepairCheck();
        Sanctum::actingAs($this->admin, ['*']);
        $this->deleteJson("/api/tickets/{$id}")->assertOk();

        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson('/api/conditions', ['vehicle_id' => $this->vehicle->vehicle_id, 'condition_result' => 'Good'])->assertStatus(409);
        $this->postJson('/api/conditions', ['vehicle_id' => $this->vehicle->vehicle_id, 'condition_result' => 'Good', 'confirm_clear_reports' => true])->assertCreated();
        $this->assertSame('Good', $this->vehicleRow()['condition']);
    }

    #[Test]
    public function a_needs_repair_check_never_closes_reports_and_a_vehicle_with_none_records_good_without_asking(): void
    {
        Sanctum::actingAs($this->custodian, ['*']);
        // No open report: Good is recorded straight away.
        $this->postJson('/api/conditions', ['vehicle_id' => $this->vehicle->vehicle_id, 'condition_result' => 'Good'])->assertCreated();

        // A fresh Needs Repair check keeps (and creates) the report; it is never closed by another Needs Repair.
        $this->postJson('/api/conditions', ['vehicle_id' => $this->vehicle->vehicle_id, 'condition_result' => 'Needs Repair', 'confirm_clear_reports' => true])->assertCreated();
        $this->assertSame('Needs Repair', $this->vehicleRow()['condition']);
    }

    #[Test]
    public function only_a_custodian_can_clear_it_and_a_live_ticket_still_blocks_a_new_check(): void
    {
        $id = $this->proposalFromNeedsRepairCheck();
        // The proposal is live (Pending Approval): a new check is refused as before, confirmation or not.
        $this->postJson('/api/conditions', ['vehicle_id' => $this->vehicle->vehicle_id, 'condition_result' => 'Good', 'confirm_clear_reports' => true])->assertUnprocessable();
        $this->assertNotNull(MaintenanceTicket::find($id));

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$id}/decline", ['decline_reason' => 'no'])->assertOk();
        foreach ([$this->admin, $this->mechanic] as $user) {
            Sanctum::actingAs($user, ['*']);
            $this->postJson('/api/conditions', ['vehicle_id' => $this->vehicle->vehicle_id, 'condition_result' => 'Good', 'confirm_clear_reports' => true])->assertForbidden();
        }
        $this->assertSame(1, VehicleIssueReport::where('vehicle_id', $this->vehicle->vehicle_id)->whereIn('status', ['Pending', 'Under Review'])->count());
    }

    #[Test]
    public function the_decline_notice_tells_the_custodian_the_exact_step(): void
    {
        $id = $this->proposalFromNeedsRepairCheck();
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$id}/decline", ['decline_reason' => 'Not needed'])->assertOk();

        $message = \App\Models\Notification::where('user_id', $this->custodian->id)->where('type', 'ticket_declined')->value('message');
        $this->assertStringContainsString('Record a new Condition Check with the result Good to clear it', $message);
    }
}
