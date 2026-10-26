{{-- Key/value card. $rows: ['Label' => 'value', ...]; values are escaped. --}}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="details-card">
@if (!empty($title))<tr><td colspan="2" class="details-title">{{ $title }}</td></tr>@endif
@foreach ($rows as $label => $value)<tr><td class="details-label">{{ $label }}</td><td class="details-value">{{ $value }}</td></tr>@endforeach
</table>
