<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use App\Http\Controllers\Concerns\UploadsImages;
use App\Mail\AccountMail;
use App\Models\ActivityLog;
use App\Models\Barangay;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\Rule;

class AuthController extends Controller
{
    use UploadsImages;

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

        // Pending accounts get the same answer as a wrong password, so login can't be used to probe who is invited.
        if ($user->activated_at === null) {
            return response()->json(['message' => 'Invalid credentials provided. Please check your email or password.'], 401);
        }

        if (!$user->is_active) {
            return response()->json(['message' => 'This account has been deactivated. Contact your administrator.'], 403);
        }

        // A temporary password stops working after a few days; the person who
        // created the account sends a fresh one instead of leaving it open.
        if ($user->must_change_password && $user->temp_password_expires_at && $user->temp_password_expires_at->isPast()) {
            return response()->json([
                'message' => 'Your temporary password has expired. Ask your administrator to send you a new one.',
                'code' => 'temporary_password_expired',
            ], 403);
        }

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
                'must_change_password' => (bool) $user->must_change_password,
                'roles' => $user->allRoles(), // Every hat this account may wear
                'abilities' => $user->getAbilities(), // Phase B2 — what the frontend gates on
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

        return User::with(['barangay.city.province', 'roleRows'])
            ->where('id', '!=', $request->user()->id)
            ->where('role', '!=', 'Impersonator')
            ->when($request->user()->hasRole('Super Admin'), fn ($q) => $q->where('role', '!=', 'Super Admin'))
            ->orderBy('name')
            ->get(['id', 'name', 'email', 'role', 'is_active', 'barangay_id'])
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
            'photo' => ['nullable', 'file', 'mimes:jpg,jpeg,png,webp', 'max:5120'],
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
            'new_password' => ['required', 'string', 'min:8', 'confirmed'],
        ]);

        if (! Hash::check($data['old_password'], $request->user()->password)) {
            return response()->json([
                'message' => 'The old password you entered is incorrect.',
            ], 422);
        }

        abort_if(Hash::check($data['new_password'], $request->user()->password), 422, 'Choose a new password that is different from the current one.');

        $request->user()->update([
            'password' => Hash::make($data['new_password']),
            'must_change_password' => false,
        ]);

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
