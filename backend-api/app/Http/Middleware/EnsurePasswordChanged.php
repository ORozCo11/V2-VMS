<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * An account still on its temporary password may only load itself, change
 * the password, or sign out. Enforced here rather than only in the SPA so a
 * temporary password can't be used to drive the API directly.
 */
class EnsurePasswordChanged
{
    private const ALLOWED_EXACT = ['user', 'profile/password', 'logout'];

    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();

        if ($user && $user->must_change_password && !in_array($request->path(), array_map(fn ($p) => "api/{$p}", self::ALLOWED_EXACT), true)) {
            return response()->json([
                'message' => 'You must replace your temporary password before using the system.',
                'password_change_required' => true,
            ], 403);
        }

        return $next($request);
    }
}
