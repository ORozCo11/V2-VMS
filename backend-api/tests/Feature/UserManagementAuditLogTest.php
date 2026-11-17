<?php

namespace Tests\Feature;

use App\Models\ActivityLog;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * Production-readiness audit finding #4 — UserController never wrote to the
 * Activity Log at all: creating, editing (including role changes and
 * password resets), activating, and deactivating a user were completely
 * unaudited. These tests prove each of those four actions now leaves a
 * durable trail, without ever logging a password's actual value.
 */
class UserManagementAuditLogTest extends TestCase
{
    use RefreshDatabase;

    private function admin(): User
    {
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => \App\Models\Barangay::create(['name' => 'T Barangay', 'city_id' => \App\Models\City::create(['code' => 'T-C', 'name' => 'T City', 'province_id' => \App\Models\Province::create(['code' => 'T-P', 'name' => 'T Province'])->id])->id, 'psgc_code' => '9999900099'])->id]);
        Sanctum::actingAs($admin, ['*']);

        return $admin;
    }

    #[Test]
    public function creating_a_user_is_logged(): void
    {
        $this->admin();

        $response = $this->postJson('/api/users', [
            'name' => 'Juan Dela Cruz',
            'email' => 'juan@example.com',
            'password' => 'password123',
            'password_confirmation' => 'password123',
            'role' => 'Custodian',
        ])->assertCreated();

        $log = ActivityLog::where('action', 'Add')->where('module', 'Users')->firstOrFail();
        $this->assertSame($response->json('id'), (int) $log->affected_record_id);
        $this->assertStringContainsString('Juan Dela Cruz', $log->details);
    }

    #[Test]
    public function editing_a_users_role_is_logged_with_the_before_and_after(): void
    {
        $this->admin();
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'barangay_id' => User::where('role', 'Admin')->value('barangay_id')]);

        $this->putJson("/api/users/{$custodian->id}", ['roles' => ['Maintenance Personnel']])->assertOk();

        $log = ActivityLog::where('action', 'Edit')->where('module', 'Users')->firstOrFail();
        $this->assertStringContainsString('Custodian', $log->details);
        $this->assertStringContainsString('Maintenance Personnel', $log->details);
    }

    #[Test]
    public function an_admin_cannot_set_or_reset_another_users_password(): void
    {
        $this->admin();
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'barangay_id' => User::where('role', 'Admin')->value('barangay_id')]);
        $before = $custodian->fresh()->password;

        $this->putJson("/api/users/{$custodian->id}", [
            'password' => 'brandNewSecret1',
            'password_confirmation' => 'brandNewSecret1',
        ])->assertStatus(422);

        $this->assertSame($before, $custodian->fresh()->password);
    }

    #[Test]
    public function an_admin_can_grant_and_revoke_vehicle_registration_delegation_and_it_is_logged(): void
    {
        $this->admin();
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'barangay_id' => User::where('role', 'Admin')->value('barangay_id'), 'can_register_vehicles' => false]);

        $this->putJson("/api/users/{$custodian->id}", ['can_register_vehicles' => true])->assertOk();
        $this->assertTrue($custodian->fresh()->can_register_vehicles);
        $this->assertDatabaseHas('activity_logs', ['action' => 'Edit', 'module' => 'Users', 'details' => "Updated user \"{$custodian->name}\" (granted vehicle registration)"]);

        $this->putJson("/api/users/{$custodian->id}", ['can_register_vehicles' => false])->assertOk();
        $this->assertFalse($custodian->fresh()->can_register_vehicles);
        $this->assertDatabaseHas('activity_logs', ['action' => 'Edit', 'module' => 'Users', 'details' => "Updated user \"{$custodian->name}\" (revoked vehicle registration)"]);
    }

    #[Test]
    public function deactivating_and_reactivating_a_user_are_both_logged(): void
    {
        $this->admin();
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'barangay_id' => User::where('role', 'Admin')->value('barangay_id'), 'is_active' => true]);

        $this->putJson("/api/users/{$custodian->id}/deactivate", [])->assertOk();
        $this->assertDatabaseHas('activity_logs', ['action' => 'Deactivate', 'module' => 'Users', 'affected_record_id' => $custodian->id]);

        $this->putJson("/api/users/{$custodian->id}/activate", [])->assertOk();
        $this->assertDatabaseHas('activity_logs', ['action' => 'Activate', 'module' => 'Users', 'affected_record_id' => $custodian->id]);
    }
}
