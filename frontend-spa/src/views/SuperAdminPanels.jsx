import SearchableSelect from '../components/SearchableSelect';
import { useEffect, useRef, useState } from 'react';
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
  const requestReject = (account) => onRequestConfirmation({ title: 'Reject Registration', message: `Reject ${account.name}'s registration for ${account.barangay_name ?? 'their barangay'}? Their account is permanently deleted — this cannot be undone.`, confirmLabel: 'Reject & Delete', variant: 'danger', onConfirm: async () => { const success = await onReject(account); if (success) setReviewing(null); } });
  const matching = approvals.filter((account) => (!barangay || String(account.barangay_id) === barangay) && [account.name, account.email, account.role, location(account)].join(' ').toLowerCase().includes(search.trim().toLowerCase()));
  // Keep barangay groups together; groups awaiting their initial Admin lead.
  const priorityGroups = new Set(approvals.filter((account) => firstAdmin(account, barangays)).map((account) => account.barangay_id));
  const visible = matching.sort((a, b) => Number(priorityGroups.has(b.barangay_id)) - Number(priorityGroups.has(a.barangay_id)) || location(a).localeCompare(location(b)) || Number(firstAdmin(b, barangays)) - Number(firstAdmin(a, barangays)) || new Date(b.created_at) - new Date(a.created_at));
  const currentPage = Math.min(paging.page, Math.max(1, Math.ceil(visible.length / paging.size)));
  const pageRows = visible.slice((currentPage - 1) * paging.size, currentPage * paging.size);
  const actions = (account) => <div className="sa-row-actions"><button className="ghost-button" type="button" onClick={() => setReviewing(account)}>Review</button><button className="primary-button" type="button" onClick={() => requestApprove(account)}>Approve</button><button className="ghost-button sa-destructive" type="button" onClick={() => requestReject(account)}>Reject</button></div>;
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
        <div className="sa-application-body"><AdminIdentity name={reviewing.name} email={reviewing.email} /><dl className="sa-detail-list"><dt>Barangay</dt><dd>{location(reviewing)}</dd><dt>Requested role</dt><dd>{reviewing.role}</dd><dt>Phone</dt><dd>{reviewing.phone || 'Not provided'}</dd><dt>Submitted</dt><dd>{formatDate(reviewing.created_at)}</dd><dt>Account state</dt><dd><StatusBadge value="Pending Approval" /></dd><dt>Approval type</dt><dd>{firstAdmin(reviewing, barangays) ? 'Initial Administrator registration' : 'Staff registration'}</dd></dl></div>
        <footer className="sa-application-actions"><p>Approve this registration to grant account access, or reject the application.</p><div className="sa-row-actions"><button className="ghost-button" type="button" onClick={() => setReviewing(null)}>Cancel</button><button className="ghost-button sa-destructive" type="button" onClick={() => requestReject(reviewing)}>Reject application</button><button className="primary-button" type="button" onClick={() => requestApprove(reviewing)}>Approve application</button></div></footer>
      </> : <AdminEmptyState icon="clipboard" title="Application unavailable" description="This application may have already been reviewed. Return to Pending Approvals to see the current list." />}
    </section>
  </section>;
  return <div className="superadmin-tab"><AdminManagementCard summary={<><strong>{approvals.length} pending applications</strong><span>Initial Administrator applications are prioritized. All applicants are listed below.</span></>} toolbar={<><LocalSearchInput value={search} onChange={(value) => { setSearch(value); setPaging((current) => ({ ...current, page: 1 })); }} placeholder="Search applicant, email, or barangay..." /><AdminFilterField label="Barangay"><SearchableSelect value={barangay} onChange={(event) => { setBarangay(event.target.value); setPaging((current) => ({ ...current, page: 1 })); }}><option value="">All Barangays</option>{[...new Map(approvals.map((account) => [String(account.barangay_id), location(account)])).entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</SearchableSelect></AdminFilterField></>}>
    <PaginatedTable rows={pageRows} columns={columns} groupBy={location} pagination={{ ...paging, total: visible.length }} onPageChange={(page) => setPaging((current) => ({ ...current, page }))} onPageSizeChange={(size) => setPaging({ page: 1, size })} emptyIcon="checkCircle" emptyMessage={approvals.length ? 'No matching applications' : 'No pending approvals'} emptyDescription={approvals.length ? 'Try another applicant name or choose a different barangay.' : 'All account applications have been reviewed.'} />
  </AdminManagementCard></div>;
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

export function UsersTab({ users, onChangeRole, onToggleActive, onApprove, onReject, onSendEmail, onRequestConfirmation }) {
  // Barangay Management links here with ?user=<id> to land on one account.
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState(() => users.find((account) => String(account.id) === searchParams.get('user'))?.email ?? '');
  const [barangay, setBarangay] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState(null);
  const [nextRole, setNextRole] = useState('');
  const [emailing, setEmailing] = useState(null);
  // Approving is the last step. A first Admin approved under the retired
  // staff-code flow who never entered the code still reads as pending.
  const isPending = (account) => !account.approved_at || (account.awaiting_staff_code && !account.is_active);
  const accountStatus = (account) => isPending(account) ? 'Pending Approval' : account.is_active ? 'Active' : 'Deactivated';
  const requestStateChange = (account) => {
    const pending = isPending(account);
    const activate = pending || !account.is_active;
    onRequestConfirmation({ title: pending ? 'Approve Registration' : activate ? 'Activate Account' : 'Deactivate Account', message: `${pending ? 'Approve' : activate ? 'Activate' : 'Deactivate'} ${account.name}'s account for ${account.barangay_name ?? 'their barangay'}?${activate ? '' : ' They will lose access and their active sessions will end.'}`, confirmLabel: pending ? 'Approve' : activate ? 'Activate' : 'Deactivate', variant: activate ? 'primary' : 'danger', onConfirm: () => pending ? onApprove(account) : onToggleActive(account) });
  };
  const requestRoleChange = (event) => {
    event.preventDefault();
    onRequestConfirmation({ title: 'Change Account Role', message: `Change ${editing.name}'s role from ${effectiveRoles(editing).join(', ')} to ${nextRole}? This replaces their current roles and changes account permissions.`, confirmLabel: 'Confirm Role Change', variant: 'primary', onConfirm: async () => { const success = await onChangeRole(editing, nextRole); if (success) setEditing(null); } });
  };
  const visible = users.filter((account) => (!barangay || String(account.barangay_id) === barangay) && (!role || effectiveRoles(account).includes(role)) && (!status || accountStatus(account) === status) && [account.name, account.email, location(account)].join(' ').toLowerCase().includes(search.trim().toLowerCase()));
  const columns = [
    { label: 'User', render: (account) => <AdminIdentity name={account.name} email={account.email} /> },
    { label: 'Barangay', render: (account) => <div className="sa-stacked"><strong>{account.barangay_name || 'Unassigned'}</strong><span>{[account.city_name, account.province_name].filter(Boolean).join(', ')}</span></div> },
    { label: 'Role', render: (account) => effectiveRoles(account).join(', ') },
    { label: 'Account Status', render: (account) => <StatusBadge value={accountStatus(account)} /> },
    { label: 'Actions', render: (account) => {
      const stateLabel = isPending(account) ? 'Approve' : account.is_active ? 'Deactivate' : 'Activate';
      return <div className="sa-row-actions">
        <button className="ghost-button sa-icon-button" type="button" aria-label={`Edit role for ${account.name}`} title="Edit role" onClick={() => { setEditing(account); setNextRole(account.role); }}><Icon name="edit" size={17} /></button>
        <button type="button" className={`ghost-button sa-icon-button${stateLabel === 'Deactivate' ? ' sa-destructive' : ''}`} aria-label={`${stateLabel} ${account.name}`} title={stateLabel} onClick={() => requestStateChange(account)}><Icon name={stateLabel === 'Deactivate' ? 'ban' : 'checkCircle'} size={17} /></button>
        {isPending(account) && <button className="ghost-button sa-icon-button sa-destructive" type="button" aria-label={`Reject ${account.name}`} title="Reject registration" onClick={() => onRequestConfirmation({ title: 'Reject Registration', message: `Permanently delete ${account.name}'s pending registration? This cannot be undone.`, confirmLabel: 'Reject & Delete', variant: 'danger', onConfirm: () => onReject(account) })}><Icon name="trash" size={17} /></button>}
        <button className="ghost-button sa-icon-button" type="button" aria-label={`Email ${account.name}`} title="Send email" onClick={() => setEmailing(account)}><Icon name="mail" size={17} /></button>
      </div>;
    } },
  ];
  return <div className="superadmin-tab"><AdminManagementCard toolbar={<><LocalSearchInput value={search} onChange={setSearch} placeholder="Search user or email..." /><AdminFilterField label="Barangay"><SearchableSelect value={barangay} onChange={(event) => setBarangay(event.target.value)}><option value="">All Barangays</option>{[...new Map(users.map((account) => [String(account.barangay_id), location(account)])).entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</SearchableSelect></AdminFilterField><AdminFilterField label="Role"><SearchableSelect value={role} onChange={(event) => setRole(event.target.value)}><option value="">All Roles</option>{ROLES.map((name) => <option key={name}>{name}</option>)}</SearchableSelect></AdminFilterField><AdminFilterField label="Account status"><SearchableSelect value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All Statuses</option>{['Active', 'Deactivated', 'Pending Approval'].map((name) => <option key={name}>{name}</option>)}</SearchableSelect></AdminFilterField></>}>
    <PaginatedTable rows={visible} columns={columns} rowClassName={(account) => isPending(account) ? 'sa-row-waiting' : undefined} emptyMessage="No matching users" emptyDescription="Try another user name or adjust the account filters." />
  </AdminManagementCard>{emailing && <MessageEmail account={emailing} onSend={onSendEmail} onClose={() => setEmailing(null)} onRequestConfirmation={onRequestConfirmation} />}{editing && <AdminActionDrawer title="Edit account role" description="Review this account's access before saving." onClose={() => setEditing(null)}><AdminIdentity name={editing.name} email={editing.email} /><form className="sa-role-form" onSubmit={requestRoleChange}><p>Current roles: <strong>{effectiveRoles(editing).join(', ')}</strong></p><AdminFilterField label="New role"><SearchableSelect value={nextRole} onChange={(event) => setNextRole(event.target.value)}>{ROLES.map((name) => <option key={name}>{name}</option>)}</SearchableSelect></AdminFilterField><p className="muted">Saving replaces the account's current roles. Last-Administrator and account restrictions still apply.</p><div className="sa-row-actions"><button type="button" className="ghost-button" onClick={() => setEditing(null)}>Cancel</button><button type="submit" className="primary-button" disabled={nextRole === editing.role && effectiveRoles(editing).length === 1}>Save Role</button></div></form></AdminActionDrawer>}</div>;
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
    { label: 'Actor', render: (entry) => entry.user?.name ?? 'Deleted account' },
    { label: 'Role', render: (entry) => entry.role ?? entry.user?.role ?? 'Not recorded' },
    { label: 'Action', render: (entry) => <StatusBadge value={entry.action} /> },
    { label: 'Module', key: 'module' },
    { label: 'Details', className: 'sa-log-details', render: (entry) => <><p className="sa-truncate">{entry.details}</p><button className="sa-text-button" type="button" onClick={() => setReviewing(entry)}>View full details</button></> },
  ];
  return <div className="superadmin-tab"><AdminManagementCard summary={<><strong>{loading ? 'Loading activity records…' : result.error ? 'Activity records unavailable' : `${result.data.total} activity records`}</strong><span>Account and platform administration · Times shown in Philippine time</span></>} toolbar={<><div className="sa-segments"><button type="button" aria-pressed={scope === 'all'} onClick={() => updateFilters({ scope: 'all' })}>Full Platform Log</button><button type="button" aria-pressed={scope === 'superadmin'} onClick={() => updateFilters({ scope: 'superadmin' })}>Super Admin Actions Only</button></div><LocalSearchInput value={search} onChange={(value) => updateFilters({ search: value.slice(0, 200) })} placeholder="Search platform activity..." /></>}>
    {loading ? <p role="status">Loading activity records…</p> : result.error ? <p role="alert">{result.error} <button type="button" className="ghost-button" onClick={() => updateFilters({ attempt: attempt + 1, page })}>Retry activity records</button></p> : <PaginatedTable rows={result.data.data} columns={columns} pagination={{ page, size, total: result.data.total }} onPageChange={(value) => updateFilters({ page: value })} onPageSizeChange={(value) => updateFilters({ size: value })} initialPageSize={25} pageSizeOptions={[25, 50, 100]} emptyMessage="No matching activity records" emptyDescription="Try another search or choose the full authorized platform log." />}
  </AdminManagementCard>{reviewing && <AdminActionDrawer title="Activity details" description={`Record ${reviewing.log_id ?? reviewing.id ?? ''}`} onClose={() => setReviewing(null)}><dl className="sa-detail-list"><dt>Date & time</dt><dd>{formatDate(reviewing.created_at)}</dd><dt>Actor</dt><dd>{reviewing.user?.name ?? 'Deleted account'}</dd><dt>Role at time of action</dt><dd>{reviewing.role ?? reviewing.user?.role ?? 'Not recorded'}</dd><dt>Action</dt><dd>{reviewing.action}</dd><dt>Module</dt><dd>{reviewing.module}</dd></dl><h3>Complete details</h3><p className="sa-full-text">{reviewing.details}</p></AdminActionDrawer>}</div>;
}
