<?php

namespace App\Http\Controllers;

use App\Http\Controllers\Concerns\AuthorizesAbilities;
use App\Http\Controllers\Concerns\GuardsLastAdmin;
use App\Http\Controllers\Concerns\GuardsOpenWorkOnDeactivation;
use App\Http\Controllers\Concerns\IssuesTemporaryPassword;
use App\Mail\AccountMail;
use App\Mail\ConcernReplyMail;
use App\Models\ActivityLog;
use App\Models\Barangay;
use App\Models\ConcernReport;
use App\Models\User;
use App\Services\InvitationService;
use App\Services\BarangayGeography;
use App\Services\PsgcRegions;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

/**
 * Platform-level account administration — the one tier above every
 * barangay's own Admin. Deliberately scoped to ACCOUNTS only (users,
 * barangays, registration codes, impersonation, the audit log): a Super
 * Admin can never see a barangay's vehicles, tickets, or other fleet data.
 * That boundary is what keeps "separate everything per barangay" true even
 * with this role in the system — see BelongsToBarangay's docblock for why
 * User itself is never scoped, which is exactly what lets a barangay_id-less
 * Super Admin see across every barangay here without any special-casing.
 */
class SuperAdminController extends Controller
{
    use GuardsLastAdmin;
    use GuardsOpenWorkOnDeactivation;
    use AuthorizesAbilities;
    use IssuesTemporaryPassword;

    private const ROLES = ['Admin', 'Custodian', 'Maintenance Personnel'];

    /**
     * `activity_logs.module` values that represent account/administrative-
     * level activity — the only entries activityLog() may return, per this
     * class's docblock. Every other module string in that table is fleet-
     * operational detail logged by FleetController/TicketController for a
     * barangay's own Admin audit trail (e.g. 'Vehicle Management', 'Vehicle
     * Maintenance Records', 'Vehicle Maintenance Schedule', 'Vehicle
     * Condition Monitoring', 'Vehicle Issue Reports', 'Vehicle Documents',
     * 'Vehicle Categories', 'Reports', 'Maintenance Tickets') and must never
     * surface here. Using an allowlist (rather than excluding fleet modules
     * by name) means a newly added fleet module is excluded by default.
     */
    private const ACCOUNT_MODULES = ['Super Admin', 'Dev Tools', 'Profile', 'Impersonation'];

    private function log(Request $request, string $action, string $details): void
    {
        ActivityLog::create([
            'user_id' => $request->user()->id,
            'role'    => $request->user()->role,
            'action'  => $action,
            'module'  => 'Super Admin',
            'details' => $details,
        ]);
    }

    /**
     * Every barangay, with its staff count and whether it currently has an
     * active Admin — an "orphaned" barangay (none) is the case this whole
     * role exists to let someone recover from.
     */
    public function barangays(Request $request)
    {
        $this->requireAbility($request, 'barangay.view_all', 'Only a Super Admin can perform this action.');

        return Barangay::with(['city.province'])
            // A registration code on its own doesn't count: BarangaySeeder pre-issues
            // codes for all of Mandaue City, and those barangays were never onboarded.
            ->registered()
            ->select(['id', 'name', 'psgc_code', 'city_id', 'boundary_status', 'boundary_source', 'boundary_verified_by', 'pending_boundary', 'pending_boundary_source', 'updated_at'])
            ->selectRaw('CASE WHEN boundary IS NULL THEN 0 ELSE 1 END AS boundary_present')
            ->withCount([
                'users',
                'users as active_admin_count' => fn ($query) => $query->havingRole('Admin')->where('is_active', true),
            ])
            ->orderBy('name')
            ->get()
            ->map(function ($b) {
                // One query, two derived facts — has_active_admin was
                // previously its own separate ->exists() query; counting
                // instead also gives Phase A4's "only one Admin left" signal
                // for free.
                $activeAdminCount = $b->active_admin_count;

                return [
                    'id' => $b->id,
                    'name' => $b->name,
                    'psgc_code' => $b->psgc_code,
                    'city_name' => $b->city?->name,
                    'province_name' => $b->city?->province?->name,
                    'staff_count' => $b->users_count,
                    'has_active_admin' => $activeAdminCount > 0,
                    // VMS-IMPROVEMENT-PLAN.md Phase A4 — one departure away
                    // from becoming a `has_active_admin: false` orphaned
                    // barangay (see GuardsLastAdmin, which blocks that
                    // departure from happening through the ordinary
                    // deactivate/role-change endpoints, but not e.g. the
                    // Admin simply leaving with no successor promoted).
                    'sole_active_admin' => $activeAdminCount === 1,
                    // Both one-line, already-loaded checks — no extra queries
                    // per row. A barangay can exist with neither yet: freshly
                    // added via storeBarangay() below, nobody's registered
                    // there, and no boundary polygon has been matched/drawn
                    // for it.
                    'has_boundary' => (bool) $b->boundary_present,
                    // Final stabilization — a real status instead of a bare
                    // boolean. 'needs_review' is derived from a pending match
                    // existing, not its own stored value, so there's exactly
                    // one place a boundary is "live" and one it's "proposed".
                    // A live outline only reads as 'verified' (reviewed) when it
                    // came from a confirmed upload naming its source document.
                    'boundary_status' => $b->pending_boundary !== null ? 'needs_review'
                        : ($b->boundary_present ? (BarangayGeography::isReviewedState($b->boundary_status, $b->boundary_source, $b->boundary_verified_by) ? 'verified' : 'needs_review') : $b->boundary_status),
                    'pending_boundary' => $b->pending_boundary,
                    'pending_boundary_source' => $b->pending_boundary_source,
                    // Dates the overview's "Review candidate boundary" items.
                    'updated_at' => $b->updated_at,
                ];
            });
    }

    /**
     * Server-side, paginated search over registered barangays nationwide,
     * for screens that must not pull every barangay into the browser.
     * Location filters use stable ids (and the PSGC region prefix), never
     * names, so same-named barangays in different cities stay distinct.
     */
    public function searchBarangays(Request $request)
    {
        $this->requireAbility($request, 'barangay.view_all', 'Only a Super Admin can perform this action.');
        $data = $request->validate($this->locationFilterRules() + [
            'q' => ['nullable', 'string', 'max:100'],
            'barangay_id' => ['nullable', 'integer'],
            'page' => ['nullable', 'integer', 'min:1'],
            'per_page' => ['nullable', 'integer', Rule::in([10, 25, 50])],
        ]);

        $query = $this->registeredLocations($data)
            ->select(['barangays.id', 'barangays.name', 'barangays.psgc_code', 'barangays.city_id', 'cities.name as located_city', 'cities.code as located_city_code', 'cities.province_id as located_province_id', 'provinces.name as located_province'])
            ->selectRaw('CASE WHEN barangays.boundary IS NULL THEN 0 ELSE 1 END AS boundary_present')
            ->selectRaw('CASE WHEN barangays.pending_boundary IS NULL THEN 0 ELSE 1 END AS pending_present');
        if (!empty($data['barangay_id'])) $query->where('barangays.id', $data['barangay_id']);
        if (($search = trim($data['q'] ?? '')) !== '') {
            $pattern = '%'.str_replace(['!', '%', '_'], ['!!', '!%', '!_'], mb_strtolower($search)).'%';
            $query->where(function ($query) use ($pattern) {
                foreach (['barangays.name', 'cities.name', 'provinces.name', 'barangays.psgc_code'] as $column) {
                    $query->orWhereRaw("LOWER({$column}) LIKE ? ESCAPE '!'", [$pattern]);
                }
            });
        }

        return $query->orderBy('barangays.name')->orderBy('cities.name')->orderBy('barangays.id')
            ->paginate($data['per_page'] ?? 25)->withQueryString()
            ->through(function ($b) {
                $region = PsgcRegions::codeForCity($b->located_city_code);

                return [
                    'id' => $b->id,
                    'name' => $b->name,
                    'psgc_code' => $b->psgc_code,
                    'city_id' => $b->city_id,
                    'city_name' => $b->located_city,
                    'province_id' => $b->located_province_id,
                    'province_name' => $b->located_province,
                    'region_code' => $region,
                    'region_name' => PsgcRegions::name($region),
                    'has_boundary' => (bool) $b->boundary_present,
                    'has_pending_boundary' => (bool) $b->pending_present,
                ];
            });
    }

    /**
     * Dependent Region > Province > City > Barangay choices, limited to
     * places that actually contain a registered barangay so no filter ever
     * leads to an empty list. Barangays are listed only within one city.
     */
    public function barangayLocations(Request $request)
    {
        $this->requireAbility($request, 'barangay.view_all', 'Only a Super Admin can perform this action.');
        $data = $request->validate($this->locationFilterRules());

        $rows = $this->registeredLocations([])
            ->get(['barangays.id', 'barangays.name', 'cities.id as located_city_id', 'cities.name as located_city', 'cities.code as located_city_code', 'provinces.id as located_province_id', 'provinces.name as located_province']);
        $regionOf = fn ($row) => PsgcRegions::codeForCity($row->located_city_code);
        $inRegion = fn ($row) => empty($data['region']) || $regionOf($row) === $data['region'];
        $inProvince = fn ($row) => $inRegion($row) && (empty($data['province_id']) || $row->located_province_id === (int) $data['province_id']);

        return response()->json([
            'regions' => $rows->map($regionOf)->filter()->unique()->sort()->values()
                ->map(fn ($code) => PsgcRegions::all()[$code] ?? ['code' => $code, 'name' => "Region {$code}", 'long_name' => "Region {$code}"])->values(),
            'provinces' => $rows->filter($inRegion)->unique('located_province_id')->sortBy('located_province')->values()
                ->map(fn ($row) => ['id' => $row->located_province_id, 'name' => $row->located_province, 'region_code' => $regionOf($row)]),
            'cities' => $rows->filter($inProvince)->unique('located_city_id')->sortBy('located_city')->values()
                ->map(fn ($row) => ['id' => $row->located_city_id, 'name' => $row->located_city, 'province_id' => $row->located_province_id]),
            'barangays' => empty($data['city_id']) ? [] : $rows->where('located_city_id', (int) $data['city_id'])->sortBy('name')->values()
                ->map(fn ($row) => ['id' => $row->id, 'name' => $row->name]),
        ]);
    }

    private function locationFilterRules(): array
    {
        return [
            'region' => ['nullable', 'regex:/^\d{2}$/'],
            'province_id' => ['nullable', 'integer'],
            'city_id' => ['nullable', 'integer'],
        ];
    }

    private function registeredLocations(array $filters)
    {
        $query = Barangay::registered()
            ->join('cities', 'cities.id', '=', 'barangays.city_id')
            ->leftJoin('provinces', 'provinces.id', '=', 'cities.province_id');
        if (!empty($filters['region'])) $query->where('cities.code', 'like', $filters['region'].'%');
        if (!empty($filters['province_id'])) $query->where('cities.province_id', $filters['province_id']);
        if (!empty($filters['city_id'])) $query->where('barangays.city_id', $filters['city_id']);

        return $query;
    }

    /**
     * Provisions an existing PSA PSGC reference barangay.  This intentionally
     * accepts no free-text name and never calls a geocoder: a boundary is
     * selected solely by its official PSGC identity, or remains unavailable.
     */
    public function storeBarangay(Request $request)
    {
        $this->requireAbility($request, 'barangay.create', 'Only a Super Admin can perform this action.');

        $data = $request->validate([
            'city_id' => ['required', 'exists:cities,id'],
            'barangay_id' => ['required', 'integer', 'exists:barangays,id'],
        ]);
        $barangay = Barangay::with('city.province')->findOrFail($data['barangay_id']);
        abort_unless($barangay->city_id === (int) $data['city_id'] && $barangay->psgc_code,
            422, 'Select an official PSGC barangay belonging to the selected city or municipality.');
        $barangay->load('city.province');
        app(BarangayGeography::class)->attachBoundary($barangay);
        $barangay->update(['provisioned_at' => $barangay->provisioned_at ?? now()]);
        $barangay->refresh();
        $barangay->loadCount(['users', 'users as active_admin_count' => fn ($query) => $query->havingRole('Admin')->where('is_active', true)]);

        $this->log($request, 'Add', "Added barangay {$barangay->name} ({$barangay->city?->name}).");

        return response()->json([
            'id' => $barangay->id,
            'name' => $barangay->name,
            'city_name' => $barangay->city?->name,
            'province_name' => $barangay->city?->province?->name,
            'staff_count' => $barangay->users_count,
            'has_active_admin' => $barangay->active_admin_count > 0,
            'sole_active_admin' => $barangay->active_admin_count === 1,
            'psgc_code' => $barangay->psgc_code,
            'has_boundary' => $barangay->boundary !== null,
            'boundary_status' => $this->boundaryStatus($barangay),
            'pending_boundary' => $barangay->pending_boundary,
            'pending_boundary_source' => $barangay->pending_boundary_source,
        ], 201);
    }

    /**
     * Re-checks the code-matched PSA/NAMRIA reference bundle. No geocoder,
     * name matching, generated geometry, or fallback barangay is permitted.
     */
    public function refreshBarangayBoundary(Request $request, Barangay $barangay)
    {
        $this->requireAbility($request, 'barangay.refresh_boundary', 'Only a Super Admin can perform this action.');

        $barangay->load('city');
        app(BarangayGeography::class)->attachBoundary($barangay);
        $barangay->refresh();
        $found = $barangay->boundary !== null;
        if (!$found) $barangay->update(['boundary_status' => 'not_found']);

        return response()->json([
            'has_boundary' => $found,
            'boundary_status' => $this->boundaryStatus($barangay),
            'pending_boundary' => $barangay->pending_boundary,
            'pending_boundary_source' => $barangay->pending_boundary_source,
        ]);
    }

    /**
     * Final stabilization (§33.2/§33.6) — the Super Admin's explicit
     * acceptance of a `pending_boundary` candidate. This is the ONLY place
     * `boundary` is ever written to from a geocoder result; nothing upstream
     * auto-confirms. Logged with before/after so a boundary's provenance is
     * always answerable later.
     */
    public function uploadBoundaryCandidate(Request $request, Barangay $barangay)
    {
        $this->requireAbility($request, 'barangay.refresh_boundary', 'Only a Super Admin can perform this action.');
        $data = $request->validate([
            'geojson' => ['required', 'array'],
            'source' => ['required', 'string', 'max:200'],
            'psgc_code' => ['nullable', 'string'],
        ]);
        abort_unless(($data['psgc_code'] ?? null) === $barangay->psgc_code, 422, 'The selected barangay code does not match.');
        $feature = $data['geojson'];
        if (($feature['type'] ?? null) === 'FeatureCollection') {
            abort_unless(is_array($feature['features'] ?? null) && array_is_list($feature['features']) && count($feature['features']) === 1 && is_array($feature['features'][0]), 422, 'Choose a file containing exactly one barangay feature.');
            $feature = $feature['features'][0];
        }
        if (($feature['type'] ?? null) === 'Feature') {
            $properties = is_array($feature['properties'] ?? null) ? $feature['properties'] : [];
            foreach (['psgc_code', 'psgc_10d', 'psgc', 'ADM4_PCODE', 'adm4_pcode'] as $key) {
                if (!isset($properties[$key])) continue;
                // COD-AB style codes carry a "PH" prefix; compare digits only.
                $code = preg_replace('/\D/', '', (string) $properties[$key]);
                abort_if($code !== (string) $barangay->psgc_code, 422, 'The GeoJSON feature belongs to a different barangay.');
            }
            $geometry = $feature['geometry'] ?? [];
        } else {
            $geometry = $feature;
        }
        abort_unless(is_array($geometry) && in_array($geometry['type'] ?? null, ['Polygon', 'MultiPolygon'], true) && self::isUsableGeometry($geometry), 422, 'Provide a valid, closed Polygon or MultiPolygon, including valid holes.');
        abort_unless(self::holesInsideShells($geometry), 422, 'Every hole must lie inside its outer ring.');
        // Coarse location sanity check: the outline must sit within ~5km of
        // the municipality's bundled reference extent. Skipped when no
        // reference shard exists for the city.
        $barangay->loadMissing('city');
        $extent = app(BarangayGeography::class)->cityExtent($barangay);
        if ($extent !== null) {
            $candidate = BarangayGeography::extendExtent(null, $geometry);
            $margin = 0.05;
            abort_if($candidate[2] < $extent[0] - $margin || $candidate[0] > $extent[2] + $margin || $candidate[3] < $extent[1] - $margin || $candidate[1] > $extent[3] + $margin,
                422, "The outline does not fall within {$barangay->city?->name}. Check that the file uses WGS84 longitude, latitude coordinates.");
        }
        $source = BarangayGeography::UPLOADED_SOURCE_PREFIX.trim($data['source']);
        \Illuminate\Support\Facades\DB::transaction(function () use ($barangay, $geometry, $source, $request) {
            $barangay->update(['pending_boundary' => $geometry, 'pending_boundary_source' => $source]);
            $this->log($request, 'Edit', "Uploaded a replacement boundary for {$barangay->name} (PSGC {$barangay->psgc_code}); source: {$source}; awaiting confirmation.");
        });
        return response()->json(['pending_boundary' => $geometry, 'pending_boundary_source' => $source, 'boundary_status' => 'needs_review']);
    }

    public function confirmBarangayBoundary(Request $request, Barangay $barangay)
    {
        $this->requireAbility($request, 'barangay.refresh_boundary', 'Only a Super Admin can perform this action.');

        abort_if($barangay->pending_boundary === null, 422, 'There is no candidate boundary waiting for review on this barangay.');

        $barangay->load('city');
        $source = $barangay->pending_boundary_source;
        // Only an uploaded file that names its source document can become a
        // reviewed (containment-enforcing) boundary. A geocoder or imported
        // reference candidate is applied as the live outline but stays
        // unverified: OSM/reference geometry is not legal boundary evidence.
        // The applying admin is still recorded so automatic refreshes keep
        // preserving the outline they chose.
        $reviewed = is_string($source) && str_starts_with($source, BarangayGeography::UPLOADED_SOURCE_PREFIX);

        $barangay->update([
            'boundary' => $barangay->pending_boundary,
            'boundary_status' => $reviewed ? 'verified' : 'needs_review',
            'boundary_source' => $source,
            'boundary_verified_at' => now(),
            'boundary_verified_by' => $request->user()->id,
            'pending_boundary' => null,
            'pending_boundary_source' => null,
        ]);

        $this->log($request, 'Edit', $reviewed
            ? "Confirmed the reviewed boundary for barangay {$barangay->name} ({$barangay->city?->name}) — source: {$source}."
            : "Applied an unverified reference outline for barangay {$barangay->name} ({$barangay->city?->name}) — source: {$source}.");

        return response()->json(['has_boundary' => true, 'boundary_status' => $reviewed ? 'verified' : 'needs_review']);
    }

    /**
     * Rejects a `pending_boundary` candidate without touching `boundary` —
     * e.g. the Super Admin looked at the map preview and it's visibly wrong.
     * Leaves the barangay exactly where it was before the lookup that
     * produced it (still 'not_found' if nothing was confirmed before).
     */
    public function discardPendingBoundary(Request $request, Barangay $barangay)
    {
        $this->requireAbility($request, 'barangay.refresh_boundary', 'Only a Super Admin can perform this action.');

        abort_if($barangay->pending_boundary === null, 422, 'There is no candidate boundary waiting for review on this barangay.');

        $barangay->load('city');
        $barangay->update([
            'pending_boundary' => null,
            'pending_boundary_source' => null,
            'boundary_status' => $barangay->boundary !== null ? (app(BarangayGeography::class)->isReviewed($barangay) ? 'verified' : 'needs_review') : 'not_found',
        ]);

        $this->log($request, 'Edit', "Discarded a candidate boundary for barangay {$barangay->name} ({$barangay->city?->name}) — did not match.");

        return response()->json(['message' => 'Candidate boundary discarded.']);
    }

    /**
     * Asks OpenStreetMap's public Nominatim geocoder for a boundary polygon
     * matching "<barangay>, <city>, Philippines" — free, no API key, but
     * rate-limited to ~1 req/sec and requires an identifying User-Agent per
     * its usage policy (https://operations.osmfoundation.org/policies/nominatim/).
     * Fine for this: one lookup per barangay actually added, never a bulk
     * operation. Coverage isn't guaranteed for every barangay in the
     * country — returns null (silently — this must never block a barangay
     * from being created) whenever nothing usable comes back.
     *
     * Nominatim's free-text ranking isn't trustworthy enough to take its
     * first "administrative boundary" hit as-is: PH barangay names repeat
     * constantly nationwide (there are dozens of "San Isidro"s, "Poblacion"s,
     * "San Roque"s...), and `class=boundary`/`type=administrative` matches
     * ANY admin tier — barangay, city/municipality, province, or region —
     * not specifically the barangay. Left unchecked, that silently attaches
     * a same-named barangay's polygon from a different province, or the
     * whole containing city's/province's polygon, to this barangay. So every
     * candidate is cross-checked against its own `address` breakdown before
     * being trusted: it must resolve to the requested city, and it must
     * actually name the barangay at barangay-level granularity — not just
     * be a match on the city/province. No match surviving that means no
     * boundary, same as if the lookup had found nothing at all.
     */
    private function lookupBoundary(string $barangayName, ?string $cityName): ?array
    {
        if (!$cityName) {
            return null;
        }

        // Two phrasings, tried in order until one produces a validated match.
        // OSM contributors are inconsistent about whether a barangay relation
        // is named "San Isidro" or "Barangay San Isidro" — plain free-text
        // search sometimes ranks the bare form above the "Barangay "-prefixed
        // one for the same place (or vice versa) depending on what else on
        // OSM shares that name, so both are worth a try before giving up.
        $queries = [
            "{$barangayName}, {$cityName}, Philippines",
            "Barangay {$barangayName}, {$cityName}, Philippines",
        ];

        foreach ($queries as $i => $query) {
            // Nominatim's usage policy caps this at ~1 req/sec; only the
            // fallback attempt needs a beat before it, since it only runs
            // when the first request has already returned.
            if ($i > 0) {
                usleep(1_000_000);
            }

            $geojson = $this->lookupBoundaryForQuery($query, $barangayName, $cityName);
            if ($geojson) {
                return $geojson;
            }
        }

        return null;
    }

    private function lookupBoundaryForQuery(string $query, string $barangayName, string $cityName): ?array
    {
        try {
            $response = Http::withHeaders(['User-Agent' => 'BarangayVMS/1.0 (https://github.com/ORozCo11/Dev_Paul)'])
                ->timeout(6)
                ->get('https://nominatim.openstreetmap.org/search', [
                    'format' => 'json',
                    'polygon_geojson' => 1,
                    'addressdetails' => 1,
                    'countrycodes' => 'ph',
                    'limit' => 5,
                    'q' => $query,
                ]);

            if (!$response->successful()) {
                return null;
            }

            $normalizedCity = self::normalizeForMatch($cityName);
            $normalizedBarangay = self::normalizeForMatch($barangayName);

            foreach ($response->json() ?? [] as $result) {
                // Only trust an actual administrative boundary relation — anything
                // else (a barangay hall, a health center, a POI) can still carry a
                // Polygon/MultiPolygon geojson but it's the shape of a building, not
                // the barangay's territory, and would draw the wrong line on the map.
                if (($result['class'] ?? null) !== 'boundary' || ($result['type'] ?? null) !== 'administrative') {
                    continue;
                }

                $geojson = $result['geojson'] ?? null;
                if (!in_array($geojson['type'] ?? null, ['Polygon', 'MultiPolygon'], true)) {
                    continue;
                }
                if (!self::isUsableGeometry($geojson)) {
                    continue;
                }

                // Reject anything outside the requested city — a same-named
                // barangay elsewhere in the country must not be accepted just
                // because it ranked in the top 5 results.
                $address = $result['address'] ?? [];
                $resultCity = $address['city'] ?? $address['municipality'] ?? $address['town'] ?? null;
                if (!$resultCity || self::normalizeForMatch($resultCity) !== $normalizedCity) {
                    continue;
                }

                // Reject a match that's actually the whole city/municipality
                // (or province) rather than the barangay itself — too coarse
                // to draw as one barangay's territory. A genuine barangay-
                // level match names the barangay somewhere in its own
                // address breakdown (OSM tags it as village/suburb/quarter/
                // neighbourhood/city_district depending on how it was mapped).
                $barangayLevelNames = array_filter([
                    $address['village'] ?? null,
                    $address['suburb'] ?? null,
                    $address['quarter'] ?? null,
                    $address['neighbourhood'] ?? null,
                    $address['city_district'] ?? null,
                ]);
                $matchesBarangay = false;
                foreach ($barangayLevelNames as $candidate) {
                    if (self::normalizeForMatch($candidate) === $normalizedBarangay) {
                        $matchesBarangay = true;
                        break;
                    }
                }
                if (!$matchesBarangay) {
                    continue;
                }

                return $geojson;
            }

            return null;
        } catch (\Throwable $e) {
            Log::warning("Boundary lookup failed for {$barangayName}, {$cityName} (query \"{$query}\"): {$e->getMessage()}");
            return null;
        }
    }

    /**
     * Same normalization BarangayBoundarySeeder uses to match the Mandaue
     * boundary file's names against seeded rows — strip everything but
     * letters/digits and lowercase, so "Centro (Poblacion)" vs "Centro",
     * "Pakna-an" vs "Paknaan", casing, and stray whitespace never cause a
     * real match to be rejected.
     */
    private static function normalizeForMatch(string $name): string
    {
        return strtolower(preg_replace('/[^a-z0-9]/i', '', $name));
    }

    /**
     * Final stabilization — a geocoder response succeeding at the HTTP level
     * (and even passing the class/type/address-match checks above) doesn't
     * guarantee the geometry itself is usable: a degenerate ring (too few
     * points, not closed) or non-numeric coordinates would still draw
     * garbage on the map. Checks every shell and hole for closure, nonzero
     * area and finite geographic coordinates. This is basic validation,
     * not a cadastral or full topological validation of the uploaded data.
     */
    private static function isUsableGeometry(array $geojson): bool
    {
        if (!is_array($geojson['coordinates'] ?? null) || !array_is_list($geojson['coordinates'])) return false;
        $polygons = $geojson['type'] === 'MultiPolygon' ? ($geojson['coordinates'] ?? []) : [$geojson['coordinates'] ?? null];

        $points = 0;
        foreach ($polygons as $polygon) {
            if (!is_array($polygon) || !array_is_list($polygon) || !$polygon) return false;
            foreach ($polygon as $ring) {
                if (!self::isUsableRing($ring)) return false;
                $points += count($ring);
                if ($points > 50000) return false;
            }
        }

        return !empty($polygons);
    }

    /** Each hole's vertices must lie inside, or on, its polygon's outer ring. */
    private static function holesInsideShells(array $geojson): bool
    {
        $polygons = $geojson['type'] === 'MultiPolygon' ? $geojson['coordinates'] : [$geojson['coordinates']];
        foreach ($polygons as $polygon) {
            foreach (array_slice($polygon, 1) as $hole) {
                foreach ($hole as $point) {
                    $x = (float) $point[0];
                    $y = (float) $point[1];
                    if (!BarangayGeography::ringContains($polygon[0], $x, $y) && !self::onRing($polygon[0], $x, $y)) {
                        return false;
                    }
                }
            }
        }
        return true;
    }

    private static function onRing(array $ring, float $x, float $y): bool
    {
        $epsilon = 1e-9;
        for ($i = 1; $i < count($ring); $i++) {
            [$ax, $ay] = $ring[$i - 1];
            [$bx, $by] = $ring[$i];
            $cross = ($bx - $ax) * ($y - $ay) - ($by - $ay) * ($x - $ax);
            if (abs($cross) <= $epsilon && $x >= min($ax, $bx) - $epsilon && $x <= max($ax, $bx) + $epsilon
                && $y >= min($ay, $by) - $epsilon && $y <= max($ay, $by) + $epsilon) {
                return true;
            }
        }
        return false;
    }

    private static function isUsableRing($ring): bool
    {
        if (!is_array($ring) || !array_is_list($ring) || count($ring) < 4) {
            return false;
        }

        foreach ($ring as $point) {
            if (!is_array($point) || !array_is_list($point) || count($point) < 2 || !(is_int($point[0]) || is_float($point[0])) || !(is_int($point[1]) || is_float($point[1])) || !is_finite((float) $point[0]) || !is_finite((float) $point[1]) || abs($point[0]) > 180 || abs($point[1]) > 90) {
                return false;
            }
        }

        $first = $ring[0];
        $last = $ring[count($ring) - 1];
        $area = 0;
        for ($i = 1; $i < count($ring); $i++) $area += $ring[$i - 1][0] * $ring[$i][1] - $ring[$i][0] * $ring[$i - 1][1];
        return $area != 0 && (float) $first[0] === (float) $last[0] && (float) $first[1] === (float) $last[1];
    }

    /**
     * Every user, across every barangay — the one screen in the whole
     * system where that's true. Search matches name or email.
     */
    public function users(Request $request)
    {
        $this->requireAbility($request, 'user.view_all_platform', 'Only a Super Admin can perform this action.');

        $query = User::with(['barangay.city.province', 'roleRows']);
        if ($city = $request->user()->city_id) {
            $query->whereHas('barangay', fn ($q) => $q->where('city_id', $city));
        }

        if ($request->filled('q')) {
            // Escape LIKE wildcards so "%" and "_" match literally, same as activityLog().
            $pattern = '%'.str_replace(['!', '%', '_'], ['!!', '!%', '!_'], (string) $request->string('q')).'%';
            $query->where(fn ($q) => $q->whereRaw("name LIKE ? ESCAPE '!'", [$pattern])->orWhereRaw("email LIKE ? ESCAPE '!'", [$pattern]));
        }

        return $query->orderBy('name')->get()->map(fn ($u) => [
            'id' => $u->id,
            'name' => $u->name,
            'email' => $u->email,
            'role' => $u->role,
            'roles' => $u->roles,
            'is_active' => $u->is_active,
            'approved_at' => $u->approved_at,
            'account_status' => InvitationService::statusOf($u),
            'barangay_id' => $u->barangay_id,
            'barangay_name' => $u->barangay?->name,
            'city_name' => $u->barangay?->city?->name,
            'province_name' => $u->barangay?->city?->province?->name,
        ]);
    }

    /** A plain message from the Super Admin to any account. */
    public function emailUser(Request $request, User $user)
    {
        $this->requireAbility($request, 'user.email_platform', 'Only a Super Admin can perform this action.');
        $data = $request->validate([
            'subject' => ['required', 'string', 'max:150'],
            'message' => ['required', 'string', 'max:5000'],
        ]);

        $this->sendMail($user, new AccountMail($user, $data['subject'], 'message', ['body' => $data['message']]));
        $this->log($request, 'Edit', "Emailed {$user->name} ({$user->email}): {$data['subject']}");

        return response()->json(['message' => "Email sent to {$user->email}."]);
    }

    /**
     * An LGU Super Admin (one with a city) only manages barangays of that city. An unassigned legacy Super
     * Admin (no city on the account) keeps the old platform-wide reach until the account is provisioned.
     */
    private function requireLguScope(Request $request, ?Barangay $barangay): void
    {
        $city = $request->user()->city_id;
        abort_if($city && (! $barangay || (int) $barangay->city_id !== (int) $city), 404);
    }

    /** Barangay Admin accounts only: the Super Admin never touches Custodians, mechanics or other Super Admins here. */
    private function requireManagedAdmin(Request $request, User $user): void
    {
        abort_unless($user->role === 'Admin' && $user->barangay_id, 404);
        $this->requireLguScope($request, $user->barangay);
    }

    /** Invites the one Admin of a barangay by email. The recipient sets their own password. */
    public function storeAdmin(Request $request, Barangay $barangay)
    {
        $this->requireAbility($request, 'user.create_admin_platform', 'Only a Super Admin can perform this action.');
        $this->requireLguScope($request, $barangay);
        $data = $request->validate([
            'name' => ['required', 'string', 'max:255'],
            'email' => ['required', 'email', 'max:255', 'unique:users,email'],
            'phone' => ['nullable', 'string', 'regex:/^09[0-9]{9}$/'],
        ], ['phone.regex' => 'Phone number must be 11 digits starting with 09 (e.g. 09171234567).']);
        abort_if(
            User::where('barangay_id', $barangay->id)->havingRole('Admin')->exists(),
            422,
            "Barangay {$barangay->name} already has an Admin (or a pending invitation). A barangay can only have one Admin."
        );

        [$admin, $emailed] = app(InvitationService::class)->invite(
            $request->user(), $data['name'], $data['email'], 'Admin', $barangay->id, $barangay->city_id,
            array_filter(['phone' => $data['phone'] ?? null], fn ($v) => $v !== null),
        );
        $this->markProvisioned($barangay);

        return response()->json(['id' => $admin->id, 'name' => $admin->name, 'email' => $admin->email, 'email_sent' => $emailed, 'account_status' => InvitationService::statusOf($admin)], 201);
    }

    /** Barangay-first directory for the Users page: per barangay, Admin counts by status. */
    public function barangayDirectory(Request $request)
    {
        $this->requireAbility($request, 'user.view_all_platform', 'Only a Super Admin can perform this action.');
        $city = $request->user()->city_id;

        return Barangay::with('city.province')->registered()
            ->when($city, fn ($q) => $q->where('city_id', $city))
            ->orderBy('name')->get()
            ->map(function ($b) {
                $admins = User::where('barangay_id', $b->id)->where('role', 'Admin')->get()->map(fn ($u) => InvitationService::statusOf($u));

                return [
                    'id' => $b->id, 'name' => $b->name, 'city_name' => $b->city?->name, 'province_name' => $b->city?->province?->name,
                    'admin_count' => $admins->count(),
                    'active_count' => $admins->filter(fn ($s) => $s === 'active')->count(),
                    'pending_count' => $admins->filter(fn ($s) => $s === 'pending_invitation')->count(),
                    'expired_count' => $admins->filter(fn ($s) => $s === 'invitation_expired')->count(),
                    'disabled_count' => $admins->filter(fn ($s) => $s === 'disabled')->count(),
                ];
            })->values();
    }

    /** The Admin accounts of one barangay, with status. */
    public function barangayAdmins(Request $request, Barangay $barangay)
    {
        $this->requireAbility($request, 'user.view_all_platform', 'Only a Super Admin can perform this action.');
        $this->requireLguScope($request, $barangay);

        return User::with('roleRows')->where('barangay_id', $barangay->id)->where('role', 'Admin')->orderBy('name')->get()
            ->map(fn ($u) => ['id' => $u->id, 'name' => $u->name, 'email' => $u->email, 'role' => $u->role, 'is_active' => $u->is_active,
                'activated_at' => $u->activated_at, 'account_status' => InvitationService::statusOf($u)]);
    }

    /** New invitation (pending/expired Admin) or password-reset link (active Admin). */
    public function resendCredentials(Request $request, User $user)
    {
        $this->requireAbility($request, 'user.create_admin_platform', 'Only a Super Admin can perform this action.');
        abort_if($user->id === $request->user()->id, 422, 'Use Change Password for your own account.');
        $this->requireManagedAdmin($request, $user);

        $pending = $user->activated_at === null;
        $emailed = app(InvitationService::class)->issue($user, $request->user(), $pending ? 'invite' : 'reset');
        $this->log($request, 'Edit', ($pending ? 'Resent the invitation to ' : 'Sent a password-reset link to ') . "{$user->name} ({$user->email}).");

        return response()->json(['email_sent' => $emailed, 'email' => $user->email, 'account_status' => InvitationService::statusOf($user->fresh())]);
    }

    public function revokeInvitation(Request $request, User $user)
    {
        $this->requireAbility($request, 'user.create_admin_platform', 'Only a Super Admin can perform this action.');
        $this->requireManagedAdmin($request, $user);
        abort_if($user->activated_at !== null, 422, 'This account is already active. Disable it instead.');

        app(InvitationService::class)->revoke($request->user(), $user);

        return response()->json(['message' => 'Invitation revoked.', 'account_status' => InvitationService::statusOf($user->fresh())]);
    }

    public function reactivateUser(Request $request, User $user)
    {
        $this->requireAbility($request, 'user.deactivate_platform', 'Only a Super Admin can perform this action.');
        $this->requireManagedAdmin($request, $user);
        abort_if($user->activated_at === null, 422, 'This person has not accepted their invitation yet. Resend the invitation instead.');

        $user->update(['is_active' => true]);
        $this->log($request, 'Activate', "Reactivated {$user->name} ({$user->email}).");

        return response()->json(['message' => 'User reactivated.']);
    }

    private function sendMail(User $user, AccountMail $mail): void
    {
        try {
            Mail::to($user->email)->send($mail);
        } catch (\Throwable $e) {
            report($e);
            abort(502, 'The email could not be sent. Check the mail settings and try again.');
        }
    }

    public function deactivateUser(Request $request, User $user)
    {
        $this->requireAbility($request, 'user.deactivate_platform', 'Only a Super Admin can perform this action.');
        abort_if($user->id === $request->user()->id, 422, 'You cannot deactivate your own account.');
        $this->requireManagedAdmin($request, $user);
        $this->abortIfLastActiveAdmin($user, 'deactivating them');
        $this->abortIfHasOpenWork($user, 'deactivating them');

        $user->update(['is_active' => false]);
        $user->tokens()->delete();
        $this->log($request, 'Deactivate', "Deactivated {$user->name} ({$user->email}).");

        return response()->json(['message' => 'User deactivated.']);
    }

    /**
     * Change a user's role — also how an orphaned barangay gets recovered:
     * pick an existing user there and set their role to Admin.
     */
    public function updateUserRole(Request $request, User $user)
    {
        $this->requireAbility($request, 'user.change_role_platform', 'Only a Super Admin can perform this action.');
        abort_if($user->id === $request->user()->id, 422, 'You cannot change your own role.');
        abort_if($user->hasRole('Super Admin'), 422, 'Super Admin roles cannot be changed through this endpoint.');
        abort_if($user->hasRole('Impersonator'), 422, 'The dedicated impersonation account cannot be converted to a barangay staff account.');

        $data = $request->validate([
            'role' => ['required', Rule::in(self::ROLES)],
            'preserve_roles' => ['sometimes', 'boolean'],
        ]);
        abort_if($request->boolean('preserve_roles') && $data['role'] !== 'Admin', 422, 'Existing roles can only be preserved when promoting an Administrator.');
        // Orphan recovery is the one exception to one-role-per-account: a Custodian or mechanic with open
        // work who is promoted to Admin keeps the old role until that work is finished.
        $roles = $request->boolean('preserve_roles') ? array_values(array_unique([...$user->allRoles(), 'Admin'])) : [$data['role']];

        if ($data['role'] !== 'Admin') {
            $this->abortIfLastActiveAdmin($user, 'changing their role');
        }

        $this->abortIfHasOpenWork($user, 'changing their roles', $roles);

        $user->update(['role' => $data['role'], 'roles' => $roles]);
        $this->log($request, 'Edit', "Changed {$user->name}'s roles to ".implode(', ', $roles)." (primary: {$data['role']}).");

        return $user->fresh('roleRows');
    }

    /**
     * Unscoped by design — BelongsToBarangay's global scope only narrows a
     * query when the VIEWER has a barangay_id, which a Super Admin never
     * does. Every barangay's own Admin still only ever sees their own
     * barangay's entries through the same model, unchanged.
     *
     * Restricted to ACCOUNT_MODULES so fleet-detail entries (vehicles,
     * tickets, maintenance, etc.) logged by FleetController/TicketController
     * never leak through this endpoint — see this class's docblock.
     */
    public function activityLog(Request $request)
    {
        $this->requireAbility($request, 'activity_log.view_platform', 'Only a Super Admin can perform this action.');

        $data = $request->validate([
            'q' => ['nullable', 'string', 'max:200'],
            'scope' => ['nullable', Rule::in(['all', 'superadmin'])],
            'page' => ['nullable', 'integer', 'min:1'],
            'per_page' => ['nullable', 'integer', Rule::in([25, 50, 100])],
        ]);
        $query = ActivityLog::with('user')->whereIn('module', self::ACCOUNT_MODULES);
        if (($data['scope'] ?? 'all') === 'superadmin') $query->where('module', 'Super Admin');
        if (($search = trim($data['q'] ?? '')) !== '') {
            $pattern = '%'.str_replace(['!', '%', '_'], ['!!', '!%', '!_'], mb_strtolower($search)).'%';
            $query->where(function ($query) use ($pattern) {
                foreach (['role', 'action', 'module', 'details'] as $column) $query->orWhereRaw("LOWER({$column}) LIKE ? ESCAPE '!'", [$pattern]);
                $query->orWhereHas('user', fn ($user) => $user->whereRaw("LOWER(name) LIKE ? ESCAPE '!'", [$pattern]));
            });
        }
        $query->latest('log_id');
        // Keep the legacy array response for existing integrations. The portal
        // requests pagination so search covers the complete authorized history.
        if ($request->boolean('paginate')) return $query->paginate($data['per_page'] ?? 25)->withQueryString();
        return $query->limit(200)->get();
    }

    // A Super Admin issuing a code onboards that barangay onto the platform.
    private function markProvisioned(Barangay $barangay): void
    {
        if ($barangay->provisioned_at === null) {
            $barangay->update(['provisioned_at' => now()]);
        }
    }

    private function boundaryStatus(Barangay $barangay): string
    {
        if ($barangay->pending_boundary !== null) return 'needs_review';
        if ($barangay->boundary === null) return 'not_found';
        return app(BarangayGeography::class)->isReviewed($barangay) ? 'verified' : 'needs_review';
    }

    /**
     * Public "Report a Concern" submissions from the Support Center page —
     * a barangay that looks unmanaged, or a suspected fake-staff account.
     * This is the inbox that closes the loop: the Super Admin reads a
     * report here, then acts using the tools above (promote/recover a
     * barangay, deactivate a suspicious account) and marks it resolved.
     */
    public function concernReports(Request $request)
    {
        $this->requireAbility($request, 'concern_report.view', 'Only a Super Admin can perform this action.');

        // Deleted reports are included (with deleted_at) for Concern History.
        return ConcernReport::withTrashed()->with('resolvedBy')->latest('id')->get();
    }

    public function resolveConcernReport(Request $request, ConcernReport $concernReport)
    {
        $this->requireAbility($request, 'concern_report.resolve', 'Only a Super Admin can perform this action.');

        $concernReport->update([
            'status' => 'Resolved',
            'resolved_by' => $request->user()->id,
            'resolved_at' => now(),
        ]);
        $this->log($request, 'Edit', "Marked concern report #{$concernReport->id} resolved.");

        return $concernReport->fresh('resolvedBy');
    }

    public function reopenConcernReport(Request $request, ConcernReport $concernReport)
    {
        $this->requireAbility($request, 'concern_report.reopen', 'Only a Super Admin can perform this action.');

        $concernReport->update(['status' => 'Open', 'resolved_by' => null, 'resolved_at' => null]);
        $this->log($request, 'Edit', "Reopened concern report #{$concernReport->id}.");

        return $concernReport->fresh();
    }

    /**
     * Moves a concern report to Concern History — the way to clear out
     * obvious spam. It is a soft delete, so a report deleted by mistake can
     * be restored (restoreConcernReport). Submission is already rate-limited
     * (see /concern-reports in routes/api.php); this is the cleanup side.
     */
    public function destroyConcernReport(Request $request, ConcernReport $concernReport)
    {
        $this->requireAbility($request, 'concern_report.delete', 'Only a Super Admin can perform this action.');

        $concernReport->delete();
        $this->log($request, 'Delete', "Deleted concern report #{$concernReport->id} (recoverable from Concern History).");

        return $concernReport->fresh('resolvedBy');
    }

    /**
     * Emails the reporter back: "acknowledge" when the concern is received
     * and being looked into, "resolved" once it has been handled. Only works
     * when the reporter left an email address (the contact field is optional
     * and may hold a phone number instead).
     */
    public function emailConcernReporter(Request $request, ConcernReport $concernReport)
    {
        $this->requireAbility($request, 'concern_report.email', 'Only a Super Admin can perform this action.');
        $data = $request->validate([
            'kind' => ['required', Rule::in(['acknowledge', 'resolved'])],
            'subject' => ['required', 'string', 'max:150'],
            'message' => ['required', 'string', 'max:5000'],
        ]);
        $email = trim((string) $concernReport->reporter_contact);
        abort_unless(filter_var($email, FILTER_VALIDATE_EMAIL), 422, 'This reporter did not leave an email address, so they cannot be emailed.');
        $sentColumn = $data['kind'] === 'resolved' ? 'resolved_email_at' : 'acknowledged_email_at';
        abort_if($concernReport->{$sentColumn}, 409, $data['kind'] === 'resolved' ? 'The resolution email for this concern has already been sent.' : 'A reply for this concern has already been sent.');

        try {
            $sent = Mail::to($email)->send(new ConcernReplyMail($concernReport, $data['subject'], $data['message'], $data['kind'] === 'resolved'));
            // Delivery trail: the Message-ID lets a missing email be found in the sender's Gmail (Sent, or a bounce).
            \Illuminate\Support\Facades\Log::info("Concern #{$concernReport->id} reply emailed to {$email}", ['message_id' => $sent?->getMessageId(), 'subject' => $data['subject'], 'smtp' => preg_match('/< (250 2\.0\.0[ -~]*)/', (string) $sent?->getDebug(), $m) ? $m[1] : null]);
        } catch (\Throwable $e) {
            report($e);
            abort(502, 'The email could not be sent. Check the mail settings and try again.');
        }

        $concernReport->update([$sentColumn => now()]);
        $this->log($request, 'Edit', "Emailed the reporter of concern report #{$concernReport->id} ({$email}): {$data['subject']}");

        return response()->json(['message' => "Email sent to {$email}.", 'report' => $concernReport->fresh('resolvedBy')]);
    }

    /** Brings a deleted concern report back to the open concerns. */
    public function restoreConcernReport(Request $request, int $concernReport)
    {
        $this->requireAbility($request, 'concern_report.reopen', 'Only a Super Admin can perform this action.');

        $report = ConcernReport::onlyTrashed()->findOrFail($concernReport);
        $report->restore();
        $report->update(['status' => 'Open', 'resolved_by' => null, 'resolved_at' => null]);
        $this->log($request, 'Edit', "Restored deleted concern report #{$report->id} to open concerns.");

        return $report->fresh('resolvedBy');
    }
}
