<?php

namespace Tests\Feature;

use App\Models\ActivityLog;
use App\Models\MaintenanceTicket;
use App\Models\Notification;
use App\Models\TicketSubIssue;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * A mechanic can hand a work item back to the Admin with a reason. The Admin and the Custodian are both told
 * and both can see the return on the ticket until the Admin reassigns it. An external-shop job has a named
 * shop tester (chosen at approval); that person can return it too and the Admin can change them.
 */
class ReturnToAdminTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;
    private User $custodian;
    private User $mechanic;
    private User $other;
    private Vehicle $vehicle;

    protected function setUp(): void
    {
        parent::setUp();
        $this->admin = User::factory()->create(['role' => 'Admin']);
        $this->custodian = User::factory()->create(['role' => 'Custodian']);
        $this->mechanic = User::factory()->create(['role' => 'Maintenance Personnel']);
        $this->other = User::factory()->create(['role' => 'Maintenance Personnel']);
        $category = VehicleCategory::create(['category_name' => 'Ambulance', 'description' => 'test']);
        $this->vehicle = Vehicle::create([
            'vehicle_name' => 'Return Test Ambulance', 'plate_number' => 'RET 1001', 'category_id' => $category->category_id,
            'brand' => 'Ford', 'model' => 'E-350', 'year_model' => 2020, 'capacity' => '4', 'vehicle_color' => 'White', 'current_location' => 'Depot',
        ]);
    }

    /** An approved ticket, returns [ticket id, sub-issue, url of the sub-issue]. */
    private function approved(string $mode = 'in_house'): array
    {
        Sanctum::actingAs($this->custodian, ['*']);
        $payload = ['vehicle_id' => $this->vehicle->vehicle_id, 'ticket_description' => 'Needs work', 'priority' => 'High',
            'entry_mode' => $mode, 'sub_issues' => [['title' => 'Brake job']]];
        if ($mode === 'external') {
            $payload += ['external_reason' => 'Parts or service only available from an authorized shop', 'external_work_scope' => 'Rebuild', 'external_vendor' => 'Shop'];
        }
        $id = $this->postJson('/api/tickets/propose', $payload)->assertCreated()->json('ticket_id');
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$id}/approve", ['assigned_mechanic_id' => $this->mechanic->id])->assertOk();
        $sub = TicketSubIssue::where('ticket_id', $id)->first();

        return [$id, $sub, "/api/tickets/{$id}/sub-issues/{$sub->sub_issue_id}"];
    }

    #[Test]
    public function the_mechanic_returns_a_work_item_and_the_admin_and_custodian_both_see_it(): void
    {
        [$id, $sub, $url] = $this->approved();
        Sanctum::actingAs($this->mechanic, ['*']);

        $this->putJson("{$url}/return-to-admin", [])->assertUnprocessable();
        $this->putJson("{$url}/return-to-admin", ['reason' => 'abc'])->assertUnprocessable();   // too short
        $res = $this->putJson("{$url}/return-to-admin", ['reason' => 'Needs a welder, not a mechanic.'])->assertOk();

        $item = $sub->fresh();
        $this->assertNull($item->assigned_mechanic_id);
        $this->assertSame('Under Repair', $item->status);
        $this->assertSame($this->mechanic->id, (int) $item->returned_to_admin_by);
        $this->assertSame('Needs a welder, not a mechanic.', $item->returned_to_admin_reason);
        $this->assertContains($this->mechanic->id, $item->prior_mechanic_ids);
        $this->assertNull(MaintenanceTicket::find($id)->assigned_mechanic_id);
        $this->assertSame('Returned to Admin', collect($item->work_history)->last()['event']);
        $this->assertSame($this->mechanic->name, $res->json('sub_issues.0.returned_to_admin_by.name'));

        // Admin and Custodian are both notified, and it is in the activity log.
        $this->assertTrue(Notification::where('user_id', $this->admin->id)->where('type', 'work_order_returned')->exists());
        $this->assertTrue(Notification::where('user_id', $this->custodian->id)->where('type', 'work_order_returned')->exists());
        $this->assertTrue(ActivityLog::where('action', 'Work Returned to Admin')->exists());

        // Both can read it on the ticket.
        foreach ([$this->admin, $this->custodian] as $viewer) {
            Sanctum::actingAs($viewer, ['*']);
            $this->getJson("/api/tickets/{$id}")->assertOk()->assertJsonPath('sub_issues.0.returned_to_admin_reason', 'Needs a welder, not a mechanic.');
        }

        // The Admin reassigns it, which clears the return.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$id}/assign-mechanic", ['assigned_mechanic_id' => $this->other->id, 'reassign_reason' => 'Welder assigned.'])->assertOk();
        $item = $sub->fresh();
        $this->assertSame($this->other->id, (int) $item->assigned_mechanic_id);
        $this->assertNull($item->returned_to_admin_at);
        $this->assertNull($item->returned_to_admin_reason);
    }

    #[Test]
    public function only_the_assigned_mechanic_can_return_it_and_only_while_it_is_under_repair_on_an_active_ticket(): void
    {
        [$id, $sub, $url] = $this->approved();

        foreach ([$this->other, $this->custodian, $this->admin] as $user) {
            Sanctum::actingAs($user, ['*']);
            $this->putJson("{$url}/return-to-admin", ['reason' => 'Not mine to do.'])->assertForbidden();
        }

        Sanctum::actingAs($this->mechanic, ['*']);
        $sub->update(['status' => 'For Inspection']);
        $this->putJson("{$url}/return-to-admin", ['reason' => 'Changed my mind.'])->assertUnprocessable();
        $sub->update(['status' => 'Under Repair']);
        MaintenanceTicket::whereKey($id)->update(['status' => 'For Verification']);
        $this->putJson("{$url}/return-to-admin", ['reason' => 'Changed my mind.'])->assertUnprocessable();
        $this->assertNull($sub->fresh()->returned_to_admin_at);
    }

    #[Test]
    public function the_named_shop_tester_can_return_the_test_and_the_admin_can_change_the_tester(): void
    {
        [$id, $sub, $url] = $this->approved('external');
        $this->assertSame($this->mechanic->id, (int) $sub->fresh()->external_tester_id);
        TicketSubIssue::whereKey($sub->sub_issue_id)->update(['external_sent_at' => now()->subDay(), 'external_returned_at' => now()]);

        // Only the named tester may test the returned job.
        Sanctum::actingAs($this->other, ['*']);
        $this->putJson("{$url}/log-repairs", ['tested_ok' => true, 'repair_logs' => 'x'])->assertForbidden();

        // The tester hands it back; nobody is the tester until the Admin names one.
        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("{$url}/return-to-admin", ['reason' => 'I am away this week.'])->assertOk();
        $this->assertNull($sub->fresh()->external_tester_id);
        $this->assertNotNull($sub->fresh()->returned_to_admin_at);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("{$url}/external-tester", ['tester_id' => $this->custodian->id])->assertUnprocessable();   // not a mechanic
        $this->putJson("{$url}/external-tester", ['tester_id' => $this->other->id])->assertOk();
        $this->assertSame($this->other->id, (int) $sub->fresh()->external_tester_id);
        $this->assertNull($sub->fresh()->returned_to_admin_at);

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("{$url}/external-tester", ['tester_id' => $this->mechanic->id])->assertForbidden();   // Admin only
    }
}
