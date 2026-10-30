<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * An account someone else created (LGU → barangay Admin, Admin → staff) starts
 * with a temporary password. Until the owner replaces it, the server refuses
 * every protected route except the few the change-password screen needs.
 */
class ForcedPasswordChangeTest extends TestCase
{
    use RefreshDatabase;

    #[Test]
    public function issuing_a_temporary_password_flags_the_account_and_stores_only_the_hash(): void
    {
        $user = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);

        $plain = $user->issueTemporaryPassword();

        $user->refresh();
        $this->assertTrue($user->must_change_password);
        $this->assertTrue(Hash::check($plain, $user->password));
        $this->assertNotSame($plain, $user->password);
        $this->assertGreaterThanOrEqual(10, strlen($plain));
    }

    #[Test]
    public function a_flagged_user_is_blocked_from_other_protected_routes_with_a_specific_reason(): void
    {
        $user = User::factory()->create([
            'role' => 'Custodian', 'roles' => ['Custodian'], 'must_change_password' => true,
        ]);

        Sanctum::actingAs($user, ['*']);
        $this->getJson('/api/greeting')
            ->assertForbidden()
            ->assertJson(['password_change_required' => true])
            ->assertJsonPath('message', 'You must replace your temporary password before using the system.');
    }

    #[Test]
    public function a_flagged_user_can_still_load_their_own_account(): void
    {
        $user = User::factory()->create([
            'role' => 'Custodian', 'roles' => ['Custodian'], 'must_change_password' => true,
        ]);

        Sanctum::actingAs($user, ['*']);
        $this->getJson('/api/user')->assertOk()->assertJsonPath('must_change_password', true);
    }

    #[Test]
    public function changing_the_password_clears_the_flag_and_unblocks_the_account(): void
    {
        $user = User::factory()->create([
            'role' => 'Custodian', 'roles' => ['Custodian'],
            'password' => Hash::make('Temp-Pass-123'), 'must_change_password' => true,
        ]);

        Sanctum::actingAs($user, ['*']);
        $this->putJson('/api/profile/password', [
            'old_password' => 'Temp-Pass-123',
            'new_password' => 'My-Own-Pass-456',
            'new_password_confirmation' => 'My-Own-Pass-456',
        ])->assertOk();

        $this->assertFalse($user->fresh()->must_change_password);
        $this->getJson('/api/greeting')->assertOk();
    }

    #[Test]
    public function the_new_password_must_differ_from_the_temporary_one(): void
    {
        $user = User::factory()->create([
            'role' => 'Custodian', 'roles' => ['Custodian'],
            'password' => Hash::make('Temp-Pass-123'), 'must_change_password' => true,
        ]);

        Sanctum::actingAs($user, ['*']);
        $this->putJson('/api/profile/password', [
            'old_password' => 'Temp-Pass-123',
            'new_password' => 'Temp-Pass-123',
            'new_password_confirmation' => 'Temp-Pass-123',
        ])->assertStatus(422)->assertJsonValidationErrors('new_password');

        $this->assertTrue($user->fresh()->must_change_password);
    }

    #[Test]
    public function login_tells_the_client_when_a_password_change_is_required(): void
    {
        User::factory()->create([
            'email' => 'temp@example.com', 'role' => 'Custodian', 'roles' => ['Custodian'],
            'password' => Hash::make('Temp-Pass-123'), 'must_change_password' => true,
        ]);

        $this->postJson('/api/login', ['email' => 'temp@example.com', 'password' => 'Temp-Pass-123'])
            ->assertOk()
            ->assertJsonPath('user.must_change_password', true);
    }
}
