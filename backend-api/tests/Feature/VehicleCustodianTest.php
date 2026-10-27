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

class VehicleCustodianTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;
    private User $custodian;
    private VehicleCategory $van;

    protected function setUp(): void
    {
        parent::setUp();
        $this->admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        $this->custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'can_register_vehicles' => true]);
        $this->van = VehicleCategory::create(['category_name' => 'Service Van', 'domain' => 'Land', 'description' => 'x']);
        VehicleHub::create(['hub_key' => 'main-depot', 'name' => 'Main Depot', 'label' => 'MD', 'lat' => 10.3, 'lng' => 123.9]);
    }

    private function payload(string $plate, array $extra = []): array
    {
        return $extra + [
            'vehicle_name' => 'New', 'plate_number' => $plate, 'category_id' => $this->van->category_id, 'brand' => 'T', 'model' => 'T',
            'year_model' => 2022, 'capacity' => '1', 'fuel_type' => 'Diesel', 'vehicle_color' => 'x', 'current_location' => 'Main Depot',
        ];
    }

    #[Test]
    public function a_custodian_registering_a_vehicle_becomes_its_custodian(): void
    {
        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson('/api/vehicles', $this->payload('NEW 1234'))
            ->assertCreated()
            ->assertJsonPath('custodian.name', $this->custodian->name);

        $this->assertSame($this->custodian->id, Vehicle::where('plate_number', 'NEW 1234')->first()->custodian_id);
    }

    #[Test]
    public function an_admin_can_pick_a_custodian_but_not_a_non_custodian(): void
    {
        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson('/api/vehicles', $this->payload('ADM 1234', ['custodian_id' => $this->admin->id]))
            ->assertUnprocessable()
            ->assertJsonValidationErrors('custodian_id');

        $this->postJson('/api/vehicles', $this->payload('ADM 1234', ['custodian_id' => $this->custodian->id]))->assertCreated();
        $this->assertSame($this->custodian->id, Vehicle::where('plate_number', 'ADM 1234')->first()->custodian_id);
    }

    #[Test]
    public function a_custodian_from_another_barangay_is_rejected(): void
    {
        $other = User::factory()->create([
            'role' => 'Custodian', 'roles' => ['Custodian'],
            'barangay_id' => Barangay::create(['name' => 'Elsewhere'])->getKey(),
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson('/api/vehicles', $this->payload('OTH 1234', ['custodian_id' => $other->id]))
            ->assertJsonValidationErrors('custodian_id');
    }
}
