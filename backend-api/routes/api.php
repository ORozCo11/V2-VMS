<?php

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\BarangayController;
use App\Http\Controllers\CatalogController;
use App\Http\Controllers\CityController;
use App\Http\Controllers\FleetController;
use App\Http\Controllers\CannibalizationController;
use App\Http\Controllers\HubController;
use App\Http\Controllers\TicketController;
use App\Http\Controllers\NotificationController;
use App\Http\Controllers\ProvinceController;
use App\Http\Controllers\SuperAdminController;
use App\Http\Controllers\ConcernReportController;
use App\Http\Controllers\UserController;
use App\Http\Controllers\VehicleImportController;
use App\Http\Controllers\VehicleTypeFieldController;
use App\Http\Middleware\EnsurePasswordChanged;
use App\Http\Middleware\EnsureUserIsActive;
use App\Http\Middleware\RestrictImpersonatedToReadOnly;
use App\Http\Middleware\RestrictSuperAdminScope;

Route::get('/files/{file}', [\App\Http\Controllers\ManagedFileController::class, 'show'])
    ->where('file', '[A-Za-z0-9-]+\.[a-z0-9]+')->middleware('signed')->name('files.show');

/*
|--------------------------------------------------------------------------
| Public Routes (No Bearer Token Required)
|--------------------------------------------------------------------------
*/
// Rate-limited to blunt credential brute-forcing: 10 attempts/min per IP.
Route::post('/login', [AuthController::class, 'login'])->middleware('throttle:10,1');

// Self-registration — rate-limited to blunt scripted account-creation spam.
Route::post('/register', [AuthController::class, 'register'])->middleware('throttle:5,1');
// A first Administrator's sign-in plus the staff code a Super Admin emailed them.
Route::post('/activate-account', [AuthController::class, 'activateWithStaffCode'])->middleware('throttle:10,1');
// Read-only lookup used interactively while filling the registration form —
// no credentials involved, but still throttled so it can't be used to
// cheaply enumerate which barangays already have an Admin.
Route::get('/address-suggestions', [\App\Http\Controllers\AddressSuggestionController::class, 'index'])->middleware('throttle:20,1');
Route::get('/registration-status', [AuthController::class, 'registrationStatus'])->middleware('throttle:20,1');

// Cascading Province -> City/Municipality -> Barangay lists for the
// registration form's address fields.
Route::get('/provinces', [ProvinceController::class, 'index']);
// Narrower list for the admin Vehicle Location map's boundary selector —
// only provinces that actually have registered barangay/boundary data.
Route::get('/provinces/with-barangays', [ProvinceController::class, 'withBarangays']);
Route::get('/cities', [CityController::class, 'index']);
Route::get('/cities/{city}', [CityController::class, 'show']);
Route::get('/barangays', [BarangayController::class, 'index']);
// Must come before /barangays/{barangay} — otherwise "registered" would be
// matched as a barangay ID by the wildcard route instead.
Route::get('/barangays/registered', [BarangayController::class, 'registered']);
Route::get('/barangays/{barangay}', [BarangayController::class, 'show']);

// Support Center's "Report a Concern" form — no account required. Rate-limited
// like /register to blunt scripted spam.
Route::post('/concern-reports', [ConcernReportController::class, 'store'])->middleware('throttle:5,1');

/*
|--------------------------------------------------------------------------
| Protected Routes (Requires a Valid Sanctum Token in Header)
|--------------------------------------------------------------------------
*/
Route::middleware(['auth:sanctum', EnsureUserIsActive::class, EnsurePasswordChanged::class, \App\Http\Middleware\RestrictImpersonationScope::class, RestrictSuperAdminScope::class, RestrictImpersonatedToReadOnly::class, \App\Http\Middleware\SignManagedFiles::class])->group(function () {
    Route::get('/files/refresh', [\App\Http\Controllers\ManagedFileController::class, 'refresh']);

    // Session termination route
    Route::post('/logout', [AuthController::class, 'logout']);

    // Secure user identification endpoint (useful for checking active status on refresh)
    Route::get('/user', function (Request $request) {
        $user = $request->user();

        // 'abilities' is added here rather than via a global User $appends —
        // this route is "who am I", the one place the frontend actually
        // needs the list (VMS-IMPROVEMENT-PLAN.md Phase B2).
        return array_merge($user->toArray(), [
            'abilities' => $user->getAbilities(),
            'is_impersonating' => $user->currentAccessToken()?->name === 'impersonation_token',
        ]);
    });


    Route::get('/greeting', [AuthController::class, 'greeting']);
    Route::get('/impersonate/candidates', [AuthController::class, 'impersonationCandidates']);
    Route::post('/impersonate/default', [AuthController::class, 'impersonateDefault'])->middleware('throttle:10,1');
    Route::post('/impersonate/{user}', [AuthController::class, 'impersonate'])->middleware('throttle:10,1');
    // Verifies the current password, so rate-limit it against guessing too.
    Route::put('/profile/password', [AuthController::class, 'updatePassword'])->middleware('throttle:10,1');
    Route::put('/profile', [AuthController::class, 'updateProfile']);

    Route::get('/lookups', [FleetController::class, 'lookups']);
    Route::get('/dashboard', [FleetController::class, 'dashboard']);

    // The two small, user-growable catalogs behind every CreatableSelect
    // dropdown (fault categories / maintenance types) — their own CRUD so
    // adding or removing one doesn't depend on submitting an unrelated form.
    Route::get('/fault-categories', [CatalogController::class, 'faultCategories']);
    Route::post('/fault-categories', [CatalogController::class, 'storeFaultCategory']);
    Route::put('/fault-categories/{faultCategory}', [CatalogController::class, 'updateFaultCategory']);
    Route::delete('/fault-categories/{faultCategory}', [CatalogController::class, 'destroyFaultCategory']);
    Route::get('/maintenance-types', [CatalogController::class, 'maintenanceTypes']);
    Route::post('/maintenance-types', [CatalogController::class, 'storeMaintenanceType']);
    Route::put('/maintenance-types/{maintenanceType}', [CatalogController::class, 'updateMaintenanceType']);
    Route::delete('/maintenance-types/{maintenanceType}', [CatalogController::class, 'destroyMaintenanceType']);
    Route::get('/reported-persons', [CatalogController::class, 'reportedPersons']);
    Route::post('/reported-persons', [CatalogController::class, 'storeReportedPerson']);
    Route::put('/reported-persons/{reportedPerson}', [CatalogController::class, 'updateReportedPerson']);
    Route::delete('/reported-persons/{reportedPerson}', [CatalogController::class, 'destroyReportedPerson']);

    Route::get('/categories', [FleetController::class, 'categories']);
    Route::post('/categories', [FleetController::class, 'storeCategory']);
    Route::put('/categories/{category}', [FleetController::class, 'updateCategory']);
    Route::delete('/categories/{category}', [FleetController::class, 'deleteCategory']);
    Route::get('/categories/{category}/fields', [VehicleTypeFieldController::class, 'index']);
    Route::post('/categories/{category}/fields', [VehicleTypeFieldController::class, 'store']);
    Route::put('/category-fields/{field}', [VehicleTypeFieldController::class, 'update']);

    Route::get('/vehicles', [FleetController::class, 'vehicles']);
    Route::post('/vehicles', [FleetController::class, 'storeVehicle']);
    Route::get('/vehicle-imports/template', [VehicleImportController::class, 'template']);
    Route::post('/vehicle-imports', [VehicleImportController::class, 'preview']);
    Route::post('/vehicle-imports/{import}/commit', [VehicleImportController::class, 'commit']);
    Route::get('/vehicle-imports/{import}/errors', [VehicleImportController::class, 'errorReport']);
    Route::put('/vehicles/{vehicle}', [FleetController::class, 'updateVehicle']);
    Route::delete('/vehicles/{vehicle}', [FleetController::class, 'archiveVehicle']);
    Route::post('/vehicles/{vehicle}/restore', [FleetController::class, 'restoreVehicle']);
    Route::put('/vehicles/{vehicle}/decommission', [FleetController::class, 'decommissionVehicle']);
    Route::get('/vehicles/{vehicle}/reliability', [FleetController::class, 'vehicleReliability']);
    Route::get('/vehicles/{vehicle}/readiness', [FleetController::class, 'vehicleReadiness']);
    Route::post('/vehicles/{vehicle}/request-inspection', [FleetController::class, 'requestInspection']);
    Route::post('/vehicles/{vehicle}/readiness-check', [FleetController::class, 'storeReadinessCheck']);
    Route::put('/vehicles/{vehicle}/mark-available', [FleetController::class, 'markVehicleAvailable']);
    Route::get('/vehicles/{vehicle}/open-tickets', [TicketController::class, 'openTicketsForVehicle']);
    Route::get('/vehicles/{vehicle}/recurrence', [FleetController::class, 'checkVehicleRecurrence']);
    Route::get('/vehicles/{vehicle}/documents', [FleetController::class, 'vehicleDocuments']);
    Route::post('/vehicles/{vehicle}/documents', [FleetController::class, 'storeVehicleDocument']);
    Route::put('/documents/{document}', [FleetController::class, 'updateVehicleDocument']);
    Route::delete('/documents/{document}', [FleetController::class, 'destroyVehicleDocument']);

    Route::get('/locations', [FleetController::class, 'locations']);
    Route::post('/locations', [FleetController::class, 'storeLocation']);

    Route::get('/users', [UserController::class, 'index']);
    Route::post('/users', [UserController::class, 'store']);
    Route::put('/users/{user}', [UserController::class, 'update']);
    Route::put('/users/{user}/deactivate', [UserController::class, 'deactivate']);
    Route::put('/users/{user}/activate', [UserController::class, 'activate']);

    Route::get('/registration-settings', [UserController::class, 'registrationSettings']);
    Route::post('/registration-settings/regenerate', [UserController::class, 'regenerateRegistrationCode'])->middleware('throttle:10,1');

    /*
    |--------------------------------------------------------------------------
    | Super Admin — account administration only, across every barangay.
    | Each method also self-guards via requireSuperAdmin, same pattern as
    | UserController's requireAdmin.
    |--------------------------------------------------------------------------
    */
    Route::get('/superadmin/barangays', [SuperAdminController::class, 'barangays']);
    Route::get('/superadmin/barangays/search', [SuperAdminController::class, 'searchBarangays']);
    Route::get('/superadmin/barangays/locations', [SuperAdminController::class, 'barangayLocations']);
    Route::post('/superadmin/barangays', [SuperAdminController::class, 'storeBarangay']);
    Route::post('/superadmin/barangays/{barangay}/admins', [SuperAdminController::class, 'storeBarangayAdmin'])->middleware('throttle:10,1');
    Route::get('/superadmin/users', [SuperAdminController::class, 'users']);
    Route::get('/superadmin/pending-approvals', [SuperAdminController::class, 'pendingApprovals']);
    Route::put('/superadmin/users/{user}/activate', [SuperAdminController::class, 'activateUser']);
    Route::put('/superadmin/users/{user}/deactivate', [SuperAdminController::class, 'deactivateUser']);
    Route::delete('/superadmin/users/{user}/reject', [SuperAdminController::class, 'rejectUser']);
    Route::put('/superadmin/users/{user}/role', [SuperAdminController::class, 'updateUserRole']);
    Route::post('/superadmin/users/{user}/send-staff-code', [SuperAdminController::class, 'sendStaffCode'])->middleware('throttle:10,1');
    Route::post('/superadmin/users/{user}/email', [SuperAdminController::class, 'emailUser'])->middleware('throttle:10,1');
    Route::get('/superadmin/barangays/{barangay}/registration-code', [SuperAdminController::class, 'registrationCode']);
    Route::post('/superadmin/barangays/{barangay}/registration-code/regenerate', [SuperAdminController::class, 'regenerateRegistrationCode'])->middleware('throttle:10,1');
    Route::post('/superadmin/barangays/{barangay}/boundary/refresh', [SuperAdminController::class, 'refreshBarangayBoundary']);
    Route::post('/superadmin/barangays/{barangay}/boundary/confirm', [SuperAdminController::class, 'confirmBarangayBoundary']);
    Route::post('/superadmin/barangays/{barangay}/boundary/candidate', [SuperAdminController::class, 'uploadBoundaryCandidate']);
    Route::delete('/superadmin/barangays/{barangay}/boundary/pending', [SuperAdminController::class, 'discardPendingBoundary']);
    Route::get('/superadmin/activity-log', [SuperAdminController::class, 'activityLog']);
    Route::get('/superadmin/concern-reports', [SuperAdminController::class, 'concernReports']);
    Route::put('/superadmin/concern-reports/{concernReport}/resolve', [SuperAdminController::class, 'resolveConcernReport']);
    Route::put('/superadmin/concern-reports/{concernReport}/reopen', [SuperAdminController::class, 'reopenConcernReport']);
    Route::delete('/superadmin/concern-reports/{concernReport}', [SuperAdminController::class, 'destroyConcernReport']);
    Route::put('/superadmin/concern-reports/{concernReport}/restore', [SuperAdminController::class, 'restoreConcernReport']);

    Route::get('/hubs', [HubController::class, 'index']);
    Route::post('/hubs', [HubController::class, 'store']);
    Route::put('/hubs/{hub}', [HubController::class, 'update']);
    Route::delete('/hubs/{hub}', [HubController::class, 'destroy']);

    Route::get('/conditions', [FleetController::class, 'conditions']);
    Route::post('/conditions', [FleetController::class, 'storeCondition']);
    Route::put('/conditions/{condition}', [FleetController::class, 'updateCondition']);
    Route::delete('/conditions/{condition}', [FleetController::class, 'deleteCondition']);

    Route::get('/issues', [FleetController::class, 'issues']);
    Route::get('/vehicles/{vehicle}/open-issues', [FleetController::class, 'openIssuesForVehicle']);
    Route::get('/issues/{issue}', [FleetController::class, 'showIssue']);
    Route::post('/issues/{issue}/recommend-ticket', [FleetController::class, 'recommendTicket']);
    Route::post('/issues', [FleetController::class, 'storeIssue']);
    Route::put('/issues/{issue}', [FleetController::class, 'updateIssue']);
    Route::delete('/issues/{issue}', [FleetController::class, 'destroyIssue']);
    Route::put('/issues/{issue}/dismiss', [FleetController::class, 'dismissIssue']);
    Route::delete('/issue-attachments/{attachment}', [FleetController::class, 'destroyIssueAttachment']);

    Route::get('/maintenance-records', [FleetController::class, 'maintenanceRecords']);
    Route::get('/maintenance-records/{record}', [FleetController::class, 'showMaintenanceRecord']);
    Route::post('/maintenance-records', [FleetController::class, 'storeMaintenanceRecord']);
    Route::put('/maintenance-records/{record}', [FleetController::class, 'updateMaintenanceRecord']);
    Route::put('/maintenance-records/{record}/verify', [FleetController::class, 'verifyMaintenance']);
    Route::put('/maintenance-records/{record}/confirm', [FleetController::class, 'confirmMaintenance']);
    Route::put('/maintenance-records/{record}/decision-close', [FleetController::class, 'decisionCloseMaintenance']);

    Route::get('/maintenance-schedules', [FleetController::class, 'schedules']);
    Route::post('/maintenance-schedules', [FleetController::class, 'storeSchedule']);
    Route::post('/maintenance-schedules/suggest', [FleetController::class, 'suggestSchedule']);
    Route::put('/maintenance-schedules/{schedule}', [FleetController::class, 'updateSchedule']);
    Route::put('/maintenance-schedules/{schedule}/approve', [FleetController::class, 'approveSchedule']);
    Route::put('/maintenance-schedules/{schedule}/decline', [FleetController::class, 'declineSchedule']);
    Route::put('/maintenance-schedules/{schedule}/undecline', [FleetController::class, 'undeclineSchedule']);
    Route::put('/maintenance-schedules/{schedule}/reassign', [FleetController::class, 'reassignSchedule']);
    Route::put('/maintenance-schedules/{schedule}/complete', [FleetController::class, 'completeSchedule']);
    Route::post('/maintenance-schedules/{schedule}/restore', [FleetController::class, 'restoreSchedule']);
    Route::delete('/maintenance-schedules/{schedule}', [FleetController::class, 'deleteSchedule']);

    Route::get('/histories', [FleetController::class, 'histories']);
    Route::get('/reports', [FleetController::class, 'reports']);
    Route::get('/logs', [FleetController::class, 'logs']);

    /*
    |--------------------------------------------------------------------------
    | Maintenance Ticket Workflow Routes (Main Issue / Sub-Issue model)
    |--------------------------------------------------------------------------
    */

    // Lookups & listing
    Route::get('/tickets/lookups', [TicketController::class, 'lookups']);
    Route::put('/tickets/{ticket}/list-visibility', [TicketController::class, 'listVisibility']);
    Route::get('/tickets', [TicketController::class, 'index']);
    Route::get('/tickets/{ticket}', [TicketController::class, 'show']);

    // Phase 1 — Admin: Create ticket (Main Issue) & assign to Custodian
    Route::post('/tickets', [TicketController::class, 'createTicket']);
    Route::post('/tickets/propose', [TicketController::class, 'proposeTicket']);
    Route::put('/tickets/{ticket}/approve', [TicketController::class, 'approveTicket']);
    Route::put('/tickets/{ticket}/decline', [TicketController::class, 'declineTicket']);
    Route::put('/tickets/{ticket}/undecline', [TicketController::class, 'undeclineTicket']);
    Route::put('/tickets/{ticket}/request-corrections', [TicketController::class, 'requestCorrections']);
    Route::put('/tickets/{ticket}/resubmit', [TicketController::class, 'resubmitProposal']);

    // Ticket-level workflow. Sub-issues remain work-line details and audit
    // evidence, never separate user-facing work orders.
    Route::put('/tickets/{ticket}/assign-mechanic', [TicketController::class, 'assignTicketMechanic']);
    Route::put('/tickets/{ticket}/submit-for-verification', [TicketController::class, 'submitForVerification']);
    Route::put('/tickets/{ticket}/verify', [TicketController::class, 'verifyTicket']);

    // Phase 2 — Custodian: Submit inspection, populate the sub-issue list
    Route::put('/tickets/{ticket}/inspect', [TicketController::class, 'submitInspection']);

    // Phase 3 — Admin: Dispatch work order to a mechanic, per sub-issue
    Route::put('/tickets/{ticket}/sub-issues/{subIssue}/assign-mechanic', [TicketController::class, 'assignMechanic']);

    // Admin: Reassign an in-progress work order to a different mechanic
    Route::put('/tickets/{ticket}/sub-issues/{subIssue}/reassign-mechanic', [TicketController::class, 'reassignMechanic']);

    // Unsticks a ticket whose assigned Custodian became unavailable — they are
    // hard-locked as both inspector and verifier, so without this the ticket
    // is unworkable and (if still Open) not even closable.
    Route::put('/tickets/{ticket}/reassign-custodian', [TicketController::class, 'reassignCustodian']);

    // Phase 3 — Mechanic: Log physical repairs on a sub-issue
    Route::put('/tickets/{ticket}/sub-issues/{subIssue}/log-repairs', [TicketController::class, 'logRepairs']);
    // Cannibalized repair: pick the donor vehicle, then manage its parts (CRUD).
    Route::put('/tickets/{ticket}/sub-issues/{subIssue}/donor', [TicketController::class, 'setDonorVehicle']);
    Route::post('/tickets/{ticket}/sub-issues/{subIssue}/donor-parts', [TicketController::class, 'storeDonorPart']);
    Route::put('/tickets/{ticket}/sub-issues/{subIssue}/donor-parts/{part}', [TicketController::class, 'updateDonorPart']);
    Route::delete('/tickets/{ticket}/sub-issues/{subIssue}/donor-parts/{part}', [TicketController::class, 'deleteDonorPart']);
    Route::put('/tickets/{ticket}/sub-issues/{subIssue}/external-sent', [TicketController::class, 'markExternalSent']);
    Route::put('/tickets/{ticket}/sub-issues/{subIssue}/external-returned', [TicketController::class, 'markExternalReturned']);
    Route::post('/tickets/{ticket}/sub-issues', [TicketController::class, 'addSubIssue']);
    Route::put('/tickets/{ticket}/sub-issues/{subIssue}', [TicketController::class, 'updateSubIssue']);
    Route::delete('/tickets/{ticket}/sub-issues/{subIssue}', [TicketController::class, 'deleteSubIssue']);

    // Phase 3.5 — Admin: Approve or reject a cannibalized repair
    Route::put('/tickets/{ticket}/sub-issues/{subIssue}/approve-cannibalization', [TicketController::class, 'approveCannibalization']);
    Route::put('/tickets/{ticket}/sub-issues/{subIssue}/reject-cannibalization', [TicketController::class, 'rejectCannibalization']);

    // Phase 4 Tier 1 — Custodian: Verify a sub-issue's repair
    Route::put('/tickets/{ticket}/sub-issues/{subIssue}/verify', [TicketController::class, 'verifyRepair']);

    // Phase 4 Tier 2 — Admin: Confirm or rework a sub-issue
    Route::put('/tickets/{ticket}/sub-issues/{subIssue}/confirm', [TicketController::class, 'confirmSubIssue']);

    // Admin: Reopen a confirmed sub-issue (send back for re-verification)
    Route::put('/tickets/{ticket}/sub-issues/{subIssue}/reopen-confirmed', [TicketController::class, 'reopenConfirmedSubIssue']);

    // Admin: Defer a sub-issue that can't be finished now (records the
    // decision + opens a breadcrumb Issue Report so it isn't forgotten)
    Route::put('/tickets/{ticket}/sub-issues/{subIssue}/defer', [TicketController::class, 'deferSubIssue']);

    // Phase 5 — Admin: Explicit ticket closure (only once every sub-issue is Done)
    Route::put('/tickets/{ticket}/close', [TicketController::class, 'closeTicket']);

    // Admin: Cancel ticket at any stage before Closed
    Route::put('/tickets/{ticket}/cancel', [TicketController::class, 'cancelTicket']);
    Route::put('/tickets/{ticket}/uncancel', [TicketController::class, 'uncancelTicket']);

    // Admin: Delete ticket completely (in case of mistakes)
    Route::delete('/tickets/{ticket}', [TicketController::class, 'deleteTicket']);

    // Archived ticket audit log — a "Closed" entry is permanently locked, but
    // a "Deleted" entry (an accidental delete that had real progress on it)
    // can be reopened. Archive deletion retains the snapshot for recovery.
    Route::get('/ticket-archives', [TicketController::class, 'archives']);
    Route::delete('/ticket-archives/{archive}', [TicketController::class, 'deleteArchive']);
    Route::put('/ticket-archives/{archive}/restore', [TicketController::class, 'restoreArchive'])->withTrashed();
    // Cannibalization: direct, final records of parts moved between vehicles
    // (no approval step, and deliberately no update/delete routes).
    Route::get('/cannibalizations', [CannibalizationController::class, 'index']);
    Route::get('/cannibalizations/{id}', [CannibalizationController::class, 'show']);
    Route::post('/cannibalizations', [CannibalizationController::class, 'store']);
    Route::put('/ticket-archives/{archive}/reopen', [TicketController::class, 'reopenArchive']);

    // Notifications API
    Route::get('/notifications', [NotificationController::class, 'index']);
    Route::put('/notifications/read-all', [NotificationController::class, 'markAllAsRead']);
    Route::put('/notifications/{notification}/read', [NotificationController::class, 'markAsRead']);
    Route::delete('/notifications/{notification}', [NotificationController::class, 'destroy']);
});
