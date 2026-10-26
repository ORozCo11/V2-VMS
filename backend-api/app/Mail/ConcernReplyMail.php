<?php

namespace App\Mail;

use App\Models\ConcernReport;
use Illuminate\Mail\Mailables\Content;

/** The Super Admin's reply to a public concern report; the reporter has no account, so it reuses AccountMail's layout without a User. */
class ConcernReplyMail extends AccountMail
{
    public function __construct(public ConcernReport $report, string $subjectLine, public string $body, public bool $resolved = false)
    {
        $this->subjectLine = $subjectLine;
    }

    public function content(): Content
    {
        return new Content(markdown: 'emails.concern-reply', with: [
            'name' => trim((string) $this->report->reporter_name),
            'body' => $this->body,
            'report' => $this->report,
            'resolved' => $this->resolved,
        ]);
    }
}
