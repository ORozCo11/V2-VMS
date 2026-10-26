{{-- Highlighted callout. $tone: blue, green, amber or red; $title and $text are escaped. --}}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="notice notice-{{ $tone ?? 'blue' }}"><tr><td class="notice-cell">@if (!empty($title))<p class="notice-title">{{ $title }}</p>@endif<p class="notice-text">{{ $text }}</p></td></tr></table>
