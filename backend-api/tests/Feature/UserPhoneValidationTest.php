<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class UserPhoneValidationTest extends TestCase
{
    use RefreshDatabase;

    public function test_create_and_edit_reject_non_mobile_or_wrong_length_numbers(): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => \App\Models\Barangay::create(['name' => 'T Barangay', 'city_id' => \App\Models\City::create(['code' => 'T-C', 'name' => 'T City', 'province_id' => \App\Models\Province::create(['code' => 'T-P', 'name' => 'T Province'])->id])->id, 'psgc_code' => '9999900099'])->id]);
        Sanctum::actingAs($admin, $admin->allRoles());
        $payload = ['name' => 'New User', 'email' => 'new@example.com', 'password' => 'password123', 'password_confirmation' => 'password123', 'role' => 'Custodian'];
        foreach (['0912345678', '091234567890', 'abcdefghijk', '08123456789'] as $phone) {
            $this->postJson('/api/users', [...$payload, 'phone' => $phone])->assertUnprocessable()->assertJsonValidationErrors('phone');
            $this->putJson('/api/users/'.$admin->id, ['phone' => $phone])->assertUnprocessable()->assertJsonValidationErrors('phone');
        }
        $id = $this->postJson('/api/users', [...$payload, 'phone' => '09123456789'])->assertCreated()->assertJsonPath('phone', '09123456789')->json('id');
        $this->putJson('/api/users/'.$id, ['phone' => '09987654321'])->assertOk()->assertJsonPath('phone', '09987654321');
    }
}
