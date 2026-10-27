import SearchableSelect from '../components/SearchableSelect';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api/axios';
import Icon from '../components/Icon';
import { DonutChart } from '../components/charts';
import { AdminActionDrawer, AdminEmptyState, AdminFilterField, AdminIdentity, AdminManagementCard, LocalSearchInput, PaginatedTable, StatusBadge } from '../components/SuperAdminUI';
import { formatDate } from '../utils/adminDate';

const ROLES = ['Admin', 'Custodian', 'Maintenance Personnel'];
const effectiveRoles = (account) => [...new Set([...(account.roles ?? []), account.role].filter(Boolean))];
const location = (record) => [record.barangay_name, record.city_name, record.province_name].filter(Boolean).join(', ') || 'Unassigned';
const firstAdmin = (account, barangays) => account.role === 'Admin' && !barangays.find((b) => b.id === account.barangay_id)?.has_active_admin;

export function PlatformOverview({ barangays, approvals, onNavigate }) {
  const [expanded, setExpanded] = useState(false);
  const boundaries = barangays.filter((b) => b.boundary_status === 'needs_review');
  const active = barangays.filter((b) => b.has_active_admin).length;
  const metrics = [
    { label: 'Registered Barangays', value: barangays.length, icon: 'pin', tab: 'barangays', detail: `${active} with an active Administrator` },
    { label: 'Pending Account Approvals', value: approvals.length, icon: 'clipboard', tab: 'pending', detail: 'Registrations awaiting a decision' },
    { label: 'Boundaries Needing Review', value: boundaries.length, icon: 'pin', tab: 'barangays', filter: 'boundary_review', detail: 'Candidate boundaries to verify' },
  ];
  const items = [
    ...[...approvals].sort((a, b) => Number(firstAdmin(b, barangays)) - Number(firstAdmin(a, barangays))).map((account) => ({ key: `approval-${account.id}`, title: firstAdmin(account, barangays) ? 'Review initial Administrator registration' : 'Review account registration', detail: `${account.name} · ${location(account)}`, status: 'Pending Approval', date: account.created_at, tab: 'pending' })),
    ...boundaries.map((b) => ({ key: `boundary-${b.id}`, title: 'Review candidate boundary', detail: `${b.name}, ${b.city_name ?? ''}`, status: 'Needs Review', date: b.updated_at, tab: 'barangays', filter: 'boundary_review' })),
    ...barangays.filter((b) => !b.has_active_admin).map((b) => ({ key: `recovery-${b.id}`, title: 'Recover Administrator coverage', detail: `${b.name}, ${b.city_name ?? ''}`, status: 'No Active Admin', tab: 'barangays', filter: 'orphaned' })),
  ];
  const segments = [{ label: 'Active Administrator', value: active, color: '#16a34a' }, { label: 'Without active Administrator', value: barangays.length - active, color: '#d97706' }];
  return <div className="focus-dashboard sa-overview">
    <div className="focus-kpis">{metrics.map((metric) => <button key={metric.label} type="button" onClick={() => onNavigate(metric.tab, metric.filter)}><span className="focus-kpi-icon"><Icon name={metric.icon} size={20} /></span><span>{metric.label}<strong>{metric.value}</strong><small>{metric.detail}</small></span><Icon name="chevronRight" size={15} /></button>)}</div>
    <div className="focus-columns">
      <section className="focus-card sa-queue"><header><div><h3>Administrative Action Queue</h3><p>Review the requests that need your attention.</p></div><span className="sa-count">{items.length} pending</span></header>
        {!items.length ? <AdminEmptyState icon="checkCircle" title="You're up to date" description="No administrative actions are waiting for review." /> : <ul className="focus-tasks">{(expanded ? items : items.slice(0, 5)).map((item) => <li key={item.key}><div><strong>{item.title}</strong><span>{item.detail}</span><div className="sa-queue-meta"><StatusBadge value={item.status} /><time>{item.date ? formatDate(item.date) : 'Date not recorded'}</time></div></div><button type="button" onClick={() => onNavigate(item.tab, item.filter)}>Review <Icon name="chevronRight" size={14} /></button></li>)}</ul>}
        {items.length > 5 && <button type="button" className="focus-more" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show fewer actions' : `View all ${items.length} actions`}</button>}
      </section>
      <section className="focus-card sa-platform-status"><header><div><h3>Platform Status</h3><p>Administrator coverage across registered barangays.</p></div></header>{barangays.length ? <div className="focus-donut"><DonutChart segments={segments} centerLabel={barangays.length} centerSubLabel="barangays" /><ul>{segments.map((segment) => <li key={segment.label}><i style={{ background: segment.color }} />{segment.label}<strong>{segment.value}</strong></li>)}</ul></div> : <AdminEmptyState icon="pin" title="No barangays registered" description="Add a barangay to begin platform onboarding." />}<button type="button" className="focus-more" onClick={() => onNavigate('barangays')}>Manage barangays <Icon name="chevronRight" size={14} /></button></section>
    </div>
  </div>;
}

// The applicant's ID and photo live on a private disk; fetch them with the
// reviewer's token and show them from short-lived object URLs.
function ApplicantDocument({ accountId, type, label, available }) {
  const [state, setState] = useState({ url: null, pdf: false, error: '' });
  useEffect(() => {
    if (!available) return undefined;
    let current = true;
    let objectUrl = null;
    api.get(`/superadmin/users/${accountId}/registration-document/${type}`, { responseType: 'blob' })
      .then(({ data }) => { if (!current) return; objectUrl = URL.createObjectURL(data); setState({ url: objectUrl, pdf: data.type === 'application/pdf', error: '' }); })
      .catch(() => { if (current) setState({ url: null, pdf: false, error: 'Could not load this document.' }); });
    return () => { current = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [accountId, type, available]);
  return <figure className="sa-applicant-document">
    <figcaption>{label}</figcaption>
    {!available ? <p className="muted">Not submitted</p>
      : state.error ? <p role="alert">{state.error}</p>
      : !state.url ? <p role="status">Loading…</p>
      : state.pdf ? <a className="ghost-button" href={state.url} target="_blank" rel="noreferrer">Open PDF</a>
      : <a href={state.url} target="_blank" rel="noreferrer"><img src={state.url} alt={label} /></a>}
  </figure>;
}

export function PendingApprovalsTab({ approvals, barangays, onApprove, onReject, onRequestConfirmation }) {
  const [search, setSearch] = useState('');
  const [barangay, setBarangay] = useState('');
  const [paging, setPaging] = useState({ page: 1, size: 25 });
  const [searchParams, setSearchParams] = useSearchParams();
  const applicationId = searchParams.get('application');
  const reviewing = approvals.find((account) => String(account.id) === applicationId);
  const reviewHeadingRef = useRef(null);
  const setReviewing = (account) => {
    const next = new URLSearchParams(searchParams);
    if (account) next.set('application', String(account.id));
    else next.delete('application');
    setSearchParams(next);
  };
  useEffect(() => {
    if (!applicationId) return;
    reviewHeadingRef.current?.focus();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [applicationId]);
  const requestApprove = (account) => onRequestConfirmation({ title: 'Approve Registration', message: firstAdmin(account, barangays) ? `Approve ${account.name} as ${account.barangay_name ?? 'this barangay'}'s first Admin? Their account stays locked until they enter the staff registration code you email them from Users.` : `Approve ${account.name}'s registration for ${account.barangay_name ?? 'their barangay'} as ${account.role}?`, confirmLabel: 'Approve', variant: 'primary', onConfirm: async () => { const success = await onApprove(account); if (success) setReviewing(null); } });
  const requestReject = (account) => onRequestConfirmation({ title: 'Reject Registration', message: `Reject ${account.name}'s registration for ${account.barangay_name ?? 'their barangay'}? They are emailed a polite note asking for a valid ID and clear photo if they try again, and their account is permanently deleted — this cannot be undone.`, confirmLabel: 'Reject & Delete', variant: 'danger', onConfirm: async () => { const success = await onReject(account); if (success) setReviewing(null); } });
  const matching = approvals.filter((account) => (!barangay || String(account.barangay_id) === barangay) && [account.name, account.email, account.role, location(account)].join(' ').toLowerCase().includes(search.trim().toLowerCase()));
  // Keep barangay groups together; groups awaiting their initial Admin lead.
  const priorityGroups = new Set(approvals.filter((account) => firstAdmin(account, barangays)).map((account) => account.barangay_id));
  const visible = matching.sort((a, b) => Number(priorityGroups.has(b.barangay_id)) - Number(priorityGroups.has(a.barangay_id)) || location(a).localeCompare(location(b)) || Number(firstAdmin(b, barangays)) - Number(firstAdmin(a, barangays)) || new Date(b.created_at) - new Date(a.created_at));
  const currentPage = Math.min(paging.page, Math.max(1, Math.ceil(visible.length / paging.size)));
  const pageRows = visible.slice((currentPage - 1) * paging.size, currentPage * paging.size);
  const actions = (account) => <div className="sa-row-actions"><button className="ghost-button sa-icon-button sa-icon-edit" type="button" aria-label={`Review application from ${account.name}`} title="Review application" onClick={() => setReviewing(account)}><Icon name="eye" size={17} /></button><button className="ghost-button sa-icon-button sa-icon-confirm" type="button" aria-label={`Approve ${account.name}`} title="Approve registration" onClick={() => requestApprove(account)}><Icon name="checkCircle" size={17} /></button><button className="ghost-button sa-icon-button sa-destructive" type="button" aria-label={`Reject ${account.name}`} title="Reject registration" onClick={() => requestReject(account)}><Icon name="close" size={17} /></button></div>;
  const columns = [
    { label: 'Applicant', render: (account) => <AdminIdentity name={account.name} email={account.email} /> },
    { label: 'Barangay', render: (account) => <div className="sa-stacked"><strong>{account.barangay_name || 'Unassigned'}</strong><span>{[account.city_name, account.province_name].filter(Boolean).join(', ')}</span></div> },
    { label: 'Requested Role', key: 'role' },
    { label: 'Date Submitted', className: 'sa-date-cell', render: (account) => formatDate(account.created_at) },
    { label: 'Approval Type', render: (account) => <StatusBadge value={firstAdmin(account, barangays) ? 'Initial Administrator' : 'Staff Registration'} /> },
    { label: 'Actions', render: actions },
  ];
  if (applicationId) return <section className="sa-application-page" aria-labelledby="application-review-title">
    <button type="button" className="ghost-button sa-review-back" onClick={() => setReviewing(null)}><Icon name="arrowLeft" size={16} />Back to Pending Approvals</button>
    <section className="sa-management-card sa-application-card">
      <header className="sa-application-header">
        <div><h2 id="application-review-title" ref={reviewHeadingRef} tabIndex={-1}>Review application</h2><p>Verify the applicant through a trusted barangay office contact or appointment record before approving. A registration code proves possession of an invitation, not official authority.</p></div>
        {reviewing && <StatusBadge value="Pending Approval" />}
      </header>
      {reviewing ? <>
        <div className="sa-application-body"><AdminIdentity name={reviewing.name} email={reviewing.email} /><dl className="sa-detail-list"><dt>Barangay</dt><dd>{location(reviewing)}</dd><dt>Requested role</dt><dd>{reviewing.role}</dd><dt>Phone</dt><dd>{reviewing.phone || 'Not provided'}</dd><dt>Submitted</dt><dd>{formatDate(reviewing.created_at)}</dd><dt>Account state</dt><dd><StatusBadge value="Pending Approval" /></dd><dt>Approval type</dt><dd>{firstAdmin(reviewing, barangays) ? 'Initial Administrator registration' : 'Staff registration'}</dd></dl><div className="sa-applicant-documents"><ApplicantDocument accountId={reviewing.id} type="id" label="Valid ID" available={reviewing.has_valid_id} /><ApplicantDocument accountId={reviewing.id} type="photo" label="Photo of applicant" available={reviewing.has_photo} /></div></div>
        <footer className="sa-application-actions"><p>Approve this registration to grant account access, or reject the application.</p><div className="sa-row-actions"><button className="ghost-button" type="button" onClick={() => setReviewing(null)}>Cancel</button><button className="ghost-button sa-destructive" type="button" onClick={() => requestReject(reviewing)}>Reject application</button><button className="primary-button" type="button" onClick={() => requestApprove(reviewing)}>Approve application</button></div></footer>
      </> : <AdminEmptyState icon="clipboard" title="Application unavailable" description="This application may have already been reviewed. Return to Pending Approvals to see the current list." />}
    </section>
  </section>;
  return <div className="superadmin-tab"><AdminManagementCard summary={<><strong>{approvals.length} pending applications</strong><span>Initial Administrator applications are prioritized. All applicants are listed below.</span></>} toolbar={<><LocalSearchInput value={search} onChange={(value) => { setSearch(value); setPaging((current) => ({ ...current, page: 1 })); }} placeholder="Search applicant, email, or barangay..." /><AdminFilterField label="Barangay"><SearchableSelect value={barangay} onChange={(event) => { setBarangay(event.target.value); setPaging((current) => ({ ...current, page: 1 })); }}><option value="">All Barangays</option>{[...new Map(approvals.map((account) => [String(account.barangay_id), location(account)])).entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</SearchableSelect></AdminFilterField></>}>
    <PaginatedTable rows={pageRows} columns={columns} groupBy={location} pagination={{ ...paging, total: visible.length }} onPageChange={(page) => setPaging((current) => ({ ...current, page }))} onPageSizeChange={(size) => setPaging({ page: 1, size })} emptyIcon="checkCircle" emptyMessage={approvals.length ? 'No matching applications' : 'No pending approvals'} emptyDescription={approvals.length ? 'Try another applicant name or choose a different barangay.' : 'All account applications have been reviewed.'} />
  </AdminManagementCard></div>;
}

const STAFF_CODE_VALID_DAYS = 7;

function StaffCodeEmail({ account, onSend, onClose }) {
  const [code, setCode] = useState({ value: null, error: null });
  const [sending, setSending] = useState(false);
  useEffect(() => {
    let current = true;
    api.get(`/superadmin/barangays/${account.barangay_id}/registration-code`)
      .then(({ data }) => { if (current) setCode({ value: data.staff_code, error: null }); })
      .catch((error) => { if (current) setCode({ value: null, error: error.response?.data?.message ?? 'Could not load this barangay\'s registration code.' }); });
    return () => { current = false; };
  }, [account.barangay_id]);
  const firstName = account.name.trim().split(/\s+/)[0];
  const place = `Barangay ${location(account)}`;
  const [expires] = useState(() => formatDate(new Date(Date.now() + STAFF_CODE_VALID_DAYS * 86400000)));
  const send = async () => { setSending(true); if (await onSend(account)) onClose(); else setSending(false); };
  return <AdminActionDrawer centered title="Send staff registration code" description="Confirm this person's appointment with their barangay office before sending. The code gives Administrator access." onClose={onClose}
    footer={<div className="sa-row-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={!code.value || sending} onClick={send}><Icon name="mail" size={16} />{sending ? 'Sending…' : account.staff_code_sent_at ? 'Resend Code' : 'Send Code'}</button></div>}>
    <div className="sa-email-form">
      {account.staff_code_sent_at && <p className="notice">Last sent {formatDate(account.staff_code_sent_at)}. Sending again restarts the {STAFF_CODE_VALID_DAYS}-day window.</p>}
      <dl className="sa-email-meta"><dt>To</dt><dd>{account.email}</dd><dt>Subject</dt><dd>Your VMS Staff Registration Code for Barangay {account.barangay_name}</dd></dl>
      {code.error ? <p className="notice error" role="alert">{code.error}</p> : <div className="sa-email-preview" aria-label="Email preview">
        <p>Hi {firstName},</p>
        <p>Your appointment as the Administrator for <strong>{place}</strong> has been confirmed. Here is your Staff Registration Code:</p>
        {code.value ? <div className="sa-code-chip"><code>{code.value}</code></div> : <code>Loading…</code>}
        <p><strong>This code expires on {expires} ({STAFF_CODE_VALID_DAYS} days from today).</strong></p>
        <p><strong>To activate your account:</strong></p>
        <ol><li>Go to the VMS sign-in page and sign in with your email and password.</li><li>When the "Enter your registration code" window appears, paste the code above.</li><li>Click <strong>Activate</strong>. You will then have full access as your barangay's Administrator.</li></ol>
        <p><strong>Keep this code private.</strong> It gives Administrator access to your barangay. VMS staff will never ask you for it.</p>
        <p>If the code expires before you use it, your registration will be cancelled and you will need to register again.</p>
        <p>VMS Support Center</p>
      </div>}
    </div>
  </AdminActionDrawer>;
}

function CopyableCode({ code }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); } };
  return <div className="sa-code-chip"><code>{code}</code><button type="button" className="ghost-button sa-icon-button" aria-label="Copy code" title={copied ? 'Copied' : 'Copy code'} onClick={copy}><Icon name={copied ? 'checkCircle' : 'clipboard'} size={17} /></button></div>;
}

const codeTemplate = (account) => ({
  subject: 'Your barangay staff registration code is now available',
  message: `Good day! The staff registration code for Barangay ${location(account)} is now available.\n\nShare it only with authorized staff of your barangay. They enter it on the VMS registration form to create their accounts, and you approve each one before they can sign in.\n\nYour staff registration code is shown below. Keep it private.`,
});

function MessageEmail({ account, onSend, onClose, onRequestConfirmation }) {
  const [draft, setDraft] = useState({ subject: '', message: '' });
  const [code, setCode] = useState(null);
  const [sending, setSending] = useState(false);
  const [codeError, setCodeError] = useState('');
  const generate = () => onRequestConfirmation({ title: 'Generate Staff Registration Code', message: `Generate a new staff registration code for Barangay ${account.barangay_name}? The barangay's current code stops working immediately.`, confirmLabel: 'Generate', variant: 'primary', onConfirm: async () => {
    setCodeError('');
    try {
      const { data } = await api.post(`/superadmin/barangays/${account.barangay_id}/registration-code/regenerate`);
      setCode(data.staff_code);
      setDraft(codeTemplate(account));
    } catch (error) { setCodeError(error.response?.data?.message ?? 'Could not generate a code.'); }
  } });
  const send = async (event) => { event.preventDefault(); setSending(true); if (await onSend(account, { ...draft, include_staff_code: Boolean(code) })) onClose(); else setSending(false); };
  return <AdminActionDrawer centered title="Send email" description="Write a message to this account. It is sent from the VMS Support Center address." onClose={onClose}>
    <form className="sa-email-form" onSubmit={send}>
      <dl className="sa-email-meta"><dt>To</dt><dd>{account.name} &lt;{account.email}&gt;</dd>{account.barangay_id && <><dt>Barangay</dt><dd>{location(account)}</dd></>}</dl>
      {account.barangay_id && <div className="sa-code-row">
        {code ? <><span>Staff registration code (added below the message)</span><CopyableCode code={code} /><button type="button" className="sa-text-button" onClick={() => setCode(null)}>Don't include the code</button></>
          : <><span>Send this barangay a new staff registration code.</span><button type="button" className="ghost-button" onClick={generate}><Icon name="key" size={16} />Generate code</button></>}
        {codeError && <p className="notice error" role="alert">{codeError}</p>}
      </div>}
      <label>Subject<input required maxLength={150} value={draft.subject} onChange={(event) => setDraft({ ...draft, subject: event.target.value })} /></label>
      <label>Message<textarea required maxLength={5000} value={draft.message} onChange={(event) => setDraft({ ...draft, message: event.target.value })} /></label>
      <div className="sa-row-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={sending || !draft.subject.trim() || !draft.message.trim()}><Icon name="mail" size={16} />{sending ? 'Sending…' : 'Send Email'}</button></div>
    </form>
  </AdminActionDrawer>;
}

export function UsersTab({ users, onChangeRole, onToggleActive, onApprove, onReject, onSendStaffCode, onSendEmail, onRequestConfirmation }) {
  // Barangay Management links here with ?user=<id> to land on one account.
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState(() => users.find((account) => String(account.id) === searchParams.get('user'))?.email ?? '');
  const [province, setProvince] = useState('');
  const [city, setCity] = useState('');
  const [barangay, setBarangay] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState(null);
  // Only locations that actually have registered users are offered, narrowed province → city → barangay.
  const located = users.filter((account) => account.barangay_id);
  const provinceOptions = [...new Set(located.map((account) => account.province_name).filter(Boolean))].sort();
  const cityOptions = [...new Set(located.filter((account) => !province || account.province_name === province).map((account) => account.city_name).filter(Boolean))].sort();
  const barangayOptions = [...new Map(located.filter((account) => (!province || account.province_name === province) && (!city || account.city_name === city)).map((account) => [String(account.barangay_id), account.barangay_name])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const [nextRole, setNextRole] = useState('');
  const [emailing, setEmailing] = useState(null);
  // A first Admin goes Pending Approval → Awaiting Code → Code Sent, and only turns Active by entering the code.
  const accountStatus = (account) => !account.approved_at ? 'Pending Approval' : account.awaiting_staff_code ? (account.staff_code_sent_at ? 'Code Sent' : 'Awaiting Code') : account.is_active ? 'Active' : 'Deactivated';
  const waitingForCode = (account) => account.awaiting_staff_code && account.approved_at;
  const requestStateChange = (account) => {
    const pending = !account.approved_at;
    const activate = pending || !account.is_active;
    onRequestConfirmation({ title: pending ? 'Approve Registration' : activate ? 'Activate Account' : 'Deactivate Account', message: `${pending ? 'Approve' : activate ? 'Activate' : 'Deactivate'} ${account.name}'s account for ${account.barangay_name ?? 'their barangay'}?${activate ? '' : ' They will lose access and their active sessions will end.'}`, confirmLabel: pending ? 'Approve' : activate ? 'Activate' : 'Deactivate', variant: activate ? 'primary' : 'danger', onConfirm: () => pending ? onApprove(account) : onToggleActive(account) });
  };
  const requestRoleChange = (event) => {
    event.preventDefault();
    onRequestConfirmation({ title: 'Change Account Role', message: `Change ${editing.name}'s role from ${effectiveRoles(editing).join(', ')} to ${nextRole}? This replaces their current roles and changes account permissions.`, confirmLabel: 'Confirm Role Change', variant: 'primary', onConfirm: async () => { const success = await onChangeRole(editing, nextRole); if (success) setEditing(null); } });
  };
  const visible = users.filter((account) => (!province || account.province_name === province) && (!city || account.city_name === city) && (!barangay || String(account.barangay_id) === barangay) && (!role || effectiveRoles(account).includes(role)) && (!status || accountStatus(account) === status) && [account.name, account.email, location(account)].join(' ').toLowerCase().includes(search.trim().toLowerCase()));
  const columns = [
    { label: 'User', render: (account) => <AdminIdentity name={account.name} email={account.email} /> },
    { label: 'Barangay', render: (account) => <div className="sa-stacked"><strong>{account.barangay_name || 'Unassigned'}</strong><span>{[account.city_name, account.province_name].filter(Boolean).join(', ')}</span></div> },
    { label: 'Role', render: (account) => effectiveRoles(account).join(', ') },
    { label: 'Account Status', render: (account) => <StatusBadge value={accountStatus(account)} /> },
    { label: 'Actions', render: (account) => {
      const stateLabel = !account.approved_at ? 'Approve' : account.is_active ? 'Deactivate' : 'Activate';
      return <div className="sa-row-actions">
        <button className="ghost-button sa-icon-button sa-icon-edit" type="button" aria-label={`Edit role for ${account.name}`} title="Edit role" onClick={() => { setEditing(account); setNextRole(account.role); }}><Icon name="edit" size={17} /></button>
        {/* Once approved, a first Administrator activates only with the emailed code. */}
        {!waitingForCode(account) && <button type="button" className={`ghost-button sa-icon-button ${stateLabel === 'Deactivate' ? 'sa-destructive' : 'sa-icon-confirm'}`} aria-label={`${stateLabel} ${account.name}`} title={stateLabel} onClick={() => requestStateChange(account)}><Icon name={stateLabel === 'Deactivate' ? 'ban' : 'checkCircle'} size={17} /></button>}
        {(!account.approved_at || waitingForCode(account)) && <button className="ghost-button sa-icon-button sa-destructive" type="button" aria-label={`Reject ${account.name}`} title="Reject registration" onClick={() => onRequestConfirmation({ title: 'Reject Registration', message: `Permanently delete ${account.name}'s pending registration? This cannot be undone.`, confirmLabel: 'Reject & Delete', variant: 'danger', onConfirm: () => onReject(account) })}><Icon name="trash" size={17} /></button>}
        <button className={`ghost-button sa-icon-button sa-icon-mail${account.awaiting_staff_code ? ' sa-attention' : ''}`} type="button" aria-label={account.awaiting_staff_code ? `Send staff registration code to ${account.name}` : `Email ${account.name}`} title={account.awaiting_staff_code ? 'Send staff registration code' : 'Send email'} onClick={() => setEmailing(account)}><Icon name="mail" size={17} /></button>
      </div>;
    } },
  ];
  return <div className="superadmin-tab"><AdminManagementCard toolbar={<><LocalSearchInput value={search} onChange={setSearch} placeholder="Search user or email..." /><AdminFilterField label="Province"><SearchableSelect value={province} onChange={(event) => { setProvince(event.target.value); setCity(''); setBarangay(''); }}><option value="">All Provinces</option>{provinceOptions.map((name) => <option key={name}>{name}</option>)}</SearchableSelect></AdminFilterField><AdminFilterField label="City / Municipality"><SearchableSelect value={city} onChange={(event) => { setCity(event.target.value); setBarangay(''); }}><option value="">All Cities</option>{cityOptions.map((name) => <option key={name}>{name}</option>)}</SearchableSelect></AdminFilterField><AdminFilterField label="Barangay"><SearchableSelect value={barangay} onChange={(event) => setBarangay(event.target.value)}><option value="">All Barangays</option>{barangayOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</SearchableSelect></AdminFilterField><AdminFilterField label="Role"><SearchableSelect value={role} onChange={(event) => setRole(event.target.value)}><option value="">All Roles</option>{ROLES.map((name) => <option key={name}>{name}</option>)}</SearchableSelect></AdminFilterField><AdminFilterField label="Account status"><SearchableSelect value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All Statuses</option>{['Active', 'Deactivated', 'Pending Approval', 'Awaiting Code', 'Code Sent'].map((name) => <option key={name}>{name}</option>)}</SearchableSelect></AdminFilterField></>}>
    <PaginatedTable rows={visible} columns={columns} rowClassName={(account) => account.awaiting_staff_code ? 'sa-row-waiting' : undefined} emptyMessage="No matching users" emptyDescription="Try another user name or adjust the account filters." />
  </AdminManagementCard>{emailing && (emailing.awaiting_staff_code
    ? <StaffCodeEmail account={emailing} onSend={onSendStaffCode} onClose={() => setEmailing(null)} />
    : <MessageEmail account={emailing} onSend={onSendEmail} onClose={() => setEmailing(null)} onRequestConfirmation={onRequestConfirmation} />)}{editing && <AdminActionDrawer title="Edit account role" description="Review this account's access before saving." onClose={() => setEditing(null)}><AdminIdentity name={editing.name} email={editing.email} /><form className="sa-role-form" onSubmit={requestRoleChange}><p>Current roles: <strong>{effectiveRoles(editing).join(', ')}</strong></p><AdminFilterField label="New role"><SearchableSelect value={nextRole} onChange={(event) => setNextRole(event.target.value)}>{ROLES.map((name) => <option key={name}>{name}</option>)}</SearchableSelect></AdminFilterField><p className="muted">Saving replaces the account's current roles. Last-Administrator and account restrictions still apply.</p><div className="sa-row-actions"><button type="button" className="ghost-button" onClick={() => setEditing(null)}>Cancel</button><button type="submit" className="primary-button" disabled={nextRole === editing.role && effectiveRoles(editing).length === 1}>Save Role</button></div></form></AdminActionDrawer>}</div>;
}

export function RegistrationCodesTab({ barangays, initialBarangay, onRequestConfirmation, setNotice, onChanged }) {
  const [provinces, setProvinces] = useState([]);
  const [cityLookup, setCityLookup] = useState({ key: '', rows: [], error: null });
  const [cityRetry, setCityRetry] = useState(0);
  const [provinceId, setProvinceId] = useState('');
  const [cityId, setCityId] = useState('');
  const [barangayId, setBarangayId] = useState(initialBarangay ? String(initialBarangay.id) : '');
  const [result, setResult] = useState({ code: null, updated: null, loading: false, error: null });
  const [retry, setRetry] = useState(0);
  const [barangayLookup, setBarangayLookup] = useState({ cityId: '', rows: [], error: null });
  const [barangayRetry, setBarangayRetry] = useState(0);
  const cityLookupKey = `${provinceId}:${cityRetry}`;
  const cities = cityLookup.key === cityLookupKey ? cityLookup.rows : [];
  const citiesLoading = Boolean(provinceId) && cityLookup.key !== cityLookupKey;
  const citiesError = cityLookup.key === cityLookupKey ? cityLookup.error : null;
  const selectedRef = useRef(barangayId);
  useEffect(() => { selectedRef.current = barangayId; }, [barangayId]);
  useEffect(() => {
    let current = true;
    api.get('/provinces').then(({ data }) => { if (!current) return; setProvinces(data); if (initialBarangay) setProvinceId(String(data.find((p) => p.name === initialBarangay.province_name)?.id ?? '')); }).catch(() => { if (current) setNotice({ type: 'error', text: 'Could not load provinces. Please reopen Registration Codes to retry.' }); });
    return () => { current = false; };
  }, [initialBarangay, setNotice]);
  useEffect(() => {
    if (!provinceId) return;
    let current = true;
    api.get('/cities', { params: { province_id: provinceId } }).then(({ data }) => { if (!current) return; setCityLookup({ key: cityLookupKey, rows: data, error: null }); if (initialBarangay?.province_name === provinces.find((p) => String(p.id) === provinceId)?.name) setCityId(String(data.find((city) => city.name === initialBarangay.city_name)?.id ?? '')); }).catch(() => { if (current) setCityLookup({ key: cityLookupKey, rows: [], error: 'Could not load cities. Please retry.' }); });
    return () => { current = false; };
  }, [provinceId, initialBarangay, provinces, cityLookupKey]);
  useEffect(() => {
    if (!barangayId) return;
    let current = true;
    api.get(`/superadmin/barangays/${barangayId}/registration-code`).then(({ data }) => { if (current) { setResult({ code: data.staff_code, updated: data.updated_at, loading: false, error: null }); onChanged?.(); } }).catch((error) => { if (current) setResult({ code: null, updated: null, loading: false, error: error.response?.data?.message ?? 'Could not load the registration code.' }); });
    return () => { current = false; };
  }, [barangayId, retry, onChanged]);
  useEffect(() => {
    if (!cityId) return;
    let current = true;
    api.get('/barangays', { params: { city_id: cityId } }).then(({ data }) => {
      if (current) setBarangayLookup({ cityId, rows: data, error: null });
    }).catch(() => {
      if (current) setBarangayLookup({ cityId, rows: [], error: 'Could not load barangays. Please retry.' });
    });
    return () => { current = false; };
  }, [cityId, barangayRetry]);
  const selectedProvince = provinces.find((p) => String(p.id) === provinceId);
  const selectedCity = cities.find((city) => String(city.id) === cityId);
  const barangaysLoading = Boolean(cityId) && barangayLookup.cityId !== cityId;
  const barangaysError = barangayLookup.cityId === cityId ? barangayLookup.error : null;
  const options = useMemo(() => {
    if (!selectedCity || barangayLookup.cityId !== cityId) return [];
    const managed = barangays.filter((b) => b.city_name === selectedCity.name && b.province_name === selectedProvince?.name);
    return [...new Map([...managed, ...barangayLookup.rows].map((b) => [String(b.id), b])).values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [barangays, selectedCity, selectedProvince, barangayLookup, cityId]);
  const selected = options.find((b) => String(b.id) === barangayId) ?? barangays.find((b) => String(b.id) === barangayId);
  const changeBarangay = (id) => { selectedRef.current = id; setBarangayId(id); setResult({ code: null, updated: null, loading: Boolean(id), error: null }); };
  const regenerate = () => {
    const id = barangayId;
    onRequestConfirmation({ title: 'Regenerate Registration Code', message: `Regenerate the code for ${selected?.name}? The old code stops working immediately.`, confirmLabel: 'Regenerate', variant: 'danger', onConfirm: async () => {
      if (selectedRef.current === id) setResult({ code: null, updated: null, loading: true, error: null });
      try { const { data } = await api.post(`/superadmin/barangays/${id}/registration-code/regenerate`, { expected_updated_at: result.updated }); if (selectedRef.current === id) setResult({ code: data.staff_code, updated: data.updated_at, loading: false, error: null }); onChanged?.(); setNotice({ type: 'success', text: 'Registration code regenerated.' }); }
      catch (error) { if (selectedRef.current === id) setResult({ code: null, updated: null, loading: false, error: error.response?.data?.message ?? 'Could not regenerate that code.' }); if (error.response?.status === 409) setRetry((value) => value + 1); throw error; }
    } });
  };
  const copyCode = async () => { try { await navigator.clipboard.writeText(result.code); setNotice({ type: 'success', text: 'Registration code copied.' }); } catch { setNotice({ type: 'error', text: 'Could not copy automatically. Select the code and copy it manually.' }); } };
  return <div className="superadmin-tab sa-codes"><AdminManagementCard toolbar={<><AdminFilterField label="Province"><SearchableSelect value={provinceId} onChange={(event) => { setProvinceId(event.target.value); setCityId(''); changeBarangay(''); }}><option value="">Select a province</option>{provinces.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</SearchableSelect></AdminFilterField><AdminFilterField label="City / Municipality"><SearchableSelect disabled={!provinceId || citiesLoading || Boolean(citiesError)} value={cityId} onChange={(event) => { setCityId(event.target.value); changeBarangay(''); }}><option value="">{citiesLoading ? 'Loading cities...' : citiesError ? 'Cities unavailable' : provinceId ? 'Select a city' : 'Select a province first'}</option>{cities.map((city) => <option key={city.id} value={city.id}>{city.name}</option>)}</SearchableSelect></AdminFilterField><AdminFilterField label="Barangay"><SearchableSelect disabled={!cityId || barangaysLoading || Boolean(barangaysError) || !options.length} value={barangayId} onChange={(event) => changeBarangay(event.target.value)}><option value="">{barangaysLoading ? 'Loading barangays...' : barangaysError ? 'Barangays unavailable' : cityId ? (options.length ? 'Select a barangay' : 'No barangays available') : 'Select a city first'}</option>{options.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</SearchableSelect></AdminFilterField></>}>
    {citiesError && <p className="notice error" role="alert">{citiesError} <button type="button" className="ghost-button" onClick={() => setCityRetry((value) => value + 1)}>Retry cities</button></p>}
    {barangaysError && <p className="notice error" role="alert">{barangaysError} <button type="button" className="ghost-button" onClick={() => { setBarangayLookup({ cityId: '', rows: [], error: null }); setBarangayRetry((value) => value + 1); }}>Retry barangays</button></p>}
    {!barangayId ? <AdminEmptyState icon="key" title="Select a barangay" description="Choose a province, city, and barangay to view or provision its staff registration code." /> : result.error ? <AdminEmptyState icon="alert" title="Code unavailable" description={result.error}><button className="ghost-button" type="button" onClick={() => { setResult({ code: null, updated: null, loading: true, error: null }); setRetry(retry + 1); }}>Retry lookup</button></AdminEmptyState> : result.loading || !result.code ? <AdminEmptyState icon="key" title="Looking up registration code" description="Checking authorized access for this barangay." /> : <div className="sa-code-details"><div><h3>Registration Code Details</h3><p><strong>{selected?.name}</strong> · {[selectedCity?.name ?? selected?.city_name, selectedProvince?.name ?? selected?.province_name].filter(Boolean).join(', ')}</p></div><code>{result.code}</code>{result.updated && <p>Last updated {formatDate(result.updated)}</p>}<div className="sa-row-actions"><button className="primary-button" type="button" onClick={copyCode}><Icon name="clipboard" size={16} />Copy Code</button><button className="ghost-button sa-destructive" type="button" onClick={regenerate}>Regenerate Code</button></div></div>}
  </AdminManagementCard></div>;
}

export function ActivityLogTab() {
  const [filters, setFilters] = useState({ search: '', scope: 'all', page: 1, size: 25, attempt: 0 });
  const [result, setResult] = useState({ key: '', data: null, error: null });
  const [reviewing, setReviewing] = useState(null);
  const { search, scope, page, size, attempt } = filters;
  const path = `/superadmin/activity-log?${new URLSearchParams({ paginate: '1', q: search.trim(), scope, page: String(page), per_page: String(size) })}`;
  const key = `${path}:${attempt}`;
  const loading = result.key !== key;
  const updateFilters = (changes) => setFilters((current) => ({ ...current, page: 1, ...changes }));
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      api.get(path).then(({ data }) => {
        if (!current) return;
        if (data.current_page > data.last_page) {
          setFilters((previous) => ({ ...previous, page: data.last_page }));
          return;
        }
        setResult({ key, data, error: null });
      }).catch(() => { if (current) setResult({ key, data: null, error: 'Could not load activity records. Please retry.' }); });
    }, 200);
    return () => { current = false; clearTimeout(timer); };
  }, [path, key]);
  const columns = [
    { label: 'Date & Time', className: 'sa-date-cell', render: (entry) => formatDate(entry.created_at) },
    { label: 'Actor', render: (entry) => <AdminIdentity name={entry.user?.name ?? 'Deleted account'} /> },
    { label: 'Role', render: (entry) => entry.role ?? entry.user?.role ?? 'Not recorded' },
    { label: 'Action', render: (entry) => <StatusBadge value={entry.action} /> },
    { label: 'Category', className: 'cell-center', render: (entry) => <span className="log-category-tag">{entry.module ?? '-'}</span> },
    { label: 'Details', className: 'sa-log-details', render: (entry) => <><p className="sa-truncate">{entry.details}</p><button className="sa-text-button" type="button" onClick={() => setReviewing(entry)}>View full details</button></> },
  ];
  return <div className="superadmin-tab"><AdminManagementCard className="sa-support-card sa-log-card" summary={<><strong>{loading ? 'Loading activity records…' : result.error ? 'Activity records unavailable' : `${result.data.total} activity records`}</strong><span>Account and platform administration · Times shown in Philippine time</span></>} toolbar={<><div className="sa-segments"><button type="button" aria-pressed={scope === 'all'} onClick={() => updateFilters({ scope: 'all' })}>Full Platform Log</button><button type="button" aria-pressed={scope === 'superadmin'} onClick={() => updateFilters({ scope: 'superadmin' })}>Super Admin Actions Only</button></div><LocalSearchInput value={search} onChange={(value) => updateFilters({ search: value.slice(0, 200) })} placeholder="Search platform activity..." /></>}>
    {loading ? <p role="status">Loading activity records…</p> : result.error ? <p role="alert">{result.error} <button type="button" className="ghost-button" onClick={() => updateFilters({ attempt: attempt + 1, page })}>Retry activity records</button></p> : <PaginatedTable rows={result.data.data} columns={columns} pagination={{ page, size, total: result.data.total }} onPageChange={(value) => updateFilters({ page: value })} onPageSizeChange={(value) => updateFilters({ size: value })} initialPageSize={25} pageSizeOptions={[10, 25, 50, 100]} emptyMessage="No matching activity records" emptyDescription="Try another search or choose the full authorized platform log." />}
  </AdminManagementCard>{reviewing && <AdminActionDrawer title="Activity details" description={`Record ${reviewing.log_id ?? reviewing.id ?? ''}`} onClose={() => setReviewing(null)}><dl className="sa-detail-list"><dt>Date & time</dt><dd>{formatDate(reviewing.created_at)}</dd><dt>Actor</dt><dd>{reviewing.user?.name ?? 'Deleted account'}</dd><dt>Role at time of action</dt><dd>{reviewing.role ?? reviewing.user?.role ?? 'Not recorded'}</dd><dt>Action</dt><dd>{reviewing.action}</dd><dt>Module</dt><dd>{reviewing.module}</dd></dl><h3>Complete details</h3><p className="sa-full-text">{reviewing.details}</p></AdminActionDrawer>}</div>;
}
