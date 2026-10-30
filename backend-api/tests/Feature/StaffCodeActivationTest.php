<?php

namespace Tests\Feature;

use App\Mail\AccountMail;
use App\Models\{Barangay, City, Province, RegistrationSetting, User};
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class StaffCodeActivationTest extends TestCase
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

    private function registerFirstAdmin(): User
    {
        $this->postJson('/api/register', [
            'name' => 'Juan Dela Cruz',
            'email' => 'juan@example.com',
            'password' => 'password123',
            'password_confirmation' => 'password123',
            'phone' => '09171234567',
            'address' => '123 Test St',
            'city_id' => $this->city->id,
            'barangay_id' => $this->barangay->id,
        ])->assertCreated();

        return User::where('email', 'juan@example.com')->firstOrFail();
    }

    private function activate(string $code)
    {
        return $this->postJson('/api/activate-account', ['email' => 'juan@example.com', 'password' => 'password123', 'staff_code' => $code]);
    }

    private function code(): string
    {
        return RegistrationSetting::for($this->barangay->id)->staff_code;
    }

    public function test_a_first_admin_registers_without_a_code_and_gets_the_welcome_email(): void
    {
        $user = $this->registerFirstAdmin();

        $this->assertSame('Admin', $user->role);
        $this->assertFalse($user->is_active);
        $this->assertTrue($user->awaiting_staff_code);
        Mail::assertSent(AccountMail::class, fn ($mail) => $mail->hasTo('juan@example.com') && $mail->template === 'welcome');
    }

    public function test_later_staff_still_need_the_barangay_code(): void
    {
        $this->registerFirstAdmin();

        $this->postJson('/api/register', [
            'name' => 'Second Person', 'email' => 'second@example.com', 'password' => 'password123', 'password_confirmation' => 'password123',
            'phone' => '09171234568', 'address' => '1 St', 'city_id' => $this->city->id, 'barangay_id' => $this->barangay->id,
            'requested_role' => 'Custodian',
        ])->assertUnprocessable()->assertJsonValidationErrors('staff_code');
    }

    public function test_the_code_cannot_be_used_before_it_is_sent(): void
    {
        $this->registerFirstAdmin();

        $this->activate($this->code())->assertUnprocessable();
    }

    public function test_super_admin_emails_the_code_and_the_user_activates_with_it(): void
    {
        $user = $this->registerFirstAdmin();
        Sanctum::actingAs($this->superAdmin, ['*']);

        $this->postJson("/api/superadmin/users/{$user->id}/send-staff-code")->assertOk();

        $this->assertNotNull($user->fresh()->staff_code_sent_at);
        Mail::assertSent(AccountMail::class, fn ($mail) => $mail->template === 'staff-code' && $mail->data['code'] === $this->code());
        $this->assertDatabaseHas('activity_logs', ['details' => 'Emailed the staff registration code to Juan Dela Cruz (juan@example.com).']);

        $this->activate('WRONGCOD')->assertUnprocessable();
        $this->activate(strtolower($this->code()))->assertOk()->assertJsonStructure(['access_token', 'user' => ['role']]);

        $fresh = $user->fresh();
        $this->assertTrue($fresh->is_active);
        $this->assertFalse($fresh->awaiting_staff_code);
        $this->assertNotNull($fresh->approved_at);
        Mail::assertSent(AccountMail::class, fn ($mail) => $mail->template === 'activated');
    }

    public function test_an_expired_code_cancels_the_registration(): void
    {
        $user = $this->registerFirstAdmin();
        $user->update(['staff_code_sent_at' => now()->subDays(User::STAFF_CODE_VALID_DAYS)->subMinute()]);

        $this->activate($this->code())->assertStatus(410);

        $this->assertModelMissing($user);
        Mail::assertSent(AccountMail::class, fn ($mail) => $mail->template === 'expired');
    }

    public function test_the_scheduled_cleanup_expires_only_stale_unclaimed_registrations(): void
    {
        $stale = $this->registerFirstAdmin();
        $stale->update(['staff_code_sent_at' => now()->subDays(8)]);
        $recent = User::factory()->create(['awaiting_staff_code' => true, 'is_active' => false, 'staff_code_sent_at' => now()->subDay()]);
        $unsent = User::factory()->create(['awaiting_staff_code' => true, 'is_active' => false, 'staff_code_sent_at' => null]);

        $this->artisan('registrations:expire-unclaimed')->assertSuccessful();

        $this->assertModelMissing($stale);
        $this->assertModelExists($recent);
        $this->assertModelExists($unsent);
    }

    public function test_a_mail_failure_leaves_the_code_unsent(): void
    {
        $user = $this->registerFirstAdmin();
        Sanctum::actingAs($this->superAdmin, ['*']);
        Mail::shouldReceive('to')->andThrow(new \RuntimeException('SMTP down'));

        $this->postJson("/api/superadmin/users/{$user->id}/send-staff-code")->assertStatus(502);
        $this->assertNull($user->fresh()->staff_code_sent_at);
    }

    public function test_super_admin_can_email_any_account_a_plain_message(): void
    {
        $target = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);
        Sanctum::actingAs($this->superAdmin, ['*']);

        $this->postJson("/api/superadmin/users/{$target->id}/email", ['subject' => 'Hello', 'message' => "Line one\nLine two"])->assertOk();

        Mail::assertSent(AccountMail::class, fn ($mail) => $mail->hasTo($target->email) && $mail->subjectLine === 'Hello');
    }

    public function test_only_a_super_admin_can_send_emails(): void
    {
        $user = $this->registerFirstAdmin();
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $this->barangay->id]);
        Sanctum::actingAs($admin, ['*']);

        $this->postJson("/api/superadmin/users/{$user->id}/send-staff-code")->assertForbidden();
        $this->postJson("/api/superadmin/users/{$user->id}/email", ['subject' => 'x', 'message' => 'y'])->assertForbidden();
    }

    public function test_a_custom_email_can_carry_the_barangay_code(): void
    {
        $target = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $this->barangay->id]);
        Sanctum::actingAs($this->superAdmin, ['*']);
        $payload = ['subject' => 'Code', 'message' => 'Here it is', 'include_staff_code' => true, 'staff_code' => 'FORGED00'];

        $this->postJson("/api/superadmin/users/{$target->id}/email", $payload)->assertOk();

        // The code always comes from the database, never from the request.
        Mail::assertSent(AccountMail::class, fn ($mail) => $mail->data['code'] === $this->code());
        $this->assertDatabaseHas('activity_logs', ['details' => "Emailed {$target->name} ({$target->email}): Code. Included the staff registration code for Fresh Barangay."]);
    }

    public function test_every_email_template_renders(): void
    {
        $user = $this->registerFirstAdmin();
        $data = ['code' => 'ABCD1234', 'expiresAt' => now()->addWeek(), 'body' => "<b>hi</b>\nthere"];

        foreach (['welcome', 'staff-code', 'activated', 'expired', 'message'] as $template) {
            $html = (new AccountMail($user, 'Subject', $template, $data))->render();
            $this->assertStringContainsString('Juan', $html, $template);
        }
        $this->assertStringContainsString('ABCD1234', (new AccountMail($user, 'S', 'staff-code', $data))->render());
        $this->assertStringNotContainsString('Reviewed and issued by', (new AccountMail($user, 'S', 'staff-code', $data))->render());

        // The person's name and their barangay stand out in bold, including inside a typed message.
        $place = 'Barangay Fresh Barangay, Test City, Test Province';
        $message = (new AccountMail($user, 'S', 'message', ['body' => "The code for {$place} is ready."]))->render();
        // The mail theme inlines a style attribute onto every <strong>.
        $bold = fn (string $text) => '/<strong[^>]*>'.preg_quote($text, '/').'<\/strong>/';
        $this->assertMatchesRegularExpression($bold('Juan'), $message);
        $this->assertMatchesRegularExpression($bold($place), $message);
        $this->assertMatchesRegularExpression($bold($place), (new AccountMail($user, 'S', 'staff-code', $data))->render());
        $this->assertStringContainsString('Barangay Fresh Barangay, Test City, Test Province', (new AccountMail($user, 'S', 'welcome', $data))->render());
        $this->assertStringNotContainsString('<b>hi</b>', (new AccountMail($user, 'S', 'message', $data))->render());
    }
}
