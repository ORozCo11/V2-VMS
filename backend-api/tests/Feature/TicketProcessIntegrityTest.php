<?php
namespace Tests\Feature;

use App\Models\{MaintenanceTicket, Notification, User, Vehicle, VehicleCategory, VehicleMaintenanceRecord};
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

// Acceptance coverage for the ticket-process review fixes.
class TicketProcessIntegrityTest extends TestCase
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
        $this->admin = User::factory()->create(['role'=>'Admin']);
        $this->custodian = User::factory()->create(['role'=>'Custodian']);
        $this->mechanic = User::factory()->create(['role'=>'Maintenance Personnel']);
        $this->other = User::factory()->create(['role'=>'Maintenance Personnel']);
        $category = VehicleCategory::create(['category_name'=>'Ambulance', 'description'=>'QA']);
        $this->vehicle = Vehicle::create(['vehicle_name'=>'QA Ambulance', 'plate_number'=>'QA-100', 'category_id'=>$category->category_id, 'brand'=>'Toyota', 'model'=>'HiAce', 'year_model'=>2022, 'capacity'=>'4', 'vehicle_color'=>'White', 'current_location'=>'Depot']);
    }

    private function active(string $mode='in_house', bool $multiple=false): MaintenanceTicket
    {
        Sanctum::actingAs($this->custodian,['*']);
        $payload=['vehicle_id'=>$this->vehicle->vehicle_id, 'ticket_description'=>'QA finding', 'priority'=>'High', 'entry_mode'=>$mode, 'sub_issues'=>[['title'=>'Brake repair']]];
        if ($multiple) $payload['sub_issues'][]=['title'=>'Siren repair'];
        if ($mode==='external') $payload+=['external_reason'=>'Parts or service only available from an authorized shop', 'external_work_scope'=>'Repair brakes', 'external_vendor'=>'QA Shop'];
        $id=$this->postJson('/api/tickets/propose',$payload)->assertCreated()->json('ticket_id');
        $ticket=MaintenanceTicket::with('subIssues')->findOrFail($id);
        Sanctum::actingAs($this->admin,['*']);
        $approval=$mode==='external'?['assigned_mechanic_id'=>$this->mechanic->id]:['sub_issues'=>$ticket->subIssues->map(fn($s,$i)=>['sub_issue_id'=>$s->sub_issue_id,'assigned_mechanic_id'=>$i===0?$this->mechanic->id:$this->other->id])->all()];
        $this->putJson("/api/tickets/$id/approve",$approval)->assertOk();
        return $ticket->fresh('subIssues');
    }

    private function path(MaintenanceTicket $ticket, int $index=0): string
    {
        return "/api/tickets/{$ticket->ticket_id}/sub-issues/{$ticket->subIssues[$index]->sub_issue_id}";
    }

    private function sentAndReturned(MaintenanceTicket $ticket): void
    {
        Sanctum::actingAs($this->custodian,['*']);
        $base=$this->path($ticket);
        $this->putJson("$base/external-sent",['external_vendor'=>'QA Shop','external_reason'=>'Parts or service only available from an authorized shop','external_work_scope'=>'Repair brakes'])->assertOk();
        $this->putJson("$base/external-returned",['external_return_notes'=>'Shop returned repaired vehicle','external_actual_cost'=>12000])->assertOk();
        Sanctum::actingAs($this->mechanic,['*']);
        $this->putJson("$base/log-repairs",['tested_ok' => true, 'repair_logs'=>'Shop repaired brakes','external_vendor'=>'Stale shop','warranty_until'=>'2040-01-01'])->assertOk();
        Sanctum::actingAs($this->custodian,['*']);
        $this->assertSame('QA Shop',$ticket->subIssues[0]->fresh()->external_vendor);
        $this->assertNull($ticket->subIssues[0]->fresh()->warranty_until);
    }

    private function approve(MaintenanceTicket $ticket): void
    {
        Sanctum::actingAs($this->custodian,['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify",['verification_verdict'=>'Approved','test_attested'=>true])->assertOk();
    }

    public function test_external_completion_requires_a_real_send_and_return(): void
    {
        $t=$this->active('external');
        Sanctum::actingAs($this->custodian,['*']);
        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson($this->path($t).'/log-repairs',['tested_ok'=>true,'repair_logs'=>'No logistics'])->assertUnprocessable();
        Sanctum::actingAs($this->custodian, ['*']);
        $this->assertSame('Active',$t->fresh()->status);
        $this->assertDatabaseCount('vehicle_maintenance_records',0);
    }

    public function test_external_close_creates_exactly_one_ledger_record_with_invoice_cost(): void
    {
        $t=$this->active('external');
        $this->sentAndReturned($t);
        $this->approve($t);
        $r=VehicleMaintenanceRecord::where('ticket_sub_issue_id',$t->subIssues[0]->sub_issue_id)->sole();
        $this->assertTrue($r->is_external);
        $this->assertSame('External Shop',$r->source);
        $this->assertNull($r->maintenance_personnel_id);
        $this->assertSame('QA Shop',$r->performed_by_other);
        $this->assertEquals(12000,$r->maintenance_cost);
        $this->putJson("/api/tickets/{$t->ticket_id}/verify",['verification_verdict'=>'Approved','test_attested'=>true])->assertUnprocessable();
        $this->assertDatabaseCount('vehicle_maintenance_records',1);
        $archive=\App\Models\TicketArchiveLog::where('ticket_id',$t->ticket_id)->sole();
        $this->assertEquals(12000,$archive->maintenance_cost);
        Sanctum::actingAs($this->admin,['*']);
        $this->getJson("/api/vehicles/{$this->vehicle->vehicle_id}/reliability")->assertOk()->assertJsonPath('total_spend',12000);
    }

    public function test_external_rework_notifies_custodian_preserves_cycle_and_accumulates_cost(): void
    {
        $t=$this->active('external');
        $this->sentAndReturned($t);
        $before=Notification::where('user_id',$this->custodian->id)->count();
        $beforeAdmin=Notification::where('user_id',$this->admin->id)->count();
        Sanctum::actingAs($this->custodian,['*']);
        $this->putJson("/api/tickets/{$t->ticket_id}/verify",['verification_verdict'=>'Rejected','verification_notes'=>'Brakes still fail','failed_sub_issue_ids'=>[$t->subIssues[0]->sub_issue_id]])->assertOk();
        // The rework goes back to the Custodian who handles the shop, not to the Admin.
        $this->assertGreaterThan($before,Notification::where('user_id',$this->custodian->id)->count());
        $this->assertSame($beforeAdmin,Notification::where('user_id',$this->admin->id)->count());
        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson($this->path($t).'/log-repairs',['tested_ok'=>true,'repair_logs'=>'Try skipping redo'])->assertUnprocessable();
        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson($this->path($t).'/external-sent',['external_vendor'=>'QA Shop','external_reason'=>'Warranty','external_work_scope'=>'Redo brakes'])->assertOk();
        $s=$t->subIssues[0]->fresh();
        $this->assertCount(1,$s->external_cycles);
        $this->assertEquals(12000,$s->external_cycles[0]['external_actual_cost']);
        $this->assertNull($s->external_returned_at);
        $this->putJson($this->path($t).'/external-returned',['external_return_notes'=>'Warranty repair returned','external_actual_cost'=>500])->assertOk();
        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson($this->path($t).'/log-repairs',['tested_ok'=>true,'repair_logs'=>'Corrected','maintenance_cost'=>1])->assertOk();
        Sanctum::actingAs($this->custodian, ['*']);
        $this->approve($t);
        $this->assertEquals(12500,VehicleMaintenanceRecord::where('ticket_sub_issue_id',$s->sub_issue_id)->sole()->maintenance_cost);
    }

    public function test_unknown_external_invoice_stays_unknown_in_ledger_and_archive(): void
    {
        $t=$this->active('external');$base=$this->path($t);Sanctum::actingAs($this->custodian,['*']);
        $this->putJson("$base/external-sent",['external_vendor'=>'QA Shop','external_reason'=>'Warranty','external_work_scope'=>'Repair'])->assertOk();
        $this->putJson("$base/external-returned",['external_return_notes'=>'Invoice pending'])->assertOk();
        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("$base/log-repairs",['tested_ok' => true, 'repair_logs'=>'Done'])->assertOk();
        Sanctum::actingAs($this->custodian, ['*']);
        $this->approve($t);
        $this->assertNull(VehicleMaintenanceRecord::where('ticket_sub_issue_id',$t->subIssues[0]->sub_issue_id)->sole()->maintenance_cost);
        $this->assertNull(\App\Models\TicketArchiveLog::where('ticket_id',$t->ticket_id)->sole()->maintenance_cost);
    }

    public function test_no_charge_shop_return_is_zero_rather_than_unknown(): void
    {
        $t=$this->active('external');$base=$this->path($t);Sanctum::actingAs($this->custodian,['*']);
        $this->putJson("$base/external-sent",['external_vendor'=>'QA Shop','external_reason'=>'Warranty','external_work_scope'=>'Repair'])->assertOk();
        $this->putJson("$base/external-returned",['external_return_notes'=>'No charge','external_actual_cost'=>0])->assertOk();
        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("$base/log-repairs",['tested_ok' => true, 'repair_logs'=>'Done under warranty'])->assertOk();
        Sanctum::actingAs($this->custodian, ['*']);
        $this->approve($t);
        $this->assertEquals(0,VehicleMaintenanceRecord::where('ticket_sub_issue_id',$t->subIssues[0]->sub_issue_id)->sole()->maintenance_cost);
        $this->assertNotNull($t->subIssues[0]->fresh()->maintenance_cost);
    }

    public function test_reassignment_only_moves_selected_unfinished_item(): void
    {
        $t=$this->active('in_house',true);
        Sanctum::actingAs($this->mechanic,['*']);
        $this->putJson($this->path($t).'/log-repairs',['tested_ok'=>true,'repair_logs'=>'Brakes finished'])->assertOk();
        Sanctum::actingAs($this->admin,['*']);
        $third=User::factory()->create(['role'=>'Maintenance Personnel']);
        $this->putJson("/api/tickets/{$t->ticket_id}/assign-mechanic",['assigned_mechanic_id'=>$third->id,'sub_issue_ids'=>[$t->subIssues[1]->sub_issue_id],'reassign_reason'=>'Siren specialist'])->assertOk();
        $this->assertSame('For Inspection',$t->subIssues[0]->fresh()->status);
        $this->assertSame($this->mechanic->id,(int)$t->subIssues[0]->fresh()->assigned_mechanic_id);
        $this->assertSame($third->id,(int)$t->subIssues[1]->fresh()->assigned_mechanic_id);
        $this->putJson("/api/tickets/{$t->ticket_id}/assign-mechanic",['assigned_mechanic_id'=>$third->id,'sub_issue_ids'=>[$t->subIssues[0]->sub_issue_id],'reassign_reason'=>'Reset completed work'])->assertUnprocessable();
    }

    public function test_approval_requires_explicit_verdict_and_attestation(): void
    {
        $t=$this->active();
        Sanctum::actingAs($this->mechanic,['*']);
        $this->putJson($this->path($t).'/log-repairs',['tested_ok'=>true,'repair_logs'=>'Done'])->assertOk();
        Sanctum::actingAs($this->custodian,['*']);
        foreach([[],['verification_verdict'=>'Approved'],['verification_verdict'=>'Approved','test_attested'=>false],['test_attested'=>true]] as $payload) $this->putJson("/api/tickets/{$t->ticket_id}/verify",$payload)->assertUnprocessable();
        $this->assertSame('For Verification',$t->fresh()->status);
        $this->approve($t);
    }

    public function test_future_and_reverse_dates_are_rejected_without_state_changes(): void
    {
        $t=$this->active();
        Sanctum::actingAs($this->mechanic,['*']);
        foreach([['repair_started_at'=>'2040-02-01','repair_completed_at'=>'2040-01-01'],['repair_started_at'=>'2020-02-01','repair_completed_at'=>'2020-01-01']] as $dates) $this->putJson($this->path($t).'/log-repairs',$dates+['repair_logs'=>'Done'])->assertUnprocessable();
        $this->assertSame('Under Repair',$t->subIssues[0]->fresh()->status);
        $this->assertDatabaseCount('vehicle_maintenance_records',0);
        $this->putJson($this->path($t).'/log-repairs',['tested_ok'=>true,'repair_logs'=>'Done'])->assertOk();
        $this->assertNotNull($t->subIssues[0]->fresh()->repair_completed_at);
    }

    public function test_only_failed_item_returns_and_other_submission_is_preserved(): void
    {
        $t=$this->active('in_house',true);
        foreach([$this->mechanic,$this->other] as $i=>$mechanic) {
            Sanctum::actingAs($mechanic,['*']);
            $this->putJson($this->path($t,$i).'/log-repairs',['tested_ok'=>true,'repair_logs'=>'Finished own job'])->assertOk();
        }
        Sanctum::actingAs($this->custodian,['*']);
        $this->putJson("/api/tickets/{$t->ticket_id}/verify",['verification_verdict'=>'Rejected','verification_notes'=>'Only brakes failed','failed_sub_issue_ids'=>[$t->subIssues[0]->sub_issue_id]])->assertOk();
        $this->assertSame('Under Repair',$t->subIssues[0]->fresh()->status);
        $this->assertSame('For Inspection',$t->subIssues[1]->fresh()->status);
        Sanctum::actingAs($this->mechanic,['*']);
        $this->putJson($this->path($t).'/log-repairs',['tested_ok'=>true,'repair_logs'=>'Fixed again'])->assertOk();
        $this->assertSame('For Verification',$t->fresh()->status);
        $this->approve($t);
        $this->assertDatabaseCount('vehicle_maintenance_records',2);
        $events=$t->subIssues[0]->fresh()->work_history;
        $this->assertSame(['Repair Submitted','Returned for Rework','Repair Submitted','Verification Approved'],array_column($events,'event'));
    }

    public function test_reassignment_timeline_identifies_work_previous_new_mechanic_and_reason(): void
    {
        $t=$this->active('in_house',true);
        $reason='Original mechanic is on leave; hand over unfinished brake repair.';
        $this->putJson("/api/tickets/{$t->ticket_id}/assign-mechanic", ['assigned_mechanic_id'=>$this->other->id,'sub_issue_ids'=>[$t->subIssues[0]->sub_issue_id],'reassign_reason'=>$reason])->assertOk();
        $activity=collect($this->getJson("/api/tickets/{$t->ticket_id}")->assertOk()->json('activity'))->where('action','Ticket Mechanic Reassigned')->sole();
        $this->assertStringContainsString($t->subIssues[0]->title,$activity['details']);
        $this->assertStringContainsString('from '.$this->mechanic->name.' to '.$this->other->name,$activity['details']);
        $this->assertStringContainsString($reason,$activity['details']);
        $this->assertSame($this->admin->id,$activity['user']['id']);
        $this->assertNotEmpty($activity['created_at']);
        $this->assertSame('Under Repair',$t->subIssues[0]->fresh()->status);
        $this->assertSame($this->other->id,$t->subIssues[1]->fresh()->assigned_mechanic_id);
        $this->assertContains($this->mechanic->id,$t->subIssues[0]->fresh()->prior_mechanic_ids);
    }

    public function test_mechanic_cannot_switch_to_external_or_record_shop_logistics(): void
    {
        $t=$this->active();
        Sanctum::actingAs($this->mechanic,['*']);
        $this->putJson($this->path($t).'/log-repairs',['tested_ok'=>true,'repair_logs'=>'Shop did it','repair_type'=>'external','external_vendor'=>'Shop'])->assertUnprocessable();
        $this->putJson($this->path($t).'/external-sent',['external_vendor'=>'Shop','external_reason'=>'x','external_work_scope'=>'x'])->assertForbidden();
        $this->assertSame('in_house',$t->subIssues[0]->fresh()->repair_type);
    }

    public function test_schema_upgrade_and_rollback_preserve_existing_vehicles_and_records(): void
    {
        $t=$this->active();
        Sanctum::actingAs($this->mechanic,['*']);
        $this->putJson($this->path($t).'/log-repairs',['tested_ok'=>true,'repair_logs'=>'Done'])->assertOk();
        $this->approve($t);
        $migration=require database_path('migrations/2026_10_24_000001_preserve_ticket_work_evidence.php');
        $migration->down();
        $this->assertFalse(\Illuminate\Support\Facades\Schema::hasColumn('ticket_sub_issues','work_history'));
        $this->assertSame(1,Vehicle::count());
        $this->assertSame(1,VehicleMaintenanceRecord::count());
        $migration->up();
        $this->assertTrue(\Illuminate\Support\Facades\Schema::hasColumn('ticket_sub_issues','external_cycles'));
        $this->assertSame(1,Vehicle::count());
        $this->assertSame(1,VehicleMaintenanceRecord::count());
    }

    public function test_failed_item_ids_cannot_reference_another_ticket(): void
    {
        $t=$this->active();
        Sanctum::actingAs($this->mechanic,['*']);
        $this->putJson($this->path($t).'/log-repairs',['tested_ok'=>true,'repair_logs'=>'Done'])->assertOk();
        Sanctum::actingAs($this->custodian,['*']);
        $this->putJson("/api/tickets/{$t->ticket_id}/verify",['verification_verdict'=>'Rejected','verification_notes'=>'Wrong ID','failed_sub_issue_ids'=>[999999]])->assertUnprocessable();
        $this->assertSame('For Verification',$t->fresh()->status);
        $this->assertSame('For Inspection',$t->subIssues[0]->fresh()->status);
    }

    public function test_schedule_conversion_observes_philippine_date_and_service_time(): void
    {
        $this->travelTo(\Carbon\Carbon::parse('2026-10-25 00:05:00', 'Asia/Manila'));
        $schedule=\App\Models\VehicleMaintenanceSchedule::create([
            'vehicle_id'=>$this->vehicle->vehicle_id, 'created_by'=>$this->custodian->id,
            'maintenance_type'=>'Oil Change', 'status'=>'Scheduled',
            'scheduled_date'=>'2026-10-25', 'scheduled_time'=>'00:10:00',
        ]);
        $this->artisan('schedules:convert-due-to-tickets')->assertSuccessful();
        $this->assertNull($schedule->fresh()->resulting_ticket_id);
        $this->travelTo(\Carbon\Carbon::parse('2026-10-25 00:10:00', 'Asia/Manila'));
        $this->artisan('schedules:convert-due-to-tickets')->assertSuccessful();
        $this->assertNotNull($schedule->fresh()->resulting_ticket_id);
        $this->artisan('schedules:convert-due-to-tickets')->assertSuccessful();
        $this->assertSame(1,MaintenanceTicket::count());
        $this->travelBack();
    }
}
