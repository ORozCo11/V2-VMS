<?php

namespace Tests\Feature;

use App\Mail\AccountMail;
use App\Models\{Barangay, City, Province, User};
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Approval is the last step: once the LGU (Super Admin) or a barangay Admin
 * approves an account, its owner can sign in straight away, and they get an
 * email with a link to the sign-in page. There is no staff-code step.
 */
class ApprovalImmediateLoginTest extends TestCase
{
    use RefreshDatabase;

    private Barangay $barangay;
    private User $superAdmin;

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
        $province = Province::create(['code' => 'TST', 'name' => 'Test Province']);
        $city = City::create(['province_id' => $province->id, 'code' => 'TSTC', 'name' => 'Test City']);
        $this->barangay = Barangay::create(['name' => 'Fresh Barangay', 'city_id' => $city->id, 'psgc_code' => '0102801001']);
        $this->superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin'], 'barangay_id' => null]);
    }

    private function pendingFirstAdmin(array $overrides = []): User
    {
        return User::factory()->create($overrides + [
            'name' => 'Juan Dela Cruz', 'email' => 'juan@example.com', 'password' => Hash::make('password123'),
            'role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $this->barangay->id,
            'is_active' => false, 'approved_at' => null, 'awaiting_staff_code' => true,
        ]);
    }

    private function signIn()
    {
        return $this->postJson('/api/login', ['email' => 'juan@example.com', 'password' => 'password123']);
    }

    public function test_a_first_admin_approved_by_the_super_admin_can_sign_in_immediately(): void
    {
        $user = $this->pendingFirstAdmin();
        Sanctum::actingAs($this->superAdmin, ['*']);

        $this->putJson("/api/superadmin/users/{$user->id}/activate")
            ->assertOk()->assertJsonPath('message', 'Juan Dela Cruz is approved and can now sign in.');

        $fresh = $user->fresh();
        $this->assertTrue($fresh->is_active);
        $this->assertFalse($fresh->awaiting_staff_code);
        $this->assertNotNull($fresh->approved_at);
        $this->signIn()->assertOk()->assertJsonStructure(['access_token']);
    }

    public function test_super_admin_approval_emails_a_sign_in_link(): void
    {
        $user = $this->pendingFirstAdmin();
        Sanctum::actingAs($this->superAdmin, ['*']);
        $this->putJson("/api/superadmin/users/{$user->id}/activate")->assertOk();

        Mail::assertSent(AccountMail::class, fn (AccountMail $mail) => $mail->hasTo('juan@example.com')
            && $mail->template === 'approved'
            && str_contains($mail->render(), rtrim(config('app.frontend_url'), '/').'/login'));
    }

    public function test_a_barangay_admin_approving_staff_emails_them_a_sign_in_link(): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $this->barangay->id]);
        $staff = User::factory()->create([
            'email' => 'pedro@example.com', 'role' => 'Custodian', 'roles' => ['Custodian'],
            'barangay_id' => $this->barangay->id, 'is_active' => false, 'approved_at' => null,
        ]);
        Sanctum::actingAs($admin, ['*']);

        $this->putJson("/api/users/{$staff->id}/activate")->assertOk();

        $this->assertTrue($staff->fresh()->is_active);
        Mail::assertSent(AccountMail::class, fn (AccountMail $mail) => $mail->hasTo('pedro@example.com') && $mail->template === 'approved');
    }

    public function test_reactivating_an_account_that_was_already_approved_sends_no_approval_email(): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $this->barangay->id]);
        $staff = User::factory()->create([
            'role' => 'Custodian', 'roles' => ['Custodian'], 'barangay_id' => $this->barangay->id,
            'is_active' => false, 'approved_at' => now()->subMonth(),
        ]);
        Sanctum::actingAs($admin, ['*']);

        $this->putJson("/api/users/{$staff->id}/activate")->assertOk();

        Mail::assertNotSent(AccountMail::class);
    }

    public function test_a_first_admin_left_waiting_for_a_code_is_back_in_pending_approvals_and_can_be_approved(): void
    {
        $user = $this->pendingFirstAdmin(['approved_at' => now()->subDay(), 'staff_code_sent_at' => now()->subDay()]);
        Sanctum::actingAs($this->superAdmin, ['*']);

        $this->getJson('/api/superadmin/pending-approvals')->assertOk()->assertJsonFragment(['id' => $user->id]);
        $this->putJson("/api/superadmin/users/{$user->id}/activate")->assertOk();
        $this->signIn()->assertOk();
    }

    public function test_a_mail_outage_does_not_block_the_approval(): void
    {
        $user = $this->pendingFirstAdmin();
        Mail::shouldReceive('to')->andThrow(new \RuntimeException('SMTP down'));
        Sanctum::actingAs($this->superAdmin, ['*']);

        $this->putJson("/api/superadmin/users/{$user->id}/activate")->assertOk();
        $this->assertTrue($user->fresh()->is_active);
    }

    public function test_signing_in_before_approval_says_who_must_approve_and_mentions_no_code(): void
    {
        $this->pendingFirstAdmin();

        $this->signIn()
            ->assertForbidden()
            ->assertJsonPath('message', 'Your account is still awaiting approval from a Super Admin, as the first Admin for your barangay.')
            ->assertJsonMissingPath('awaiting_staff_code')
            ->assertJsonMissingPath('access_token');
    }
}
