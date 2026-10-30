<x-mail::message>
# You're invited to VMS

Hi **{{ $firstName }}**,

Your barangay Admin has invited you to the Vehicle Management System (VMS) for **{{ $place }}**. Set your password to activate your account.

<x-mail::button :url="$inviteUrl">
Set your password
</x-mail::button>

This link works once and expires on {{ $expiresAt->timezone('Asia/Manila')->format('F j, Y g:i A') }}. If it expires, ask your barangay Admin to send a new invite.

If you were not expecting this email, you can ignore it.

VMS Support Center<br>
{{ config('mail.from.address') }}
</x-mail::message>
