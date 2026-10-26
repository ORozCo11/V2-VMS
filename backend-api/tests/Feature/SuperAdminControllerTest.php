<?php

namespace Tests\Feature;

use App\Mail\ConcernReplyMail;
use App\Models\ActivityLog;
use App\Models\ConcernReport;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * SuperAdminController is scoped to accounts only (see its class docblock):
 * a Super Admin can never see a barangay's vehicles, tickets, or other
 * fleet data. activityLog() shares the activity_logs table with
 * FleetController/TicketController, which log fine-grained fleet-detail
 * entries for a barangay's own Admin audit trail — those must never surface
 * through the Super Admin endpoint.
 */
class SuperAdminControllerTest extends TestCase
{
    use RefreshDatabase;

    #[Test]
    public function barangay_management_excludes_reference_only_rows_and_batches_admin_counts(): void
    {
        $province = \App\Models\Province::create(['code' => 'TEST', 'name' => 'Test Province']);
        $city = \App\Models\City::create(['province_id' => $province->id, 'code' => 'TESTCITY', 'name' => 'Test City']);
        $reference = \App\Models\Barangay::create(['city_id' => $city->id, 'name' => 'Reference only', 'psgc_code' => '0100000001']);
        $tenant = \App\Models\Barangay::create(['city_id' => $city->id, 'name' => 'Registered', 'psgc_code' => '0100000002', 'boundary' => ['type' => 'Polygon', 'coordinates' => [[[0, 0], [1, 0], [1, 1], [0, 0]]]]]);
        $provisioned = \App\Models\Barangay::create(['city_id' => $city->id, 'name' => 'Code provisioned', 'psgc_code' => '0100000003', 'boundary' => ['type' => 'Polygon', 'coordinates' => [[[0, 0], [1, 0], [1, 1], [0, 0]]]]]);
        $seededCodeOnly = \App\Models\Barangay::create(['city_id' => $city->id, 'name' => 'Seeded code only', 'psgc_code' => '0100000004']);
        $manual = \App\Models\Barangay::create(['city_id' => $city->id, 'name' => 'Manually added']);
        \App\Models\RegistrationSetting::for($seededCodeOnly->id);
        User::factory()->create(['barangay_id' => $tenant->id, 'role' => 'Custodian', 'roles' => ['Custodian', 'Admin'], 'is_active' => true]);
        User::factory()->create(['barangay_id' => $tenant->id, 'role' => 'Admin', 'roles' => ['Admin'], 'is_active' => false]);
        $superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin']]);
        Sanctum::actingAs($superAdmin, ['*']);
        // Issuing a code through the platform onboards the barangay; a code
        // row created any other way (e.g. by a seeder) does not.
        $this->getJson("/api/superadmin/barangays/{$provisioned->id}/registration-code")->assertOk();

        \Illuminate\Support\Facades\DB::enableQueryLog();
        $rows = collect($this->getJson('/api/superadmin/barangays')->assertOk()->json());
        $queryCount = count(\Illuminate\Support\Facades\DB::getQueryLog());
        \Illuminate\Support\Facades\DB::disableQueryLog();
        $this->assertEqualsCanonicalizing([$tenant->id, $provisioned->id, $manual->id], $rows->pluck('id')->all());
        $this->assertNotContains($reference->id, $rows->pluck('id')->all());
        $this->assertNotContains($seededCodeOnly->id, $rows->pluck('id')->all());
        $registered = $rows->firstWhere('id', $tenant->id);
        $this->assertSame(2, $registered['staff_count']);
        $this->assertTrue($registered['has_active_admin']);
        $this->assertTrue($registered['sole_active_admin']);
        $this->assertTrue($registered['has_boundary']);
        $this->assertArrayNotHasKey('boundary', $registered);
        $this->assertFalse($rows->firstWhere('id', $manual->id)['has_boundary']);
        $this->assertTrue($rows->firstWhere('id', $provisioned->id)['has_registration_code']);
        $this->assertLessThanOrEqual(5, $queryCount, 'Admin counts must not issue a query per barangay.');
    }

    #[Test]
    public function super_admin_activity_log_excludes_fleet_detail_entries(): void
    {
        $superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin']]);

        // A fleet-operational entry, the kind FleetController logs for a
        // barangay Admin's own audit trail — must NOT appear here.
        ActivityLog::create([
            'user_id' => $superAdmin->id,
            'role' => 'Admin',
            'action' => 'Add',
            'module' => 'Vehicle Management',
            'details' => 'Added vehicle Dump Truck 01',
        ]);

        // A ticket-workflow entry, logged by TicketController — also must
        // NOT appear here.
        ActivityLog::create([
            'user_id' => $superAdmin->id,
            'role' => 'Admin',
            'action' => 'Create Ticket',
            'module' => 'Maintenance Tickets',
            'details' => 'Ticket #1 created for Dump Truck 01',
        ]);

        // An account/admin-level entry — this SHOULD appear.
        ActivityLog::create([
            'user_id' => $superAdmin->id,
            'role' => 'Super Admin',
            'action' => 'Activate',
            'module' => 'Super Admin',
            'details' => 'Activated Jane Doe (jane@example.com).',
        ]);

        Sanctum::actingAs($superAdmin, ['*']);
        $response = $this->getJson('/api/superadmin/activity-log')->assertOk();

        $modules = collect($response->json())->pluck('module');

        $this->assertFalse($modules->contains('Vehicle Management'), 'Fleet-detail entries must not leak into the Super Admin activity log.');
        $this->assertFalse($modules->contains('Maintenance Tickets'), 'Ticket-detail entries must not leak into the Super Admin activity log.');
        $this->assertTrue($modules->contains('Super Admin'), 'Account-level entries should still appear in the Super Admin activity log.');
    }

    #[Test]
    public function concern_reports_cannot_be_managed_by_tenant_admins(): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        $report = ConcernReport::create([
            'concern_type' => 'Other',
            'description' => 'Spam submission',
            'status' => 'Open',
        ]);

        Sanctum::actingAs($admin, ['*']);
        $this->getJson('/api/superadmin/concern-reports')->assertForbidden();
        $this->putJson("/api/superadmin/concern-reports/{$report->id}/resolve")->assertForbidden();
        $this->putJson("/api/superadmin/concern-reports/{$report->id}/reopen")->assertForbidden();
        $this->deleteJson("/api/superadmin/concern-reports/{$report->id}")->assertForbidden();
        $this->putJson("/api/superadmin/concern-reports/{$report->id}/restore")->assertForbidden();
        $this->assertDatabaseHas('concern_reports', ['id' => $report->id]);
    }

    #[Test]
    public function super_admin_can_review_resolve_reopen_and_delete_existing_concerns(): void
    {
        $superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin']]);
        $report = ConcernReport::create([
            'concern_type' => 'Other',
            'description' => 'Spam submission',
            'status' => 'Open',
        ]);

        Sanctum::actingAs($superAdmin, ['*']);
        $this->getJson('/api/superadmin/concern-reports')->assertOk()->assertJsonFragment(['id' => $report->id]);
        $this->putJson("/api/superadmin/concern-reports/{$report->id}/resolve")->assertOk()->assertJsonPath('status', 'Resolved');
        $this->assertDatabaseHas('concern_reports', ['id' => $report->id, 'resolved_by' => $superAdmin->id]);
        $this->assertNotNull($report->fresh()->resolved_at);
        $this->putJson("/api/superadmin/concern-reports/{$report->id}/reopen")->assertOk()->assertJsonPath('status', 'Open');
        $this->assertDatabaseHas('concern_reports', ['id' => $report->id, 'status' => 'Open']);
        $this->assertNull($report->fresh()->resolved_by);
        $this->assertNull($report->fresh()->resolved_at);
        $this->deleteJson("/api/superadmin/concern-reports/{$report->id}")->assertOk()->assertJsonPath('id', $report->id);
        // Deleted reports stay in Concern History and can be restored as open.
        $this->assertSoftDeleted('concern_reports', ['id' => $report->id]);
        $this->getJson('/api/superadmin/concern-reports')->assertOk()->assertJsonFragment(['id' => $report->id]);
        $this->putJson("/api/superadmin/concern-reports/{$report->id}/restore")->assertOk()->assertJsonPath('status', 'Open')->assertJsonPath('deleted_at', null);
        $this->assertNotSoftDeleted('concern_reports', ['id' => $report->id]);
        $this->putJson("/api/superadmin/concern-reports/{$report->id}/restore")->assertNotFound();
    }

    #[Test]
    public function public_can_submit_concerns_but_cannot_read_the_inbox(): void
    {
        $this->postJson('/api/concern-reports', ['concern_type' => 'Other', 'description' => 'Unable to reach our administrator'])->assertCreated();
        $this->assertDatabaseHas('concern_reports', ['description' => 'Unable to reach our administrator', 'status' => 'Open']);
        $this->getJson('/api/superadmin/concern-reports')->assertUnauthorized();
        $this->postJson('/api/concern-reports', ['concern_type' => 'Invalid'])->assertUnprocessable()->assertJsonValidationErrors(['concern_type']);
        // Only "Other" needs a description; the named types explain themselves and drop any sent text.
        $this->postJson('/api/concern-reports', ['concern_type' => 'Other'])->assertUnprocessable()->assertJsonValidationErrors(['description']);
        $this->postJson('/api/concern-reports', ['concern_type' => 'Suspected Fake Staff', 'description' => 'ignored'])->assertCreated();
        $this->assertDatabaseHas('concern_reports', ['concern_type' => 'Suspected Fake Staff', 'description' => null]);
    }

    #[Test]
    public function super_admin_emails_the_reporter_once_per_stage(): void
    {
        Mail::fake();
        $superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin']]);
        $report = ConcernReport::create(['concern_type' => 'Other', 'description' => 'Help', 'status' => 'Open', 'reporter_contact' => 'reporter@example.test']);
        $phoneOnly = ConcernReport::create(['concern_type' => 'Other', 'description' => 'Help', 'status' => 'Open', 'reporter_contact' => '09171234567']);
        Sanctum::actingAs($superAdmin, ['*']);
        $email = fn (ConcernReport $r, string $kind) => $this->postJson("/api/superadmin/concern-reports/{$r->id}/email", ['kind' => $kind, 'subject' => 'Update', 'message' => 'We are on it.']);

        $email($report, 'acknowledge')->assertOk()->assertJsonPath('report.id', $report->id);
        $this->assertNotNull($report->fresh()->acknowledged_email_at);
        $email($report, 'acknowledge')->assertStatus(409);
        $email($report, 'resolved')->assertOk();
        $email($report, 'resolved')->assertStatus(409);
        $email($phoneOnly, 'acknowledge')->assertUnprocessable();

        Mail::assertSent(ConcernReplyMail::class, 2);
        Mail::assertSent(ConcernReplyMail::class, fn (ConcernReplyMail $mail) => $mail->hasTo('reporter@example.test'));
    }

    #[Test]
    public function only_a_super_admin_can_email_a_reporter(): void
    {
        Mail::fake();
        $report = ConcernReport::create(['concern_type' => 'Other', 'description' => 'Help', 'status' => 'Open', 'reporter_contact' => 'reporter@example.test']);
        Sanctum::actingAs(User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]), ['*']);
        $this->postJson("/api/superadmin/concern-reports/{$report->id}/email", ['kind' => 'acknowledge', 'subject' => 'S', 'message' => 'M'])->assertForbidden();
        Mail::assertNothingSent();
    }

    #[Test]
    public function public_concern_submissions_are_rate_limited(): void
    {
        for ($attempt = 0; $attempt < 5; $attempt++) {
            $this->postJson('/api/concern-reports', ['concern_type' => 'Other', 'description' => 'A concern'])->assertCreated();
        }
        $this->postJson('/api/concern-reports', ['concern_type' => 'Other', 'description' => 'Another concern'])->assertStatus(429);
    }

    #[Test]
    public function pending_approvals_lists_only_accounts_never_approved(): void
    {
        $superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin']]);
        $pending = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'approved_at' => null, 'is_active' => false]);
        $approved = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'approved_at' => now()]);

        Sanctum::actingAs($superAdmin, ['*']);
        $response = $this->getJson('/api/superadmin/pending-approvals')->assertOk();

        $ids = collect($response->json())->pluck('id');
        $this->assertTrue($ids->contains($pending->id));
        $this->assertFalse($ids->contains($approved->id));
    }

    #[Test]
    public function rejecting_a_never_approved_registration_deletes_the_account(): void
    {
        $superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin']]);
        $pending = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'approved_at' => null, 'is_active' => false]);

        Sanctum::actingAs($superAdmin, ['*']);
        $this->deleteJson("/api/superadmin/users/{$pending->id}/reject")->assertOk();

        $this->assertDatabaseMissing('users', ['id' => $pending->id]);
    }

    #[Test]
    public function rejecting_an_account_that_was_ever_approved_is_refused(): void
    {
        $superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin']]);
        // Approved in the past, even if inactive now — reject() must only
        // ever touch a registration nobody has reviewed yet; anything else
        // goes through deactivateUser() instead.
        $approved = User::factory()->create([
            'role' => 'Custodian', 'roles' => ['Custodian'], 'is_active' => false, 'approved_at' => now()->subDay(),
        ]);

        Sanctum::actingAs($superAdmin, ['*']);
        $this->deleteJson("/api/superadmin/users/{$approved->id}/reject")->assertStatus(422);

        $this->assertDatabaseHas('users', ['id' => $approved->id]);
    }

    /**
     * RestrictSuperAdminScope allowlists /superadmin/*, /impersonate/*, and a
     * handful of account routes — everything else 403s so a Super Admin can
     * never read fleet data through an ordinary endpoint (see its docblock).
     * /notifications is a deliberate exception: it's how notifySuperAdmins()
     * (AuthController::register()) actually reaches a Super Admin, and
     * NotificationController scopes strictly by `user_id`, never barangay —
     * no fleet data flows through it.
     */
    #[Test]
    public function super_admin_can_read_their_own_notifications(): void
    {
        $superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin']]);
        \App\Models\Notification::create([
            'user_id' => $superAdmin->id,
            'title' => 'New barangay Admin awaiting approval',
            'message' => 'Test Admin registered as the first Admin for Test Barangay.',
            'type' => 'pending_admin_approval',
        ]);

        Sanctum::actingAs($superAdmin, ['*']);
        $response = $this->getJson('/api/notifications')->assertOk();

        $this->assertCount(1, $response->json());
    }
}
