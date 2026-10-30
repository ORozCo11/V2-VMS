<?php

namespace Tests\Feature;

use App\Mail\AccountMail;
use App\Models\{ActivityLog, Barangay, City, Province, User, UserImport};
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Storage;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Batch upload: a barangay Admin with many staff to add uploads a spreadsheet,
 * previews per-row problems, then confirms — every valid row gets an invite.
 */
class UserImportTest extends TestCase
{
    use RefreshDatabase;

    private Barangay $barangay;
    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
        Storage::fake('local');
        $province = Province::create(['code' => 'TST', 'name' => 'Test Province']);
        $city = City::create(['province_id' => $province->id, 'code' => 'TSTC', 'name' => 'Test City']);
        $this->barangay = Barangay::create(['name' => 'Fresh Barangay', 'city_id' => $city->id, 'psgc_code' => '0102801001']);
        $this->admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $this->barangay->id, 'city_id' => $city->id]);
    }

    private function csv(array $lines, string $name = 'staff.csv'): UploadedFile
    {
        return UploadedFile::fake()->createWithContent($name, implode("\n", array_merge(['Full Name,Email,Phone,Role'], $lines))."\n");
    }

    private function preview(UploadedFile $file)
    {
        Sanctum::actingAs($this->admin, ['*']);

        return $this->post('/api/user-imports', ['file' => $file], ['Accept' => 'application/json']);
    }

    public function test_the_template_downloads_with_the_expected_columns(): void
    {
        Sanctum::actingAs($this->admin, ['*']);

        $response = $this->get('/api/user-imports/template?format=csv')->assertOk();
        $this->assertStringStartsWith('Full Name *,Email *,Phone,Role *', str_replace('"', '', $response->streamedContent()));
    }

    public function test_preview_flags_exactly_the_bad_rows_and_creates_nothing(): void
    {
        User::factory()->create(['email' => 'taken@example.com']);

        $this->preview($this->csv([
            'Ana Reyes,ana@example.com,09171234567,Custodian',
            'Ben Cruz,not-an-email,,Custodian',
            'Cora Lim,taken@example.com,,Maintenance Personnel',
            'Dan Uy,dan@example.com,,Driver',
            'Eva Go,ana@example.com,,Custodian',
            'Fe Tan,fe@example.com,,Custodian; Maintenance Personnel',
        ]))->assertCreated()
            ->assertJsonPath('total_rows', 6)
            ->assertJsonPath('valid_rows', 2)
            ->assertJsonPath('error_rows', 4)
            ->assertJsonFragment(['row' => 3, 'field' => 'email', 'level' => 'error', 'message' => 'Enter a valid email address.'])
            ->assertJsonFragment(['row' => 4, 'field' => 'email', 'level' => 'error', 'message' => 'An account with this email address already exists.'])
            ->assertJsonFragment(['row' => 5, 'field' => 'role', 'level' => 'error', 'message' => 'Unknown role "Driver". Use Admin, Custodian or Maintenance Personnel.'])
            ->assertJsonFragment(['row' => 6, 'field' => 'email', 'level' => 'error', 'message' => 'Duplicate email — also used on row 2.']);

        $this->assertSame(1, User::where('barangay_id', $this->barangay->id)->count(), 'Preview must not create accounts.');
        Mail::assertNothingSent();
    }

    public function test_commit_invites_only_the_valid_rows(): void
    {
        $id = $this->preview($this->csv([
            'Ana Reyes,ana@example.com,09171234567,Custodian',
            'Ben Cruz,not-an-email,,Custodian',
            'Fe Tan,fe@example.com,,Custodian; Maintenance Personnel',
        ]))->assertCreated()->json('id');

        $this->postJson("/api/user-imports/{$id}/commit")->assertOk()
            ->assertJsonPath('imported_rows', 2)
            ->assertJsonPath('failed_rows', 1);

        $ana = User::where('email', 'ana@example.com')->firstOrFail();
        $this->assertTrue($ana->invite_pending);
        $this->assertSame($this->barangay->id, $ana->barangay_id);
        $this->assertSame(['Custodian', 'Maintenance Personnel'], User::where('email', 'fe@example.com')->value('roles'));
        Mail::assertSent(AccountMail::class, 2);
        Mail::assertSent(AccountMail::class, fn (AccountMail $mail) => $mail->hasTo('fe@example.com') && $mail->template === 'invite');
        $this->assertTrue(ActivityLog::where('module', 'Users')->where('action', 'Import')->exists());
    }

    public function test_an_import_can_only_be_committed_once(): void
    {
        $id = $this->preview($this->csv(['Ana Reyes,ana@example.com,,Custodian']))->json('id');
        $this->postJson("/api/user-imports/{$id}/commit")->assertOk();

        $this->postJson("/api/user-imports/{$id}/commit")->assertStatus(422)
            ->assertJsonPath('message', 'This import has already been processed.');
    }

    public function test_a_row_whose_invite_email_fails_is_reported_and_leaves_no_account(): void
    {
        $id = $this->preview($this->csv(['Ana Reyes,ana@example.com,,Custodian']))->json('id');
        Mail::shouldReceive('to')->andThrow(new \RuntimeException('SMTP down'));

        $this->postJson("/api/user-imports/{$id}/commit")->assertOk()
            ->assertJsonPath('imported_rows', 0)
            ->assertJsonPath('failed_rows', 1)
            ->assertJsonFragment(['row' => 2, 'field' => 'email', 'level' => 'error', 'message' => 'The invite email could not be sent, so this account was not created.']);
        $this->assertFalse(User::where('email', 'ana@example.com')->exists());
    }

    public function test_wrong_file_types_and_oversized_files_are_rejected_with_the_limit(): void
    {
        $this->preview(UploadedFile::fake()->createWithContent('staff.txt', "Full Name,Email,Role\n"))
            ->assertStatus(422)->assertJsonPath('message', 'Only .xlsx or .csv files can be imported.');

        $this->preview(UploadedFile::fake()->create('staff.csv', 3 * 1024, 'text/csv'))
            ->assertStatus(422)->assertJsonPath('errors.file.0', 'The file must be 2 MB or smaller.');
    }

    public function test_a_file_missing_required_columns_names_them(): void
    {
        $file = UploadedFile::fake()->createWithContent('staff.csv', "Full Name,Phone\nAna Reyes,09171234567\n");

        $this->preview($file)->assertStatus(422)
            ->assertJsonPath('message', 'Missing required column(s): Email, Role. Download the template for the expected headers.');
    }

    public function test_only_admins_can_import_users(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'barangay_id' => $this->barangay->id]), ['*']);

        $this->post('/api/user-imports', ['file' => $this->csv(['Ana Reyes,ana@example.com,,Custodian'])], ['Accept' => 'application/json'])->assertForbidden();
    }

    public function test_another_admin_cannot_commit_someone_elses_import(): void
    {
        $id = $this->preview($this->csv(['Ana Reyes,ana@example.com,,Custodian']))->json('id');
        Sanctum::actingAs(User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $this->barangay->id]), ['*']);

        $this->postJson("/api/user-imports/{$id}/commit")->assertNotFound();
        $this->assertSame('previewed', UserImport::find($id)->status);
    }
}
