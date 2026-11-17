<?php

namespace App\Models;

use App\Models\Concerns\HasBarangayNumber;

use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Illuminate\Database\Eloquent\Factories\HasFactory;

// CHANGE THIS LINE to use Laravel's built-in token trait instead:
use Laravel\Sanctum\HasApiTokens;

class User extends Authenticatable
{
    // Make sure it is included here inside the class wrapper:
    use HasApiTokens, Notifiable, HasFactory;
    use HasBarangayNumber;

    /**
     * The attributes that are mass assignable.
     */
    protected $fillable = [
        'name',
        'email',
        'password',
        'must_change_password',
        'temp_password_expires_at',
        'role',
        'roles',
        'phone',
        'address',
        'barangay_id',
        'city_id',
        'photo_url',
        'is_active',
        'approved_at',
        'activated_at',
        'can_register_vehicles',
    ];

    // A temporary password emailed to a new account stops working after this long.
    public const TEMP_PASSWORD_VALID_HOURS = 72;

    /**
     * The attributes that should be hidden for serialization.
     */
    protected $hidden = [
        'roleRows',
        'password',
        'remember_token',
    ];

    protected $casts = [
        'is_active' => 'boolean',
        'must_change_password' => 'boolean',
        'temp_password_expires_at' => 'datetime',
        'approved_at' => 'datetime',
        'activated_at' => 'datetime',
        'can_register_vehicles' => 'boolean',
    ];

    // Matches the migration's DB-level default. Without this, a User
    // instance built in PHP without an explicit is_active (e.g. a factory
    // in tests) casts its unset attribute to `false`, not the DB's `true` —
    // a silent mismatch between what's in memory and what's actually stored.
    protected $attributes = [
        'is_active' => true,
    ];

    /** Roles written through `$user->roles = [...]` are held here until the row is saved. */
    protected ?array $pendingRoles = null;

    protected static function booted(): void
    {
        // Accounts created outside the invitation flow (seeders, factories, console) are active at once.
        // The invitation flow passes an explicit null for `activated_at`, which keeps the account pending.
        static::creating(function (User $user) {
            if (! array_key_exists('activated_at', $user->getAttributes())) {
                $user->activated_at = now();
            }
        });

        static::saved(function (User $user) {
            if ($user->pendingRoles === null) {
                return;
            }

            $keep = $user->pendingRoles;
            $user->pendingRoles = null;

            $user->roleRows()->whereNotIn('role', $keep)->delete();
            $existing = $user->roleRows()->pluck('role')->all();
            foreach (array_diff($keep, $existing) as $role) {
                $user->roleRows()->create(['role' => $role]);
            }
            $user->unsetRelation('roleRows');
        });
    }

    /**
     * `roles` used to be a column, so it appeared in every serialized user.
     * Include it whenever the role rows are loaded; endpoints that return
     * users to the frontend eager-load `roleRows`, while embedded users
     * (a ticket's custodian, etc.) stay lean instead of costing a query each.
     */
    public function toArray()
    {
        $array = parent::toArray();

        if ($this->relationLoaded('roleRows')) {
            $array['roles'] = $this->roleRows->pluck('role')->all();
        }

        return $array;
    }

    /** One row per role the account holds (normalized from the old `roles` JSON column). */
    public function roleRows()
    {
        return $this->hasMany(UserRole::class)->orderBy('id');
    }

    /**
     * `roles` reads and writes the user_roles table as a plain array, so
     * callers keep using `$user->roles` / `['roles' => [...]]` unchanged.
     */
    protected function roles(): Attribute
    {
        return Attribute::make(
            get: fn () => $this->pendingRoles ?? ($this->exists ? $this->roleRows->pluck('role')->all() : []),
            set: function ($value) {
                $this->pendingRoles = array_values(array_unique(array_filter((array) $value)));

                return [];
            },
        );
    }

    public function barangay()
    {
        return $this->belongsTo(Barangay::class);
    }

    public function city()
    {
        return $this->belongsTo(City::class);
    }

    /**
     * Multi-role support. `role` remains the user's PRIMARY role (used for
     * routing, dashboards, badges); `roles` is the full set of hats the
     * account may wear (used for permission checks). One person in a small
     * barangay can hold, e.g., ['Custodian', 'Maintenance Personnel'] and act
     * under each — the action taken records which function they performed.
     */
    public function hasRole(string $role): bool
    {
        // Delegate to allRoles() so the primary `role` always counts even if
        // `roles` is populated but happens not to list it — hasRole(),
        // allRoles(), and scopeHavingRole() must always agree on membership.
        return in_array($role, $this->allRoles(), true);
    }

    public function hasAnyRole(array $roles): bool
    {
        foreach ($roles as $role) {
            if ($this->hasRole($role)) {
                return true;
            }
        }

        return false;
    }

    /**
     * The account's effective role set — always includes the primary role.
     */
    public function allRoles(): array
    {
        $roles = $this->roles ?: [];
        if ($this->role && !in_array($this->role, $roles, true)) {
            $roles[] = $this->role;
        }

        return array_values(array_unique($roles));
    }

    /**
     * Match users who hold a given role either as their primary `role` or
     * in the user_roles table.
     *
     * This is a SQL-level mirror of hasRole()/allRoles() (PHP-level), kept
     * separate deliberately — a query scope filters rows at the database
     * before they're hydrated into User instances, so it can't call an
     * instance method per row without pulling every row into PHP first,
     * which would defeat the point of filtering in the query. Because the
     * two are necessarily separate implementations of the same rule, they
     * MUST be changed together — MultiRoleTest::scope_having_role_agrees_with_has_role_for_every_role_storage_shape
     * guards against them silently drifting apart.
     */
    public function scopeHavingRole($query, string $role)
    {
        return $query->where(function ($q) use ($role) {
            $q->where('role', $role)
              ->orWhereExists(function ($sub) use ($role) {
                  $sub->selectRaw('1')
                      ->from('user_roles')
                      ->whereColumn('user_roles.user_id', 'users.id')
                      ->where('user_roles.role', $role);
              });
        });
    }

    /**
     * Single source of truth for "can this account do X" (config/permissions.php),
     * OR'd across every role the account holds. Ownership/live-state rules
     * (own report, not-the-repairer, last-active-Admin, same barangay) are
     * NOT decided here — they stay as separate guard calls next to this one,
     * since they depend on a database record, not just the actor's role.
     */
    /**
     * VMS-IMPROVEMENT-PLAN.md Phase B2 — every ability this account currently
     * holds, for the frontend to gate on instead of role strings. Deliberately
     * a plain method, not an Eloquent accessor/$appends entry: this is only
     * meaningful for "who am I" (login response, GET /user) — appending it
     * globally would silently bloat every OTHER user embedded elsewhere
     * (a ticket's assignedCustodian, an issue's reportedBy, etc.) with an
     * abilities array nobody asked for there.
     */
    public function getAbilities(): array
    {
        return collect(config('permissions'))
            ->filter(fn (array $roles, string $ability) => $this->canDo($ability))
            ->keys()
            ->values()
            ->all();
    }

    /** Registration is a standard duty of Admin and Custodian accounts. */
    public function canRegisterVehicles(): bool
    {
        if ($this->hasRole('Admin')) {
            return true;
        }

        // Vehicle registration is now a standard Custodian duty. Keep the
        // old database flag for account history, but do not require it.
        return $this->hasRole('Custodian');
    }

    public function canDo(string $ability): bool
    {
        if ($ability === 'impersonation.start') {
            // Only the dedicated demo account switcher may impersonate. The real
            // Super Admin cannot sign in as other accounts.
            return $this->is_active && $this->role === 'Impersonator'
                && strtolower(trim($this->email)) === 'superadmin@demotest.com';
        }

        // Note: config('permissions.' . $ability) would be wrong here — Laravel's
        // config() helper splits every dot into a nested lookup, but
        // config/permissions.php stores each ability as a single flat key that
        // itself contains a dot (e.g. 'vehicle.create'), not a nested array.
        $allowedRoles = config('permissions')[$ability] ?? [];

        return $this->hasAnyRole($allowedRoles);
    }

    /**
     * Which of this account's roles actually granted the given ability — the
     * "function used" for an audit-log entry, as opposed to the primary
     * `role` (which only reflects routing/dashboard layout). A dual-role
     * account (e.g. Custodian + Maintenance Personnel) performing a
     * Maintenance-only action should have THAT role recorded, even when
     * their primary role is Custodian. Falls back to the primary role when
     * the ability is unknown or the account doesn't actually hold it (the
     * caller should already have gated on canDo() before reaching here).
     */
    public function effectiveRoleFor(string $ability): ?string
    {
        $allowedRoles = config('permissions')[$ability] ?? [];

        // Primary role first (allRoles() doesn't guarantee that ordering on
        // its own), so a role held both primarily and in the secondary
        // `roles` list is reported the same way canDo() already treats it —
        // a tie goes to the role that drives this account's dashboard/routing.
        if ($this->role && in_array($this->role, $allowedRoles, true)) {
            return $this->role;
        }
        foreach ($this->allRoles() as $candidate) {
            if (in_array($candidate, $allowedRoles, true)) {
                return $candidate;
            }
        }

        return $this->role;
    }
}
