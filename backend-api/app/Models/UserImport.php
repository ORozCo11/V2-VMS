<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class UserImport extends Model
{
    protected $fillable = [
        'user_id', 'barangay_id', 'file_name', 'stored_path', 'status',
        'total_rows', 'valid_rows', 'error_rows',
        'imported_rows', 'failed_rows', 'findings', 'completed_at',
    ];

    protected $casts = [
        'findings' => 'array',
        'completed_at' => 'datetime',
    ];

    public function user()
    {
        return $this->belongsTo(User::class);
    }
}
