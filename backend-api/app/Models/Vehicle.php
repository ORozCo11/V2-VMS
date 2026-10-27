<?php

namespace App\Models;

use App\Models\Concerns\HasBarangayNumber;

use App\Models\Concerns\BelongsToBarangay;
use Illuminate\Database\Eloquent\Model;

class Vehicle extends Model
{
    use BelongsToBarangay;
    use HasBarangayNumber;

    protected $primaryKey = 'vehicle_id';

    protected $fillable = [
        'readiness_invalidated_at',
        'custom_values',
        'criticality',
        'vehicle_name',
        'plate_number',
        'category_id',
        'barangay_id',
        'brand',
        'model',
        'year_model',
        'capacity',
        'acquisition_cost',
        'fuel_type',
        'hull_material',
        'engine_type',
        'vehicle_color',
        'current_location',
        'custodian_id',
        'photo_url',
        'remarks',
        'status',
        'condition',
        'estimated_return_date',
        'archived_at',
        'archived_by',
        // Gap 4 — end-of-life (decommission)
        'decommission_reason',
        'decommissioned_by',
        'decommissioned_at',
    ];

    protected static function booted(): void
    {
        static::updating(function (self $vehicle) {
            if (($vehicle->isDirty('status') && $vehicle->status === 'Under Maintenance')
                || ($vehicle->isDirty('condition') && $vehicle->condition !== 'Good')) {
                $vehicle->readiness_invalidated_at = now();
            }
        });
    }

    protected $casts = [
        'readiness_invalidated_at' => 'datetime',
        'custom_values' => 'array',
        'archived_at' => 'datetime',
        'decommissioned_at' => 'datetime',
        // Serialize as a plain Y-m-d string so it binds directly to a
        // native <input type="date"> on the frontend.
        'estimated_return_date' => 'date:Y-m-d',
    ];

    public function category()
    {
        return $this->belongsTo(VehicleCategory::class, 'category_id', 'category_id');
    }

    public function custodian()
    {
        return $this->belongsTo(User::class, 'custodian_id');
    }

    public function archivedBy()
    {
        return $this->belongsTo(User::class, 'archived_by');
    }

    public function decommissionedBy()
    {
        return $this->belongsTo(User::class, 'decommissioned_by');
    }

    public function schedules()
    {
        return $this->hasMany(VehicleMaintenanceSchedule::class, 'vehicle_id', 'vehicle_id');
    }

    // Admin's per-vehicle override, else the Vehicle Type's default.
    public function effectiveCriticality(): string
    {
        return $this->criticality ?: ($this->category?->default_criticality ?: 'Normal');
    }

    public function readinessChecks()
    {
        return $this->hasMany(VehicleReadinessCheck::class, 'vehicle_id', 'vehicle_id');
    }

    public function tickets()
    {
        return $this->hasMany(MaintenanceTicket::class, 'vehicle_id', 'vehicle_id');
    }

    public function issueReports()
    {
        return $this->hasMany(VehicleIssueReport::class, 'vehicle_id', 'vehicle_id');
    }

    public function maintenanceRecords()
    {
        return $this->hasMany(VehicleMaintenanceRecord::class, 'vehicle_id', 'vehicle_id');
    }

    public function histories()
    {
        return $this->hasMany(VehicleHistory::class, 'vehicle_id', 'vehicle_id');
    }

    public function documents()
    {
        return $this->hasMany(VehicleDocument::class, 'vehicle_id', 'vehicle_id');
    }
}
