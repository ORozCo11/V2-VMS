<?php

namespace Tests\Feature;

use App\Mail\AccountMail;
use App\Models\{Barangay, City, Province, User};
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * A barangay Admin invites a staff member by email. The invite link opens a
 * "set your password" page; using it activates the account and signs them in.
 */
class UserInviteTest extends TestCase
{
    use RefreshDatabase;

    private Barangay $barangay;
    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
        $province = Province::create(['code' => 'TST', 'name' => 'Test Province']);
        $city = City::create(['province_id' => $province->id, 'code' => 'TSTC', 'name' => 'Test City']);
        $this->barangay = Barangay::create(['name' => 'Fresh Barangay', 'city_id' => $city->id, 'psgc_code' => '0102801001']);
        $this->admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $this->barangay->id, 'city_id' => $city->id]);
    }

    private function invite(array $overrides = [])
    {
        Sanctum::actingAs($this->admin, ['*']);

        return $this->postJson('/api/users/invite', $overrides + [
            'name' => 'Pedro Penduko',
            'email' => 'pedro@example.com',
            'roles' => ['Custodian'],
        ]);
    }

    /** The plaintext token from the most recent invite email. */
    private function sentToken(): string
    {
        $token = null;
        Mail::assertSent(AccountMail::class, function (AccountMail $mail) use (&$token) {
            if ($mail->template === 'invite') $token = $mail->data['token'];
            return true;
        });

        return $token;
    }

    private function accept(string $token, array $overrides = [])
    {
        return $this->postJson('/api/invites/accept', $overrides + [
            'email' => 'pedro@example.com',
            'token' => $token,
            'password' => 'My-Own-Pass-456',
            'password_confirmation' => 'My-Own-Pass-456',
        ]);
    }

    public function test_an_admin_invites_a_user_into_their_own_barangay(): void
    {
        $this->invite()->assertCreated()->assertJsonPath('user.invite_pending', true);

        $user = User::where('email', 'pedro@example.com')->firstOrFail();
        $this->assertFalse($user->is_active);
        $this->assertSame($this->barangay->id, $user->barangay_id);
        $this->assertSame(['Custodian'], $user->roles);
        $this->assertNotNull($user->invite_expires_at);
        $this->assertNotNull($user->approved_at, 'An invited account is approved by the Admin who invited it.');
    }

    public function test_the_invite_email_links_to_the_set_password_page_and_only_a_hash_is_stored(): void
    {
        $this->invite()->assertCreated();
        $token = $this->sentToken();
        $user = User::where('email', 'pedro@example.com')->firstOrFail();

        $this->assertNotSame($token, $user->invite_token);
        Mail::assertSent(AccountMail::class, fn (AccountMail $mail) => $mail->hasTo('pedro@example.com')
            && str_contains($mail->render(), rtrim(config('app.frontend_url'), '/').'/accept-invite?'));
        $this->assertArrayNotHasKey('invite_token', $user->toArray());
    }

    public function test_accepting_the_invite_sets_the_password_activates_and_signs_in(): void
    {
        $this->invite()->assertCreated();

        $this->accept($this->sentToken())->assertOk()->assertJsonStructure(['access_token', 'user' => ['role']]);

        $user = User::where('email', 'pedro@example.com')->firstOrFail();
        $this->assertTrue($user->is_active);
        $this->assertNull($user->invite_token);
        $this->assertNull($user->invite_expires_at);
        $this->postJson('/api/login', ['email' => 'pedro@example.com', 'password' => 'My-Own-Pass-456'])->assertOk();
    }

    public function test_an_invite_link_works_only_once(): void
    {
        $this->invite()->assertCreated();
        $token = $this->sentToken();
        $this->accept($token)->assertOk();

        $this->accept($token)->assertStatus(410)
            ->assertJsonPath('message', 'This invite has already been used. Sign in with your email and password.');
    }

    public function test_an_expired_invite_says_to_ask_for_a_new_one(): void
    {
        $this->invite()->assertCreated();
        $token = $this->sentToken();
        $this->travel(User::INVITE_VALID_DAYS + 1)->days();

        $this->accept($token)->assertStatus(410)
            ->assertJsonPath('message', 'This invite has expired. Ask your barangay Admin to send a new one.');
    }

    public function test_a_wrong_token_is_rejected(): void
    {
        $this->invite()->assertCreated();

        $this->accept('not-the-real-token')->assertStatus(422)
            ->assertJsonPath('message', 'This invite link is not valid. Open the most recent invite email, or ask your barangay Admin to send a new one.');
        $this->assertFalse(User::where('email', 'pedro@example.com')->first()->is_active);
    }

    public function test_resending_issues_a_new_link_and_the_old_one_stops_working(): void
    {
        $this->invite()->assertCreated();
        $old = $this->sentToken();
        $user = User::where('email', 'pedro@example.com')->firstOrFail();

        $this->postJson("/api/users/{$user->id}/invite/resend")->assertOk();
        $new = $this->sentToken();

        $this->assertNotSame($old, $new);
        $this->accept($old)->assertStatus(422);
        $this->accept($new)->assertOk();
    }

    public function test_cancelling_a_pending_invite_removes_the_account(): void
    {
        $this->invite()->assertCreated();
        $user = User::where('email', 'pedro@example.com')->firstOrFail();

        $this->deleteJson("/api/users/{$user->id}/invite")->assertOk();
        $this->assertModelMissing($user);
    }

    public function test_an_accepted_account_cannot_be_cancelled_as_an_invite(): void
    {
        $this->invite()->assertCreated();
        $this->accept($this->sentToken())->assertOk();
        $user = User::where('email', 'pedro@example.com')->firstOrFail();

        Sanctum::actingAs($this->admin, ['*']);
        $this->deleteJson("/api/users/{$user->id}/invite")->assertStatus(422)
            ->assertJsonPath('message', 'This account has no pending invite. Deactivate it instead.');
    }

    public function test_an_admin_cannot_manage_invites_in_another_barangay(): void
    {
        $this->invite()->assertCreated();
        $user = User::where('email', 'pedro@example.com')->firstOrFail();
        $other = Barangay::create(['name' => 'Other', 'city_id' => $this->barangay->city_id, 'psgc_code' => '0102801002']);
        Sanctum::actingAs(User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $other->id]), ['*']);

        $this->postJson("/api/users/{$user->id}/invite/resend")->assertNotFound();
        $this->deleteJson("/api/users/{$user->id}/invite")->assertNotFound();
    }

    public function test_only_admins_can_invite(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'barangay_id' => $this->barangay->id]), ['*']);

        $this->postJson('/api/users/invite', ['name' => 'X', 'email' => 'x@example.com', 'roles' => ['Custodian']])->assertForbidden();
    }

    public function test_an_email_already_in_use_is_rejected_with_a_specific_message(): void
    {
        User::factory()->create(['email' => 'pedro@example.com']);

        $this->invite()->assertStatus(422)->assertJsonPath('errors.email.0', 'An account with this email address already exists.');
    }

    public function test_signing_in_before_accepting_points_to_the_invite_email(): void
    {
        $this->invite()->assertCreated();

        $this->postJson('/api/login', ['email' => 'pedro@example.com', 'password' => 'anything'])
            ->assertUnauthorized();
        $user = User::where('email', 'pedro@example.com')->firstOrFail();
        $user->forceFill(['password' => bcrypt('known-pass-1')])->save();
        $this->postJson('/api/login', ['email' => 'pedro@example.com', 'password' => 'known-pass-1'])
            ->assertForbidden()
            ->assertJsonPath('message', "You haven't accepted your invite yet. Open the link in your invite email to set your password.");
    }

    public function test_no_account_is_left_behind_when_the_invite_email_cannot_be_sent(): void
    {
        Mail::shouldReceive('to')->andThrow(new \RuntimeException('SMTP down'));

        $this->invite()->assertStatus(502);
        $this->assertFalse(User::where('email', 'pedro@example.com')->exists());
    }
}
