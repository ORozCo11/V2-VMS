<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    // The Custodian responsible for a vehicle — prefilled with whoever
    // registers it when that person is a Custodian.
    // SQLite can only add a foreign key by rebuilding the table, which would
    // drop the vehicles CHECK constraints, so it gets a plain column there.
    public function up(): void
    {
        $sqlite = Schema::getConnection()->getDriverName() === 'sqlite';

        Schema::table('vehicles', function (Blueprint $table) use ($sqlite) {
            $column = $table->foreignId('custodian_id')->nullable()->after('current_location');
            if (!$sqlite) {
                $column->constrained('users')->nullOnDelete();
            }
        });
    }

    public function down(): void
    {
        Schema::table('vehicles', function (Blueprint $table) {
            if (Schema::getConnection()->getDriverName() !== 'sqlite') {
                $table->dropForeign(['custodian_id']);
            }
            $table->dropColumn('custodian_id');
        });
    }
};
