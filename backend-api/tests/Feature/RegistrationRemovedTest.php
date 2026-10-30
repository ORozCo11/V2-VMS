<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * There is no public self-registration: the LGU (Super Admin) creates each
 * barangay's Admin, and Admins invite or add their own staff.
 */
class RegistrationRemovedTest extends TestCase
{
    use RefreshDatabase;

    public function test_the_public_registration_endpoints_no_longer_exist(): void
    {
        $this->postJson('/api/register', [
            'name' => 'Walk In', 'email' => 'walkin@example.com',
            'password' => 'password123', 'password_confirmation' => 'password123',
        ])->assertNotFound();
        $this->getJson('/api/registration-status?city_id=1&barangay_id=1')->assertNotFound();
        $this->getJson('/api/address-suggestions?barangay_id=1&q=main')->assertNotFound();

        $this->assertFalse(User::where('email', 'walkin@example.com')->exists());
    }
}
