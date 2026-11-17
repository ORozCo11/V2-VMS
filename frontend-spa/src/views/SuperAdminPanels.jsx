import SearchableSelect from '../components/SearchableSelect';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api/axios';
import Icon from '../components/Icon';
import { DonutChart } from '../components/charts';
import { AdminActionDrawer, AdminEmptyState, AdminFilterField, AdminIdentity, AdminManagementCard, LocalSearchInput, PaginatedTable, StatusBadge } from '../components/SuperAdminUI';
import { formatDate } from '../utils/adminDate';

const ROLES = ['Admin', 'Custodian', 'Maintenance Personnel'];
const STATUS_LABELS = { pending_invitation: 'Pending Invitation', active: 'Active', disabled: 'Disabled', invitation_expired: 'Invitation Expired' };
const effectiveRoles = (account) => [...new Set([...(account.roles ?? []), account.role].filter(Boolean))];
const location = (record) => [record.barangay_name, record.city_name, record.province_name].filter(Boolean).join(', ') || 'Unassigned';

export function PlatformOverview({ barangays, onNavigate }) {
  const [expanded, setExpanded] = useState(false);
  const boundaries = barangays.filter((b) => b.boundary_status === 'needs_review');
  const active = barangays.filter((b) => b.has_active_admin).length;
  const metrics = [
    { label: 'Registered Barangays', value: barangays.length, icon: 'pin', tab: 'barangays', detail: `${active} with an active Administrator` },
    { label: 'Boundaries Needing Review', value: boundaries.length, icon: 'pin', tab: 'barangays', filter: 'boundary_review', detail: 'Candidate boundaries to verify' },
  ];
  const items = [
    ...boundaries.map((b) => ({ key: `boundary-${b.id}`, title: 'Review candidate boundary', detail: `${b.name}, ${b.city_name ?? ''}`, status: 'Needs Review', date: b.updated_at, tab: 'barangays', filter: 'boundary_review' })),
    ...barangays.filter((b) => !b.has_active_admin).map((b) => ({ key: `recovery-${b.id}`, title: 'Create or recover Administrator', detail: `${b.name}, ${b.city_name ?? ''}`, status: 'No Active Admin', tab: 'barangays', filter: 'orphaned' })),
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

function MessageEmail({ account, onSend, onClose }) {
  const [draft, setDraft] = useState({ subject: '', message: '' });
  const [sending, setSending] = useState(false);
  const send = async (event) => { event.preventDefault(); setSending(true); if (await onSend(account, draft)) onClose(); else setSending(false); };
  return <AdminActionDrawer centered title="Send email" description="Write a message to this account. It is sent from the VMS Support Center address." onClose={onClose}>
    <form className="sa-email-form" onSubmit={send}>
      <dl className="sa-email-meta"><dt>To</dt><dd>{account.name} &lt;{account.email}&gt;</dd>{account.barangay_id && <><dt>Barangay</dt><dd>{location(account)}</dd></>}</dl>
      <label>Subject<input required maxLength={150} value={draft.subject} onChange={(event) => setDraft({ ...draft, subject: event.target.value })} /></label>
      <label>Message<textarea required maxLength={5000} value={draft.message} onChange={(event) => setDraft({ ...draft, message: event.target.value })} /></label>
      <div className="sa-row-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={sending || !draft.subject.trim() || !draft.message.trim()}><Icon name="mail" size={16} />{sending ? 'Sending…' : 'Send Email'}</button></div>
    </form>
  </AdminActionDrawer>;
}

function AllAccountsTable({ users, onChangeRole, onToggleActive, onResend, onSendEmail, onRequestConfirmation }) {
  // Barangay Management links here with ?user=<id> to land on one account.
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState(() => users.find((account) => String(account.id) === searchParams.get('user'))?.email ?? '');
  const [province, setProvince] = useState('');
  const [city, setCity] = useState('');
  const [barangay, setBarangay] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState(null);
  // Only locations that actually have users are offered, narrowed province → city → barangay.
  const located = users.filter((account) => account.barangay_id);
  const provinceOptions = [...new Set(located.map((account) => account.province_name).filter(Boolean))].sort();
  const cityOptions = [...new Set(located.filter((account) => !province || account.province_name === province).map((account) => account.city_name).filter(Boolean))].sort();
  const barangayOptions = [...new Map(located.filter((account) => (!province || account.province_name === province) && (!city || account.city_name === city)).map((account) => [String(account.barangay_id), account.barangay_name])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const [nextRole, setNextRole] = useState('');
  const [emailing, setEmailing] = useState(null);
  const accountStatus = (account) => STATUS_LABELS[account.account_status] ?? (account.is_active ? 'Active' : 'Disabled');
  const requestDeactivate = (account) => onRequestConfirmation({ title: 'Deactivate Account', message: `Deactivate ${account.name}'s account for ${account.barangay_name ?? 'their barangay'}? They will lose access and their active sessions will end.`, confirmLabel: 'Deactivate', variant: 'danger', onConfirm: () => onToggleActive(account) });
  const requestResend = (account) => onRequestConfirmation({ title: account.account_status === 'active' ? 'Send Password Reset' : 'Resend Invitation', message: account.account_status === 'active' ? `Email ${account.name} (${account.email}) a link to choose a new password? The link works once and expires in 24 hours.` : `Send ${account.name} (${account.email}) a new invitation? Any earlier invitation link stops working.`, confirmLabel: account.account_status === 'active' ? 'Send Reset Link' : 'Resend Invitation', variant: 'primary', onConfirm: () => onResend(account) });
  const requestRoleChange = (event) => {
    event.preventDefault();
    onRequestConfirmation({ title: 'Change Account Role', message: `Change ${editing.name}'s role from ${effectiveRoles(editing).join(', ')} to ${nextRole}? This replaces their current roles and changes account permissions.`, confirmLabel: 'Confirm Role Change', variant: 'primary', onConfirm: async () => { const success = await onChangeRole(editing, nextRole); if (success) setEditing(null); } });
  };
  const visible = users.filter((account) => (!province || account.province_name === province) && (!city || account.city_name === city) && (!barangay || String(account.barangay_id) === barangay) && (!role || effectiveRoles(account).includes(role)) && (!status || accountStatus(account) === status) && [account.name, account.email, location(account)].join(' ').toLowerCase().includes(search.trim().toLowerCase()));
  const columns = [
    { label: 'ID', key: 'id', className: 'cell-center' },
    { label: 'User', render: (account) => <AdminIdentity name={account.name} email={account.email} /> },
    { label: 'Barangay', render: (account) => <div className="sa-stacked"><strong>{account.barangay_name || 'Unassigned'}</strong><span>{[account.city_name, account.province_name].filter(Boolean).join(', ')}</span></div> },
    { label: 'Role', render: (account) => effectiveRoles(account).join(', ') },
    { label: 'Account Status', render: (account) => <StatusBadge value={accountStatus(account)} /> },
    { label: 'Actions', render: (account) => <div className="sa-row-actions">
      <button className="ghost-button sa-icon-button sa-icon-edit" type="button" aria-label={`Edit role for ${account.name}`} title="Edit role" onClick={() => { setEditing(account); setNextRole(account.role); }}><Icon name="edit" size={17} /></button>
      {account.role === 'Admin' && <button type="button" className="ghost-button sa-icon-button sa-icon-confirm" aria-label={`Resend invitation or reset password for ${account.name}`} title={account.account_status === 'active' ? 'Reset password' : 'Resend invitation'} onClick={() => requestResend(account)}><Icon name="key" size={17} /></button>}
      {account.role === 'Admin' && account.account_status === 'active' && <button type="button" className="ghost-button sa-icon-button sa-destructive" aria-label={`Disable ${account.name}`} title="Disable account" onClick={() => requestDeactivate(account)}><Icon name="ban" size={17} /></button>}
      <button className="ghost-button sa-icon-button sa-icon-mail" type="button" aria-label={`Email ${account.name}`} title="Send email" onClick={() => setEmailing(account)}><Icon name="mail" size={17} /></button>
    </div> },
  ];
  return <div className="superadmin-tab"><AdminManagementCard toolbar={<><LocalSearchInput value={search} onChange={setSearch} placeholder="Search user or email..." /><AdminFilterField label="Province"><SearchableSelect value={province} onChange={(event) => { setProvince(event.target.value); setCity(''); setBarangay(''); }}><option value="">All Provinces</option>{provinceOptions.map((name) => <option key={name}>{name}</option>)}</SearchableSelect></AdminFilterField><AdminFilterField label="City / Municipality"><SearchableSelect value={city} onChange={(event) => { setCity(event.target.value); setBarangay(''); }}><option value="">All Cities</option>{cityOptions.map((name) => <option key={name}>{name}</option>)}</SearchableSelect></AdminFilterField><AdminFilterField label="Barangay"><SearchableSelect value={barangay} onChange={(event) => setBarangay(event.target.value)}><option value="">All Barangays</option>{barangayOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</SearchableSelect></AdminFilterField><AdminFilterField label="Role"><SearchableSelect value={role} onChange={(event) => setRole(event.target.value)}><option value="">All Roles</option>{ROLES.map((name) => <option key={name}>{name}</option>)}</SearchableSelect></AdminFilterField><AdminFilterField label="Account status"><SearchableSelect value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All Statuses</option>{Object.values(STATUS_LABELS).map((name) => <option key={name}>{name}</option>)}</SearchableSelect></AdminFilterField></>}>
    <PaginatedTable rows={visible} columns={columns} emptyMessage="No matching users" emptyDescription="Try another user name or adjust the account filters." />
  </AdminManagementCard>{emailing && <MessageEmail account={emailing} onSend={onSendEmail} onClose={() => setEmailing(null)} />}{editing && <AdminActionDrawer title="Edit account role" description="Review this account's access before saving." onClose={() => setEditing(null)}><AdminIdentity name={editing.name} email={editing.email} /><form className="sa-role-form" onSubmit={requestRoleChange}><p>Current roles: <strong>{effectiveRoles(editing).join(', ')}</strong></p><AdminFilterField label="New role"><SearchableSelect value={nextRole} onChange={(event) => setNextRole(event.target.value)}>{ROLES.map((name) => <option key={name}>{name}</option>)}</SearchableSelect></AdminFilterField><p className="muted">Saving replaces the account's current roles. Last-Administrator and account restrictions still apply.</p><div className="sa-row-actions"><button type="button" className="ghost-button" onClick={() => setEditing(null)}>Cancel</button><button type="submit" className="primary-button" disabled={nextRole === editing.role && effectiveRoles(editing).length === 1}>Save Role</button></div></form></AdminActionDrawer>}</div>;
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
    { label: 'ID', className: 'cell-center', render: (entry) => entry.log_id ?? entry.id ?? '—' },
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

export function CreateAdminDrawer({ barangay, onSubmit, onClose }) {
  const [form, setForm] = useState({ name: '', email: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    const failure = await onSubmit(barangay, { name: form.name.trim(), email: form.email.trim() });
    if (failure) { setError(failure); setBusy(false); }
  };
  return <AdminActionDrawer centered title="Invite Barangay Admin" description={`The one Administrator of ${barangay.name}. They receive an email invitation and choose their own password. The link expires after 24 hours.`} onClose={onClose}>
    <form className="sa-email-form" onSubmit={submit}>
      <label>Full name<input required maxLength={120} value={form.name} onChange={set('name')} autoComplete="off" /></label>
      <label>Email address<input required type="email" maxLength={150} value={form.email} onChange={set('email')} autoComplete="off" /></label>
      <label>Assigned barangay<input value={[barangay.name, barangay.city_name].filter(Boolean).join(', ')} readOnly disabled /></label>
      <label>Role<input value="Admin" readOnly disabled /></label>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="sa-row-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={busy || !form.name.trim() || !form.email.trim()}><Icon name="mail" size={16} />{busy ? 'Sending…' : 'Send Invitation'}</button></div>
    </form>
  </AdminActionDrawer>;
}

export function CredentialsDialog({ result, onClose }) {
  return <AdminActionDrawer centered title={result.title} onClose={onClose} footer={<div className="sa-row-actions"><button type="button" className="primary-button" onClick={onClose}>Done</button></div>}>
    {result.email_sent
      ? <p>{result.lead} An email was handed to the mail server for <strong>{result.email}</strong>. The link expires in 24 hours and works once.</p>
      : <p className="sa-notice-warn" role="alert"><strong>{result.lead} The email could not be sent to {result.email}.</strong> The account is saved. Check the mail settings, then use "Resend invitation".</p>}
  </AdminActionDrawer>;
}

const accountLabel = (account) => STATUS_LABELS[account.account_status] ?? 'Active';

function BarangayAdmins({ barangay, refreshKey, onBack, onInvite, onResend, onRevoke, onDisable, onReactivate, onRequestConfirmation }) {
  const [admins, setAdmins] = useState(null);
  const [error, setError] = useState('');
  const [inviting, setInviting] = useState(false);
  const [details, setDetails] = useState(null);
  useEffect(() => {
    let current = true;
    api.get(`/superadmin/barangays/${barangay.id}/admins`).then(({ data }) => { if (current) { setAdmins(data); setError(''); } })
      .catch(() => { if (current) setError('Could not load the Admin accounts. Please retry.'); });
    return () => { current = false; };
  }, [barangay.id, refreshKey]);
  const confirm = (title, message, confirmLabel, action, variant = 'primary') => onRequestConfirmation({ title, message, confirmLabel, variant, onConfirm: action });
  const columns = [
    { label: 'Admin', render: (account) => <AdminIdentity name={account.name} email={account.email} /> },
    { label: 'Account Status', render: (account) => <StatusBadge value={accountLabel(account)} /> },
    { label: 'Actions', render: (account) => {
      const status = account.account_status;
      return <div className="sa-row-actions">
        <button className="ghost-button" type="button" onClick={() => setDetails(account)}>View details</button>
        {(status === 'pending_invitation' || status === 'invitation_expired') && <button className="ghost-button" type="button" onClick={() => confirm('Resend Invitation', `Send ${account.name} (${account.email}) a new invitation? Any earlier link stops working.`, 'Resend Invitation', () => onResend(account))}>Resend invitation</button>}
        {status === 'pending_invitation' && <button className="ghost-button sa-destructive" type="button" onClick={() => confirm('Revoke Invitation', `Revoke the pending invitation for ${account.name}? The link will stop working.`, 'Revoke', () => onRevoke(account), 'danger')}>Revoke</button>}
        {status === 'active' && <button className="ghost-button" type="button" onClick={() => confirm('Reset Password', `Email ${account.name} a link to choose a new password? It works once and expires in 24 hours.`, 'Send Reset Link', () => onResend(account))}>Reset password</button>}
        {status === 'active' && <button className="ghost-button sa-destructive" type="button" onClick={() => confirm('Disable Account', `Disable ${account.name}'s account? They lose access and their sessions end immediately.`, 'Disable', () => onDisable(account), 'danger')}>Disable</button>}
        {status === 'disabled' && <button className="ghost-button" type="button" onClick={() => confirm('Reactivate Account', `Let ${account.name} sign in again?`, 'Reactivate', () => onReactivate(account))}>Reactivate</button>}
      </div>;
    } },
  ];
  const hasAdmin = (admins ?? []).length > 0;
  return <div className="superadmin-tab"><AdminManagementCard summary={<><button type="button" className="sa-text-button" onClick={onBack}>← Barangay Directory</button><strong>Barangay {barangay.name} — Admin accounts</strong><span>{[barangay.city_name, barangay.province_name].filter(Boolean).join(', ')}</span></>}
    toolbar={<button type="button" className="primary-button" disabled={hasAdmin} title={hasAdmin ? 'This barangay already has an Admin' : undefined} onClick={() => setInviting(true)}><Icon name="mail" size={16} />Invite Barangay Admin</button>}>
    {error ? <p role="alert">{error}</p> : admins === null ? <p role="status">Loading Admin accounts…</p> : <PaginatedTable rows={admins} columns={columns} emptyMessage="No Admin accounts yet" emptyDescription="Invite this barangay's Admin to get started." />}
  </AdminManagementCard>
  {inviting && <CreateAdminDrawer barangay={barangay} onClose={() => setInviting(false)} onSubmit={async (b, form) => { const failure = await onInvite(b, form); if (!failure) setInviting(false); return failure; }} />}
  {details && <AdminActionDrawer title="Account details" description={details.email} onClose={() => setDetails(null)}><dl className="sa-detail-list"><dt>Name</dt><dd>{details.name}</dd><dt>Email</dt><dd>{details.email}</dd><dt>Role</dt><dd>{details.role}</dd><dt>Barangay</dt><dd>{barangay.name}</dd><dt>Status</dt><dd>{accountLabel(details)}</dd><dt>Activated</dt><dd>{details.activated_at && details.account_status !== 'pending_invitation' && details.account_status !== 'invitation_expired' ? formatDate(details.activated_at) : 'Not yet'}</dd></dl></AdminActionDrawer>}</div>;
}

/** Users → Barangay Directory → Barangay Admin Accounts (the LGU Super Admin only ever manages Admins). */
export function UsersTab({ users, onInvite, onResend, onRevoke, onToggleActive, onReactivate, onChangeRole, onSendEmail, onRequestConfirmation }) {
  const [view, setView] = useState('directory');
  const [directory, setDirectory] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState('');
  useEffect(() => {
    let current = true;
    api.get('/superadmin/barangay-directory').then(({ data }) => { if (current) { setDirectory(data); setError(''); } })
      .catch(() => { if (current) setError('Could not load the barangay directory. Please retry.'); });
    return () => { current = false; };
  }, [users]);

  if (view === 'accounts') {
    return <div className="superadmin-tab"><div className="sa-segments"><button type="button" aria-pressed={false} onClick={() => setView('directory')}>Barangay Directory</button><button type="button" aria-pressed>All accounts</button></div>
      <AllAccountsTable users={users} onChangeRole={onChangeRole} onToggleActive={onToggleActive} onResend={onResend} onSendEmail={onSendEmail} onRequestConfirmation={onRequestConfirmation} /></div>;
  }
  if (selected) {
    return <BarangayAdmins barangay={selected} refreshKey={users} onBack={() => setSelected(null)} onInvite={onInvite} onResend={onResend} onRevoke={onRevoke} onDisable={onToggleActive} onReactivate={onReactivate} onRequestConfirmation={onRequestConfirmation} />;
  }
  const visible = (directory ?? []).filter((b) => b.name.toLowerCase().includes(search.trim().toLowerCase()));
  return <div className="superadmin-tab">
    <div className="sa-segments"><button type="button" aria-pressed>Barangay Directory</button><button type="button" aria-pressed={false} onClick={() => setView('accounts')}>All accounts</button></div>
    <AdminManagementCard toolbar={<LocalSearchInput value={search} onChange={setSearch} placeholder="Search barangay..." />}>
      {error ? <p role="alert">{error}</p> : directory === null ? <p role="status">Loading barangays…</p> : !directory.length
        ? <AdminEmptyState icon="pin" title="No barangays in your LGU yet" description="Add a barangay first, then invite its Admin." />
        : !visible.length ? <AdminEmptyState icon="pin" title="No matching barangays" description="Try another name." />
        : <ul className="sa-directory" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>{visible.map((b) => <li key={b.id}>
          <button type="button" className="focus-card" style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={() => setSelected(b)} aria-label={`Open ${b.name} Admin accounts`}>
            <strong>{b.name}</strong><br /><span className="muted">{[b.city_name, b.province_name].filter(Boolean).join(', ')}</span>
            <p style={{ margin: '8px 0 4px' }}>{b.admin_count} Admin account{b.admin_count === 1 ? '' : 's'}</p>
            <span className="muted">{b.active_count} active · {b.pending_count} pending{b.expired_count ? ` · ${b.expired_count} expired` : ''}{b.disabled_count ? ` · ${b.disabled_count} disabled` : ''}</span>
          </button></li>)}</ul>}
    </AdminManagementCard>
  </div>;
}
