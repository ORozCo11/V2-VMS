<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;
use App\Models\Barangay;
use App\Models\User;
use Illuminate\Support\Facades\Hash;

class UserSeeder extends Seeder
{
    /**
     * Run the database seeds.
     *
     * Fixed, publicly-known demo credentials (including a Super Admin, the
     * one account that can see across every barangay) — local/testing
     * convenience only, same guard as
     * 2026_08_31_000001_create_super_admin_account.php. Unlike that
     * migration, this seeder isn't guaranteed to only run in those
     * environments: it's called unconditionally from DatabaseSeeder, and
     * `php artisan db:seed` / `migrate:fresh --seed` are ordinary things to
     * run when first standing up a new environment. Provision a real Super
     * Admin in production with `php artisan superadmin:create` instead.
     */
    public function run(): void
    {
        if (!app()->environment(['local', 'testing'])) {
            $this->command?->warn('UserSeeder skipped — demo accounts (including Super Admin) only seed in local/testing.');
            return;
        }

        // Remove any other users not part of this fixed demo roster.
        User::whereNotIn('email', [
            'superadmin@barangay.gov',
            'admin@barangay.gov',
            'custodian@barangay.gov',
            'custodian2@barangay.gov',
            'maintenance@barangay.gov',
            'maintenance2@barangay.gov',
            'maintenance3@barangay.gov',
        ])->delete();

        // Same convention as FleetReferenceSeeder::seedDefaultHubs() — these
        // demo accounts represent real Paknaan staff, so they're stamped with
        // Paknaan's own barangay_id. Without it, BelongsToBarangay's global
        // scope (`Auth::check() && Auth::user()->barangay_id`) never applies
        // for them, so they'd see/act across every barangay's data — and
        // Vehicle's creating-time auto-stamp never fires here anyway since
        // there's no authenticated user while seeding.
        $paknaanId = Barangay::where('name', 'Paknaan')->value('id');

        $users = [
            [
                'name' => 'Super Admin',
                'email' => 'superadmin@barangay.gov',
                'password' => 'superadmin123',
                'role' => 'Super Admin',
                // Intentionally left without a barangay_id — see
                // 2026_08_31_000001_create_super_admin_account.php and
                // BelongsToBarangay's docblock: a null barangay_id is what
                // lets the Super Admin see across every barangay.
                'barangay_id' => null,
            ],
            [
                'name' => 'Paul Orozco',
                'email' => 'admin@barangay.gov',
                'password' => 'admin123',
                'role' => 'Admin',
                'barangay_id' => $paknaanId,
            ],
            [
                'name' => 'Precious Dignos',
                'email' => 'custodian@barangay.gov',
                'password' => 'custodian123',
                'role' => 'Custodian',
                'barangay_id' => $paknaanId,
            ],
            [
                'name' => 'Justine Mae Belia',
                'email' => 'custodian2@barangay.gov',
                'password' => 'custodian123',
                'role' => 'Custodian',
                'barangay_id' => $paknaanId,
            ],
            [
                'name' => 'Jake Engana',
                'email' => 'maintenance@barangay.gov',
                'password' => 'maintenance123',
                'role' => 'Maintenance Personnel',
                'barangay_id' => $paknaanId,
            ],
            [
                'name' => 'Rohan Naveo',
                'email' => 'maintenance2@barangay.gov',
                'password' => 'maintenance123',
                'role' => 'Maintenance Personnel',
                'barangay_id' => $paknaanId,
            ],
            [
                'name' => 'Mia Santos',
                'email' => 'maintenance3@barangay.gov',
                'password' => 'maintenance123',
                'role' => 'Maintenance Personnel',
                'barangay_id' => $paknaanId,
            ],
        ];

        foreach ($users as $user) {
            User::updateOrCreate(
                ['email' => $user['email']],
                [
                    'name' => $user['name'],
                    'password' => Hash::make($user['password']),
                    'role' => $user['role'],
                    'barangay_id' => $user['barangay_id'],
                ],
            );
        }
    }
}
