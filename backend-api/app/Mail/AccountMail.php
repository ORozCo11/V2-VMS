<?php

namespace App\Mail;

use App\Models\User;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;
use Illuminate\Support\Facades\Mail;

/** One class for every account email; each message is just its own markdown view in resources/views/emails. */
class AccountMail extends Mailable
{
    public function __construct(public User $user, public string $subjectLine, public string $template, public array $data = [])
    {
    }

    /**
     * For courtesy emails (welcome, activated, expired): a mail outage is
     * logged instead of failing the registration or activation it follows.
     */
    public static function trySend(User $user, string $subject, string $template, array $data = []): void
    {
        try {
            Mail::to($user->email)->send(new self($user, $subject, $template, $data));
        } catch (\Throwable $e) {
            report($e);
        }
    }

    public function envelope(): Envelope
    {
        return new Envelope(subject: $this->subjectLine);
    }

    public function content(): Content
    {
        $frontend = rtrim(config('app.frontend_url'), '/');
        $barangay = $this->user->barangay;

        return new Content(markdown: 'emails.'.$this->template, with: $this->data + [
            'firstName' => explode(' ', trim($this->user->name))[0],
            'place' => implode(', ', array_filter(['Barangay '.($barangay?->name ?? $this->user->barangay_name), $barangay?->city?->name, $barangay?->city?->province?->name])),
            'loginUrl' => "{$frontend}/login",
            'registerUrl' => "{$frontend}/register",
            // Link buttons only once VMS is deployed: a localhost link is dead on the recipient's device.
            'showLinks' => ! in_array(parse_url($frontend, PHP_URL_HOST), ['localhost', '127.0.0.1', '::1'], true),
        ]);
    }
}
