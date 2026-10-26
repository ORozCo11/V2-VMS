<x-mail::message>
@include('emails._eyebrow', ['label' => 'Account activated', 'tone' => 'green'])

# Your VMS account is now active

Hi **{{ $firstName }}**,

Your VMS account is now active. You are now the Administrator for **{{ $place }}**.

@include('emails._details', ['title' => 'Your account', 'rows' => [
    'Name' => $user->name,
    'Email' => $user->email,
    'Role' => 'Administrator',
    'Barangay' => $place,
]])

@if ($showLinks)
<x-mail::button :url="$loginUrl">
Sign in to VMS
</x-mail::button>
@endif

@include('emails._signoff')
</x-mail::message>
