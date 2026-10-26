<x-mail::message>
@include('emails._eyebrow', ['label' => 'Support Center · Concern #'.$report->id, 'tone' => $resolved ? 'green' : 'blue'])

# {{ $subjectLine }}

Hi{!! $name !== '' ? ' **'.e($name).'**' : ' there' !!},

@include('emails._body-card', ['body' => $body])

@include('emails._details', ['title' => 'Your concern', 'rows' => array_filter([
    'Reference' => 'Concern #'.$report->id,
    'Concern' => ['Barangay Inactive' => 'Barangay account seems inactive', 'Suspected Fake Staff' => 'Suspected fake staff account'][$report->concern_type] ?? 'Other concern',
    'Location' => implode(', ', array_filter([$report->barangay_name, $report->city_name, $report->province_name])),
    'Submitted' => $report->created_at?->timezone('Asia/Manila')->format('F j, Y g:i A'),
    'Status' => $resolved ? 'Resolved' : 'Under review',
])])

You can reply to this email if you have more details to share.

@include('emails._signoff')
</x-mail::message>
