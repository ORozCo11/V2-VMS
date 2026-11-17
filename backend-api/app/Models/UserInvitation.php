<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class UserInvitation extends Model
{
    public const VALID_HOURS = 24;

    protected $fillable = ['user_id', 'invited_by', 'purpose', 'token_hash', 'expires_at', 'accepted_at', 'revoked_at', 'sent_at'];

    protected $casts = ['expires_at' => 'datetime', 'accepted_at' => 'datetime', 'revoked_at' => 'datetime', 'sent_at' => 'datetime'];

    public function user()
    {
        return $this->belongsTo(User::class);
    }

    public static function hashToken(string $token): string
    {
        return hash('sha256', $token);
    }

    /** Usable = not accepted, not revoked/superseded and not expired. */
    public function isUsable(): bool
    {
        return $this->accepted_at === null && $this->revoked_at === null && $this->expires_at->isFuture();
    }
}
