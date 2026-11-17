<?php

namespace App\Console\Commands;

use App\Models\City;
use App\Models\User;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Validator;

/**
 * The only supported way to provision a real Super Admin account outside
 * local/testing. 2026_08_31_000001_create_super_admin_account.php seeds a
 * demo one, but is deliberately gated to local/testing only — a well-known
 * email+password for an account that can see every barangay's accounts
 * must never be auto-created on a real deployment (see that migration's
 * docblock, and database/seeders/UserSeeder.php which is gated the same
 * way as of this command's introduction).
 *
 * Prompts interactively for everything rather than taking flags, so a
 * password never ends up in shell history or a deploy script's logs.
 * Not scoped to any barangay (barangay_id stays null) — see
 * SuperAdminController and BelongsToBarangay's docblock for why that's
 * what lets a Super Admin see across every barangay.
 */
class CreateSuperAdmin extends Command
{
    protected $signature = 'superadmin:create {--city= : City/municipality (the LGU) this Super Admin governs: id or exact name}';
    protected $description = 'Interactively create a real Super Admin account (production-safe, no hardcoded credentials)';

    public function handle(): int
    {
        // The LGU this Super Admin governs. Without one the account keeps the legacy platform-wide reach.
        $city = null;
        if ($this->option('city') !== null) {
            $needle = (string) $this->option('city');
            $matches = City::query()->when(ctype_digit($needle), fn ($q) => $q->where('id', (int) $needle), fn ($q) => $q->where('name', $needle))->get();
            if ($matches->count() !== 1) {
                $this->error($matches->isEmpty() ? "No city or municipality matches \"{$needle}\"." : "\"{$needle}\" matches several cities; pass the city id instead.");
                return self::FAILURE;
            }
            $city = $matches->first();
        } else {
            $this->warn('No --city given: this Super Admin will not be limited to one LGU. Pass --city="Mandaue City" to scope it.');
        }

        $name = $this->ask('Full name');
        if (!$name) {
            $this->error('A name is required.');
            return self::FAILURE;
        }

        $email = $this->ask('Email address');
        $password = $this->secret('Password (min 8 characters)');
        $confirmation = $this->secret('Confirm password');

        $validator = Validator::make(
            [
                'name' => $name,
                'email' => $email,
                'password' => $password,
                'password_confirmation' => $confirmation,
            ],
            [
                'name' => ['required', 'string', 'max:150'],
                'email' => ['required', 'email', 'unique:users,email'],
                'password' => ['required', 'string', 'min:8', 'confirmed'],
            ]
        );

        if ($validator->fails()) {
            foreach ($validator->errors()->all() as $message) {
                $this->error($message);
            }
            return self::FAILURE;
        }

        if (!$this->confirm("Create a Super Admin account for {$email}?", true)) {
            $this->info('Cancelled — no account created.');
            return self::SUCCESS;
        }

        $user = User::create([
            'name' => $name,
            'email' => $email,
            'password' => Hash::make($password),
            'role' => 'Super Admin',
            'roles' => ['Super Admin'],
            'barangay_id' => null,
            'city_id' => $city?->id,
            'is_active' => true,
            'approved_at' => now(),
        ]);

        $this->info("Super Admin account created: {$user->email} (id {$user->id})".($city ? ", governing {$city->name}." : "."));

        return self::SUCCESS;
    }
}
