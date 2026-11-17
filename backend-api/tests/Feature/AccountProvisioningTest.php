<?php

namespace Tests\Feature;

use App\Mail\AccountMail;
use App\Models\{Barangay, City, Province, User};
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class AccountProvisioningTest extends TestCase
{
    use RefreshDatabase;

    private Barangay $barangay;
    private User $superAdmin;

    protected function setUp(): void
    {
        parent::setUp();
        $province = Province::create(['code' => 'AP', 'name' => 'AP Province']);
        $city = City::create(['code' => 'AP-CITY', 'name' => 'AP City', 'province_id' => $province->id]);
        $this->barangay = Barangay::create(['name' => 'AP Barangay', 'city_id' => $city->id, 'psgc_code' => '9999900003']);
        $this->superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin'], 'barangay_id' => null]);
    }

    public function test_there_is_no_public_registration(): void
    {
        $this->postJson('/api/register', ['name' => 'X', 'email' => 'x@example.com'])->assertNotFound();
    }

    public function test_the_super_admin_invites_the_barangay_admin_and_no_password_is_emailed(): void
    {
        Mail::fake();
        Sanctum::actingAs($this->superAdmin, ['*']);

        $response = $this->postJson("/api/superadmin/barangays/{$this->barangay->id}/admin", ['name' => 'Ana Admin', 'email' => 'ana@example.com'])
            ->assertCreated()->assertJsonPath('email_sent', true)->assertJsonPath('account_status', 'pending_invitation')
            ->assertJsonMissingPath('temporary_password');

        $admin = User::where('email', 'ana@example.com')->firstOrFail();
        $this->assertTrue($admin->hasRole('Admin'));
        $this->assertSame($this->barangay->id, $admin->barangay_id);
        $this->assertNull($admin->activated_at);
        $this->assertFalse($admin->is_active);
        Mail::assertSent(AccountMail::class, fn ($mail) => $mail->hasTo('ana@example.com') && $mail->template === 'invitation');
    }

    public function test_a_barangay_can_only_have_one_admin(): void
    {
        Sanctum::actingAs($this->superAdmin, ['*']);
        $this->postJson("/api/superadmin/barangays/{$this->barangay->id}/admin", ['name' => 'First', 'email' => 'first@example.com'])->assertCreated();
        $this->postJson("/api/superadmin/barangays/{$this->barangay->id}/admin", ['name' => 'Second', 'email' => 'second@example.com'])->assertUnprocessable();
    }

    public function test_a_barangay_admin_cannot_create_another_admin_through_the_super_admin_route(): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $this->barangay->id]);
        Sanctum::actingAs($admin, ['*']);
        $this->postJson("/api/superadmin/barangays/{$this->barangay->id}/admin", ['name' => 'Rogue', 'email' => 'rogue@example.com'])->assertForbidden();
    }

    public function test_an_admin_cannot_reset_an_admin_but_can_reset_their_own_staff(): void
    {
        Mail::fake();
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $this->barangay->id]);
        $staff = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'barangay_id' => $this->barangay->id]);
        Sanctum::actingAs($admin, ['*']);
        $this->postJson("/api/users/{$staff->id}/resend-credentials")->assertOk();
        $this->assertSame(1, \App\Models\UserInvitation::where('user_id', $staff->id)->where('purpose', 'reset')->count());
        $this->postJson("/api/users/{$admin->id}/resend-credentials")->assertUnprocessable();
    }

    public function test_a_failed_email_is_reported_as_not_sent(): void
    {
        Mail::shouldReceive('to')->andThrow(new \RuntimeException('smtp down'));
        Sanctum::actingAs($this->superAdmin, ['*']);
        $this->postJson("/api/superadmin/barangays/{$this->barangay->id}/admin", ['name' => 'Ana Admin', 'email' => 'ana@example.com'])
            ->assertCreated()->assertJsonPath('email_sent', false)->assertJsonMissingPath('temporary_password');
    }
}
