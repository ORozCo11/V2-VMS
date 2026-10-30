<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use App\Http\Controllers\Concerns\UploadsImages;
use App\Mail\AccountMail;
use App\Models\ActivityLog;
use App\Models\Barangay;
use App\Models\RegistrationSetting;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\Rule;

class AuthController extends Controller
{
    use UploadsImages;

    /**
     * Register against a preloaded PSGC barangay ID. The barangay must belong
     * to the selected city; free-text barangay creation is not a public flow.
     * Staff need the barangay's staff code and await Admin approval; a first
     * Administrator registers without one and activates with the code a
     * Super Admin emails them (activateWithStaffCode).
     */
    public function register(Request $request)
    {
        $data = $request->validate([
            // Letters, spaces, and the punctuation that legitimately shows up
            // in PH names (hyphenated surnames, "Ñ", apostrophes, "Jr.").
            'name' => ['required', 'string', 'max:255', 'regex:/^[A-Za-zÀ-ÖØ-öø-ÿ.\'\- ]+$/u'],
            'email' => ['required', 'email', 'unique:users,email'],
            'password' => ['required', 'string', 'min:8', 'confirmed'],
            // PH mobile format: 09 + 9 digits = 11 digits total.
            'phone' => ['required', 'regex:/^09[0-9]{9}$/'],
            'address' => ['required', 'string', 'max:255'],
            'city_id' => ['required', 'exists:cities,id', function ($attribute, $value, $fail) use ($request) {
                if ($request->filled('province_id') && (int) \App\Models\City::find($value)?->province_id !== (int) $request->input('province_id')) {
                    $fail('Selected city does not belong to the selected province.');
                }
            }],
            'province_id' => ['nullable', 'exists:provinces,id'],
            'barangay_id' => [
                'required',
                Rule::exists('barangays', 'id')->whereNotNull('psgc_code'),
                function ($attribute, $value, $fail) use ($request) {
                    if ($value && (int) Barangay::find($value)?->city_id !== (int) $request->input('city_id')) {
                        $fail('Selected barangay does not belong to the selected city.');
                    }
                },
            ],
            'barangay_name' => ['prohibited'],
        ], [
            'name.regex' => 'Name may only contain letters.',
            'phone.regex' => 'Phone number must be 11 digits starting with 09 (e.g. 09171234567).',
        ]);

        $barangayId = $data['barangay_id'] ?? null;

        // Everything from here on runs inside a transaction that locks the
        // Barangay row: without it, two people registering for the same
        // brand-new barangay within the same instant could both read "no
        // admin yet" (a plain SELECT, not itself a lock) and both get
        // created as that barangay's Admin. lockForUpdate() serializes any
        // concurrent registration for the SAME barangay behind this one —
        // registrations for a DIFFERENT barangay lock a different row and
        // proceed independently.
        [$user, $isFirstForBarangay] = DB::transaction(function () use ($data, $barangayId, $request) {
            $barangay = Barangay::where('id', $barangayId)->lockForUpdate()->firstOrFail();
            app(\App\Services\BarangayGeography::class)->attachBoundary($barangay);

            // Deliberately unscoped (User carries no global scope) and looks
            // across every barangay — this is the one place that's supposed to.
            $isFirstForBarangay = !User::where('barangay_id', $barangayId)->exists();

            // The first-for-this-barangay account has no role choice (it's
            // always Admin) and no staff code yet: a Super Admin emails it
            // the code after confirming the appointment, and the account
            // stays locked until that code is entered (activateWithStaffCode).
            $roleData = $request->validate([
                'requested_role' => [$isFirstForBarangay ? 'nullable' : 'required', Rule::in(['Custodian', 'Maintenance Personnel'])],
                'staff_code' => [$isFirstForBarangay ? 'nullable' : 'required', 'string'],
            ], [
                'requested_role.required' => 'Please select whether you are a Custodian or Maintenance Personnel.',
                'staff_code.required' => 'Please enter the staff registration code given to you by your barangay office.',
            ]);

            abort_unless(
                $isFirstForBarangay || hash_equals(RegistrationSetting::for($barangayId)->staff_code, strtoupper(trim($roleData['staff_code']))),
                422,
                'That staff registration code is not correct. Ask your barangay office for the current code.'
            );

            $role = $isFirstForBarangay ? 'Admin' : $roleData['requested_role'];

            // Was: `is_active: $isFirstForBarangay` — the first person to
            // register for a barangay went live instantly, with nobody ever
            // reviewing them. The shared staff code only proves "someone
            // handed me a code for this barangay," not "I'm the legitimate
            // first Admin" — anyone holding that code could win the race.
            // Every registrant, first-for-barangay or not, now starts
            // inactive and waits for a human: Super Admin approves the
            // first Admin per barangay (see SuperAdminController::
            // pendingAdmins()); an existing Admin approves everyone after.
            $user = User::create([
                'name' => $data['name'],
                'email' => $data['email'],
                'password' => Hash::make($data['password']),
                'phone' => $data['phone'],
                'address' => $data['address'],
                'city_id' => $data['city_id'],
                'barangay_id' => $barangayId,
                'barangay_name' => $barangay->name,
                'role' => $role,
                'roles' => [$role],
                'is_active' => false,
                'approved_at' => null,
                'awaiting_staff_code' => $isFirstForBarangay,
            ]);

            return [$user, $isFirstForBarangay];
        });

        if ($isFirstForBarangay) {
            $barangayLabel = $user->barangay_name ?? $user->barangay?->name ?? 'their barangay';
            $this->notifySuperAdmins(
                'New barangay Admin awaiting approval',
                "{$user->name} registered as the first Admin for {$barangayLabel}. Confirm the appointment, then approve the account from Pending Approvals.",
                'pending_admin_approval'
            );
            AccountMail::trySend($user, 'Welcome to VMS. Your account is waiting for approval', 'welcome');
        } else {
            // Every other registration is approved by the barangay's own
            // Admin(s), who otherwise had no way to learn a pending account
            // existed short of happening to open the Users module
            // (VMS-IMPROVEMENT-PLAN.md Phase B6).
            $this->notifyAdmins(
                'New staff registration awaiting approval',
                "{$user->name} registered as {$user->role} and is awaiting your approval before they can sign in.",
                'pending_staff_approval',
                $user->barangay_id
            );
        }

        return response()->json([
            'message' => $isFirstForBarangay
                ? 'Registration submitted. Check your email: a Super Admin will send your staff registration code, which you enter after signing in to activate your account.'
                : 'Registration submitted. An administrator must approve your account before you can sign in.',
            'user' => [
                'id' => $user->id,
                'name' => $user->name,
                'email' => $user->email,
            ],
        ], 201);
    }

    // Mirrors FleetController::notifyAdmins() — Super Admin is unscoped by
    // barangay, so this reaches every Super Admin account platform-wide,
    // not just one barangay's.
    private function notifySuperAdmins(string $title, string $message, string $type): void
    {
        $superAdmins = User::havingRole('Super Admin')->get();
        foreach ($superAdmins as $superAdmin) {
            \App\Models\Notification::create([
                'user_id' => $superAdmin->id,
                'title' => $title,
                'message' => $message,
                'type' => $type,
                'ticket_id' => null,
            ]);
        }
    }

    // Same shape as FleetController::notifyAdmins() / TicketController's own
    // copy — a fourth near-identical instance rather than a new shared
    // service, matching how the other two already coexist.
    private function notifyAdmins(string $title, string $message, string $type, ?int $barangayId): void
    {
        $admins = User::where('barangay_id', $barangayId)->havingRole('Admin')->get();
        foreach ($admins as $admin) {
            \App\Models\Notification::create([
                'user_id' => $admin->id,
                'title' => $title,
                'message' => $message,
                'type' => $type,
                'ticket_id' => null,
            ]);
        }
    }

    /** Side-effect-free first-Administrator preview for a selected reference ID. */
    public function registrationStatus(Request $request)
    {
        $data = $request->validate([
            'city_id' => ['required', 'exists:cities,id'],
            'barangay_id' => ['required', Rule::exists('barangays', 'id')->where('city_id', $request->input('city_id'))->whereNotNull('psgc_code')],
            'barangay_name' => ['prohibited'],
        ]);
        $isFirst = !User::where('barangay_id', $data['barangay_id'])->exists();
        return response()->json(['is_first' => $isFirst]);
    }

    /**
     * Handle stateless frontend login requests.
     */
    public function login(Request $request)
    {
        // 1. Validate incoming user inputs from React
        $request->validate([
            'email' => 'required|email',
            'password' => 'required|string',
        ]);

        // 2. Locate the user profile row in the database
        $user = User::where('email', $request->email)->first();

        // 3. Verify the record exists and evaluate the encrypted password match
        if (!$user || !Hash::check($request->password, $user->password)) {
            return response()->json([
                'message' => 'Invalid credentials provided. Please check your email or password.'
            ], 401); // Returns 401 Unauthorized status code
        }

        if (!$user->is_active) {
            // approved_at is only ever set the moment an Admin (or, for a
            // barangay's first-ever Admin, a Super Admin) first approves an
            // account (UserController::activate / SuperAdminController::
            // activateUser) — a still-NULL value means this account has
            // never been approved yet at all (a brand-new registrant waiting
            // in the queue), which reads very differently from an account an
            // Admin actively deactivated after it was already in use. A
            // pending Admin with no other active Admin in their barangay is
            // specifically the case a Super Admin approves, not their own
            // (nonexistent) barangay Admin — the message reflects who they're
            // actually waiting on.
            $awaitsSuperAdmin = ($user->approved_at === null || $user->awaiting_staff_code)
                && $user->role === 'Admin'
                && !User::where('barangay_id', $user->barangay_id)->where('id', '!=', $user->id)
                    ->havingRole('Admin')->where('is_active', true)->exists();

            // A first Admin approved under the retired staff-code flow is
            // still waiting on the Super Admin, not deactivated.
            $message = $user->approved_at !== null && !$user->awaiting_staff_code
                ? 'This account has been deactivated. Contact an administrator.'
                : ($awaitsSuperAdmin
                    ? 'Your account is still awaiting approval from a Super Admin, as the first Admin for your barangay.'
                    : 'Your account is still awaiting approval from your barangay\'s Admin.');

            return response()->json(['message' => $message], 403);
        }

        return $this->signedIn($user);
    }

    /**
     * A first Administrator's activation: the same email and password as
     * sign-in, plus the staff code a Super Admin emailed them. The code
     * must be this barangay's current one and used within
     * User::STAFF_CODE_VALID_DAYS of being sent; an expired registration
     * is cancelled so the person can register again.
     */
    public function activateWithStaffCode(Request $request)
    {
        $data = $request->validate([
            'email' => 'required|email',
            'password' => 'required|string',
            'staff_code' => 'required|string',
        ]);

        $user = User::where('email', $data['email'])->first();
        if (!$user || !Hash::check($data['password'], $user->password)) {
            return response()->json(['message' => 'Invalid credentials provided. Please check your email or password.'], 401);
        }
        abort_unless($user->awaiting_staff_code && !$user->is_active, 422, 'This account is not waiting for a staff registration code.');
        abort_unless($user->staff_code_sent_at, 422, 'Your staff registration code has not been sent yet. Please wait for the email from the Super Admin.');

        if ($user->staffCodeExpired()) {
            $user->expireRegistration();
            return response()->json(['message' => 'Your staff registration code has expired and your registration was cancelled. Please register again.'], 410);
        }

        abort_unless(
            hash_equals(RegistrationSetting::for($user->barangay_id)->staff_code, strtoupper(trim($data['staff_code']))),
            422,
            'That staff registration code is not correct. Check the code in your email and try again.'
        );

        $user->update(['is_active' => true, 'approved_at' => $user->approved_at ?? now(), 'awaiting_staff_code' => false]);
        ActivityLog::create([
            'user_id' => $user->id,
            'role' => $user->role,
            'action' => 'Activate',
            'module' => 'Authentication',
            'details' => "{$user->name} activated their account with the emailed staff registration code.",
        ]);
        AccountMail::trySend($user, 'Your VMS account is now active', 'activated');

        return $this->signedIn($user);
    }

    private function signedIn(User $user)
    {
        // 4. Issue a secure, unique Sanctum token, tagged with every role
        //    (hat) the account may wear so token abilities match its access.
        $token = $user->createToken('auth_token', $user->allRoles())->plainTextToken;

        // 5. Send data bundle back to the React client application
        return response()->json([
            'message' => 'Login authenticated successfully!',
            'access_token' => $token,
            'token_type' => 'Bearer',
            'user' => [
                'id' => $user->id,
                'name' => $user->name,
                'email' => $user->email,
                'role' => $user->role, // Primary role — drives the portal layout
                'roles' => $user->allRoles(), // Every hat this account may wear
                'abilities' => $user->getAbilities(), // Phase B2 — what the frontend gates on
                'must_change_password' => (bool) $user->must_change_password,
            ]
        ], 200);
    }

    /** Only the dedicated account-switcher login can start a session. */
    private function canImpersonate(Request $request): bool
    {
        return (bool) $request->user()?->canDo('impersonation.start')
            && $request->user()?->currentAccessToken()?->name !== 'impersonation_token';
    }

    /** All accounts across barangays, including platform accounts without a barangay. */
    public function impersonationCandidates(Request $request)
    {
        abort_unless($this->canImpersonate($request), 403, 'Sign in to the dedicated account switcher to impersonate an account.');

        return User::with('barangay.city.province')
            ->where('id', '!=', $request->user()->id)
            ->where('role', '!=', 'Impersonator')
            ->when($request->user()->hasRole('Super Admin'), fn ($q) => $q->where('role', '!=', 'Super Admin'))
            ->orderBy('name')
            ->get(['id', 'name', 'email', 'role', 'roles', 'is_active', 'barangay_id'])
            ->map(fn ($u) => [
                'id' => $u->id,
                'name' => $u->name,
                'email' => $u->email,
                'role' => $u->role,
                'roles' => $u->roles,
                'is_active' => $u->is_active,
                'barangay_id' => $u->barangay_id,
                'province_id' => $u->barangay?->city?->province?->id,
                'province_name' => $u->barangay?->city?->province?->name,
                'city_name' => $u->barangay?->city?->name,
                'city_id' => $u->barangay?->city?->id,
                'barangay_name' => $u->barangay?->name,
            ]);
    }

    /** Open a stable default barangay Admin without requiring an account picker. */
    public function impersonateDefault(Request $request)
    {
        abort_unless($this->canImpersonate($request), 403, 'Sign in to the dedicated account switcher to impersonate an account.');
        $target = User::where('role', 'Admin')->where('is_active', true)
            ->whereNotNull('barangay_id')->whereHas('barangay')
            ->orderByRaw('CASE WHEN email = ? THEN 0 ELSE 1 END', ['admin@barangay.gov'])
            ->orderBy('barangay_id')->orderBy('id')->first();
        abort_unless($target, 422, 'No active barangay Admin is available. Choose another account.');
        $request->merge(['reason' => 'Automatic login to the default barangay Admin workspace']);

        return $this->impersonate($request, $target);
    }

    /** Enter a selected account's workspace and keep an audit trail. */
    public function impersonate(Request $request, User $user)
    {
        abort_unless($this->canImpersonate($request), 403, 'Sign in to the dedicated account switcher to impersonate an account.');
        abort_if($user->hasRole('Impersonator') || $user->id === $request->user()->id,
            403, 'The account switcher cannot impersonate itself or another switcher.');
        abort_if($request->user()->hasRole('Super Admin') && $user->hasRole('Super Admin'),
            403, 'A Super Admin cannot impersonate another Super Admin.');
        abort_if(!$user->is_active, 422, 'That account is deactivated.');

        // Every account switch records the initiating account and reason.
        $data = $request->validate([
            'reason' => ['required', 'string', 'min:5', 'max:500'],
        ], [
            'reason.required' => 'A reason is required before impersonating an account.',
        ]);

        // Impersonation is a brief, deliberate admin action, not a persistent
        // login — give it a short explicit expiry regardless of the global
        // Sanctum 'expiration' setting (config/sanctum.php), which governs
        // ordinary login tokens instead. 30 minutes (not the 4 hours this
        // used to be): long enough for one support task, short enough that a
        // forgotten/abandoned session doesn't sit live for hours.
        // In 'local' only, no expiry at all — a dev jumping between many
        // accounts to test a feature shouldn't get logged out mid-session
        // ("Unauthenticated") just for taking longer than 30 minutes.
        // Deployed support sessions retain their 30-minute expiry.
        $impersonationExpiry = app()->environment('local') ? null : now()->addMinutes(30);
        $issued = $user->createToken('impersonation_token', [...$user->allRoles(), 'impersonated'], $impersonationExpiry);
        $issued->accessToken->forceFill(['impersonator_user_id' => $request->user()->id, 'impersonation_reason' => $data['reason']])->save();
        $token = $issued->plainTextToken;

        ActivityLog::create([
            'user_id'     => $request->user()?->id,
            'role'        => $request->user()?->role,
            'action'      => 'Impersonate',
            'module'      => 'Impersonation',
            // Explicitly set (not left to BelongsToBarangay's creating-hook
            // default, which would stamp the ACTOR's own barangay_id — null
            // for the switcher) so this entry is visible in the TARGET
            // barangay's own Activity Log (FleetController::logs(), scoped
            // by BelongsToBarangay's global scope) as well as here via
            // SuperAdminController::activityLog()'s module filter, from the
            // same single row.
            'barangay_id' => $user->barangay_id,
            'details'     => ($request->user()?->name ?? 'Someone') . " impersonated {$user->name}"
                . '.'
                . " Reason: {$data['reason']}",
        ]);

        return response()->json([
            'access_token' => $token,
            'token_type'   => 'Bearer',
            'user' => [
                'id'    => $user->id,
                'name'  => $user->name,
                'email' => $user->email,
                'role'  => $user->role,
                'roles' => $user->allRoles(),
                'abilities' => $user->getAbilities(),
            ],
        ]);
    }

    /**
     * Terminate active sessions and revoke active tokens.
     */
    public function logout(Request $request)
    {
        $user = $request->user();
        $token = $user->currentAccessToken();

        // Phase A5 — "log start and end": impersonate() above logs the
        // start; ending one always goes through here (either an explicit
        // logout, or Workspace.jsx's "Return to..." control, which calls
        // this on the impersonated token before swapping back to the real
        // account — see stopImpersonating()). $user IS the impersonated
        // account at this point, not who started it, so this can't name
        // them the way the start log does; cross-referencing barangay_id
        // and timing against that start entry covers that.
        //
        // Keyed off the token's NAME, not ->can('impersonated') — see
        // RestrictImpersonatedToReadOnly's docblock for why: the ability
        // check is satisfied by ANY Sanctum::actingAs($user, ['*']) token,
        // which is this whole test suite's normal way of authenticating.
        if ($token?->name === 'impersonation_token') {
            ActivityLog::create([
                'user_id'     => $user->id,
                'role'        => $user->role,
                'action'      => 'Impersonation Ended',
                'module'      => 'Super Admin',
                'barangay_id' => $user->barangay_id,
                'details'     => "Impersonated session for {$user->name} ended.",
            ]);
        }

        // Revoke the exact token string utilized to authenticate the active API request
        $token->delete();

        return response()->json([
            'message' => 'Session terminated and token revoked successfully.'
        ], 200);
    }

    /**
     * Return a time-aware greeting for the authenticated workspace user.
     */
    public function greeting(Request $request)
    {
        $user = $request->user();
        $timezone = 'Asia/Manila';
        $now = now($timezone);
        $hour = (int) $now->format('G');
        $displayName = strtoupper(strtok(trim($user->name), ' ') ?: $user->name);

        $period = match (true) {
            $hour >= 5 && $hour < 12 => 'morning',
            $hour === 12 => 'noon',
            $hour >= 13 && $hour < 15 => 'afternoon',
            $hour >= 15 && $hour < 18 => 'late_afternoon',
            $hour >= 18 && $hour < 22 => 'evening',
            default => 'night',
        };

        $messages = [
            'morning' => [
                "Rise and shine, {$displayName}!",
                "A bright morning to you, {$displayName}!",
                "Fresh start, {$displayName}! Let's keep the fleet moving.",
                "Morning momentum is here, {$displayName}!",
            ],
            'noon' => [
                "Happy noon, {$displayName}!",
                "Midday check-in, {$displayName}! The fleet is ready.",
                "It's noon, {$displayName}! Keep the day rolling.",
                "A steady noon to you, {$displayName}!",
            ],
            'afternoon' => [
                "A pleasant afternoon, {$displayName}!",
                "Good energy this afternoon, {$displayName}!",
                "Afternoon focus is on, {$displayName}!",
                "Keep the dashboard sharp this afternoon, {$displayName}!",
            ],
            'late_afternoon' => [
                "It's late afternoon, {$displayName}!",
                "Late afternoon focus, {$displayName}!",
                "A strong late afternoon to you, {$displayName}!",
                "The day is still moving, {$displayName}!",
            ],
            'evening' => [
                "A calm evening to you, {$displayName}!",
                "Evening check-in, {$displayName}! The fleet is in view.",
                "Good evening, {$displayName}! Keep things steady.",
                "The evening shift is looking sharp, {$displayName}!",
            ],
            'night' => [
                "Working late, {$displayName}? The dashboard is ready.",
                "Quiet night watch, {$displayName}!",
                "Late-night focus, {$displayName}!",
                "The fleet rests easier with you here, {$displayName}!",
            ],
        ];

        $roleLabel = match ($user->role) {
            'Admin' => 'Administrator',
            'Maintenance Personnel' => 'Maintenance',
            default => $user->role,
        };

        $periodMessages = $messages[$period];
        $greeting = $periodMessages[random_int(0, count($periodMessages) - 1)];

        return response()->json([
            'greeting' => $greeting,
            'period' => $period,
            'role_label' => $roleLabel,
            'timezone' => $timezone,
            'generated_at' => $now->toIso8601String(),
            'user' => [
                'id' => $user->id,
                'name' => $user->name,
                'email' => $user->email,
                'role' => $user->role,
            ],
        ]);
    }

    /**
     * Self-service edit of the authenticated user's own contact details —
     * the same fields an Admin can edit for someone else via
     * UserController::update, minus role and password (role is
     * Admin-reviewed only; password stays on its own old-password-verified
     * endpoint above).
     */
    public function updateProfile(Request $request)
    {
        $user = $request->user();

        $data = $request->validate([
            'name' => ['sometimes', 'required', 'string', 'max:255'],
            'email' => ['sometimes', 'required', 'email', Rule::unique('users', 'email')->ignore($user->id)],
            'phone' => ['nullable', 'string', 'regex:/^09[0-9]{9}$/'],
            'address' => ['nullable', 'string', 'max:255'],
            'photo' => ['nullable', 'image', 'max:4096'],
        ], [
            'phone.regex' => 'Phone number must be 11 digits starting with 09 (e.g. 09171234567).',
        ]);

        if ($request->hasFile('photo')) {
            $data['photo_url'] = $this->storeUploadedImage($request->file('photo'), 'profile-photos');
        }
        unset($data['photo']);

        $user->update($data);

        ActivityLog::create([
            'user_id' => $user->id,
            'role' => $user->role,
            'action' => 'Edit',
            'module' => 'Profile',
            'affected_record_id' => (string) $user->id,
            'details' => "{$user->name} updated their profile details.",
        ]);

        return $user->fresh();
    }

    /**
     * Update the authenticated user's security password.
     */
    public function updatePassword(Request $request)
    {
        $data = $request->validate([
            'old_password' => ['required', 'string'],
            'new_password' => ['required', 'string', 'min:8', 'confirmed', 'different:old_password'],
        ], [
            'new_password.different' => 'Your new password must be different from your current one.',
        ]);

        if (! Hash::check($data['old_password'], $request->user()->password)) {
            return response()->json([
                'message' => 'The old password you entered is incorrect.',
            ], 422);
        }

        $request->user()->forceFill([
            'password' => Hash::make($data['new_password']),
            'must_change_password' => false,
        ])->save();

        $request->user()->tokens()->where('id', '!=', $request->user()->currentAccessToken()?->id)->delete();

        ActivityLog::create([
            'user_id' => $request->user()->id,
            'role' => $request->user()->role,
            'action' => 'Edit',
            'module' => 'Profile',
            'affected_record_id' => (string) $request->user()->id,
            'details' => "{$request->user()->name} updated account security credentials.",
        ]);

        return response()->json([
            'message' => 'Password updated successfully.',
        ]);
    }
}
