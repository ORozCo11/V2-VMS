<x-mail::message>
@include('emails._eyebrow', ['label' => 'Registration expired', 'tone' => 'red'])

# Your VMS registration has expired

Hi **{{ $firstName }}**,

Your Staff Registration Code for **{{ $place }}** was not used in time, so your registration has been cancelled.

@include('emails._details', ['rows' => [
    'Barangay' => $place,
    'Code expired' => $expiresAt->timezone('Asia/Manila')->format('F j, Y g:i A'),
]])

To try again, fill out the registration form.

@if ($showLinks)
<x-mail::button :url="$registerUrl">
Register again
</x-mail::button>
@endif

@include('emails._signoff')
</x-mail::message>
