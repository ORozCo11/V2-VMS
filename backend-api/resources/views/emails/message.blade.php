<x-mail::message>
@include('emails._eyebrow', ['label' => 'Message from VMS Support', 'tone' => 'blue'])

# {{ $subjectLine }}

Hi **{{ $firstName }}**,

{{-- The barangay is bolded wherever the message names it. --}}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="body-card"><tr><td class="body-card-cell">{!! nl2br(str_replace(e($place), "<strong>".e($place)."</strong>", e($body))) !!}</td></tr></table>

@isset($code)
@include('emails._code')
@endisset

@include('emails._signoff')
</x-mail::message>
