<?php

namespace App\Http\Controllers;

use App\Http\Controllers\Concerns\AuthorizesAbilities;
use App\Http\Controllers\Concerns\GuardsLastAdmin;
use App\Http\Controllers\Concerns\GuardsOpenWorkOnDeactivation;
use App\Http\Controllers\Concerns\UploadsImages;
use App\Mail\AccountMail;
use App\Models\ActivityLog;
use App\Models\RegistrationSetting;
use App\Models\User;
use App\Services\UserInviter;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\Rule;

class UserController extends Controller
{
    use UploadsImages;
    use GuardsLastAdmin;
    use GuardsOpenWorkOnDeactivation;
    use AuthorizesAbilities;

    private const ROLES = ['Admin', 'Custodian', 'Maintenance Personnel'];

    /**
     * Cross-tenant guard for the User model, which — unlike Vehicle/Hub —
     * deliberately does NOT carry a global scope (see BelongsToBarangay's
     * docblock: scoping User itself recurses into Sanctum's own auth
     * resolution). 404, not 403, so this reads the same as "no such user"
     * rather than confirming a user with that id exists in another barangay.
     */
    private function requireSameBarangay(Request $request, User $target): void
    {
        abort_if($target->barangay_id !== $request->user()->barangay_id, 404);
    }

    // Production-readiness audit finding #4 — account/role management had no
    // audit trail at all. Mirrors FleetController/TicketController's own
    // private log() helper (each controller keeps its own rather than a
    // shared trait, per the existing pattern in this codebase).
    private function log(Request $request, string $action, ?int $affectedUserId, string $details): void
    {
        ActivityLog::create([
            'user_id' => $request->user()?->id,
            'role'    => $request->attributes->get('vms_acted_as_role') ?? $request->user()?->role,
            'action'  => $action,
            'module'  => 'Users',
            'affected_record_id' => $affectedUserId,
            'details' => $details,
        ]);
    }

    /**
     * Normalize role input into a {role: primary, roles: [...]} pair.
     * Prefers the multi-select `roles[]`; falls back to a single `role`.
     * The first role in the list is the primary (drives portal/routing).
     */
    private function normalizeRoles(Request $request, array $data): array
    {
        $roles = $data['roles'] ?? ($request->filled('role') ? [$data['role']] : null);

        if (!empty($roles)) {
            $roles = array_values(array_unique($roles));
            $data['roles'] = $roles;
            $data['role']  = $roles[0];
        }

        return $data;
    }

    public function index(Request $request)
    {
        $this->requireAbility($request, 'user.view', 'Only Admins can manage users.');

        $query = User::where('barangay_id', $request->user()->barangay_id);

        if ($request->filled('q')) {
            $search = $request->string('q');
            $query->where(function ($nested) use ($search) {
                $nested->where('name', 'like', "%{$search}%")
                    ->orWhere('email', 'like', "%{$search}%")
                    ->orWhere('phone', 'like', "%{$search}%");
            });
        }

        $query->when($request->filled('role'), fn ($q) => $q->havingRole($request->role));
        // Pending self-registrations, not "any deactivated account" — those
        // keep their approved_at stamp from the first time they were
        // approved, even if deactivated again later.
        $query->when($request->boolean('pending'), fn ($q) => $q->whereNull('approved_at'));

        return $query->with(['barangay', 'city'])->latest('id')->get();
    }

    public function store(Request $request)
    {
        $this->requireAbility($request, 'user.create', 'Only Admins can manage users.');

        $data = $request->validate([
            'name' => ['required', 'string', 'max:255'],
            'email' => ['required', 'email', 'unique:users,email'],
            'password' => ['required', 'string', 'min:8', 'confirmed'],
            'role' => ['required_without:roles', Rule::in(self::ROLES)],
            'roles' => ['required_without:role', 'array', 'min:1'],
            'roles.*' => [Rule::in(self::ROLES)],
            'phone' => ['nullable', 'string', 'regex:/^09[0-9]{9}$/'],
            'address' => ['nullable', 'string', 'max:255'],
            'photo' => ['nullable', 'image', 'max:4096'],
            'can_register_vehicles' => ['sometimes', 'boolean'],
        ], [
            'phone.regex' => 'Phone number must be 11 digits starting with 09 (e.g. 09171234567).',
        ]);

        $data = $this->normalizeRoles($request, $data);
        $data['password'] = Hash::make($data['password']);
        $data['is_active'] = true;
        // Created by an Admin directly, so already approved — without this
        // stamp the account reads as a pending registration everywhere.
        $data['approved_at'] = now();
        // Always the creating Admin's own barangay — never client-supplied,
        // so an Admin can't plant a user into a barangay they don't manage.
        $data['barangay_id'] = $request->user()->barangay_id;

        if ($request->hasFile('photo')) {
            $data['photo_url'] = $this->storeUploadedImage($request->file('photo'), 'profile-photos');
        }
        unset($data['photo']);

        $user = User::create($data);

        $this->log($request, 'Add', $user->id, "Created user \"{$user->name}\" ({$user->email}), role: " . implode('/', $user->roles ?? [$user->role]));

        return response()->json($user, 201);
    }

    /**
     * Invite a staff member by email. The account is created inactive (but
     * already approved by this Admin) and becomes active when the invitee
     * sets a password from the link. If the email can't be sent the account
     * is rolled back, so no one holds an invite they never received.
     */
    public function invite(Request $request, UserInviter $inviter)
    {
        $this->requireAbility($request, 'user.invite', 'Only Admins can invite users.');

        $data = $request->validate([
            'name' => ['required', 'string', 'max:255'],
            'email' => ['required', 'email', 'unique:users,email'],
            'role' => ['required_without:roles', Rule::in(self::ROLES)],
            'roles' => ['required_without:role', 'array', 'min:1'],
            'roles.*' => [Rule::in(self::ROLES)],
            'phone' => ['nullable', 'string', 'regex:/^09[0-9]{9}$/'],
        ], [
            'email.unique' => 'An account with this email address already exists.',
            'phone.regex' => 'Phone number must be 11 digits starting with 09 (e.g. 09171234567).',
        ]);
        $data = $this->normalizeRoles($request, $data);

        try {
            $user = $inviter->invite($data, $request->user());
        } catch (\RuntimeException) {
            abort(502, 'The invite email could not be sent, so no invite was saved. Check the mail settings and try again.');
        }

        $this->log($request, 'Add', $user->id, "Invited \"{$user->name}\" ({$user->email}), role: " . implode('/', $user->roles ?? [$user->role]));

        return response()->json(['message' => "Invite sent to {$user->email}.", 'user' => $user->fresh()], 201);
    }

    public function resendInvite(Request $request, User $user, UserInviter $inviter)
    {
        $this->requireAbility($request, 'user.invite', 'Only Admins can invite users.');
        $this->requireSameBarangay($request, $user);
        abort_unless($user->invite_pending, 422, 'This account has no pending invite. Deactivate it instead.');

        try {
            DB::transaction(fn () => $inviter->send($user));
        } catch (\RuntimeException) {
            abort(502, 'The invite email could not be sent, so the earlier invite link still works. Check the mail settings and try again.');
        }
        $this->log($request, 'Edit', $user->id, "Resent the invite to \"{$user->name}\" ({$user->email}).");

        return response()->json(['message' => "A new invite was sent to {$user->email}. Earlier invite links no longer work."]);
    }

    public function cancelInvite(Request $request, User $user)
    {
        $this->requireAbility($request, 'user.invite', 'Only Admins can invite users.');
        $this->requireSameBarangay($request, $user);
        abort_unless($user->invite_pending, 422, 'This account has no pending invite. Deactivate it instead.');

        $user->delete();
        $this->log($request, 'Delete', $user->id, "Cancelled the invite for \"{$user->name}\" ({$user->email}).");

        return response()->json(['message' => "The invite for {$user->email} was cancelled."]);
    }

    public function update(Request $request, User $user)
    {
        $this->requireAbility($request, 'user.edit', 'Only Admins can manage users.');
        $this->requireSameBarangay($request, $user);

        $data = $request->validate([
            'name' => ['sometimes', 'required', 'string', 'max:255'],
            'email' => ['sometimes', 'required', 'email', Rule::unique('users', 'email')->ignore($user->id)],
            'password' => ['nullable', 'string', 'min:8', 'confirmed'],
            'role' => ['sometimes', 'required', Rule::in(self::ROLES)],
            'roles' => ['sometimes', 'required', 'array', 'min:1'],
            'roles.*' => [Rule::in(self::ROLES)],
            'phone' => ['nullable', 'string', 'regex:/^09[0-9]{9}$/'],
            'address' => ['nullable', 'string', 'max:255'],
            'photo' => ['nullable', 'image', 'max:4096'],
            'can_register_vehicles' => ['sometimes', 'boolean'],
        ], [
            'phone.regex' => 'Phone number must be 11 digits starting with 09 (e.g. 09171234567).',
        ]);

        $data = $this->normalizeRoles($request, $data);

        // A sole Admin unchecking their own "Admin" role through this same
        // form (see deactivate()'s identical self-lockout guard below) would
        // lock themselves — and, if they're the only Admin, their whole
        // barangay — out of user management with no other way back in.
        if ($user->id === $request->user()->id && $user->hasRole('Admin') && array_key_exists('roles', $data)) {
            abort_if(!in_array('Admin', $data['roles'], true), 422, 'You cannot remove your own Admin role.');
        }

        // Phase A4 — same protection, extended to an Admin editing SOMEONE
        // ELSE'S roles: the self-check above only covers the acting Admin
        // locking out their own account, not them demoting the barangay's
        // only OTHER Admin.
        if (array_key_exists('roles', $data) && !in_array('Admin', $data['roles'], true)) {
            $this->abortIfLastActiveAdmin($user, 'removing their Admin role');
        }

        if (array_key_exists('roles', $data)) {
            $this->abortIfHasOpenWork($user, 'changing their roles', $data['roles']);
        }

        if (!empty($data['password'])) {
            $data['password'] = Hash::make($data['password']);
        } else {
            unset($data['password']);
        }

        if ($request->hasFile('photo')) {
            $data['photo_url'] = $this->storeUploadedImage($request->file('photo'), 'profile-photos');
        }
        unset($data['photo']);

        // Built BEFORE update() so a role change is compared against what
        // the account held a moment ago — and the password's own VALUE is
        // never logged, only the fact that it changed.
        $changeNotes = [];
        if (array_key_exists('roles', $data) && $data['roles'] !== $user->roles) {
            $changeNotes[] = 'roles ' . implode('/', $user->roles ?? [$user->role]) . ' -> ' . implode('/', $data['roles']);
        }
        if (array_key_exists('password', $data)) {
            $changeNotes[] = 'password reset';
        }
        if (array_key_exists('email', $data) && $data['email'] !== $user->email) {
            $changeNotes[] = "email {$user->email} -> {$data['email']}";
        }
        if (array_key_exists('can_register_vehicles', $data) && (bool) $data['can_register_vehicles'] !== (bool) $user->can_register_vehicles) {
            $changeNotes[] = $data['can_register_vehicles'] ? 'granted vehicle registration' : 'revoked vehicle registration';
        }

        $user->update($data);
        if (array_key_exists('password', $data)) $user->tokens()->delete();

        $this->log($request, 'Edit', $user->id, "Updated user \"{$user->name}\"" . ($changeNotes ? ' (' . implode('; ', $changeNotes) . ')' : ''));

        return $user->fresh();
    }

    public function deactivate(Request $request, User $user)
    {
        $this->requireAbility($request, 'user.deactivate', 'Only Admins can manage users.');
        $this->requireSameBarangay($request, $user);
        abort_if($user->id === $request->user()->id, 422, 'You cannot deactivate your own account.');
        $this->abortIfLastActiveAdmin($user, 'deactivating them');
        $this->abortIfHasOpenWork($user, 'deactivating them');

        $user->update(['is_active' => false]);
        // Revoke every existing token immediately — otherwise a session
        // already in progress keeps working until it happens to expire.
        $user->tokens()->delete();

        $this->log($request, 'Deactivate', $user->id, "Deactivated user \"{$user->name}\" ({$user->email}).");

        return response()->json(['message' => 'User deactivated.']);
    }

    public function activate(Request $request, User $user)
    {
        $this->requireAbility($request, 'user.activate', 'Only Admins can manage users.');
        $this->requireSameBarangay($request, $user);

        $data = $request->validate([
            // Only meaningful on a FIRST approval — Admin reviewing a
            // self-registered role request can confirm it or pick a
            // different one before it actually takes effect. Re-activating
            // an already-approved account never needs this; the frontend
            // only sends it the first time around.
            'role' => ['nullable', Rule::in(self::ROLES)],
        ]);

        $update = [
            'is_active' => true,
            // Only stamp on the FIRST approval — re-activating an account
            // that was already approved before shouldn't touch it.
            'approved_at' => $user->approved_at ?? now(),
        ];

        if (!empty($data['role'])) {
            abort_if($user->approved_at !== null || $user->is_active, 422, 'Role confirmation is only available for pending accounts. Use Edit User to change an existing account role.');
            $this->abortIfHasOpenWork($user, 'changing their roles', [$data['role']]);
            $update['role'] = $data['role'];
            $update['roles'] = [$data['role']];
        }

        $firstApproval = $user->approved_at === null;
        $user->update($update);

        $this->log($request, 'Activate', $user->id, "Activated user \"{$user->name}\" ({$user->email})." . (!empty($data['role']) ? " Role confirmed/changed to {$data['role']}." : ''));

        if ($firstApproval) {
            AccountMail::trySend($user, 'Your VMS account is approved', 'approved');
        }

        return response()->json(['message' => 'User activated.']);
    }

    public function registrationSettings(Request $request)
    {
        $this->requireAbility($request, 'registration_code.view', 'Only Admins can manage users.');

        return response()->json(['staff_code' => RegistrationSetting::for($request->user()->barangay_id)->staff_code]);
    }

    public function regenerateRegistrationCode(Request $request)
    {
        $this->requireAbility($request, 'registration_code.regenerate', 'Only Admins can manage users.');

        $setting = RegistrationSetting::regenerateFor($request->user()->barangay_id);
        $this->log($request, 'Edit', null, 'Regenerated the staff registration code for '.($request->user()->barangay?->name ?? 'this barangay').'.');

        return response()->json(['staff_code' => $setting->staff_code]);
    }
}
