<?php

namespace Tests\Feature;

use App\Models\Barangay;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use App\Models\VehicleHub;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * Regression coverage for the three VehicleHub tenant-scoping bugs:
 *  - hub name uniqueness must be scoped per barangay, not global
 *  - a hub still referenced by a vehicle's current_location can't be deleted
 */
class HubControllerTest extends TestCase
{
    use RefreshDatabase;

    private function admin(?int $barangayId = null): User
    {
        return User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $barangayId]);
    }

    #[Test]
    public function two_different_barangays_can_each_have_a_hub_with_the_same_name(): void
    {
        $barangayA = Barangay::create(['name' => 'Barangay A ' . uniqid()]);
        $barangayB = Barangay::create(['name' => 'Barangay B ' . uniqid()]);

        Sanctum::actingAs($this->admin($barangayA->id), ['*']);
        $this->postJson('/api/hubs', [
            'name' => 'Main Depot',
            'lat' => 10.34,
            'lng' => 123.95,
        ])->assertCreated();

        // A different barangay's Admin creating a hub with the SAME name
        // must not be blocked by a global uniqueness check.
        Sanctum::actingAs($this->admin($barangayB->id), ['*']);
        $this->postJson('/api/hubs', [
            'name' => 'Main Depot',
            'lat' => 10.35,
            'lng' => 123.96,
        ])->assertCreated();

        $this->assertDatabaseCount('vehicle_hubs', 2);
    }

    #[Test]
    public function a_custodian_can_add_a_new_location(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]), ['*']);
        $this->postJson('/api/hubs', ['name' => 'Second Depot', 'lat' => 10.31, 'lng' => 123.91])->assertCreated();
    }

    #[Test]
    public function the_same_barangay_still_cannot_create_two_hubs_with_the_same_name(): void
    {
        $barangay = Barangay::create(['name' => 'Barangay A ' . uniqid()]);
        Sanctum::actingAs($this->admin($barangay->id), ['*']);

        $this->postJson('/api/hubs', [
            'name' => 'Main Depot',
            'lat' => 10.34,
            'lng' => 123.95,
        ])->assertCreated();

        $this->postJson('/api/hubs', [
            'name' => 'Main Depot',
            'lat' => 10.35,
            'lng' => 123.96,
        ])->assertUnprocessable();
    }

    #[Test]
    public function a_hub_still_used_as_a_vehicles_current_location_cannot_be_deleted(): void
    {
        $admin = $this->admin();
        Sanctum::actingAs($admin, ['*']);

        $hub = VehicleHub::create([
            'hub_key' => 'test-depot-' . uniqid(),
            'name' => 'Main Depot',
            'lat' => 10.34,
            'lng' => 123.95,
            'is_default' => false,
        ]);

        $category = VehicleCategory::create(['category_name' => 'Van ' . uniqid(), 'description' => 'x']);
        Vehicle::create([
            'vehicle_name' => 'Test Van',
            'plate_number' => 'HUB ' . random_int(1000, 9999),
            'category_id' => $category->category_id,
            'brand' => 'Toyota', 'model' => 'HiAce', 'year_model' => 2022,
            'capacity' => '12 pax', 'vehicle_color' => 'White',
            'current_location' => $hub->name,
        ]);

        $this->deleteJson("/api/hubs/{$hub->hub_id}")->assertUnprocessable();
        $this->assertDatabaseHas('vehicle_hubs', ['hub_id' => $hub->hub_id]);
    }

    #[Test]
    public function a_hub_no_longer_referenced_by_any_vehicle_can_be_deleted(): void
    {
        $admin = $this->admin();
        Sanctum::actingAs($admin, ['*']);

        $hub = VehicleHub::create([
            'hub_key' => 'test-depot-' . uniqid(),
            'name' => 'Unused Depot',
            'lat' => 10.34,
            'lng' => 123.95,
            'is_default' => false,
        ]);

        $this->deleteJson("/api/hubs/{$hub->hub_id}")->assertOk();
        $this->assertDatabaseMissing('vehicle_hubs', ['hub_id' => $hub->hub_id]);
    }
}
