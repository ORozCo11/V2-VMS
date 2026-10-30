<?php

namespace App\Services;

use App\Mail\AccountMail;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use RuntimeException;

/**
 * Creates invited accounts and sends their "Set your password" emails, for
 * both a single invite (UserController) and batch upload (UserImportController).
 * An account is only kept if its invite email was actually sent.
 */
class UserInviter
{
    /**
     * Create an inactive account in the inviting Admin's barangay — already
     * approved by that Admin — and email the invite.
     *
     * @throws RuntimeException when the email can't be sent (nothing is saved)
     */
    public function invite(array $data, User $admin): User
    {
        return DB::transaction(function () use ($data, $admin) {
            $user = User::create($data + [
                'password' => Hash::make(Str::random(40)),
                'barangay_id' => $admin->barangay_id,
                'city_id' => $admin->city_id,
                'barangay_name' => $admin->barangay?->name ?? $admin->barangay_name,
                'is_active' => false,
                'approved_at' => now(),
            ]);
            $this->send($user);

            return $user;
        });
    }

    /**
     * Issue a fresh link (earlier ones stop working) and email it.
     *
     * @throws RuntimeException when the email can't be sent
     */
    public function send(User $user): void
    {
        $token = $user->issueInvite();
        $url = rtrim(config('app.frontend_url'), '/').'/accept-invite?'.http_build_query(['email' => $user->email, 'token' => $token]);

        try {
            Mail::to($user->email)->send(new AccountMail($user, "You're invited to VMS for Barangay {$user->barangay_name}", 'invite', [
                'token' => $token,
                'inviteUrl' => $url,
                'expiresAt' => $user->invite_expires_at,
            ]));
        } catch (\Throwable $e) {
            report($e);
            throw new RuntimeException('The invite email could not be sent.', 0, $e);
        }
    }
}
