<?php

namespace App\Services;

use App\Mail\AccountMail;
use App\Models\ActivityLog;
use App\Models\User;
use App\Models\UserInvitation;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;

/**
 * Invitation-only account provisioning. The invitation (server-side) decides who the
 * account is, its role and its barangay; the recipient only ever chooses a password.
 * Tokens are random, single-use, expire after 24 hours and are stored hashed.
 */
class InvitationService
{
    /** Creates the pending account and emails its invitation. Returns [user, emailSent]. */
    public function invite(User $actor, string $name, string $email, string $role, ?int $barangayId, ?int $cityId, array $extra = []): array
    {
        $user = DB::transaction(fn () => User::create($extra + [
            'name' => $name,
            'email' => $email,
            'password' => Hash::make(Str::random(48)), // unusable until the owner sets their own
            'role' => $role,
            'roles' => [$role],
            'barangay_id' => $barangayId,
            'city_id' => $cityId,
            'is_active' => false,
            'activated_at' => null,
            'approved_at' => null,
            'must_change_password' => false,
            'can_register_vehicles' => false,
        ]));

        $emailed = $this->issue($user, $actor, 'invite');
        $this->audit($actor, 'Add', $user, "Invited {$user->name} ({$user->email}) as {$role}.");

        return [$user, $emailed];
    }

    /** Supersedes any open invitation, creates a fresh one and emails it. True only if the mailer accepted it. */
    public function issue(User $user, ?User $actor, string $purpose): bool
    {
        $plain = Str::random(64);

        DB::transaction(function () use ($user, $actor, $purpose, $plain) {
            UserInvitation::where('user_id', $user->id)->whereNull('accepted_at')->whereNull('revoked_at')->update(['revoked_at' => now()]);
            UserInvitation::create([
                'user_id' => $user->id,
                'invited_by' => $actor?->id,
                'purpose' => $purpose,
                'token_hash' => UserInvitation::hashToken($plain),
                'expires_at' => now()->addHours(UserInvitation::VALID_HOURS),
            ]);
        });
        $invitation = UserInvitation::where('token_hash', UserInvitation::hashToken($plain))->firstOrFail();

        $frontend = rtrim(config('app.frontend_url'), '/');
        try {
            Mail::to($user->email)->send(new AccountMail(
                $user,
                $purpose === 'reset' ? 'Reset your Barangay VMS password' : 'Your Barangay VMS Account Invitation',
                $purpose === 'reset' ? 'password-reset' : 'invitation',
                ['activationUrl' => "{$frontend}/accept-invitation?token={$plain}", 'roleName' => $user->role, 'expiresAt' => $invitation->expires_at],
            ));
            $invitation->forceFill(['sent_at' => now()])->save();

            return true;
        } catch (\Throwable $e) {
            // Never log the token: report only the failure itself.
            report(new \RuntimeException('Invitation email failed: '.get_class($e)));

            return false;
        }
    }

    public function revoke(User $actor, User $user): void
    {
        UserInvitation::where('user_id', $user->id)->whereNull('accepted_at')->whereNull('revoked_at')->update(['revoked_at' => now()]);
        $this->audit($actor, 'Revoke', $user, "Revoked the invitation for {$user->name} ({$user->email}).");
    }

    /** Looks a token up by hash. Returns the invitation only while it is usable. */
    public function find(string $token): ?UserInvitation
    {
        $invitation = UserInvitation::with('user.barangay.city')->where('token_hash', UserInvitation::hashToken($token))->first();

        return $invitation && $invitation->isUsable() ? $invitation : null;
    }

    /** Sets the password and activates the account. Single-use even under concurrent requests. */
    public function accept(string $token, string $password): ?User
    {
        return DB::transaction(function () use ($token, $password) {
            $invitation = UserInvitation::where('token_hash', UserInvitation::hashToken($token))->lockForUpdate()->first();
            if (! $invitation || ! $invitation->isUsable()) {
                return null;
            }
            $user = User::lockForUpdate()->find($invitation->user_id);
            if (! $user) {
                return null;
            }

            $firstActivation = $user->activated_at === null;
            $user->forceFill([
                'password' => Hash::make($password),
                'must_change_password' => false,
                'temp_password_expires_at' => null,
                'activated_at' => $user->activated_at ?? now(),
                'approved_at' => $user->approved_at ?? now(),
                // An invitation activates a pending account; a reset never re-enables a disabled one.
                'is_active' => $firstActivation ? true : $user->is_active,
            ])->save();
            $invitation->forceFill(['accepted_at' => now()])->save();
            UserInvitation::where('user_id', $user->id)->whereNull('accepted_at')->whereNull('revoked_at')->update(['revoked_at' => now()]);
            $user->tokens()->delete(); // sign out anything issued before the password changed

            ActivityLog::create([
                'user_id' => $user->id, 'role' => $user->role, 'action' => $firstActivation ? 'Activate' : 'Edit', 'module' => 'Users',
                'affected_record_id' => $user->id,
                'details' => $firstActivation ? "{$user->name} accepted the invitation and activated the account." : "{$user->name} reset their password from an emailed link.",
            ]);

            return $user;
        });
    }

    /** pending_invitation | invitation_expired | active | disabled */
    public static function statusOf(User $user): string
    {
        if ($user->activated_at === null) {
            $latest = UserInvitation::where('user_id', $user->id)->whereNull('accepted_at')->whereNull('revoked_at')->latest('id')->first();

            return $latest && $latest->expires_at->isFuture() ? 'pending_invitation' : 'invitation_expired';
        }

        return $user->is_active ? 'active' : 'disabled';
    }

    private function audit(User $actor, string $action, User $target, string $details): void
    {
        ActivityLog::create([
            'user_id' => $actor->id, 'role' => $actor->role, 'action' => $action,
            'module' => $actor->hasRole('Super Admin') ? 'Super Admin' : 'Users',
            'affected_record_id' => $target->id, 'details' => $details,
        ]);
    }
}
