<?php

namespace App\Http\Controllers;

use App\Http\Controllers\Concerns\AuthorizesAbilities;
use App\Models\ActivityLog;
use App\Models\User;
use App\Models\UserImport;
use App\Services\UserInviter;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use PhpOffice\PhpSpreadsheet\IOFactory;
use PhpOffice\PhpSpreadsheet\Spreadsheet;
use PhpOffice\PhpSpreadsheet\Writer\Csv as CsvWriter;
use PhpOffice\PhpSpreadsheet\Writer\Xlsx as XlsxWriter;

/**
 * Batch upload of staff: template -> upload -> preview (validate only) ->
 * confirm -> invite every valid row -> summary + Activity Log. Same shape and
 * file rules as VehicleImportController; the confirm step re-reads and
 * re-validates the stored file rather than trusting rows from the client.
 */
class UserImportController extends Controller
{
    use AuthorizesAbilities;

    private const MAX_BYTES = 2 * 1024 * 1024;
    private const MAX_ROWS = 500;
    private const ROLES = ['Admin', 'Custodian', 'Maintenance Personnel'];

    // key => [header label, aliases (normalized: lowercase letters/digits only)]
    private const COLUMNS = [
        'name'  => ['Full Name', ['fullname', 'name']],
        'email' => ['Email', ['email', 'emailaddress']],
        'phone' => ['Phone', ['phone', 'phonenumber', 'mobile', 'contactnumber']],
        'role'  => ['Role', ['role', 'roles']],
    ];

    private const REQUIRED_COLUMNS = ['name', 'email', 'role'];

    public function template(Request $request)
    {
        $this->requireAbility($request, 'user.invite', 'Only Admins can import users.');
        $format = $request->query('format') === 'csv' ? 'csv' : 'xlsx';

        $sheet = new Spreadsheet();
        $data = $sheet->getActiveSheet()->setTitle('Users');
        $col = 1;
        foreach (self::COLUMNS as $key => [$label]) {
            $data->setCellValue([$col++, 1], $label . (in_array($key, self::REQUIRED_COLUMNS, true) ? ' *' : ''));
        }
        foreach (['Juan Dela Cruz', 'juan@example.com', '09171234567', 'Custodian'] as $i => $value) {
            $data->setCellValueExplicit([$i + 1, 2], $value, \PhpOffice\PhpSpreadsheet\Cell\DataType::TYPE_STRING);
        }

        $guide = $sheet->createSheet()->setTitle('Instructions');
        $guide->fromArray([
            ['Columns marked * are required. Delete the sample row before uploading.'],
            ['Each person gets an email invite with a link to set their password.'],
            ['Phone, if given, must be 11 digits starting with 09.'],
            ['To give someone more than one role, separate them with a semicolon, e.g. Custodian; Maintenance Personnel'],
            [''],
            ['Valid Roles'],
            ...array_map(fn ($r) => [$r], self::ROLES),
            [''],
            ['Limits: .xlsx or .csv, up to 2 MB and ' . self::MAX_ROWS . ' people per file.'],
        ]);
        $guide->getColumnDimension('A')->setWidth(90);

        if ($format === 'csv') {
            $sheet->setActiveSheetIndex(0);
            $writer = new CsvWriter($sheet);
            $writer->setSheetIndex(0);
        } else {
            $writer = new XlsxWriter($sheet);
        }

        return response()->streamDownload(fn () => $writer->save('php://output'), "user-import-template.{$format}", [
            'Content-Type' => $format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ]);
    }

    public function preview(Request $request)
    {
        $this->requireAbility($request, 'user.invite', 'Only Admins can import users.');

        $request->validate(
            ['file' => ['required', 'file', 'max:' . (self::MAX_BYTES / 1024)]],
            ['file.max' => 'The file must be 2 MB or smaller.', 'file.required' => 'Choose a .xlsx or .csv file to upload.'],
        );
        $file = $request->file('file');

        // Extension AND content must agree — a renamed file or a spoofed
        // Content-Type header is rejected here, not just by the browser.
        $ext = strtolower($file->getClientOriginalExtension());
        abort_unless(in_array($ext, ['xlsx', 'csv'], true), 422, 'Only .xlsx or .csv files can be imported.');
        $mime = (new \finfo(FILEINFO_MIME_TYPE))->file($file->getRealPath());
        $zipMimes = ['application/zip', 'application/x-zip-compressed', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
        $textMimes = ['text/plain', 'text/csv', 'application/csv', 'application/vnd.ms-excel', 'inode/x-empty'];
        abort_unless(in_array($mime, $ext === 'xlsx' ? $zipMimes : $textMimes, true), 422, 'The file contents do not match a valid .' . $ext . ' spreadsheet.');

        try {
            $rows = $this->readRows($file->getRealPath(), $ext);
        } catch (\Throwable $e) {
            abort(422, 'The spreadsheet could not be read. Make sure it is a valid, uncorrupted .xlsx or .csv file.');
        }

        abort_if(count($rows) < 2, 422, 'The spreadsheet has no data rows.');
        abort_if(count($rows) - 1 > self::MAX_ROWS, 422, 'Too many rows — import at most ' . self::MAX_ROWS . ' people at a time.');

        $analysis = $this->analyze($rows);
        if ($analysis['missing_columns']) {
            abort(422, 'Missing required column(s): ' . implode(', ', $analysis['missing_columns']) . '. Download the template for the expected headers.');
        }

        $path = $file->storeAs('user-imports', bin2hex(random_bytes(16)) . '.' . $ext, 'local');

        $import = UserImport::create([
            'user_id' => $request->user()->id,
            'barangay_id' => $request->user()->barangay_id,
            'file_name' => mb_substr($file->getClientOriginalName(), 0, 255),
            'stored_path' => $path,
            'status' => 'previewed',
            'total_rows' => $analysis['total'],
            'valid_rows' => $analysis['valid'],
            'error_rows' => $analysis['errors'],
            'findings' => $analysis['findings'],
        ]);

        return response()->json($this->summary($import) + ['ignored_columns' => $analysis['ignored_columns']], 201);
    }

    public function commit(Request $request, UserImport $import, UserInviter $inviter)
    {
        $this->requireAbility($request, 'user.invite', 'Only Admins can import users.');
        $this->authorizeImport($request, $import);

        // Claim the import first so a double-click can't invite everyone twice;
        // emails go out afterwards, one account per row.
        DB::transaction(function () use ($request, $import) {
            $locked = UserImport::whereKey($import->id)->lockForUpdate()->firstOrFail();
            $this->authorizeImport($request, $locked);
            abort_unless($locked->status === 'previewed', 422, 'This import has already been processed.');
            abort_unless(Storage::disk('local')->exists($locked->stored_path), 410, 'The uploaded file is no longer available. Upload it again.');
            $locked->update(['status' => 'processing']);
        });

        $import->refresh();
        $ext = pathinfo($import->stored_path, PATHINFO_EXTENSION);
        $analysis = $this->analyze($this->readRows(Storage::disk('local')->path($import->stored_path), $ext));
        $findings = $analysis['findings'];
        $imported = 0;
        $failed = $analysis['errors'];

        foreach ($analysis['valid_data'] as $rowNo => $data) {
            try {
                $inviter->invite($data, $request->user());
                $imported++;
            } catch (\RuntimeException) {
                $failed++;
                $findings[] = ['row' => $rowNo, 'field' => 'email', 'level' => 'error', 'message' => 'The invite email could not be sent, so this account was not created.'];
            }
        }

        Storage::disk('local')->delete($import->stored_path);
        $import->update([
            'status' => 'completed',
            'total_rows' => $analysis['total'],
            'valid_rows' => $analysis['valid'],
            'error_rows' => $analysis['errors'],
            'imported_rows' => $imported,
            'failed_rows' => $failed,
            'findings' => $findings,
            'completed_at' => now(),
            'stored_path' => null,
        ]);
        ActivityLog::create([
            'user_id' => $request->user()->id,
            'role' => $request->attributes->get('vms_acted_as_role') ?? $request->user()->role,
            'action' => 'Import',
            'module' => 'Users',
            'affected_record_id' => (string) $import->id,
            'details' => "Imported users from {$import->file_name}: {$imported} invited, {$failed} skipped of {$analysis['total']} rows.",
        ]);

        return response()->json($this->summary($import->fresh()));
    }

    public function errorReport(Request $request, UserImport $import)
    {
        $this->requireAbility($request, 'user.invite', 'Only Admins can import users.');
        $this->authorizeImport($request, $import);

        $findings = $import->findings ?? [];

        return response()->streamDownload(function () use ($findings) {
            $out = fopen('php://output', 'w');
            fputcsv($out, ['Row', 'Field', 'Level', 'Message']);
            foreach ($findings as $f) {
                // Cells beginning with = + - @ are prefixed so the report can't run as a formula.
                $msg = preg_match('/^[=+\-@]/', $f['message']) ? "'" . $f['message'] : $f['message'];
                fputcsv($out, [$f['row'], $f['field'], $f['level'], $msg]);
            }
            fclose($out);
        }, "user-import-{$import->id}-report.csv", ['Content-Type' => 'text/csv']);
    }

    // ------------------------------------------------------------------

    private function authorizeImport(Request $request, UserImport $import): void
    {
        abort_unless(
            $import->user_id === $request->user()->id && $import->barangay_id === $request->user()->barangay_id,
            404
        );
    }

    private function summary(UserImport $import): array
    {
        return [
            'id' => $import->id,
            'file_name' => $import->file_name,
            'status' => $import->status,
            'total_rows' => $import->total_rows,
            'valid_rows' => $import->valid_rows,
            'error_rows' => $import->error_rows,
            'imported_rows' => $import->imported_rows,
            'failed_rows' => $import->failed_rows,
            'findings' => $import->findings ?? [],
        ];
    }

    private function readRows(string $path, string $ext): array
    {
        $reader = IOFactory::createReader($ext === 'csv' ? 'Csv' : 'Xlsx');
        $reader->setReadDataOnly(true);

        // calculateFormulas=false: formulas arrive as "=..." text we reject below.
        return $reader->load($path)->getSheet(0)->toArray(null, false, false, false);
    }

    private function cell(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }
        if (is_float($value) && floor($value) === $value && abs($value) < 1e15) {
            $value = (int) $value;
        }
        $value = trim((string) $value);

        return $value === '' ? null : $value;
    }

    /**
     * Maps headers, validates every row, and returns counts + findings. Used
     * by both preview and commit so the two can never disagree.
     */
    private function analyze(array $rows): array
    {
        $originalHeaders = $rows[0];
        $headers = array_map(fn ($h) => preg_replace('/[^a-z0-9]/', '', strtolower((string) preg_replace('/\*$/', '', trim((string) $h)))), array_shift($rows));

        $map = [];
        $ignored = [];
        foreach ($headers as $i => $h) {
            $key = null;
            foreach (self::COLUMNS as $k => [, $aliases]) {
                if (in_array($h, $aliases, true) && !isset($map[$k])) {
                    $key = $k;
                    break;
                }
            }
            if ($key) {
                $map[$key] = $i;
            } elseif ($h !== '') {
                $ignored[] = trim((string) $originalHeaders[$i]);
            }
        }
        $missing = array_map(fn ($k) => self::COLUMNS[$k][0], array_values(array_diff(self::REQUIRED_COLUMNS, array_keys($map))));
        if ($missing) {
            return ['missing_columns' => $missing];
        }

        $findings = [];
        $validData = [];
        $seenEmails = [];
        $errorRows = 0;
        $total = 0;

        foreach ($rows as $idx => $raw) {
            $rowNo = $idx + 2; // spreadsheet row number (header is row 1)
            $values = [];
            foreach ($map as $key => $col) {
                $values[$key] = $this->cell($raw[$col] ?? null);
            }
            if (!array_filter($values, fn ($v) => $v !== null)) {
                continue; // fully blank row
            }
            $total++;
            $rowErrors = [];

            foreach ($values as $key => $v) {
                if ($v !== null && $v[0] === '=') {
                    $rowErrors[] = [$key, 'Formulas are not allowed — enter the plain value.'];
                    $values[$key] = null;
                }
            }

            if ($values['name'] === null) {
                $rowErrors[] = ['name', 'Full Name is required.'];
            } elseif (mb_strlen($values['name']) > 255) {
                $rowErrors[] = ['name', 'Full Name must be 255 characters or fewer.'];
            }

            $email = $values['email'] === null ? null : mb_strtolower($values['email']);
            if ($email === null) {
                $rowErrors[] = ['email', 'Email is required.'];
            } elseif (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
                $rowErrors[] = ['email', 'Enter a valid email address.'];
            } elseif (isset($seenEmails[$email])) {
                $rowErrors[] = ['email', "Duplicate email — also used on row {$seenEmails[$email]}."];
            } elseif (User::where('email', $email)->exists()) {
                $rowErrors[] = ['email', 'An account with this email address already exists.'];
            }
            if ($email !== null && !isset($seenEmails[$email])) {
                $seenEmails[$email] = $rowNo;
            }

            $phone = $values['phone'] ?? null;
            if ($phone !== null && !preg_match('/^09[0-9]{9}$/', $phone)) {
                $rowErrors[] = ['phone', 'Phone number must be 11 digits starting with 09 (e.g. 09171234567).'];
            }

            $roles = [];
            if ($values['role'] === null) {
                $rowErrors[] = ['role', 'Role is required.'];
            } else {
                foreach (preg_split('/[;,\/]/', $values['role']) as $given) {
                    $given = trim($given);
                    if ($given === '') continue;
                    $match = collect(self::ROLES)->first(fn ($r) => strcasecmp($r, $given) === 0);
                    if ($match === null) {
                        $rowErrors[] = ['role', "Unknown role \"{$given}\". Use Admin, Custodian or Maintenance Personnel."];
                    } elseif (!in_array($match, $roles, true)) {
                        $roles[] = $match;
                    }
                }
            }

            foreach ($rowErrors as [$field, $message]) {
                $findings[] = ['row' => $rowNo, 'field' => $field, 'level' => 'error', 'message' => $message];
            }
            if ($rowErrors) {
                $errorRows++;
            } else {
                $validData[$rowNo] = ['name' => $values['name'], 'email' => $email, 'phone' => $phone, 'role' => $roles[0], 'roles' => $roles];
            }
        }

        abort_if($total === 0, 422, 'The spreadsheet has no data rows.');

        return [
            'total' => $total,
            'valid' => $total - $errorRows,
            'errors' => $errorRows,
            'findings' => $findings,
            'valid_data' => $validData,
            'missing_columns' => [],
            'ignored_columns' => $ignored,
        ];
    }
}
