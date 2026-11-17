<?php

namespace Tests\Feature;

use App\Models\{Barangay, City, Province, User};
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class TemporaryPasswordTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;

    private string $temporary = '';

    protected function setUp(): void
    {
        parent::setUp();
        $province = Province::create(['code' => 'TP', 'name' => 'TP Province']);
        $city = City::create(['code' => 'TP-CITY', 'name' => 'TP City', 'province_id' => $province->id]);
        $barangay = Barangay::create(['name' => 'TP Barangay', 'city_id' => $city->id, 'psgc_code' => '9999900002']);
        $this->admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $barangay->id, 'approved_at' => now()]);
    }

    /** Accounts issued before invitations existed may still hold a temporary password. */
    private function createCustodian(): User
    {
        $this->temporary = 'Temp-Pass-123';
        $user = User::factory()->create([
            'role' => 'Custodian', 'roles' => ['Custodian'], 'barangay_id' => $this->admin->barangay_id,
            'password' => \Illuminate\Support\Facades\Hash::make($this->temporary), 'must_change_password' => true,
        ]);

        return $user;
    }

    public function test_a_legacy_temporary_password_account_must_change_its_password(): void
    {
        $user = $this->createCustodian();
        $this->assertTrue($user->must_change_password);

        Sanctum::actingAs($user, ['*']);
        $this->getJson('/api/user')->assertOk()->assertJsonPath('must_change_password', true);
        $this->getJson('/api/vehicles')->assertForbidden()->assertJsonPath('code', 'password_change_required');
    }

    public function test_changing_the_password_unlocks_the_account(): void
    {
        $user = $this->createCustodian();
        Sanctum::actingAs($user, ['*']);

        $this->putJson('/api/profile/password', ['old_password' => $this->temporary, 'new_password' => $this->temporary, 'new_password_confirmation' => $this->temporary])
            ->assertUnprocessable();
        $this->putJson('/api/profile/password', ['old_password' => $this->temporary, 'new_password' => 'My-Own-Pass-456', 'new_password_confirmation' => 'My-Own-Pass-456'])
            ->assertOk();

        $this->assertFalse($user->fresh()->must_change_password);
        $this->getJson('/api/vehicles')->assertOk();
    }

    public function test_ordinary_accounts_are_not_forced_to_change_their_password(): void
    {
        Sanctum::actingAs($this->admin, ['*']);
        $this->getJson('/api/vehicles')->assertOk();
    }
}
