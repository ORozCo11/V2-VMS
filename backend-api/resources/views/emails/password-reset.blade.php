<x-mail::message>
@include('emails._eyebrow', ['label' => 'Password reset', 'tone' => 'blue'])

# Reset your Barangay VMS password

Hello {{ $user->name }},

An administrator asked for a password reset on your Barangay VMS account. Click the button below to choose a new password:

<x-mail::button :url="$activationUrl">
Choose a New Password
</x-mail::button>

For security, this link will expire after 24 hours and works only once.

If you were not expecting this, you may safely ignore this email.

Regards,<br>
Barangay Vehicle Management System
</x-mail::message>
