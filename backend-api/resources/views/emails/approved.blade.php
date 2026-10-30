<x-mail::message>
# Your VMS account is approved

Hi **{{ $firstName }}**,

Your VMS account for **{{ $place }}** has been approved. You can sign in now with the email address and password you registered with.

<x-mail::button :url="$loginUrl">
Sign in to VMS
</x-mail::button>

VMS Support Center<br>
{{ config('mail.from.address') }}
</x-mail::message>
