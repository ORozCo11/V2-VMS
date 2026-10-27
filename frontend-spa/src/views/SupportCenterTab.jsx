import SearchableSelect from '../components/SearchableSelect';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/axios';
import Icon from '../components/Icon';
import { AdminActionDrawer, AdminFilterField, AdminManagementCard, LocalSearchInput, PaginatedTable, StatusBadge } from '../components/SuperAdminUI';
import { formatDate } from '../utils/adminDate';

// Deleted reports are soft-deleted: they come back with deleted_at set and live in Concern History.
const stateOf = (report) => report.deleted_at ? 'Deleted' : report.status;
const typeOf = (report) => report.concern_type;
const location = (report) => [report.barangay_name, report.city_name, report.province_name].filter(Boolean).join(', ');

// The contact field is "email or phone", so only an email address can be replied to.
const replyEmail = (report) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((report.reporter_contact ?? '').trim()) ? report.reporter_contact.trim() : null;
// Each email goes out once per stage: the "received" reply while open, the resolution email once resolved.
const replyKind = (report) => report.status === 'Resolved' ? 'resolved' : 'acknowledge';
const replySentAt = (report) => replyKind(report) === 'resolved' ? report.resolved_email_at : report.acknowledged_email_at;
const REPLY_TEMPLATES = {
  acknowledge: (report) => ({
    subject: `We received your concern (Concern #${report.id})`,
    message: `Good day! Thank you for reaching out to the VMS Support Center.

We have received your concern about the issue you reported, and our team is now looking into it. We will review the details you shared and let you know once it has been addressed.

If you have more information that could help, just reply to this email.

Thank you for helping keep VMS safe and reliable for every barangay.`,
  }),
  resolved: (report) => ({
    subject: `Your concern has been resolved (Concern #${report.id})`,
    message: `Good day! We are following up on the issue you reported to us.

Our team has reviewed it, and the concern has now been resolved.

Thank you for taking the time to let us know. Reports like yours help keep VMS accurate and secure for every barangay. If the issue continues or you have something else to share, reply to this email or submit a new concern through the Support Center.`,
  }),
};

function ReplyEmail({ report, kind, onSent, onClose }) {
  const [draft, setDraft] = useState(() => REPLY_TEMPLATES[kind](report));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const send = async (event) => {
    event.preventDefault(); setSending(true); setError('');
    try {
      const { data } = await api.post(`/superadmin/concern-reports/${report.id}/email`, { ...draft, kind });
      onSent(data);
    } catch (err) { setError(err.response?.data?.message ?? 'Could not send that email.'); setSending(false); }
  };
  return <AdminActionDrawer centered title={kind === 'resolved' ? 'Send resolution email' : 'Reply to reporter'} description={kind === 'resolved' ? 'Let the reporter know their concern has been resolved.' : 'Let the reporter know their concern was received and is being looked into.'} onClose={onClose}>
    <form className="sa-email-form" onSubmit={send}>
      <dl className="sa-email-meta"><dt>To</dt><dd>{report.reporter_name ? `${report.reporter_name} <${replyEmail(report)}>` : replyEmail(report)}</dd><dt>Concern</dt><dd>#{report.id} · {typeOf(report)}</dd></dl>
      <label>Subject<input required maxLength={150} value={draft.subject} onChange={(event) => setDraft({ ...draft, subject: event.target.value })} /></label>
      <label>Message<textarea required maxLength={5000} value={draft.message} onChange={(event) => setDraft({ ...draft, message: event.target.value })} /></label>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="sa-row-actions"><button type="button" className="ghost-button" onClick={onClose}>{kind === 'resolved' ? 'Skip' : 'Cancel'}</button><button type="submit" className="primary-button" disabled={sending || !draft.subject.trim() || !draft.message.trim()}><Icon name="mail" size={16} />{sending ? 'Sending…' : 'Send Email'}</button></div>
    </form>
  </AdminActionDrawer>;
}

const ACTIONS = {
  resolve: { title: 'Resolve', confirm: 'Mark Resolved', message: 'This report will be marked resolved and moved to Concern History.', done: 'Concern Resolved', detail: 'is marked resolved' },
  reopen: { title: 'Reopen', confirm: 'Reopen Report', message: 'This report will move back to open concerns.', done: 'Concern Reopened', detail: 'is open again' },
  delete: { title: 'Delete', confirm: 'Delete Report', message: 'This report moves to Concern History. You can restore it to open concerns later.', done: 'Report Deleted', detail: 'moved to Concern History' },
  restore: { title: 'Restore', confirm: 'Restore to Open', message: 'This deleted report will move back to open concerns.', done: 'Concern Restored', detail: 'is back in open concerns' },
};

export default function SupportCenterTab({ onRequestConfirmation, onSuccess, onOpenCountChange }) {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState('');
  const [view, setView] = useState('open');
  const [historyFilter, setHistoryFilter] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [emailing, setEmailing] = useState(null);
  const selected = reports.find((report) => report.id === selectedId);

  useEffect(() => {
    let current = true;
    api.get('/superadmin/concern-reports').then(({ data }) => {
      if (current) { setReports(data); setError(false); }
    }).catch(() => { if (current) setError(true); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [retry]);

  const requestAction = (report, action) => {
    const copy = ACTIONS[action];
    onRequestConfirmation({
      title: `${copy.title} concern #${report.id}?`,
      message: copy.message,
      confirmLabel: copy.confirm,
      variant: action === 'delete' ? 'danger' : 'primary',
      onConfirm: async () => {
        const path = `/superadmin/concern-reports/${report.id}`;
        const { data } = action === 'delete' ? await api.delete(path) : await api.put(`${path}/${action}`);
        setReports((rows) => rows.map((row) => row.id === report.id ? data : row));
        setSelectedId(null);
        onSuccess({ title: copy.done, detail: `Concern #${report.id} ${copy.detail}.` });
        // Resolving offers the follow-up email right away.
        if (action === 'resolve' && replyEmail(data) && !data.resolved_email_at) setEmailing({ report: data, kind: 'resolved' });
      },
    });
  };

  const openReports = reports.filter((report) => stateOf(report) === 'Open');
  // Keeps the sidebar badge in step as reports are resolved, deleted or restored here.
  useEffect(() => { if (!loading && !error) onOpenCountChange?.(openReports.length); }, [loading, error, openReports.length, onOpenCountChange]);
  const history = reports.filter((report) => stateOf(report) !== 'Open');
  const query = search.trim().toLowerCase();
  const visible = (view === 'open' ? openReports : history.filter((report) => !historyFilter || stateOf(report) === historyFilter))
    .filter((report) => [report.id, report.concern_type, report.province_name, report.city_name, report.barangay_name, report.description, report.reporter_name, report.reporter_contact].some((value) => String(value ?? '').toLowerCase().includes(query)));

  const footer = selected && <div className="sa-row-actions">{stateOf(selected) === 'Deleted'
    ? <button type="button" className="primary-button" onClick={() => requestAction(selected, 'restore')}>Restore to Open</button>
    : <><button type="button" className="primary-button" onClick={() => requestAction(selected, selected.status === 'Resolved' ? 'reopen' : 'resolve')}>{selected.status === 'Resolved' ? 'Reopen Report' : 'Mark Resolved'}</button><button type="button" className="ghost-button danger" onClick={() => requestAction(selected, 'delete')}>Delete Report</button></>}</div>;

  return <div className="superadmin-tab">
    <AdminManagementCard className="sa-support-card"
      summary={<><div className="sa-support-summary"><strong>{openReports.length} open {openReports.length === 1 ? 'concern' : 'concerns'}</strong><span>Public submissions for platform review. <Link to="/support">Open public Support Center</Link></span></div>
        <div className="sa-segments sa-support-views">{[['open', 'Open Concerns', openReports.length], ['history', 'Concern History', history.length]].map(([key, label, count]) => <button key={key} type="button" aria-pressed={view === key} onClick={() => { setView(key); setSelectedId(null); }}>{label}<span>{count}</span></button>)}</div></>}
      toolbar={<><LocalSearchInput value={search} onChange={setSearch} placeholder="Search concern, barangay, or reporter..." />{view === 'history' && <AdminFilterField label="Show"><SearchableSelect value={historyFilter} onChange={(event) => setHistoryFilter(event.target.value)}><option value="">Resolved and Deleted</option><option>Resolved</option><option>Deleted</option></SearchableSelect></AdminFilterField>}</>}>
      {loading ? <p role="status">Loading concern reports…</p> : error ? <p role="alert">Concern reports could not be loaded. <button type="button" className="ghost-button" onClick={() => { setLoading(true); setRetry((value) => value + 1); }}>Try again</button></p> : <PaginatedTable rows={visible}
        emptyMessage={view === 'open' ? 'No open concerns' : 'No concern history yet'}
        emptyDescription={view === 'open' ? 'New reports will appear here when submitted through the Support Center.' : 'Resolved and deleted concerns will appear here.'}
        columns={[
          { label: 'Concern', render: (report) => <><strong>#{report.id} · {typeOf(report)}</strong><div>{location(report) || 'Location not provided'}</div></> },
          { label: 'Reporter', render: (report) => report.reporter_name || 'Anonymous' },
          { label: 'Submitted', render: (report) => formatDate(report.created_at) },
          ...(view === 'history' ? [{ label: 'Closed', render: (report) => formatDate(report.deleted_at ?? report.resolved_at) }] : []),
          { label: 'Status', render: (report) => <StatusBadge value={stateOf(report)} /> },
          { label: 'Actions', render: (report) => <div className="sa-row-actions"><button type="button" className="ghost-button sa-icon-button sa-icon-edit" aria-label={`Review concern #${report.id}`} title="Review" onClick={() => setSelectedId(report.id)}><Icon name="eye" size={17} /></button>{stateOf(report) !== 'Deleted' && (replySentAt(report)
            ? <span className="ghost-button sa-icon-button sa-icon-confirm sa-email-sent" role="img" aria-label={`Email sent for concern #${report.id}`} title={`${replyKind(report) === 'resolved' ? 'Resolution email' : 'Reply'} sent ${formatDate(replySentAt(report))}`}><Icon name="checkCircle" size={17} /></span>
            : <button type="button" className="ghost-button sa-icon-button sa-icon-mail" disabled={!replyEmail(report)} aria-label={`Email the reporter of concern #${report.id}`} title={!replyEmail(report) ? 'No email address was left for this concern' : replyKind(report) === 'resolved' ? 'Send resolution email' : 'Reply to reporter'} onClick={() => setEmailing({ report, kind: replyKind(report) })}><Icon name="mail" size={17} /></button>)}</div> },
        ]} />}
    </AdminManagementCard>
    {selected && <AdminActionDrawer centered className="sa-concern-modal" title={`Concern #${selected.id}`} description={typeOf(selected)} onClose={() => setSelectedId(null)} footer={footer}>
      <dl className="sa-detail-list"><dt>Status</dt><dd><StatusBadge value={stateOf(selected)} /></dd><dt>Location</dt><dd>{location(selected) || 'Not provided'}</dd><dt>Submitted</dt><dd>{formatDate(selected.created_at)}</dd><dt>Reporter</dt><dd>{selected.reporter_name || 'Anonymous'}</dd><dt>Email or phone</dt><dd>{selected.reporter_contact || 'Not provided'}</dd><dt>Reply emails</dt><dd>{[selected.acknowledged_email_at && `Received reply sent ${formatDate(selected.acknowledged_email_at)}`, selected.resolved_email_at && `Resolution email sent ${formatDate(selected.resolved_email_at)}`].filter(Boolean).join(' · ') || (replyEmail(selected) ? 'None sent yet' : 'No email address to reply to')}</dd></dl>
      <h3 className="sa-concern-heading">Concern details</h3><p className="sa-concern-text">{selected.description || 'No details were needed for this concern type.'}</p>
      {stateOf(selected) === 'Deleted' ? <p className="muted">Deleted on {formatDate(selected.deleted_at)}. Restore it to move it back to open concerns.</p>
        : selected.status === 'Resolved' && <p className="muted">Resolved by {selected.resolved_by?.name || 'a platform administrator'} on {formatDate(selected.resolved_at)}.</p>}
    </AdminActionDrawer>}
    {emailing && <ReplyEmail key={`${emailing.report.id}-${emailing.kind}`} report={emailing.report} kind={emailing.kind} onClose={() => setEmailing(null)}
      onSent={(data) => { setReports((rows) => rows.map((row) => row.id === data.report.id ? data.report : row)); setEmailing(null); onSuccess({ title: 'Email Sent', detail: data.message }); }} />}
  </div>;
}
