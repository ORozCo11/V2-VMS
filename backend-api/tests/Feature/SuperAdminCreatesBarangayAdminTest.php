<?php

namespace Tests\Feature;

use App\Mail\AccountMail;
use App\Models\{ActivityLog, Barangay, City, Province, User};
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * The LGU (Super Admin) creates each barangay's Admin account directly. The
 * Admin receives a temporary password and a sign-in link by email and must
 * replace the password on first sign-in.
 */
class SuperAdminCreatesBarangayAdminTest extends TestCase
{
    use RefreshDatabase;

    private City $city;
    private Barangay $barangay;
    private User $superAdmin;

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
        $province = Province::create(['code' => 'TST', 'name' => 'Test Province']);
        $this->city = City::create(['province_id' => $province->id, 'code' => 'TSTC', 'name' => 'Test City']);
        $this->barangay = Barangay::create(['name' => 'Fresh Barangay', 'city_id' => $this->city->id, 'psgc_code' => '0102801001']);
        $this->superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin'], 'barangay_id' => null]);
    }

    private function createAdmin(array $overrides = [])
    {
        return $this->postJson("/api/superadmin/barangays/{$this->barangay->id}/admins", $overrides + [
            'name' => 'Maria Santos',
            'email' => 'maria@example.com',
            'phone' => '09171234567',
        ]);
    }

    public function test_it_creates_an_active_admin_for_the_barangay_who_must_change_their_password(): void
    {
        Sanctum::actingAs($this->superAdmin, ['*']);

        $this->createAdmin()->assertCreated()->assertJsonMissingPath('password');

        $admin = User::where('email', 'maria@example.com')->firstOrFail();
        $this->assertSame('Admin', $admin->role);
        $this->assertSame(['Admin'], $admin->roles);
        $this->assertSame($this->barangay->id, $admin->barangay_id);
        $this->assertSame($this->city->id, $admin->city_id);
        $this->assertTrue($admin->is_active);
        $this->assertNotNull($admin->approved_at);
        $this->assertTrue($admin->must_change_password);
        $this->assertNotNull($this->barangay->fresh()->provisioned_at);
    }

    public function test_the_admin_is_emailed_a_working_temporary_password_and_a_sign_in_link(): void
    {
        Sanctum::actingAs($this->superAdmin, ['*']);
        $this->createAdmin()->assertCreated();
        $admin = User::where('email', 'maria@example.com')->firstOrFail();

        Mail::assertSent(AccountMail::class, function (AccountMail $mail) use ($admin) {
            $html = $mail->render();
            return $mail->hasTo('maria@example.com')
                && $mail->template === 'admin-created'
                && Hash::check($mail->data['temporaryPassword'], $admin->password)
                && str_contains($html, $mail->data['temporaryPassword'])
                && str_contains($html, rtrim(config('app.frontend_url'), '/').'/login');
        });
    }

    public function test_the_temporary_password_is_never_written_to_the_activity_log(): void
    {
        Sanctum::actingAs($this->superAdmin, ['*']);
        $this->createAdmin()->assertCreated();

        $password = null;
        Mail::assertSent(AccountMail::class, function (AccountMail $mail) use (&$password) {
            $password = $mail->data['temporaryPassword'];
            return true;
        });

        $this->assertTrue(ActivityLog::where('details', 'like', '%Maria Santos%')->exists());
        $this->assertFalse(ActivityLog::where('details', 'like', "%{$password}%")->exists());
    }

    public function test_only_a_super_admin_can_create_a_barangay_admin(): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $this->barangay->id]);
        Sanctum::actingAs($admin, ['*']);

        $this->createAdmin()->assertForbidden();
        $this->assertFalse(User::where('email', 'maria@example.com')->exists());
    }

    public function test_an_email_already_in_use_is_rejected_with_a_specific_message(): void
    {
        User::factory()->create(['email' => 'maria@example.com']);
        Sanctum::actingAs($this->superAdmin, ['*']);

        $this->createAdmin()
            ->assertStatus(422)
            ->assertJsonPath('errors.email.0', 'An account with this email address already exists.');
    }

    public function test_a_barangay_without_an_official_psgc_code_is_rejected(): void
    {
        $this->barangay->update(['psgc_code' => null]);
        Sanctum::actingAs($this->superAdmin, ['*']);

        $this->createAdmin()
            ->assertStatus(422)
            ->assertJsonPath('message', 'Admins can only be created for an official PSGC barangay.');
    }

    public function test_no_account_is_left_behind_when_the_email_cannot_be_sent(): void
    {
        Mail::shouldReceive('to')->andThrow(new \RuntimeException('SMTP down'));
        Sanctum::actingAs($this->superAdmin, ['*']);

        $this->createAdmin()->assertStatus(502);
        $this->assertFalse(User::where('email', 'maria@example.com')->exists());
    }
}
