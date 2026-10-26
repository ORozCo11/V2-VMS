<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// When the Super Admin last emailed the reporter: the "we received it" reply and the "it's resolved" follow-up.
return new class extends Migration {
    public function up(): void
    {
        Schema::table('concern_reports', function (Blueprint $table) {
            $table->timestamp('acknowledged_email_at')->nullable();
            $table->timestamp('resolved_email_at')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('concern_reports', fn (Blueprint $table) => $table->dropColumn(['acknowledged_email_at', 'resolved_email_at']));
    }
};
