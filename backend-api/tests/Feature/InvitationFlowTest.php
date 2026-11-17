<?php

namespace Tests\Feature;

use App\Mail\AccountMail;
use App\Models\{Barangay, City, Province, User, UserInvitation};
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class InvitationFlowTest extends TestCase
{
    use RefreshDatabase;

    private City $lgu;
    private City $otherLgu;
    private Barangay $barangay;
    private Barangay $sibling;
    private Barangay $foreign;
    private User $superAdmin;
    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();
        $province = Province::create(['code' => 'IF', 'name' => 'IF Province']);
        $this->lgu = City::create(['code' => 'IF-A', 'name' => 'Mandaue City', 'province_id' => $province->id]);
        $this->otherLgu = City::create(['code' => 'IF-B', 'name' => 'Other City', 'province_id' => $province->id]);
        $this->barangay = Barangay::create(['name' => 'Alpha', 'city_id' => $this->lgu->id, 'psgc_code' => '9999900011']);
        $this->sibling = Barangay::create(['name' => 'Beta', 'city_id' => $this->lgu->id, 'psgc_code' => '9999900012']);
        $this->foreign = Barangay::create(['name' => 'Gamma', 'city_id' => $this->otherLgu->id, 'psgc_code' => '9999900013']);
        $this->superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin'], 'barangay_id' => null, 'city_id' => $this->lgu->id]);
        $this->admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $this->barangay->id, 'city_id' => $this->lgu->id]);
    }

    /** Invites through the API and returns the plain token captured from the outgoing email. */
    private function inviteAdminAndCaptureToken(string $email = 'ana@example.com'): string
    {
        $token = null;
        Mail::fake();
        Sanctum::actingAs($this->superAdmin, ['*']);
        $this->postJson("/api/superadmin/barangays/{$this->sibling->id}/admin", ['name' => 'Ana Admin', 'email' => $email])->assertCreated();
        Mail::assertSent(AccountMail::class, function (AccountMail $mail) use (&$token) {
            preg_match('/token=([A-Za-z0-9]{64})/', $mail->data['activationUrl'], $m);
            $token = $m[1] ?? null;

            return true;
        });

        return $token;
    }

    public function test_the_invitation_email_has_the_activation_link_and_only_a_hash_is_stored(): void
    {
        $token = $this->inviteAdminAndCaptureToken();

        $this->assertNotNull($token);
        $invitation = UserInvitation::firstOrFail();
        $this->assertSame(hash('sha256', $token), $invitation->token_hash);
        $this->assertNotSame($token, $invitation->token_hash);
        $this->assertTrue($invitation->expires_at->between(now()->addHours(23), now()->addHours(25)));
    }

    public function test_the_super_admin_cannot_invite_staff_roles_or_super_admins(): void
    {
        Sanctum::actingAs($this->superAdmin, ['*']);
        // The role in the request is ignored: this route can only ever produce a barangay Admin.
        $this->postJson("/api/superadmin/barangays/{$this->sibling->id}/admin", ['name' => 'Sneaky', 'email' => 's@example.com', 'role' => 'Super Admin', 'roles' => ['Custodian']])->assertCreated();
        $user = User::where('email', 's@example.com')->firstOrFail();
        $this->assertSame('Admin', $user->role);
        $this->assertSame(['Admin'], $user->roles);
        $this->postJson('/api/users', ['name' => 'X', 'email' => 'x@example.com', 'role' => 'Custodian'])->assertForbidden();
    }

    public function test_the_super_admin_is_limited_to_their_own_lgu(): void
    {
        Sanctum::actingAs($this->superAdmin, ['*']);
        $this->postJson("/api/superadmin/barangays/{$this->foreign->id}/admin", ['name' => 'Far', 'email' => 'far@example.com'])->assertNotFound();
        $this->assertDatabaseMissing('users', ['email' => 'far@example.com']);

        $foreignAdmin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $this->foreign->id]);
        $this->putJson("/api/superadmin/users/{$foreignAdmin->id}/deactivate")->assertNotFound();
        $this->postJson("/api/superadmin/users/{$foreignAdmin->id}/resend-credentials")->assertNotFound();
        $this->getJson("/api/superadmin/barangays/{$this->foreign->id}/admins")->assertNotFound();

        $names = collect($this->getJson('/api/superadmin/barangay-directory')->assertOk()->json())->pluck('name')->all();
        $this->assertContains('Alpha', $names);
        $this->assertNotContains('Gamma', $names);
    }

    public function test_a_barangay_admin_invites_custodians_and_mechanics_into_their_own_barangay_only(): void
    {
        Mail::fake();
        Sanctum::actingAs($this->admin, ['*']);

        // A barangay_id in the request is ignored.
        $this->postJson('/api/users', ['name' => 'Cus', 'email' => 'cus@example.com', 'role' => 'Custodian', 'barangay_id' => $this->sibling->id])->assertCreated();
        $this->postJson('/api/users', ['name' => 'Mech', 'email' => 'mech@example.com', 'role' => 'Maintenance Personnel'])->assertCreated();

        $this->assertSame($this->barangay->id, User::where('email', 'cus@example.com')->value('barangay_id'));
        $this->assertSame($this->barangay->id, User::where('email', 'mech@example.com')->value('barangay_id'));
        Mail::assertSent(AccountMail::class, 2);

        $this->postJson('/api/users', ['name' => 'Boss', 'email' => 'boss@example.com', 'role' => 'Admin'])->assertUnprocessable();
        $this->postJson('/api/users', ['name' => 'Boss', 'email' => 'boss@example.com', 'role' => 'Super Admin'])->assertUnprocessable();
    }

    public function test_staff_cannot_invite_anyone(): void
    {
        foreach (['Custodian', 'Maintenance Personnel'] as $role) {
            $staff = User::factory()->create(['role' => $role, 'roles' => [$role], 'barangay_id' => $this->barangay->id]);
            Sanctum::actingAs($staff, ['*']);
            $this->postJson('/api/users', ['name' => 'N', 'email' => strtolower(substr($role, 0, 3)).'@example.com', 'role' => 'Custodian'])->assertForbidden();
        }
    }

    public function test_an_admin_cannot_manage_another_barangays_people(): void
    {
        $other = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'barangay_id' => $this->sibling->id]);
        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson("/api/users/{$other->id}/resend-credentials")->assertNotFound();
        $this->putJson("/api/users/{$other->id}/deactivate")->assertNotFound();
    }

    public function test_a_valid_invitation_activates_the_account_and_first_login_works(): void
    {
        $token = $this->inviteAdminAndCaptureToken();

        $this->getJson("/api/invitations/{$token}")->assertOk()->assertJsonPath('barangay', 'Beta')->assertJsonPath('lgu', 'Mandaue City')->assertJsonPath('role', 'Admin');
        // A pending account cannot sign in, and the answer matches a wrong password.
        $this->postJson('/api/login', ['email' => 'ana@example.com', 'password' => 'anything-123'])->assertUnauthorized();

        $this->postJson('/api/invitations/accept', ['token' => $token, 'password' => 'short', 'password_confirmation' => 'short'])->assertUnprocessable();
        $this->postJson('/api/invitations/accept', ['token' => $token, 'password' => 'Brand-New-Pass-1', 'password_confirmation' => 'Mismatch-1'])->assertUnprocessable();
        $this->postJson('/api/invitations/accept', ['token' => $token, 'password' => 'Brand-New-Pass-1', 'password_confirmation' => 'Brand-New-Pass-1'])->assertOk();

        $user = User::where('email', 'ana@example.com')->firstOrFail();
        $this->assertTrue($user->is_active);
        $this->assertNotNull($user->activated_at);
        $this->postJson('/api/login', ['email' => 'ana@example.com', 'password' => 'Brand-New-Pass-1'])->assertOk()->assertJsonPath('user.role', 'Admin');
    }

    public function test_a_token_works_only_once(): void
    {
        $token = $this->inviteAdminAndCaptureToken();
        $payload = ['token' => $token, 'password' => 'Brand-New-Pass-1', 'password_confirmation' => 'Brand-New-Pass-1'];

        $this->postJson('/api/invitations/accept', $payload)->assertOk();
        $this->postJson('/api/invitations/accept', ['token' => $token, 'password' => 'Hijack-Pass-9', 'password_confirmation' => 'Hijack-Pass-9'])->assertStatus(410);
        $this->getJson("/api/invitations/{$token}")->assertStatus(410);
        $this->postJson('/api/login', ['email' => 'ana@example.com', 'password' => 'Brand-New-Pass-1'])->assertOk();
    }

    public function test_expired_revoked_superseded_and_tampered_tokens_are_rejected_identically(): void
    {
        $token = $this->inviteAdminAndCaptureToken();
        $user = User::where('email', 'ana@example.com')->firstOrFail();
        $payload = fn (string $t) => ['token' => $t, 'password' => 'Brand-New-Pass-1', 'password_confirmation' => 'Brand-New-Pass-1'];

        // Tampered / unknown
        $tampered = substr($token, 0, 63).($token[63] === 'a' ? 'b' : 'a');
        $this->postJson('/api/invitations/accept', $payload($tampered))->assertStatus(410);
        $this->getJson('/api/invitations/'.str_repeat('z', 64))->assertStatus(410);
        $this->getJson('/api/invitations/short')->assertStatus(410);

        // Expired
        UserInvitation::query()->update(['expires_at' => now()->subMinute()]);
        $this->postJson('/api/invitations/accept', $payload($token))->assertStatus(410);
        $this->assertSame('invitation_expired', \App\Services\InvitationService::statusOf($user->fresh()));
        UserInvitation::query()->update(['expires_at' => now()->addHours(5)]);

        // Superseded by a resend
        Mail::fake();
        Sanctum::actingAs($this->superAdmin, ['*']);
        $this->postJson("/api/superadmin/users/{$user->id}/resend-credentials")->assertOk();
        $this->postJson('/api/invitations/accept', $payload($token))->assertStatus(410);

        // Revoked
        $this->postJson("/api/superadmin/users/{$user->id}/revoke-invitation")->assertOk();
        $this->assertSame(0, UserInvitation::whereNull('revoked_at')->whereNull('accepted_at')->count());
        $this->assertFalse($user->fresh()->is_active);
    }

    public function test_duplicate_emails_and_second_admins_are_refused(): void
    {
        Mail::fake();
        Sanctum::actingAs($this->superAdmin, ['*']);
        $this->postJson("/api/superadmin/barangays/{$this->sibling->id}/admin", ['name' => 'Ana', 'email' => 'ana@example.com'])->assertCreated();
        $this->postJson("/api/superadmin/barangays/{$this->sibling->id}/admin", ['name' => 'Ana 2', 'email' => 'ana2@example.com'])->assertUnprocessable();
        $this->postJson("/api/superadmin/barangays/{$this->barangay->id}/admin", ['name' => 'Dup', 'email' => 'ana@example.com'])->assertUnprocessable();

        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson('/api/users', ['name' => 'C', 'email' => 'ana@example.com', 'role' => 'Custodian'])->assertUnprocessable();
    }

    public function test_a_pending_account_has_no_api_access_even_with_a_token(): void
    {
        $token = $this->inviteAdminAndCaptureToken();
        $pending = User::where('email', 'ana@example.com')->firstOrFail();

        Sanctum::actingAs($pending, ['*']);
        $this->getJson('/api/user')->assertUnauthorized();
        $this->assertNotEmpty($token);
    }

    public function test_a_disabled_account_loses_access_and_can_be_reactivated(): void
    {
        $token = $this->inviteAdminAndCaptureToken();
        $this->postJson('/api/invitations/accept', ['token' => $token, 'password' => 'Brand-New-Pass-1', 'password_confirmation' => 'Brand-New-Pass-1'])->assertOk();
        $user = User::where('email', 'ana@example.com')->firstOrFail();
        $session = $this->postJson('/api/login', ['email' => 'ana@example.com', 'password' => 'Brand-New-Pass-1'])->json('access_token');

        // Last-active-Admin protection: another Admin keeps the barangay covered.
        User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $this->sibling->id]);
        Sanctum::actingAs($this->superAdmin, ['*']);
        $this->putJson("/api/superadmin/users/{$user->id}/deactivate")->assertOk();
        $this->assertSame(0, $user->tokens()->count());

        $this->app['auth']->forgetGuards();
        $this->withToken($session)->getJson('/api/user')->assertUnauthorized();
        $this->postJson('/api/login', ['email' => 'ana@example.com', 'password' => 'Brand-New-Pass-1'])->assertForbidden();

        Sanctum::actingAs($this->superAdmin, ['*']);
        $this->putJson("/api/superadmin/users/{$user->id}/reactivate")->assertOk();
        $this->postJson('/api/login', ['email' => 'ana@example.com', 'password' => 'Brand-New-Pass-1'])->assertOk();
    }

    public function test_a_reset_link_changes_the_password_of_an_active_account_without_reenabling_a_disabled_one(): void
    {
        $token = $this->inviteAdminAndCaptureToken();
        $this->postJson('/api/invitations/accept', ['token' => $token, 'password' => 'Brand-New-Pass-1', 'password_confirmation' => 'Brand-New-Pass-1'])->assertOk();
        $user = User::where('email', 'ana@example.com')->firstOrFail();

        Mail::fake();
        Sanctum::actingAs($this->superAdmin, ['*']);
        $this->postJson("/api/superadmin/users/{$user->id}/resend-credentials")->assertOk();
        $reset = null;
        Mail::assertSent(AccountMail::class, function (AccountMail $m) use (&$reset) {
            preg_match('/token=([A-Za-z0-9]{64})/', $m->data['activationUrl'], $x);
            $reset = $x[1];

            return $m->template === 'password-reset';
        });

        $user->update(['is_active' => false]);
        $this->postJson('/api/invitations/accept', ['token' => $reset, 'password' => 'Reset-Pass-22', 'password_confirmation' => 'Reset-Pass-22'])->assertOk();
        $this->assertFalse($user->fresh()->is_active);
        $this->postJson('/api/login', ['email' => 'ana@example.com', 'password' => 'Reset-Pass-22'])->assertForbidden();
    }

    public function test_public_registration_endpoints_do_not_exist(): void
    {
        foreach (['/api/register', '/api/signup'] as $url) {
            $this->postJson($url, ['name' => 'X', 'email' => 'x@example.com', 'password' => 'Password-123', 'password_confirmation' => 'Password-123'])->assertStatus(404);
        }
        // Creating accounts is never possible without signing in.
        $this->postJson('/api/users', ['name' => 'X', 'email' => 'x@example.com', 'role' => 'Custodian'])->assertUnauthorized();
        $this->postJson("/api/superadmin/barangays/{$this->barangay->id}/admin", ['name' => 'X', 'email' => 'x@example.com'])->assertUnauthorized();
    }

    public function test_the_provisioning_command_creates_an_lgu_scoped_super_admin(): void
    {
        $this->artisan('superadmin:create', ['--city' => 'Mandaue City'])
            ->expectsQuestion('Full name', 'LGU Boss')
            ->expectsQuestion('Email address', 'boss@mandaue.test')
            ->expectsQuestion('Password (min 8 characters)', 'Provision-Pass-1')
            ->expectsQuestion('Confirm password', 'Provision-Pass-1')
            ->expectsConfirmation('Create a Super Admin account for boss@mandaue.test?', 'yes')
            ->assertSuccessful();

        $boss = User::where('email', 'boss@mandaue.test')->firstOrFail();
        $this->assertSame($this->lgu->id, $boss->city_id);
        $this->assertNull($boss->barangay_id);
        $this->assertNotNull($boss->activated_at);

        $this->artisan('superadmin:create', ['--city' => 'Nowhere City'])->assertFailed();
    }
}
