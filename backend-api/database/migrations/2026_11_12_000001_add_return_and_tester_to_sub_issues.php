<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * - A mechanic can return a work item to the Admin (with a reason) when it should not be theirs, for
 *   example it needs different work. The return is recorded on the item so the Admin and the Custodian
 *   can both see it until the item is reassigned.
 * - An external-shop job has a named tester: the Maintenance Personnel the Admin picks when approving.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('ticket_sub_issues', function (Blueprint $table) {
            if (! Schema::hasColumn('ticket_sub_issues', 'returned_to_admin_at')) {
                $table->timestamp('returned_to_admin_at')->nullable();
                $table->unsignedBigInteger('returned_to_admin_by')->nullable();
                $table->text('returned_to_admin_reason')->nullable();
            }
            if (! Schema::hasColumn('ticket_sub_issues', 'external_tester_id')) {
                $table->unsignedBigInteger('external_tester_id')->nullable();
            }
        });
    }

    public function down(): void
    {
        Schema::table('ticket_sub_issues', function (Blueprint $table) {
            $table->dropColumn(['returned_to_admin_at', 'returned_to_admin_by', 'returned_to_admin_reason', 'external_tester_id']);
        });
    }
};
