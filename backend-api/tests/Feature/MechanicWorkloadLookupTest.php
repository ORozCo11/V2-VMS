<?php

namespace Tests\Feature;

use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * The ticket lookups carry each mechanic's current load so Admin and
 * Custodian can balance work before assigning (and reassign if needed).
 */
class MechanicWorkloadLookupTest extends TestCase
{
    use RefreshDatabase;

    #[Test]
    public function lookups_report_each_mechanics_open_ticket_count(): void
    {
        $admin = User::factory()->create(['role' => 'Admin']);
        $custodian = User::factory()->create(['role' => 'Custodian']);
        $busy = User::factory()->create(['role' => 'Maintenance Personnel']);
        $idle = User::factory()->create(['role' => 'Maintenance Personnel']);

        $category = VehicleCategory::create(['category_name' => 'Ambulance', 'description' => 'test']);
        $vehicle = Vehicle::create([
            'vehicle_name' => 'Workload Test Ambulance', 'plate_number' => 'WLT 1001', 'category_id' => $category->category_id,
            'brand' => 'Ford', 'model' => 'E-350', 'year_model' => 2020, 'capacity' => '4', 'vehicle_color' => 'White', 'current_location' => 'Depot',
        ]);

        // Two approved (Active) tickets land on the busy mechanic.
        foreach (['Dented door', 'Cracked mirror'] as $title) {
            Sanctum::actingAs($custodian, ['*']);
            $id = $this->postJson('/api/tickets/propose', [
                'vehicle_id' => $vehicle->vehicle_id, 'ticket_description' => $title, 'priority' => 'High',
                'sub_issues' => [['title' => $title]],
            ])->assertCreated()->json('ticket_id');
            Sanctum::actingAs($admin, ['*']);
            $this->putJson("/api/tickets/{$id}/approve", ['assigned_mechanic_id' => $busy->id])->assertOk();
        }

        foreach ([$admin, $custodian] as $viewer) {
            Sanctum::actingAs($viewer, ['*']);
            $rows = collect($this->getJson('/api/tickets/lookups')->assertOk()->json('maintenance_personnel'))->keyBy('id');

            $this->assertSame(2, $rows[$busy->id]['active_tickets']);
            $this->assertSame(0, $rows[$idle->id]['active_tickets']);
            $this->assertSame(0, $rows[$idle->id]['scheduled_jobs']);
        }
    }
}
