<?php

namespace Tests\Feature;

use App\Models\Barangay;
use App\Models\City;
use App\Models\Province;
use App\Models\RegistrationSetting;
use App\Models\User;
use Database\Seeders\UserSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * VMS-IMPROVEMENT-PLAN.md Phase A1 — the `users.role` column must accept
 * 'Super Admin' on every database this app runs on (it never did on a
 * cleanly-migrated Postgres database, since enum() there compiles to a real
 * CHECK constraint — see 2026_09_25_000001_widen_users_role_column.php),
 * while every application-level write path keeps rejecting it, and the only
 * production-safe way to create one is `superadmin:create`.
 */
class SuperAdminProvisioningTest extends TestCase
{
    use RefreshDatabase;

    #[Test]
    public function the_role_column_accepts_super_admin_at_the_database_level(): void
    {
        // Bypasses Eloquent entirely — this is what actually proves the old
        // enum/CHECK constraint no longer rejects the value, as opposed to
        // just proving the app never sends it.
        DB::table('users')->insert([
            'name' => 'DB-Level Super Admin',
            'email' => 'db-level-superadmin@example.com',
            'password' => 'x',
            'role' => 'Super Admin',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $this->assertDatabaseHas('users', [
            'email' => 'db-level-superadmin@example.com',
            'role' => 'Super Admin',
        ]);
    }

    #[Test]
    public function superadmin_create_command_provisions_a_working_account(): void
    {
        $this->artisan('superadmin:create')
            ->expectsQuestion('Full name', 'Real Super Admin')
            ->expectsQuestion('Email address', 'real-superadmin@example.com')
            ->expectsQuestion('Password (min 8 characters)', 'a-strong-password')
            ->expectsQuestion('Confirm password', 'a-strong-password')
            ->expectsConfirmation('Create a Super Admin account for real-superadmin@example.com?', 'yes')
            ->assertExitCode(0);

        $user = User::where('email', 'real-superadmin@example.com')->first();
        $this->assertNotNull($user);
        $this->assertSame('Super Admin', $user->role);
        $this->assertSame(['Super Admin'], $user->roles);
        $this->assertNull($user->barangay_id);
        $this->assertTrue($user->is_active);
        $this->assertTrue(\Illuminate\Support\Facades\Hash::check('a-strong-password', $user->password));
    }

    #[Test]
    public function superadmin_create_command_declines_a_duplicate_email(): void
    {
        User::factory()->create(['email' => 'taken@example.com']);

        $this->artisan('superadmin:create')
            ->expectsQuestion('Full name', 'Another One')
            ->expectsQuestion('Email address', 'taken@example.com')
            ->expectsQuestion('Password (min 8 characters)', 'a-strong-password')
            ->expectsQuestion('Confirm password', 'a-strong-password')
            ->assertExitCode(1);

        $this->assertSame(1, User::where('email', 'taken@example.com')->count());
    }

    #[Test]
    public function superadmin_create_command_declines_a_short_or_mismatched_password(): void
    {
        $this->artisan('superadmin:create')
            ->expectsQuestion('Full name', 'Weak Password')
            ->expectsQuestion('Email address', 'weak@example.com')
            ->expectsQuestion('Password (min 8 characters)', 'short')
            ->expectsQuestion('Confirm password', 'short')
            ->assertExitCode(1);

        $this->artisan('superadmin:create')
            ->expectsQuestion('Full name', 'Mismatched Password')
            ->expectsQuestion('Email address', 'mismatched@example.com')
            ->expectsQuestion('Password (min 8 characters)', 'a-strong-password')
            ->expectsQuestion('Confirm password', 'a-different-password')
            ->assertExitCode(1);

        $this->assertDatabaseMissing('users', ['email' => 'weak@example.com']);
        $this->assertDatabaseMissing('users', ['email' => 'mismatched@example.com']);
    }

    #[Test]
    public function superadmin_create_command_can_be_cancelled_at_the_confirmation_step(): void
    {
        $this->artisan('superadmin:create')
            ->expectsQuestion('Full name', 'Changed My Mind')
            ->expectsQuestion('Email address', 'changed-my-mind@example.com')
            ->expectsQuestion('Password (min 8 characters)', 'a-strong-password')
            ->expectsQuestion('Confirm password', 'a-strong-password')
            ->expectsConfirmation('Create a Super Admin account for changed-my-mind@example.com?', 'no')
            ->assertExitCode(0);

        $this->assertDatabaseMissing('users', ['email' => 'changed-my-mind@example.com']);
    }

    #[Test]
    public function user_seeder_seeds_the_demo_roster_in_testing(): void
    {
        (new UserSeeder())->run();

        $this->assertDatabaseHas('users', ['email' => 'superadmin@barangay.gov', 'role' => 'Super Admin']);
        $this->assertDatabaseHas('users', ['email' => 'admin@barangay.gov', 'role' => 'Admin']);
    }

    #[Test]
    public function user_seeder_is_skipped_outside_local_and_testing(): void
    {
        // The whole point of gating this seeder: `db:seed` / `migrate:fresh
        // --seed` against production must never create the publicly-known
        // demo accounts. Checked against 'admin@barangay.gov' rather than
        // the Super Admin email: RefreshDatabase runs every migration
        // (including 2026_08_31_000001_create_super_admin_account.php,
        // itself correctly local/testing-gated) during setUp(), while the
        // environment is still 'testing' — so that row already exists by
        // the time this test body overrides the environment below, for a
        // reason unrelated to UserSeeder. 'admin@barangay.gov' is only ever
        // created by UserSeeder, making it the clean signal for this gate.
        $this->app['env'] = 'production';

        (new UserSeeder())->run();

        $this->assertDatabaseMissing('users', ['email' => 'admin@barangay.gov']);
        $this->assertDatabaseMissing('users', ['email' => 'custodian@barangay.gov']);
    }
}
