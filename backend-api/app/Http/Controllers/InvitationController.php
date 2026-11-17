<?php

namespace App\Http\Controllers;

use App\Services\InvitationService;
use Illuminate\Http\Request;
use Illuminate\Validation\Rules\Password;

/**
 * Public, token-authenticated endpoints. Every failure (unknown, expired, revoked, used, tampered)
 * returns the same generic answer so the endpoints reveal nothing about who has been invited.
 */
class InvitationController extends Controller
{
    private const INVALID = 'This invitation link is invalid or has expired. Ask your administrator to send a new one.';

    public function show(string $token, InvitationService $invitations)
    {
        $invitation = strlen($token) === 64 ? $invitations->find($token) : null;
        abort_unless($invitation, 410, self::INVALID);

        $user = $invitation->user;

        return response()->json([
            'name' => $user->name,
            'role' => $user->role,
            'barangay' => $user->barangay?->name,
            'lgu' => $user->barangay?->city?->name,
            'purpose' => $invitation->purpose,
            'expires_at' => $invitation->expires_at,
        ]);
    }

    public function accept(Request $request, InvitationService $invitations)
    {
        $data = $request->validate([
            'token' => ['required', 'string', 'size:64'],
            'password' => ['required', 'string', 'confirmed', Password::min(8)->letters()->numbers()],
        ]);

        $user = $invitations->accept($data['token'], $data['password']);
        abort_unless($user, 410, self::INVALID);

        return response()->json(['message' => 'Your password is set. You can now sign in.']);
    }
}
