<x-mail::message>
@include('emails._eyebrow', ['label' => 'Registration received', 'tone' => 'blue'])

# Welcome to VMS, {{ $firstName }}

Thank you for registering with the Vehicle Management System (VMS) as the first Administrator for **{{ $place }}**.

@include('emails._notice', ['tone' => 'amber', 'title' => 'Your account is not active yet', 'text' => 'Because you are the first Administrator for your barangay, the VMS Super Admin needs to confirm your appointment with your barangay office. Once you are confirmed, we will send your Staff Registration Code to this email address.'])

@include('emails._steps', ['title' => 'What happens next', 'steps' => [
    'The Super Admin reviews your registration. You do not need to do anything yet.',
    'Watch this inbox, including your Spam or Promotions folder, for a second email with your Staff Registration Code.',
    'You will use that code to activate your account.',
]])

@include('emails._details', ['title' => 'Your registration details', 'rows' => [
    'Name' => $user->name,
    'Email' => $user->email,
    'Barangay' => $place,
    'Submitted' => $user->created_at->timezone('Asia/Manila')->format('F j, Y g:i A'),
]])

If you did not register for VMS, you can ignore this email, or contact us at {{ config('mail.from.address') }}.

@include('emails._signoff')

<small>This is an automated message. Please do not share your password with anyone, including VMS staff.</small>
</x-mail::message>
