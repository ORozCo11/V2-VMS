<x-mail::message>
@include('emails._eyebrow', ['label' => 'Account invitation', 'tone' => 'blue'])

# Your Barangay VMS Account Invitation

Hello {{ $user->name }},

You have been invited to access the Barangay Vehicle Management System as a **{{ $roleName }}** for **{{ $place }}**.

To activate your account, please click the button below:

<x-mail::button :url="$activationUrl">
Activate Your Account
</x-mail::button>

For security, this invitation link will expire after 24 hours.

If you were not expecting this invitation, you may safely ignore this email.

Regards,<br>
Barangay Vehicle Management System
</x-mail::message>
