<x-mail::message>
@include('emails._eyebrow', ['label' => 'Staff registration code', 'tone' => 'blue'])

# Your Staff Registration Code

Hi **{{ $firstName }}**,

Your appointment as the Administrator for **{{ $place }}** has been confirmed. Here is your Staff Registration Code:

@include('emails._code')

@include('emails._notice', ['tone' => 'amber', 'title' => 'This code expires on '.$expiresAt->timezone('Asia/Manila')->format('F j, Y g:i A'), 'text' => 'That is 7 days from today. If the code expires before you use it, your registration will be cancelled and you will need to register again.'])

@include('emails._steps', ['title' => 'To activate your account', 'steps' => [
    'Go to the VMS sign-in page and sign in with your email and password.',
    'When the "Enter your registration code" window appears, paste the code above.',
    'Click Activate. You will then have full access as your barangay\'s Administrator.',
]])

@include('emails._notice', ['tone' => 'red', 'title' => 'Keep this code private', 'text' => 'It gives Administrator access to your barangay. VMS staff will never ask you for it.'])

@if ($showLinks)
<x-mail::button :url="$loginUrl">
Sign in to VMS
</x-mail::button>
@endif

@include('emails._signoff')
</x-mail::message>
