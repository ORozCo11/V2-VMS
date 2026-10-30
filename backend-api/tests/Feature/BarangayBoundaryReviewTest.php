<?php

namespace Tests\Feature;

use App\Models\Barangay;
use App\Models\City;
use App\Models\Province;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * Final stabilization (§33) — a boundary match from the public geocoder is
 * no longer auto-saved. It lands in `pending_boundary` for the Super Admin
 * to review on a map and explicitly confirm; `boundary` is only ever
 * written by confirmBarangayBoundary(). Also covers the geometry sanity
 * check that rejects a degenerate (too-short/unclosed) ring before it's
 * even offered for review.
 */
class BarangayBoundaryReviewTest extends TestCase
{
    use RefreshDatabase;

    private User $superAdmin;

    protected function setUp(): void
    {
        parent::setUp();
        $this->superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin']]);
    }

    private function barangay(): Barangay
    {
        $province = Province::create(['code' => 'TST', 'name' => 'Test Province']);
        $city = City::create(['province_id' => $province->id, 'code' => 'TSTC', 'name' => 'Test City']);

        return Barangay::create(['name' => 'Test Barangay', 'city_id' => $city->id]);
    }

    private function validRing(): array
    {
        // A closed square — 4 distinct corners plus the repeated first point.
        return [[123.9, 10.3], [123.91, 10.3], [123.91, 10.31], [123.9, 10.31], [123.9, 10.3]];
    }

    #[Test]
    public function uploaded_boundary_requires_confirmation_and_preserves_the_previous_geometry(): void
    {
        $barangay = $this->barangay();
        $barangay->update(['psgc_code' => '0702222024', 'boundary' => ['type' => 'Polygon', 'coordinates' => [$this->validRing()]]]);
        $old = $barangay->fresh()->boundary;
        $replacement = ['type' => 'Polygon', 'coordinates' => [[[123.45, 9.81], [123.47, 9.81], [123.47, 9.83], [123.45, 9.81]]]];
        Sanctum::actingAs($this->superAdmin, ['*']);
        $this->postJson("/api/superadmin/barangays/{$barangay->id}/boundary/candidate", ['geojson' => $replacement, 'source' => 'LGU approved map test', 'psgc_code' => $barangay->psgc_code])->assertOk();
        $this->assertSame($old, $barangay->fresh()->boundary);
        $this->assertSame($replacement, $barangay->fresh()->pending_boundary);
        $this->postJson("/api/superadmin/barangays/{$barangay->id}/boundary/confirm")->assertOk();
        $this->assertSame($replacement, $barangay->fresh()->boundary);
        $this->assertSame($this->superAdmin->id, $barangay->fresh()->boundary_verified_by);
        $this->getJson('/api/barangays/'.$barangay->id)->assertJsonPath('boundary_verified', true);
        app(\App\Services\BarangayGeography::class)->attachBoundary($barangay->fresh());
        $this->assertSame($replacement, $barangay->fresh()->boundary);
        $this->assertSame($replacement, $barangay->fresh()->boundary);
        $this->assertSame($this->superAdmin->id, $barangay->fresh()->boundary_verified_by);
    }

    #[Test]
    public function automatic_reference_cannot_become_verified_through_refresh_or_discard(): void
    {
        $barangay = $this->barangay();
        $barangay->update(['boundary' => ['type' => 'Polygon', 'coordinates' => [$this->validRing()]], 'boundary_source' => \App\Services\BarangayGeography::SOURCE, 'boundary_status' => 'verified']);
        $this->getJson('/api/barangays/'.$barangay->id)->assertJsonPath('boundary_verified', false);
        Sanctum::actingAs($this->superAdmin, ['*']);
        $this->postJson("/api/superadmin/barangays/{$barangay->id}/boundary/refresh")->assertOk()->assertJsonPath('boundary_status', 'needs_review');
        $this->deleteJson("/api/superadmin/barangays/{$barangay->id}/boundary/pending")->assertOk();
        $this->assertSame('needs_review', $barangay->fresh()->boundary_status);
        $this->assertNull($barangay->fresh()->boundary_verified_by);
    }

    #[Test]
    public function uploaded_boundary_rejects_wrong_codes_invalid_holes_and_non_admin_access(): void
    {
        $barangay = $this->barangay();
        $barangay->update(['psgc_code' => '0702222024']);
        $url = "/api/superadmin/barangays/{$barangay->id}/boundary/candidate";
        $payload = ['geojson' => ['type' => 'Polygon', 'coordinates' => [$this->validRing()]], 'source' => 'Test source', 'psgc_code' => $barangay->psgc_code];
        Sanctum::actingAs(User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]), ['*']);
        $this->postJson($url, $payload)->assertForbidden();
        Sanctum::actingAs($this->superAdmin, ['*']);
        $bad = $payload;
        $bad['psgc_code'] = '0702222034';
        $this->postJson($url, $bad)->assertUnprocessable();
        $bad = $payload;
        $bad['geojson']['coordinates'][] = [[123, 10], [124, 10]];
        $this->postJson($url, $bad)->assertUnprocessable();
        $bad['geojson']['coordinates'] = 'malformed';
        $this->postJson($url, $bad)->assertUnprocessable();
        $bad['geojson'] = ['type' => 'FeatureCollection', 'features' => 'malformed'];
        $this->postJson($url, $bad)->assertUnprocessable();
        $bad['geojson'] = ['type' => 'Feature', 'properties' => ['psgc_10d' => '0702222034'], 'geometry' => $payload['geojson']];
        $this->postJson($url, $bad)->assertUnprocessable();
        $bad['geojson'] = ['type' => 'Feature', 'properties' => ['ADM4_PCODE' => 'PH0702222034'], 'geometry' => $payload['geojson']];
        $this->postJson($url, $bad)->assertUnprocessable();
        // A hole that lies outside its outer ring.
        $bad['geojson'] = ['type' => 'Polygon', 'coordinates' => [$this->validRing(), [[124.0, 10.0], [124.01, 10.0], [124.01, 10.01], [124.0, 10.0]]]];
        $this->postJson($url, $bad)->assertUnprocessable();
        $this->assertNull($barangay->fresh()->pending_boundary);
    }

    private function nominatimResult(array $ring, string $barangayName = 'Test Barangay', string $cityName = 'Test City'): array
    {
        return [[
            'class' => 'boundary',
            'type' => 'administrative',
            'geojson' => ['type' => 'Polygon', 'coordinates' => [$ring]],
            'address' => ['city' => $cityName, 'village' => $barangayName],
        ]];
    }

    #[Test]
    public function refresh_does_not_query_or_offer_a_non_authoritative_geocoder_boundary(): void
    {
        $barangay = $this->barangay();

        Sanctum::actingAs($this->superAdmin, ['*']);
        $response = $this->postJson("/api/superadmin/barangays/{$barangay->id}/boundary/refresh")->assertOk();

        $this->assertSame('not_found', $response->json('boundary_status'));
        $this->assertFalse($response->json('has_boundary'));

        $barangay->refresh();
        $this->assertNull($barangay->boundary, 'A found match must not be auto-saved to the live boundary.');
        $this->assertNull($barangay->pending_boundary);
        $this->assertNull($barangay->pending_boundary_source);
    }

    #[Test]
    public function a_reference_refresh_never_promotes_an_unavailable_boundary_to_verified(): void
    {
        $barangay = $this->barangay();

        Sanctum::actingAs($this->superAdmin, ['*']);
        $this->postJson("/api/superadmin/barangays/{$barangay->id}/boundary/refresh")->assertOk();

        $barangay->refresh();
        $this->assertNull($barangay->boundary);
        $this->assertSame('not_found', $barangay->boundary_status);
        $this->postJson("/api/superadmin/barangays/{$barangay->id}/boundary/confirm")->assertStatus(422);
    }

    #[Test]
    public function confirming_with_nothing_pending_is_rejected(): void
    {
        $barangay = $this->barangay();

        Sanctum::actingAs($this->superAdmin, ['*']);
        $this->postJson("/api/superadmin/barangays/{$barangay->id}/boundary/confirm")->assertStatus(422);
    }

    #[Test]
    public function discarding_a_pending_boundary_leaves_the_live_boundary_untouched(): void
    {
        $barangay = $this->barangay();

        Sanctum::actingAs($this->superAdmin, ['*']);
        $this->postJson("/api/superadmin/barangays/{$barangay->id}/boundary/refresh")->assertOk();
        $this->deleteJson("/api/superadmin/barangays/{$barangay->id}/boundary/pending")->assertStatus(422);

        $barangay->refresh();
        $this->assertNull($barangay->pending_boundary);
        $this->assertNull($barangay->boundary);
        $this->assertSame('not_found', $barangay->boundary_status, 'Discarding with nothing confirmed before should read as not_found.');
    }

    #[Test]
    public function a_legacy_backfilled_boundary_is_an_unverified_reference_and_keeps_its_geometry(): void
    {
        $barangay = $this->barangay();
        $barangay->update([
            'boundary' => ['type' => 'Polygon', 'coordinates' => [$this->validRing()]],
            'boundary_status' => 'verified',
            'boundary_source' => 'legacy',
            'boundary_verified_at' => now(),
        ]);

        // A different geometry this time — if this were ever accepted, the
        // verified boundary would have silently changed underneath it.
        Http::fake(['nominatim.openstreetmap.org/*' => Http::response($this->nominatimResult([
            [124.0, 10.5], [124.01, 10.5], [124.01, 10.51], [124.0, 10.51], [124.0, 10.5],
        ]))]);

        Sanctum::actingAs($this->superAdmin, ['*']);
        $response = $this->postJson("/api/superadmin/barangays/{$barangay->id}/boundary/refresh")->assertOk();
        $this->assertTrue($response->json('has_boundary'));
        // The 2026_10_11 'legacy' backfill was never reviewed by anyone.
        $this->assertSame('needs_review', $response->json('boundary_status'));
        $this->getJson('/api/barangays/'.$barangay->id)->assertJsonPath('boundary_verified', false);

        $originalCoordinates = $barangay->boundary['coordinates'];
        $barangay->refresh();
        $this->assertSame($originalCoordinates, $barangay->boundary['coordinates'], 'An existing boundary must never change from a later lookup.');
        $this->assertNotSame([[124.0, 10.5], [124.01, 10.5], [124.01, 10.51], [124.0, 10.51], [124.0, 10.5]], $barangay->pending_boundary['coordinates'][0] ?? null);
    }

    #[Test]
    public function only_a_reviewed_boundary_rejects_hub_pins_outside_it_on_the_server(): void
    {
        $barangay = $this->barangay();
        $barangay->update(['psgc_code' => '0702222024', 'boundary' => ['type' => 'Polygon', 'coordinates' => [$this->validRing()]], 'boundary_source' => 'legacy', 'boundary_status' => 'verified']);
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $barangay->id]);
        $outside = ['name' => 'Outside hub', 'lat' => 10.5, 'lng' => 124.5];

        // Unreviewed reference: the outline does not block the pin.
        Sanctum::actingAs($admin, ['*']);
        $this->postJson('/api/hubs', $outside)->assertCreated();

        Sanctum::actingAs($this->superAdmin, ['*']);
        $this->postJson("/api/superadmin/barangays/{$barangay->id}/boundary/candidate", ['geojson' => ['type' => 'Polygon', 'coordinates' => [$this->validRing()]], 'source' => 'Dalaguete MPDO certified map', 'psgc_code' => $barangay->psgc_code])->assertOk();
        $this->postJson("/api/superadmin/barangays/{$barangay->id}/boundary/confirm")->assertOk()->assertJsonPath('boundary_status', 'verified');

        Sanctum::actingAs($admin, ['*']);
        $this->postJson('/api/hubs', ['name' => 'Outside again', 'lat' => 10.5, 'lng' => 124.5])->assertUnprocessable();
        $inside = $this->postJson('/api/hubs', ['name' => 'Inside hub', 'lat' => 10.305, 'lng' => 123.905])->assertCreated();
        $this->putJson('/api/hubs/'.$inside->json('hub_id'), ['lat' => 10.5])->assertUnprocessable();
    }

    #[Test]
    public function no_match_sets_not_found(): void
    {
        Http::fake(['nominatim.openstreetmap.org/*' => Http::response([])]);
        $barangay = $this->barangay();

        Sanctum::actingAs($this->superAdmin, ['*']);
        $response = $this->postJson("/api/superadmin/barangays/{$barangay->id}/boundary/refresh")->assertOk();

        $this->assertSame('not_found', $response->json('boundary_status'));
        $this->assertSame('not_found', $barangay->fresh()->boundary_status);
    }

    #[Test]
    public function a_degenerate_ring_is_rejected_before_it_ever_becomes_a_pending_candidate(): void
    {
        // Only 3 points (a valid closed ring needs at least 4, the last
        // repeating the first) — geometrically unusable.
        $tooShort = [[123.9, 10.3], [123.91, 10.3], [123.9, 10.3]];
        Http::fake(['nominatim.openstreetmap.org/*' => Http::response($this->nominatimResult($tooShort))]);
        $barangay = $this->barangay();

        Sanctum::actingAs($this->superAdmin, ['*']);
        $response = $this->postJson("/api/superadmin/barangays/{$barangay->id}/boundary/refresh")->assertOk();

        $this->assertSame('not_found', $response->json('boundary_status'), 'A degenerate ring must be treated as no usable match, not offered for review.');
        $this->assertNull($barangay->fresh()->pending_boundary);
    }

    #[Test]
    public function the_registration_code_response_includes_when_it_was_last_changed(): void
    {
        $barangay = $this->barangay();
        $barangay->update(['boundary' => ['type' => 'Polygon', 'coordinates' => [$this->validRing()]]]);

        Sanctum::actingAs($this->superAdmin, ['*']);
        $first = $this->getJson("/api/superadmin/barangays/{$barangay->id}/registration-code")->assertOk();
        $this->assertNotNull($first->json('updated_at'));

        $second = $this->postJson("/api/superadmin/barangays/{$barangay->id}/registration-code/regenerate")->assertOk();
        $this->assertNotNull($second->json('updated_at'));
        $this->assertNotSame($first->json('staff_code'), $second->json('staff_code'));
    }

    #[Test]
    public function registration_codes_are_available_while_a_boundary_is_awaiting_review(): void
    {
        $barangay = $this->barangay();
        $barangay->update([
            'boundary' => null,
            'pending_boundary' => ['type' => 'Polygon', 'coordinates' => [$this->validRing()]],
        ]);

        Sanctum::actingAs($this->superAdmin, ['*']);

        $this->getJson("/api/superadmin/barangays/{$barangay->id}/registration-code")
            ->assertOk()
            ->assertJsonStructure(['staff_code', 'updated_at']);
        $this->postJson("/api/superadmin/barangays/{$barangay->id}/registration-code/regenerate")
            ->assertOk()
            ->assertJsonStructure(['staff_code', 'updated_at']);
    }
}
