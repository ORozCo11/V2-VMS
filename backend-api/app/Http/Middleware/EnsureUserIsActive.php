<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Deactivation must take effect immediately, not just block future logins.
 * Without this, a deactivated user's existing Sanctum token keeps working on
 * every protected route indefinitely — `is_active` was previously only
 * checked at login. Runs after auth:sanctum, so $request->user() is set.
 */
class EnsureUserIsActive
{
    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();

        // A pending (never-activated) account has no access at all, whatever token it might hold.
        if ($user && $user->activated_at === null) {
            abort(401, 'This account has not been activated.');
        }

        if ($user && !$user->is_active) {
            abort(401, 'This account has been deactivated.');
        }

        // A temporary password must be replaced before anything else works —
        // only "who am I", sign-out and the password change itself are allowed.
        // (Impersonation sessions are exempt: the Super Admin never has the
        // person's password to change.)
        if ($user && $user->must_change_password
            && $user->currentAccessToken()?->name !== 'impersonation_token'
            && ! $request->is('api/user', 'api/logout', 'api/profile/password')) {
            return response()->json([
                'message' => 'You must change your temporary password before continuing.',
                'code' => 'password_change_required',
            ], 403);
        }

        return $next($request);
    }
}
