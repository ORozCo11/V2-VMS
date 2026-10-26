{{-- Numbered steps with blue number badges. $steps: list of strings (escaped). --}}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="steps">
@if (!empty($title))<tr><td colspan="2" class="steps-title">{{ $title }}</td></tr>@endif
@foreach ($steps as $i => $step)<tr><td class="step-number-cell"><span class="step-number">{{ $i + 1 }}</span></td><td class="step-text">{{ $step }}</td></tr>@endforeach
</table>
