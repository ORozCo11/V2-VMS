<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// The public form only asks for a description when the concern type is "Other".
return new class extends Migration {
    public function up(): void
    {
        Schema::table('concern_reports', fn (Blueprint $table) => $table->text('description')->nullable()->change());
    }

    public function down(): void
    {
        Schema::table('concern_reports', fn (Blueprint $table) => $table->text('description')->nullable(false)->change());
    }
};
