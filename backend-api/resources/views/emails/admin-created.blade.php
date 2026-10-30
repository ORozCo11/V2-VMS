<x-mail::message>
# Your VMS Administrator account is ready

Hi **{{ $firstName }}**,

Your LGU has created your Administrator account for **{{ $place }}**. Sign in with this email address and the temporary password below. You will be asked to choose your own password right away.

@include('emails._code', ['code' => $temporaryPassword])

<x-mail::button :url="$loginUrl">
Sign in to VMS
</x-mail::button>

If you were not expecting this email, you can ignore it.

VMS Support Center<br>
{{ config('mail.from.address') }}
</x-mail::message>
