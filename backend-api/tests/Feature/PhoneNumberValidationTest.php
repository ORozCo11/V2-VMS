<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * Registration already required an 11-digit PH mobile number (09XXXXXXXXX),
 * but Add User, Update User and Edit Profile accepted any string up to 30
 * characters — so the same person could be saved with a malformed number
 * just by going through a different form. Every phone write path now uses
 * the registration rule; blank stays allowed because phone is optional there.
 */
class PhoneNumberValidationTest extends TestCase
{
    use RefreshDatabase;

    private function admin(): User
    {
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => \App\Models\Barangay::create(['name' => 'T Barangay', 'city_id' => \App\Models\City::create(['code' => 'T-C', 'name' => 'T City', 'province_id' => \App\Models\Province::create(['code' => 'T-P', 'name' => 'T Province'])->id])->id, 'psgc_code' => '9999900099'])->id]);
        Sanctum::actingAs($admin, ['*']);

        return $admin;
    }

    public static function invalidPhones(): array
    {
        return [
            'ten digits' => ['0912365478'],
            'twelve digits' => ['091236547890'],
            'wrong prefix' => ['19123654789'],
            'letters' => ['09abc654789'],
            'formatted' => ['0912-365-4789'],
        ];
    }

    #[Test]
    #[DataProvider('invalidPhones')]
    public function creating_a_user_rejects_a_malformed_phone(string $phone): void
    {
        $this->admin();

        $this->postJson('/api/users', [
            'name' => 'Juan Dela Cruz',
            'email' => 'juan@example.com',
            'password' => 'password123',
            'password_confirmation' => 'password123',
            'role' => 'Custodian',
            'phone' => $phone,
        ])->assertUnprocessable()->assertJsonValidationErrors('phone');
    }

    #[Test]
    #[DataProvider('invalidPhones')]
    public function updating_a_user_rejects_a_malformed_phone(string $phone): void
    {
        $this->admin();
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'barangay_id' => User::where('role', 'Admin')->value('barangay_id')]);

        $this->putJson("/api/users/{$custodian->id}", ['phone' => $phone])
            ->assertUnprocessable()->assertJsonValidationErrors('phone');
    }

    #[Test]
    #[DataProvider('invalidPhones')]
    public function updating_your_own_profile_rejects_a_malformed_phone(string $phone): void
    {
        $this->admin();

        $this->putJson('/api/profile', ['phone' => $phone])
            ->assertUnprocessable()->assertJsonValidationErrors('phone');
    }

    #[Test]
    public function a_valid_11_digit_phone_is_saved_on_every_path(): void
    {
        $admin = $this->admin();
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'barangay_id' => User::where('role', 'Admin')->value('barangay_id')]);

        $created = $this->postJson('/api/users', [
            'name' => 'Juan Dela Cruz',
            'email' => 'juan@example.com',
            'password' => 'password123',
            'password_confirmation' => 'password123',
            'role' => 'Custodian',
            'phone' => '09123654789',
        ])->assertCreated();
        $this->assertSame('09123654789', $created->json('phone'));

        $this->putJson("/api/users/{$custodian->id}", ['phone' => '09171234567'])->assertOk();
        $this->assertSame('09171234567', $custodian->fresh()->phone);

        $this->putJson('/api/profile', ['phone' => '09181234567'])->assertOk();
        $this->assertSame('09181234567', $admin->fresh()->phone);
    }

    #[Test]
    public function phone_can_still_be_cleared(): void
    {
        $this->admin();
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'barangay_id' => User::where('role', 'Admin')->value('barangay_id'), 'phone' => '09171234567']);

        $this->putJson("/api/users/{$custodian->id}", ['phone' => null])->assertOk();
        $this->assertNull($custodian->fresh()->phone);
    }
}
