<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // An account is "pending" until its owner sets a password through an invitation.
        Schema::table('users', function (Blueprint $table) {
            $table->timestamp('activated_at')->nullable()->after('approved_at');
        });
        // Every account that exists today already has a working password.
        DB::table('users')->whereNull('activated_at')->update(['activated_at' => DB::raw('COALESCE(approved_at, created_at, CURRENT_TIMESTAMP)')]);

        Schema::create('user_invitations', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->foreignId('invited_by')->nullable()->constrained('users')->nullOnDelete();
            // 'invite' = first activation; 'reset' = a password reset sent to an active account.
            $table->string('purpose', 16)->default('invite');
            // Only the SHA-256 of the token is stored; the plain token exists only inside the email link.
            $table->string('token_hash', 64)->unique();
            $table->timestamp('expires_at');
            $table->timestamp('accepted_at')->nullable();
            $table->timestamp('revoked_at')->nullable();
            $table->timestamp('sent_at')->nullable();
            $table->timestamps();

            $table->index(['user_id', 'accepted_at', 'revoked_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('user_invitations');
        Schema::table('users', fn (Blueprint $table) => $table->dropColumn('activated_at'));
    }
};
