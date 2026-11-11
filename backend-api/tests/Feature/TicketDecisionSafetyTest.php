<?php
namespace Tests\Feature;

use App\Models\{MaintenanceTicket, Notification, User, Vehicle, VehicleCategory, VehicleMaintenanceRecord};
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

// Acceptance coverage for ticket decision integrity and correction workflow.
class TicketDecisionSafetyTest extends TestCase
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

    private function propose(string $mode='in_house', string $title='Brake repair', ?int $issue=null): MaintenanceTicket
    {
        Sanctum::actingAs($this->custodian,['*']);
        $payload=['vehicle_id'=>$this->vehicle->vehicle_id,'ticket_description'=>'QA findings','priority'=>'High','entry_mode'=>$mode,'sub_issues'=>[['title'=>$title]]];
        if($issue) $payload['issue_report_id']=$issue;
        if($mode==='external') $payload+=['external_reason'=>'Parts or service only available from an authorized shop','external_work_scope'=>'Repair brakes','external_vendor'=>'QA Shop'];
        $id=$this->postJson('/api/tickets/propose',$payload)->assertCreated()->json('ticket_id');
        return MaintenanceTicket::with('subIssues')->findOrFail($id);
    }
    private function activate(MaintenanceTicket $t): void
    {
        Sanctum::actingAs($this->admin,['*']);
        $payload=['assigned_mechanic_id'=>$this->mechanic->id];
        $this->putJson("/api/tickets/{$t->ticket_id}/approve",$payload)->assertOk();
    }
    private function submit(MaintenanceTicket $t): void
    {
        $s=$t->subIssues[0];$base="/api/tickets/{$t->ticket_id}/sub-issues/{$s->sub_issue_id}";
        if($s->repair_type==='external') {
            Sanctum::actingAs($this->custodian,['*']);
            $this->putJson("$base/external-sent",['external_vendor'=>'QA Shop','external_reason'=>'Warranty','external_work_scope'=>'Repair'])->assertOk();
            $this->putJson("$base/external-returned",['external_return_notes'=>'Done','external_actual_cost'=>12000])->assertOk();
        }
        Sanctum::actingAs($this->mechanic,['*']);
        $this->putJson("$base/log-repairs",['tested_ok' => true, 'repair_logs'=>'Actual paid repair','maintenance_cost'=>500])->assertOk();
    }
    private function staleDecision(string $action,MaintenanceTicket $snapshot,array $data=[]): void
    {
        Sanctum::actingAs($this->admin,['*']);
        $request=\Illuminate\Http\Request::create('/api/tickets/'.$snapshot->ticket_id,'PUT',$data);
        $request->setUserResolver(fn()=>$this->admin);
        try {
            (new \App\Http\Controllers\TicketController())->{$action}($request,$snapshot);
            $this->fail('A stale decision must be rejected.');
        } catch (\Symfony\Component\HttpKernel\Exception\HttpException $error) {
            $this->assertSame(422, $error->getStatusCode());
        }
    }
    private function close(MaintenanceTicket $ticket): void
    {
        Sanctum::actingAs($this->custodian,['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify",['verification_verdict'=>'Approved','test_attested'=>true])->assertOk();
    }
    private function correctionPayload(MaintenanceTicket $ticket): array
    {
        return ['ticket_description'=>'Corrected observations','priority'=>'Low','sub_issues'=>$ticket->subIssues->map(fn($item)=>['sub_issue_id'=>$item->sub_issue_id,'title'=>'Corrected brake concern','maintenance_type'=>null])->all()];
    }
    public function test_stale_decline_cannot_overwrite_approved_work(): void
    {
        $t=$this->propose();$snapshot=$t->fresh();$this->activate($t);
        $before=Notification::count();
        $this->staleDecision('declineTicket',$snapshot,['decline_reason'=>'Old decision']);
        $this->assertSame('Active',$t->fresh()->status);
        $this->assertSame('Under Repair',$t->subIssues[0]->fresh()->status);
        $this->assertSame($before,Notification::count());
    }
    public function test_stale_cancel_and_delete_cannot_change_closed_work(): void
    {
        $t=$this->propose();$this->activate($t);$snapshot=$t->fresh(['subIssues']);$this->submit($t);$this->close($t);
        $this->staleDecision('cancelTicket',$snapshot,['closing_notes'=>'Old cancellation']);
        $this->staleDecision('deleteTicket',$snapshot);
        $this->assertSame('Closed',$t->fresh()->status);
        $this->assertSame(1,VehicleMaintenanceRecord::count());
        $this->assertSame(1,\App\Models\TicketArchiveLog::where('final_status','Closed')->count());
    }
    public function test_stale_undecline_and_restore_cannot_rewind_work(): void
    {
        $t=$this->propose();Sanctum::actingAs($this->admin,['*']);
        $this->putJson("/api/tickets/{$t->ticket_id}/decline",['decline_reason'=>'Wrong scope'])->assertOk();
        $oldDeclined=$t->fresh();
        $this->putJson("/api/tickets/{$t->ticket_id}/undecline",[])->assertOk();$this->activate($t);
        $this->staleDecision('undeclineTicket',$oldDeclined);
        $this->putJson("/api/tickets/{$t->ticket_id}/cancel",['closing_notes'=>'Pause work'])->assertOk();
        $oldCancelled=$t->fresh();
        $this->putJson("/api/tickets/{$t->ticket_id}/uncancel",[])->assertOk();
        $this->staleDecision('uncancelTicket',$oldCancelled);
        $this->assertSame('Active',$t->fresh()->status);
    }
    public function test_deleting_submitted_paid_work_preserves_everything(): void
    {
        $t=$this->propose();$this->activate($t);$this->submit($t);
        Sanctum::actingAs($this->admin,['*']);
        $this->deleteJson("/api/tickets/{$t->ticket_id}")->assertUnprocessable();
        $this->assertSame('For Verification',$t->fresh()->status);
        $this->assertEquals(500,$t->subIssues[0]->fresh()->maintenance_cost);
        $this->assertStringContainsString('Actual paid repair',$t->subIssues[0]->fresh()->repair_logs);
    }
    public function test_saved_cost_zero_and_attachments_also_prevent_deletion(): void
    {
        foreach([['repair_completed_at'=>'2026-10-24'],['maintenance_cost'=>0],['attachment_files'=>[['url'=>'qa-evidence','name'=>'proof.pdf']]],['external_sent_at'=>now()]] as $i=>$evidence) {
            $t=$this->propose('in_house','Separate job '.$i);$this->activate($t);
            $t->subIssues[0]->update($evidence);
            Sanctum::actingAs($this->admin,['*']);
            $this->deleteJson("/api/tickets/{$t->ticket_id}")->assertUnprocessable();
            $this->assertNotNull($t->fresh());
        }
    }
    public function test_external_restoration_returns_submitted_work_to_verification_once(): void
    {
        $t=$this->propose('external');$this->activate($t);$this->submit($t);
        Sanctum::actingAs($this->admin,['*']);
        $this->putJson("/api/tickets/{$t->ticket_id}/cancel",['closing_notes'=>'Temporary administrative pause'])->assertOk();
        $before=Notification::where('user_id',$this->custodian->id)->where('type','repairs_completed')->count();
        $this->putJson("/api/tickets/{$t->ticket_id}/uncancel",[])->assertOk()->assertJsonPath('status','For Verification');
        $this->assertSame($before+1,Notification::where('user_id',$this->custodian->id)->where('type','repairs_completed')->count());
        $this->putJson("/api/tickets/{$t->ticket_id}/uncancel",[])->assertUnprocessable();
        $this->assertSame($before+1,Notification::where('user_id',$this->custodian->id)->where('type','repairs_completed')->count());
        $this->close($t);
    }
    public function test_cancellation_requires_reason_notifies_actors_and_retains_history(): void
    {
        $t=$this->propose();$this->activate($t);Sanctum::actingAs($this->admin,['*']);
        foreach([[],['closing_notes'=>'   ']] as $data) $this->putJson("/api/tickets/{$t->ticket_id}/cancel",$data)->assertUnprocessable();
        $this->assertSame('Active',$t->fresh()->status);
        $this->putJson("/api/tickets/{$t->ticket_id}/cancel",['closing_notes'=>'Duplicate approved work'])->assertOk();
        foreach([$this->custodian,$this->mechanic] as $person) $this->assertDatabaseHas('notifications',['user_id'=>$person->id,'ticket_id'=>$t->ticket_id,'type'=>'ticket_cancelled']);
        $this->putJson("/api/tickets/{$t->ticket_id}/uncancel",[])->assertOk();
        $this->assertSame('Duplicate approved work',$t->fresh()->closing_notes);
        $history=$t->fresh()->decision_history;
        $this->assertSame(['Approved','Cancelled','Restored'],array_column($history,'event'));
        $this->assertSame('Duplicate approved work',$history[1]['details']['reason']);
    }
    public function test_undecline_cannot_reclaim_another_tickets_report(): void
    {
        $a=$this->propose();Sanctum::actingAs($this->admin,['*']);
        $this->putJson("/api/tickets/{$a->ticket_id}/decline",['decline_reason'=>'Correct scope'])->assertOk();
        $b=$this->propose('in_house','New scope',$a->issue_report_id);$this->activate($b);
        $this->putJson("/api/tickets/{$a->ticket_id}/undecline",[])->assertUnprocessable();
        $this->assertSame('Declined',$a->fresh()->status);
        $this->assertSame('In Maintenance',\App\Models\VehicleIssueReport::find($a->issue_report_id)->status);
        $this->submit($b);$this->close($b);
        Sanctum::actingAs($this->admin,['*']);
        $this->putJson("/api/tickets/{$a->ticket_id}/undecline",[])->assertUnprocessable();
        $this->assertSame('Resolved',\App\Models\VehicleIssueReport::find($a->issue_report_id)->status);
    }
    public function test_restore_cannot_reclaim_another_tickets_report(): void
    {
        $a=$this->propose();$this->activate($a);
        $this->putJson("/api/tickets/{$a->ticket_id}/cancel",['closing_notes'=>'Scope superseded'])->assertOk();
        $b=$this->propose('in_house','Replacement scope',$a->issue_report_id);$this->activate($b);
        $this->putJson("/api/tickets/{$a->ticket_id}/uncancel",[])->assertUnprocessable();
        $this->assertSame('Cancelled',$a->fresh()->status);
        $this->assertSame('Active',$b->fresh()->status);
    }
    public function test_old_declined_ticket_deletion_does_not_reset_new_report_owner(): void
    {
        $a=$this->propose();Sanctum::actingAs($this->admin,['*']);
        $this->putJson("/api/tickets/{$a->ticket_id}/decline",['decline_reason'=>'Wrong scope'])->assertOk();
        $b=$this->propose('in_house','Replacement scope',$a->issue_report_id);$this->activate($b);
        $this->deleteJson("/api/tickets/{$a->ticket_id}")->assertOk();
        $this->assertSame('In Maintenance',\App\Models\VehicleIssueReport::find($b->issue_report_id)->status);
    }
    public function test_final_decline_allows_a_new_proposal_but_blocks_duplicate_reconsideration(): void
    {
        $a=$this->propose();Sanctum::actingAs($this->admin,['*']);
        $this->putJson("/api/tickets/{$a->ticket_id}/decline",['decline_reason'=>'New information required'])->assertOk();
        $b=$this->propose();
        Sanctum::actingAs($this->admin,['*']);
        $this->putJson("/api/tickets/{$a->ticket_id}/undecline",[])->assertUnprocessable();
        $this->assertSame('Pending Approval',$b->fresh()->status);
    }
    public function test_correction_cycle_reuses_proposal_and_requires_fresh_admin_review(): void
    {
        $t=$this->propose();Sanctum::actingAs($this->admin,['*']);
        $this->putJson("/api/tickets/{$t->ticket_id}/request-corrections",['correction_reason'=>'Describe the physical symptom'])->assertOk();
        $this->putJson("/api/tickets/{$t->ticket_id}/approve",['assigned_mechanic_id'=>$this->mechanic->id])->assertUnprocessable();
        Sanctum::actingAs($this->custodian,['*']);
        $this->putJson("/api/tickets/{$t->ticket_id}/resubmit",$this->correctionPayload($t))->assertOk();
        $this->assertSame(1,MaintenanceTicket::count());
        $this->assertSame('Pending Approval',$t->fresh()->status);
        $this->assertNull($t->fresh()->correction_requested_at);
        $this->assertSame('Corrected observations',$t->fresh()->ticket_description);
        $this->assertSame(['Corrections Requested','Proposal Resubmitted'],array_column($t->fresh()->decision_history,'event'));
        $this->activate($t);
        $this->assertSame('Active',$t->fresh()->status);
    }
    public function test_only_assigned_custodian_can_correct_and_active_work_cannot_be_rewritten(): void
    {
        $t=$this->propose();Sanctum::actingAs($this->admin,['*']);
        $this->putJson("/api/tickets/{$t->ticket_id}/request-corrections",['correction_reason'=>'Clarify'])->assertOk();
        $otherCustodian=User::factory()->create(['role'=>'Custodian']);
        foreach([$otherCustodian,$this->admin,$this->mechanic] as $person) {
            Sanctum::actingAs($person,['*']);
            $this->putJson("/api/tickets/{$t->ticket_id}/resubmit",$this->correctionPayload($t))->assertForbidden();
        }
        Sanctum::actingAs($this->custodian,['*']);
        $this->putJson("/api/tickets/{$t->ticket_id}/resubmit",$this->correctionPayload($t))->assertOk();$this->activate($t);
        $this->putJson("/api/tickets/{$t->ticket_id}/request-corrections",['correction_reason'=>'Rewrite live work'])->assertUnprocessable();
        Sanctum::actingAs($this->custodian,['*']);
        $this->putJson("/api/tickets/{$t->ticket_id}/resubmit",$this->correctionPayload($t))->assertUnprocessable();
    }
    public function test_stale_review_revision_cannot_approve_decline_or_resubmit(): void
    {
        $t=$this->propose();Sanctum::actingAs($this->admin,['*']);
        $this->putJson("/api/tickets/{$t->ticket_id}/request-corrections",['correction_reason'=>'Correct','expected_revision'=>0])->assertOk();
        $before=Notification::count();
        $this->putJson("/api/tickets/{$t->ticket_id}/decline",['decline_reason'=>'Old view','expected_revision'=>0])->assertStatus(409);
        $this->assertSame($before,Notification::count());
        Sanctum::actingAs($this->custodian,['*']);
        $this->putJson("/api/tickets/{$t->ticket_id}/resubmit",$this->correctionPayload($t)+['expected_revision'=>0])->assertStatus(409);
        $this->putJson("/api/tickets/{$t->ticket_id}/resubmit",$this->correctionPayload($t)+['expected_revision'=>1])->assertOk();
        Sanctum::actingAs($this->admin,['*']);
        $this->putJson("/api/tickets/{$t->ticket_id}/approve",['assigned_mechanic_id'=>$this->mechanic->id,'expected_revision'=>1])->assertStatus(409);
        $this->assertSame('Pending Approval',$t->fresh()->status);
    }
    public function test_correction_failure_does_not_partially_change_proposal_or_history(): void
    {
        $t=$this->propose();Sanctum::actingAs($this->admin,['*']);
        $this->putJson("/api/tickets/{$t->ticket_id}/request-corrections",['correction_reason'=>'Correct'])->assertOk();
        Sanctum::actingAs($this->custodian,['*']);
        $data=$this->correctionPayload($t);$data['sub_issues'][0]['sub_issue_id']=999999;
        $this->putJson("/api/tickets/{$t->ticket_id}/resubmit",$data)->assertUnprocessable();
        $this->assertSame('QA findings',$t->fresh()->ticket_description);
        $this->assertCount(1,$t->fresh()->decision_history);
        $this->assertNotNull($t->fresh()->correction_requested_at);
    }
    public function test_ticket_still_at_shop_cannot_be_cancelled_and_released(): void
    {
        $t=$this->propose('external');$this->activate($t);
        $s=$t->subIssues[0];
        Sanctum::actingAs($this->custodian,['*']);
        $this->putJson("/api/tickets/{$t->ticket_id}/sub-issues/{$s->sub_issue_id}/external-sent",['external_vendor'=>'QA Shop','external_reason'=>'Warranty','external_work_scope'=>'Repair'])->assertOk();
        Sanctum::actingAs($this->admin,['*']);
        $this->putJson("/api/tickets/{$t->ticket_id}/cancel",['closing_notes'=>'Stop work'])->assertUnprocessable();
        $this->assertSame('Active',$t->fresh()->status);
        $this->assertSame('Under Maintenance',$this->vehicle->fresh()->status);
    }
    public function test_decision_migration_round_trip_keeps_vehicle_and_ticket(): void
    {
        $t=$this->propose();$migration=require database_path('migrations/2026_10_24_000002_add_ticket_decision_history.php');
        $migration->down();$this->assertSame(1,Vehicle::count());$this->assertSame(1,MaintenanceTicket::count());
        $migration->up();$this->assertSame(0,$t->fresh()->decision_revision);$this->assertNull($t->fresh()->decision_history);
    }

    public function test_issue_link_follows_current_owner_instead_of_old_declined_or_cancelled_ticket(): void
    {
        $a=$this->propose();Sanctum::actingAs($this->admin,['*']);
        $this->putJson("/api/tickets/{$a->ticket_id}/decline",['decline_reason'=>'Wrong scope'])->assertOk();
        $b=$this->propose('in_house','Replacement scope',$a->issue_report_id);$this->activate($b);
        $report=\App\Models\VehicleIssueReport::findOrFail($a->issue_report_id);
        $this->assertSame($b->ticket_id,$report->fresh('maintenanceTicket')->maintenanceTicket->ticket_id);
        $this->putJson("/api/tickets/{$b->ticket_id}/cancel",['closing_notes'=>'Reconsider the original scope'])->assertOk();
        $this->putJson("/api/tickets/{$a->ticket_id}/undecline",[])->assertOk();
        $this->assertSame($a->ticket_id,$report->fresh('maintenanceTicket')->maintenanceTicket->ticket_id);
    }

    public function test_admin_can_finally_decline_a_proposal_awaiting_corrections(): void
    {
        $t=$this->propose();Sanctum::actingAs($this->admin,['*']);
        $this->putJson("/api/tickets/{$t->ticket_id}/request-corrections",['correction_reason'=>'Clarify scope'])->assertOk();
        $this->putJson("/api/tickets/{$t->ticket_id}/decline",['decline_reason'=>'This work is no longer proposed'])->assertOk();
        $this->assertSame('Declined',$t->fresh()->status);
        $this->assertNull($t->fresh()->correction_requested_at);
        $this->assertSame('Clarify scope',$t->fresh()->decision_history[0]['details']['reason']);
        Sanctum::actingAs($this->custodian,['*']);
        $this->putJson("/api/tickets/{$t->ticket_id}/resubmit",$this->correctionPayload($t))->assertUnprocessable();
    }
}
