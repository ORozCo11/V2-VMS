<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * An account an Admin creates directly through Add User is active from the
 * start, but UserController::store never stamped approved_at — so it sat in
 * the Super Admin's Pending Approvals queue forever, and "Reject" (which
 * hard-deletes anything with a null approved_at) would wipe out a working
 * staff member. Admin-created accounts are approved at creation, and reject
 * refuses any account that is already active regardless of its stamp.
 */
class AdminCreatedUserApprovalTest extends TestCase
{
    use RefreshDatabase;

    private function createStaffAsAdmin(): User
    {
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'approved_at' => now(), 'barangay_id' => \App\Models\Barangay::create(['name' => 'T Barangay', 'city_id' => \App\Models\City::create(['code' => 'T-C', 'name' => 'T City', 'province_id' => \App\Models\Province::create(['code' => 'T-P', 'name' => 'T Province'])->id])->id, 'psgc_code' => '9999900099'])->id]);
        Sanctum::actingAs($admin, ['*']);

        $id = $this->postJson('/api/users', [
            'name' => 'Juan Dela Cruz',
            'email' => 'juan@example.com',
            'password' => 'password123',
            'password_confirmation' => 'password123',
            'role' => 'Custodian',
        ])->assertCreated()->json('id');

        return User::findOrFail($id);
    }

    private function actAsSuperAdmin(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin'], 'approved_at' => now()]), ['*']);
    }

    #[Test]
    public function an_admin_created_user_is_pending_until_the_invitation_is_accepted(): void
    {
        $user = $this->createStaffAsAdmin();
        $this->assertNull($user->approved_at);
        $this->assertNull($user->activated_at);
        $this->assertFalse($user->is_active);
    }

    #[Test]
    public function the_backfill_approves_existing_active_accounts_but_not_pending_registrations(): void
    {
        $active = User::factory()->create(['is_active' => true, 'approved_at' => null]);
        $pending = User::factory()->create(['is_active' => false, 'approved_at' => null]);

        (require database_path('migrations/2026_10_22_000001_backfill_approved_at_for_admin_created_users.php'))->up();

        $this->assertNotNull($active->fresh()->approved_at);
        $this->assertNull($pending->fresh()->approved_at);
    }
}
