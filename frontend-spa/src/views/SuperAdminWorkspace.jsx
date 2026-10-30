import ThemeToggle from '../components/ThemeToggle';
import SearchableSelect from '../components/SearchableSelect';
import ImpersonationPicker from '../components/ImpersonationPicker';
import EndImpersonationAction from '../components/EndImpersonationAction';
import { useLocation, useMatch, useNavigate } from 'react-router-dom';
import VMSLogo from '../components/VMSLogo';
import '../components/RoleDashboard.css';
import './SuperAdminWorkspace.css';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import 'leaflet/dist/leaflet.css';
import { MapContainer, Polygon, TileLayer } from 'react-leaflet';
import BoundaryReviewModal from '../components/BoundaryReviewModal';
import api from '../api/axios';
import Icon from '../components/Icon';
import WorkspaceFooter from '../components/WorkspaceFooter';
import { AdminConfirmDialog, AdminFilterField, AdminManagementCard, LocalSearchInput, PaginatedTable, StatusBadge, SuccessCelebration } from '../components/SuperAdminUI';
import { geoJsonToPolygons } from '../utils/boundary';
import { ActivityLogTab, PendingApprovalsTab, PlatformOverview, UsersTab } from './SuperAdminPanels';
import { AuthContext } from '../context/AuthContextObject';
import SupportCenterTab from './SupportCenterTab';


// Kept separate from every other role's landing route — a Super Admin never
// lands on the fleet-oriented Workspace.jsx shell, since RestrictSuperAdminScope
// (backend) blocks that account from all fleet-data endpoints anyway.



// Flat platform navigation preserves the existing module keys.
const TABS = [
  ['dashboard', 'Platform Overview'], ['barangays', 'Barangay Management'], ['pending', 'Pending Approvals'],
  ['users', 'Users'], ['activity', 'Activity Log'],
  ['support', 'Support Center'],
];

const TAB_DESCRIPTIONS = {
  dashboard: 'Manage barangays, user accounts, and platform administration.',
  barangays: 'Manage registered barangays and their platform configuration.',
  pending: 'Review account requests and keep every barangay properly staffed.',
  users: 'Manage platform users, roles, and account availability by location.',
  activity: 'A chronological record of platform and Super Admin activity.',
  settings: 'Manage your Super Admin account settings and security.',
  support: 'Review and manage concerns submitted through the public Support Center.',
};

function UsersIcon() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

const TAB_ICONS = {
  barangays: <Icon name="pin" size={18} className="nav-icon" />,
  dashboard: <Icon name="grid" size={18} className="nav-icon" />,
  pending: <Icon name="clipboard" size={18} className="nav-icon" />,
  users: <UsersIcon />,
  activity: <Icon name="clipboard" size={18} className="nav-icon" />,
  settings: <Icon name="key" size={18} className="nav-icon" />,
  support: <Icon name="mail" size={18} className="nav-icon" />,
};

function ProfileMenu({ user, open, setOpen, onOpenSettings, onLogout }) {
  const initials = user.name ? user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() : 'U';
  return (
    <>
      <button className="profile-menu-trigger" type="button" onClick={() => setOpen((v) => !v)} aria-label="Account menu" aria-expanded={open}>
        <span className="profile-menu-avatar">{initials}</span>
      </button>
      {open && (
        <div className="profile-menu-dropdown">
          <div className="profile-menu-user">
            <span className="profile-menu-avatar">{initials}</span>
            <div className="profile-menu-user-info">
              <span className="profile-menu-name">{user.name}</span>
              <span className="profile-menu-role">{user.role}</span>
            </div>
          </div>
          <div className="profile-menu-divider" />
          <button className="profile-menu-item" type="button" onClick={() => { onOpenSettings(); setOpen(false); }}>
            <Icon name="key" size={15} /> My Settings
          </button>
          <div className="profile-menu-divider" />
          <button className="profile-menu-item profile-menu-item-danger" type="button" onClick={onLogout}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 15, height: 15 }}>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Logout
          </button>
        </div>
      )}
    </>
  );
}

// The LGU creates a barangay's Admin directly; the server emails a temporary
// password and sign-in link, so nothing secret is shown here.
function CreateBarangayAdminForm({ barangay, onCreated }) {
  const empty = { name: '', email: '', phone: '' };
  const [form, setForm] = useState(empty);
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const update = (event) => setForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setErrors({});
    setMessage('');
    try {
      const { data } = await api.post(`/superadmin/barangays/${barangay.id}/admins`, { ...form, phone: form.phone || null });
      setForm(empty);
      await onCreated(data.message);
    } catch (error) {
      const data = error.response?.data;
      if (data?.errors) setErrors(Object.fromEntries(Object.entries(data.errors).map(([field, list]) => [field, list[0]])));
      else setMessage(data?.message ?? `The Admin account for ${barangay.name} was not created because the server could not be reached. Check your connection and try again.`);
    } finally {
      setSaving(false);
    }
  };
  const field = (name, label, type, extra = {}) => <>
    <AdminFilterField label={label}><input name={name} type={type} value={form[name]} onChange={update} {...extra} /></AdminFilterField>
    {errors[name] && <p className="notice error" role="alert">{errors[name]}</p>}
  </>;
  return <form className="sa-detail-section" onSubmit={submit} noValidate>
    <h3>Create Administrator account</h3>
    <p>The Admin will get an email with a temporary password and a link to sign in. They must choose their own password the first time they sign in.</p>
    {field('name', 'Full name', 'text', { required: true, autoComplete: 'name' })}
    {field('email', 'Email address', 'email', { required: true, autoComplete: 'email' })}
    {field('phone', 'Phone (optional)', 'tel', { placeholder: '09171234567', inputMode: 'numeric' })}
    {message && <p className="notice error" role="alert">{message}</p>}
    <button type="submit" className="primary-button" disabled={saving || !form.name.trim() || !form.email.trim()}>{saving ? 'Creating and emailing…' : 'Create Admin and send email'}</button>
  </form>;
}

function BarangayManagementTab({ barangays, users, onPromote, onAdminCreated, onAddedBarangay, onRetryBoundary, onConfirmBoundary, onDiscardBoundary, onBoundarySaved, initialFilter, showAddForm, onCloseAdd, onRequestConfirmation }) {
  const [activeFilter, setActiveFilter] = useState(initialFilter || 'all');
  const [search, setSearch] = useState('');
  const [provinceFilter, setProvinceFilter] = useState('');
  const [cityFilter, setCityFilter] = useState('');
  const [boundaryFilter, setBoundaryFilter] = useState('');
  const navigate = useNavigate();
  const detailRoute = useMatch('/superadmin/barangays/:barangayId');
  const managingId = detailRoute?.params.barangayId;
  const setManagingId = (id) => navigate(id == null ? '/superadmin/barangays' : `/superadmin/barangays/${id}`);
  const [pickedUserId, setPickedUserId] = useState('');
  const [reviewingBoundary, setReviewingBoundary] = useState(null);
  const [retryingId, setRetryingId] = useState(null);
  const orphaned = barangays.filter((b) => !b.has_active_admin);
  const pending = barangays.filter((b) => b.boundary_status === 'needs_review');
  const provinceOptions = [...new Set(barangays.map((b) => b.province_name).filter(Boolean))].sort();
  const cities = [...new Set(barangays.filter((b) => !provinceFilter || b.province_name === provinceFilter).map((b) => b.city_name).filter(Boolean))].sort();
  const boundaryStatus = (b) => b.boundary_status === 'verified' ? 'Reviewed' : b.boundary_status === 'needs_review' ? 'Needs Review' : 'Not Found';
  const filtered = barangays.filter((b) => (activeFilter === 'all' || activeFilter === 'active' && b.has_active_admin || activeFilter === 'orphaned' && !b.has_active_admin || activeFilter === 'boundary_review' && b.boundary_status === 'needs_review') && (!provinceFilter || b.province_name === provinceFilter) && (!cityFilter || b.city_name === cityFilter) && (!boundaryFilter || boundaryStatus(b) === boundaryFilter) && [b.name, b.city_name, b.province_name].join(' ').toLowerCase().includes(search.trim().toLowerCase()));
  const managing = barangays.find((b) => String(b.id) === managingId);
  const candidates = managing ? users.filter((account) => account.barangay_id === managing.id) : [];
  const waitingAdmins = candidates.filter((account) => account.awaiting_staff_code && !account.is_active);
  const retryBoundary = async (b) => { setRetryingId(b.id); try { await onRetryBoundary(b); } finally { setRetryingId(null); } };
  const columns = [
    { label: 'Barangay', render: (b) => <strong>{b.name}</strong> },
    { label: 'City / Province', render: (b) => <div className="sa-stacked"><strong>{b.city_name || 'Not specified'}</strong><span>{b.province_name || 'Not specified'}</span></div> },
    { label: 'Staff Count', key: 'staff_count' },
    { label: 'Administrator Status', render: (b) => <div className="sa-stacked"><StatusBadge value={b.has_active_admin ? 'Active Admin' : 'No Active Admin'} />{b.sole_active_admin && <span className="sa-warning"><Icon name="alert" size={12} />Only one active Admin</span>}</div> },
    { label: 'Boundary Status', render: (b) => <StatusBadge value={boundaryStatus(b)} /> },
    { label: 'Actions', render: (b) => <button type="button" className="ghost-button" onClick={() => { setManagingId(b.id); setPickedUserId(''); }}>View / Manage</button> },
  ];
  return <div className="superadmin-tab">
    {showAddForm && <AddBarangayForm existingBarangayIds={barangays.map((b) => String(b.id))} onAdded={(created) => { onAddedBarangay(created); onCloseAdd(); }} onCancel={onCloseAdd} />}
    {!managingId && <AdminManagementCard summary={<div className="sa-segments">{[['all', 'All Barangays', barangays.length], ['active', 'Active Admin', barangays.length - orphaned.length], ['orphaned', 'Orphaned', orphaned.length], ['boundary_review', 'Needs Boundary Review', pending.length]].map(([key, label, count]) => <button key={key} type="button" aria-pressed={activeFilter === key} onClick={() => setActiveFilter(key)}>{label}<span>{count}</span></button>)}</div>} toolbar={<>
      <LocalSearchInput value={search} onChange={setSearch} placeholder="Search barangay, city, or province..." />
      <AdminFilterField label="Province"><SearchableSelect aria-label="Filter by province" value={provinceFilter} onChange={(event) => { setProvinceFilter(event.target.value); setCityFilter(''); }}><option value="">All Provinces</option>{provinceOptions.map((province) => <option key={province}>{province}</option>)}</SearchableSelect></AdminFilterField>
      <AdminFilterField label="City"><SearchableSelect aria-label="Filter by city" value={cityFilter} onChange={(event) => setCityFilter(event.target.value)}><option value="">All Cities</option>{cities.map((city) => <option key={city}>{city}</option>)}</SearchableSelect></AdminFilterField>
      <AdminFilterField label="Boundary status"><SearchableSelect aria-label="Boundary status" value={boundaryFilter} onChange={(event) => setBoundaryFilter(event.target.value)}><option value="">All Boundaries</option>{['Reviewed', 'Needs Review', 'Not Found'].map((status) => <option key={status}>{status}</option>)}</SearchableSelect></AdminFilterField>
    </>}><PaginatedTable rows={filtered} columns={columns} emptyIcon="pin" emptyMessage="No barangays found" emptyDescription="Try another search or adjust the location and status filters." /></AdminManagementCard>}
    {managingId && !managing && <p role="alert">Barangay not found. <button type="button" className="ghost-button" onClick={() => setManagingId(null)}>Back to Barangays</button></p>}
    {managing && <section className="sa-management-card sa-barangay-page">
      <header className="sa-barangay-page-header"><button type="button" className="ghost-button" onClick={() => setManagingId(null)}><Icon name="arrowLeft" size={15} />Back to Barangays</button><h2>{managing.name}</h2><p>{[managing.city_name, managing.province_name].filter(Boolean).join(', ')}</p></header>
      <div className="sa-barangay-page-grid">
      <dl className="sa-detail-list"><dt>Registered staff</dt><dd>{managing.staff_count}</dd><dt>Administrator status</dt><dd><StatusBadge value={managing.has_active_admin ? 'Active Admin' : 'No Active Admin'} /></dd>{waitingAdmins.length > 0 && <><dt>Admin awaiting approval</dt><dd className="sa-waiting-admin">{waitingAdmins.map((account) => <span key={account.id}><button type="button" className="sa-text-button" onClick={() => navigate(`/superadmin/users?user=${account.id}`)}>{account.name}</button> <StatusBadge value="Pending Approval" /></span>)}</dd></>}<dt>Boundary status</dt><dd><StatusBadge value={boundaryStatus(managing)} /></dd><dt>Registration code</dt><dd>{managing.has_registration_code ? 'On file' : 'Not generated yet'}</dd></dl>
      {managing.psgc_code && <CreateBarangayAdminForm key={managing.id} barangay={managing} onCreated={onAdminCreated} />}
      <section className="sa-detail-section"><h3>Boundary configuration</h3><button type="button" className="ghost-button" onClick={() => { setReviewingBoundary(managing); }}>Review / Replace Boundary</button>{managing.boundary_status === 'needs_review' ? <><p>{managing.pending_boundary ? 'A candidate outline is waiting for review.' : 'The current outline is an unverified reference.'} Review it against an LGU-approved boundary map or survey.</p><button type="button" className="primary-button" onClick={() => { setReviewingBoundary(managing); }}>Review Boundary</button></> : managing.boundary_status === 'verified' ? <p>A boundary reviewed against an uploaded source document is on file. This is an administrator review, not a legal certification.</p> : <><p>No matching boundary is on file. Retry the supported lookup.</p><button type="button" className="ghost-button" disabled={retryingId === managing.id} onClick={() => retryBoundary(managing)}>{retryingId === managing.id ? 'Checking…' : 'Retry Boundary Lookup'}</button></>}</section>
      {!managing.has_active_admin && <section className="sa-detail-section"><h3>Recover Administrator</h3>{!candidates.length ? <p>No staff are available to promote. Use Create Administrator account above to add one.</p> : <><p>Promote an existing staff member to Admin while keeping their current roles and assigned responsibilities. An inactive account will also be approved and activated.</p><AdminFilterField label="Staff member"><SearchableSelect value={pickedUserId} onChange={(event) => setPickedUserId(event.target.value)}><option value="">Select a staff member</option>{candidates.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.role}{account.is_active ? '' : ' (inactive)'}</option>)}</SearchableSelect></AdminFilterField><button type="button" className="primary-button" disabled={!pickedUserId} onClick={() => { const target = candidates.find((account) => String(account.id) === pickedUserId); onRequestConfirmation({ title: 'Recover Administrator', message: `Promote ${target.name} to Admin for ${managing.name}${target.is_active ? '' : ' and activate their account'}?`, confirmLabel: 'Promote to Admin', variant: 'primary', onConfirm: async () => { const success = await onPromote(target); if (success) setManagingId(null); } }); }}>Promote to Admin</button></>}</section>}
      </div>
    </section>}
    {reviewingBoundary && <BoundaryReviewModal onSaved={onBoundarySaved} barangay={reviewingBoundary} onClose={() => setReviewingBoundary(null)} onConfirm={async () => { if (await onConfirmBoundary(reviewingBoundary)) setReviewingBoundary(null); }} onDiscard={async () => { if (await onDiscardBoundary(reviewingBoundary)) setReviewingBoundary(null); }} />}
  </div>;
}

function useAdminLookup(url, enabled, label) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState({ key: '', rows: [], error: null });
  const key = `${url}:${attempt}`;
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    api.get(url).then(({ data }) => {
      if (current) setResult({ key, rows: data, error: null });
    }).catch(() => {
      if (current) setResult({ key, rows: [], error: `Could not load ${label}. Please retry.` });
    });
    return () => { current = false; };
  }, [url, enabled, label, key]);
  return { rows: enabled && result.key === key ? result.rows : [], loading: enabled && result.key !== key, error: enabled && result.key === key ? result.error : null, retry: () => setAttempt((value) => value + 1) };
}

// Nationwide location cascade for adding a registered barangay.
function AddBarangayForm({ existingBarangayIds, onAdded, onCancel }) {
  const [provinceId, setProvinceId] = useState('');
  const [cityId, setCityId] = useState('');
  const [barangayId, setBarangayId] = useState('');
  const [boundaryPreview, setBoundaryPreview] = useState(null);
  const [previewStatus, setPreviewStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const provinceLookup = useAdminLookup('/provinces', true, 'provinces');
  const cityLookup = useAdminLookup(`/cities?province_id=${provinceId}`, Boolean(provinceId), 'cities');
  const barangayLookup = useAdminLookup(`/barangays?city_id=${cityId}`, Boolean(cityId), 'barangays');
  const provinces = provinceLookup.rows;
  const cities = cityLookup.rows;
  const barangays = barangayLookup.rows;
  const isDuplicate = barangayId && existingBarangayIds.includes(String(barangayId));

  useEffect(() => {
    if (!barangayId) return;
    let current = true;
    api.get(`/barangays/${barangayId}`).then(({ data }) => {
      if (!current) return;
      setBoundaryPreview(data);
      setPreviewStatus(data.boundary ? '' : 'Unavailable: this PSGC record has no approved reference geometry. No boundary will be generated.');
    }).catch(() => { if (current) setPreviewStatus('The reference boundary could not be loaded.'); });
    return () => { current = false; };
  }, [barangayId]);

  const previewPolygons = useMemo(() => geoJsonToPolygons(boundaryPreview?.boundary), [boundaryPreview]);

  const submit = async (e) => {
    e.preventDefault();
    if (!cityId || !barangayId || isDuplicate) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.post('/superadmin/barangays', { city_id: cityId, barangay_id: barangayId });
      onAdded(res.data);
    } catch (err) {
      setError(err.response?.data?.message ?? 'Something went wrong — please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="location-form-panel superadmin-panel-spaced" onSubmit={submit}>
      <h3>Add Barangay</h3>
      <p className="muted superadmin-muted-block">
        Adds the barangay to platform management. You can then create its Administrator account from the barangay's page.
      </p>
      {error && <p className="muted" style={{ color: '#dc2626' }}>{error}</p>}
      {[provinceLookup, cityLookup, barangayLookup].filter((lookup) => lookup.error).map((lookup) => <p key={lookup.error} className="notice error" role="alert">{lookup.error} <button type="button" className="ghost-button" onClick={lookup.retry}>Retry lookup</button></p>)}
      <div className="superadmin-inline-row">
        <SearchableSelect aria-label="New barangay province" value={provinceId} disabled={provinceLookup.loading || Boolean(provinceLookup.error)} onChange={(e) => { setProvinceId(e.target.value); setCityId(''); setBarangayId(''); setBoundaryPreview(null); setPreviewStatus(''); }} required>
          <option value="">{provinceLookup.loading ? 'Loading provinces…' : 'Province'}</option>
          {provinces.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </SearchableSelect>
        <SearchableSelect aria-label="New barangay city" value={cityId} onChange={(e) => { setCityId(e.target.value); setBarangayId(''); setBoundaryPreview(null); setPreviewStatus(''); }} disabled={!provinceId || cityLookup.loading || Boolean(cityLookup.error)} required>
          <option value="">{cityLookup.loading ? 'Loading cities…' : 'City / Municipality'}</option>
          {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SearchableSelect>
        <SearchableSelect aria-label="Official PSGC barangay" value={barangayId} onChange={(e) => { setBarangayId(e.target.value); setBoundaryPreview(null); setPreviewStatus('Loading the PSGC-matched boundary…'); }} disabled={!cityId || barangayLookup.loading || Boolean(barangayLookup.error)} required>
          <option value="">{barangayLookup.loading ? 'Loading barangays…' : 'Barangay (PSGC)'}</option>
          {barangays.map((barangay) => <option key={barangay.id} value={barangay.id}>{barangay.name} · {barangay.psgc_code}</option>)}
        </SearchableSelect>
        <button type="button" className="ghost-button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary-button" disabled={saving || !cityId || !barangayId || isDuplicate}>
          {saving ? 'Adding…' : 'Add'}
        </button>
      </div>
      {isDuplicate && <p className="notice error" role="alert">This barangay is already managed by the platform. Open it from the barangay list instead.</p>}
      {barangayId && <section className="boundary-registration-preview" aria-live="polite">
        <div className="boundary-registration-preview-head"><div><strong>Step 2 — Boundary Preview</strong><span>{boundaryPreview?.name ?? 'Selected barangay'} · PSGC {boundaryPreview?.psgc_code ?? 'Loading…'}</span></div><small>{boundaryPreview?.boundary_source ?? 'Authoritative reference lookup'}</small></div>
        {previewPolygons.length ? <div className="boundary-registration-map"><MapContainer key={JSON.stringify(boundaryPreview?.boundary)} bounds={previewPolygons.flat(2)} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
          <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          {previewPolygons.map((polygon, index) => <Polygon key={index} positions={polygon} pathOptions={{ color: '#fca5a5', weight: 2, fillColor: '#ef4444', fillOpacity: .12 }} />)}
        </MapContainer></div> : <p className="muted boundary-registration-empty">{previewStatus || 'Choose an official PSGC barangay to retrieve its boundary.'}</p>}
        {previewPolygons.length > 0 && <p className="muted boundary-registration-note">Reference preview only. A live imported outline can support registration without being marked reviewed. Confirming an uploaded source marks a boundary reviewed; this is not a legal or cadastral certification.</p>}
      </section>}
    </form>
  );
}

function SettingsTab({ setNotice }) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.put('/profile/password', {
        old_password: oldPassword,
        new_password: newPassword,
        new_password_confirmation: confirmPassword,
      });
      setNotice({ type: 'success', text: 'Password updated.' });
      setOldPassword(''); setNewPassword(''); setConfirmPassword('');
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not update password.' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="superadmin-tab superadmin-settings-tab">
      <div className="panel-header-bar">
        <h3>Change password</h3>
      </div>
      <form className="smart-form" onSubmit={submit} style={{ maxWidth: 420 }}>
        <label>
          <span>Current Password</span>
          <input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} required autoComplete="off" />
        </label>
        <label>
          <span>New Password</span>
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
        </label>
        <label>
          <span>Confirm New Password</span>
          <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
        </label>
        <div className="form-actions">
          <button className="primary-button" type="submit" disabled={submitting}>{submitting ? 'Saving…' : 'Update Password'}</button>
        </div>
      </form>
    </div>
  );
}

export default function SuperAdminWorkspace() {
  const { user, logout } = useContext(AuthContext);
  const shellRef = useRef(null);
  useEffect(() => {
    const shell = shellRef.current;
    const header = shell?.querySelector('.topbar');
    if (!header) return;
    const measure = () => shell.style.setProperty('--topbar-height', `${Math.ceil(header.getBoundingClientRect().height)}px`);
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    measure();
    return () => observer.disconnect();
  }, [user?.id]);
  const navigate = useNavigate();
  const location = useLocation();
  const activeTab = location.pathname.split('/')[2] || 'dashboard';
  const validRoute = (TABS.some(([tab]) => tab === activeTab) || activeTab === 'settings')
    && (!location.pathname.split('/')[3] || activeTab === 'barangays' && /^\d+$/.test(location.pathname.split('/')[3]))
    && !location.pathname.split('/').slice(4).some(Boolean);
  const [barangayFilter, setBarangayFilter] = useState('all');
  const [showAddBarangay, setShowAddBarangay] = useState(false);
  const navigateTab = (tab, filter) => { navigate(`/superadmin/${tab}`); setMobileNavOpen(false); setBarangayFilter(filter || 'all'); setShowAddBarangay(false); window.scrollTo({ top: 0, behavior: 'instant' }); };
  // Always starts expanded — a collapsed sidebar should only ever be a
  // deliberate, in-session choice (the toggle button), never the default a
  // returning user lands on.
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  // Phone-width drawer (the sidebar slides in over the page instead of
  // collapsing to an icon rail).
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(() => {
    if (!mobileNavOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setMobileNavOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileNavOpen]);
  const toggleSidebar = () => {
    if (window.matchMedia('(max-width: 767px)').matches) {
      setMobileNavOpen((open) => !open);
      return;
    }
    setIsSidebarCollapsed((v) => !v);
  };
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [notice, setNotice] = useState(null);
  const [celebration, setCelebration] = useState(null);
  const endCelebration = useCallback(() => setCelebration(null), []);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const handleConfirmDialog = async () => {
    if (!confirmDialog?.onConfirm || confirmBusy) return;
    setConfirmBusy(true);
    try {
      await confirmDialog.onConfirm();
      setConfirmDialog(null);
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Something went wrong. Please try again.' });
    } finally {
      setConfirmBusy(false);
    }
  };

  const [barangays, setBarangays] = useState([]);
  const [users, setUsers] = useState([]);
  const [pendingApprovals, setPendingApprovals] = useState([]);
  const [resourceLoading, setResourceLoading] = useState({ barangays: true, users: true, pending: true });
  const [resourceErrors, setResourceErrors] = useState({});
  const loadVersion = useRef(0);
  const requiredResources = { dashboard: ['barangays', 'pending'], barangays: ['barangays', 'users'], pending: ['pending', 'barangays'], users: ['users'] };
  const loading = (requiredResources[activeTab] ?? []).some((key) => resourceLoading[key]);
  const loadError = (requiredResources[activeTab] ?? []).some((key) => resourceErrors[key]);

  const profileMenuRef = useRef(null);


  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // Each page waits only for its own datasets. Refreshes preserve form state,
  // and an unrelated slow or failed endpoint cannot hide healthy controls.
  const loadAll = useCallback(async ({ background = false } = {}) => {
    const version = ++loadVersion.current;
    const resources = [
      ['barangays', '/superadmin/barangays', setBarangays],
      ['users', '/superadmin/users', setUsers],
      ['pending', '/superadmin/pending-approvals', setPendingApprovals],
    ];
    await Promise.allSettled(resources.map(async ([key, path, update]) => {
      try {
        const { data } = await api.get(path, { timeout: 15000 });
        if (version !== loadVersion.current) return;
        update(data);
        setResourceErrors((previous) => ({ ...previous, [key]: false }));
      } catch {
        if (!background && version === loadVersion.current) setResourceErrors((previous) => ({ ...previous, [key]: true }));
      } finally {
        if (version === loadVersion.current) setResourceLoading((previous) => ({ ...previous, [key]: false }));
      }
    }));
  }, []);

  useEffect(() => {
    // loadAll awaits the API batch before updating React state.
    loadAll();
    const refresh = () => { if (document.visibilityState === 'visible') loadAll({ background: true }); };
    const interval = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', refresh);
    };
  }, [loadAll]);

  useEffect(() => {
    function handleClickOutside(event) {
      if (profileMenuRef.current && !profileMenuRef.current.contains(event.target)) {
        setShowProfileMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Computed once here and handed to both DashboardTab and UsersTab so the
  // "Total Users"/"Pending Registrations" counts on the dashboard can never
  // drift from the "All Users" tab's own count badge — both read the same
  // Super-Admin-excluded list instead of each filtering independently.
  const visibleUsers = useMemo(() => users.filter((u) => u.role !== 'Super Admin'), [users]);

  const promoteToAdmin = async (target) => {
    if (!target) return;
    try {
      await api.put(`/superadmin/users/${target.id}/role`, { role: 'Admin', preserve_roles: true });
      if (!target.is_active || !target.approved_at) {
        await api.put(`/superadmin/users/${target.id}/activate`);
      }
      setNotice({ type: 'success', text: `${target.name} is now this barangay's Admin.` });
      await loadAll();
      return true;
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not promote this user.' });
      return false;
    }
  };

  // CreateBarangayAdminForm POSTs itself; this surfaces the server's message and refreshes.
  const adminCreated = async (message) => {
    setNotice({ type: 'success', text: message });
    await loadAll();
  };

  // AddBarangayForm already POSTs and hands back the created row itself —
  // this just refreshes the shared datasets (same loadAll() convention
  // every other mutation here uses) and surfaces the success notice.
  const addBarangay = async (created) => {
    setNotice({ type: 'success', text: `${created.name} (${created.city_name}) added.` });
    await loadAll();
  };

  // Only meaningful for a barangay without a verified boundary yet — re-runs
  // the same OSM lookup storeBarangay() tried on creation, for the (common)
  // case where nothing trustworthy was found the first time. Never
  // overwrites a boundary that's already verified (see
  // refreshBarangayBoundary()). A match found here lands as a candidate
  // awaiting review (boundary_status 'needs_review'), not an immediate save.
  const retryBoundary = async (barangay) => {
    try {
      const res = await api.post(`/superadmin/barangays/${barangay.id}/boundary/refresh`);
      setNotice(res.data.boundary_status === 'needs_review'
        ? { type: 'success', text: `A reference outline is on file for ${barangay.name}. Review or replace it against an LGU-approved source.` }
        : res.data.boundary_status === 'verified'
          ? { type: 'success', text: `${barangay.name} already has a reviewed boundary.` }
          : { type: 'error', text: `Still no boundary match for ${barangay.name} — try again later, or add it manually.` });
      await loadAll();
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not retry that boundary lookup.' });
    }
  };

  const confirmBoundary = async (barangay) => {
    try {
      const { data } = await api.post(`/superadmin/barangays/${barangay.id}/boundary/confirm`);
      setNotice({ type: 'success', text: data.boundary_status === 'verified'
        ? `Boundary reviewed and applied for ${barangay.name}.`
        : `Outline applied for ${barangay.name} as an unverified reference. Upload an LGU-approved file to mark it reviewed.` });
      await loadAll();
      return true;
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not confirm that boundary.' });
      return false;
    }
  };

  const discardBoundary = async (barangay) => {
    try {
      await api.delete(`/superadmin/barangays/${barangay.id}/boundary/pending`);
      setNotice({ type: 'success', text: `Candidate boundary discarded for ${barangay.name}.` });
      await loadAll();
      return true;
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not discard that candidate boundary.' });
      return false;
    }
  };

  const changeRole = async (targetUser, role) => {
    if (role === targetUser.role && !(targetUser.roles ?? []).some((current) => current !== role)) return;
    try {
      await api.put(`/superadmin/users/${targetUser.id}/role`, { role });
      setNotice({ type: 'success', text: `${targetUser.name}'s role is now ${role}.` });
      await loadAll();
      return true;
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not change that role.' });
      return false;
    }
  };

  const toggleActive = async (targetUser) => {
    try {
      await api.put(`/superadmin/users/${targetUser.id}/${targetUser.is_active ? 'deactivate' : 'activate'}`);
      setNotice({ type: 'success', text: `${targetUser.name} is now ${targetUser.is_active ? 'inactive' : 'active'}.` });
      await loadAll();
      return true;
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not update that account.' });
      return false;
    }
  };

  const approvePending = async (approval) => {
    try {
      const { data } = await api.put(`/superadmin/users/${approval.id}/activate`);
      setCelebration({ title: 'Approved', detail: data.message });
      await loadAll();
      return true;
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not approve this account.' });
      return false;
    }
  };

  const rejectPending = async (approval) => {
    try {
      await api.delete(`/superadmin/users/${approval.id}/reject`);
      setNotice({ type: 'success', text: `${approval.name}'s registration was rejected.` });
      await loadAll();
      return true;
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not reject this account.' });
      return false;
    }
  };

  const sendEmail = async (target, draft) => {
    try {
      const { data } = await api.post(`/superadmin/users/${target.id}/email`, draft);
      setCelebration({ title: 'Email Sent', detail: data.message });
      return true;
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not send that email.' });
      return false;
    }
  };

  const handleLogout = () => {
    setShowProfileMenu(false);
    logout();
  };

  if (!user) return null;

  return (
    // Scopes the modern <SearchableSelect> styling below (superadmin-shell select) to
    // just this portal — the main Workspace.jsx shell uses the same
    // "workspace" class name on its own <main>, so a bare Fragment here
    // couldn't be targeted on its own without also restyling every select
    // in the fleet-facing app.
    <div className="superadmin-shell" ref={shellRef}>
      <header className="topbar">
        <div className="topbar-left">
          <div className="topbar-brand-cluster">
            <button
              aria-label={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="sidebar-toggle-btn"
              onClick={toggleSidebar}
              title={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              type="button"
            >
              <Icon name="menu" size={24} />
            </button>
            <VMSLogo variant="blue" size={24} className="topbar-gear-icon" />
            <span className="vms-wordmark vms-wordmark-sm">vms</span>
          </div>
          <ImpersonationPicker user={user} />
        </div>

        <div className="topbar-right"><ThemeToggle /><EndImpersonationAction compact />
          <div className="profile-menu-container" ref={profileMenuRef}>
            <ProfileMenu
              user={user}
              open={showProfileMenu}
              setOpen={setShowProfileMenu}
              onOpenSettings={() => navigateTab('settings')}
              onLogout={handleLogout}
            />
          </div>
        </div>
      </header>

      <main className={`workspace${isSidebarCollapsed ? ' sidebar-collapsed' : ''}${mobileNavOpen ? ' mobile-nav-open' : ''}`}>
        <aside className={`sidebar${isSidebarCollapsed ? ' collapsed' : ''}`} id="superadmin-sidebar">
          <nav className="module-nav" aria-label="Super Admin modules">
            {TABS.map(([key, label]) => <button key={key} type="button" aria-label={label} aria-current={key === activeTab ? 'page' : undefined} className={key === activeTab ? 'active' : ''} onClick={() => navigateTab(key)} title={label}>
              {TAB_ICONS[key]}<span>{label}</span>{key === 'pending' && pendingApprovals.length > 0 && <span className="module-nav-badge">{pendingApprovals.length}</span>}
            </button>)}

          </nav>
        </aside>
        {mobileNavOpen && <div className="mobile-nav-backdrop" onClick={() => setMobileNavOpen(false)} aria-hidden="true" />}

        <section className="content-area">
          <div className={`page-heading-row${activeTab === 'dashboard' ? ' focus-branded-heading' : ''}`}>
            <div className="page-heading-text">
              <h1>{!validRoute ? 'Page not found' : TABS.find(([k]) => k === activeTab)?.[1] ?? 'My Settings'}</h1>
              <p>{!validRoute ? 'This Super Admin page does not exist.' : TAB_DESCRIPTIONS[activeTab] ?? TAB_DESCRIPTIONS.settings}</p>
            </div>
            {activeTab === 'barangays' && !location.pathname.split('/')[3] && <button type="button" className="primary-button" onClick={() => setShowAddBarangay(!showAddBarangay)}><Icon name={showAddBarangay ? 'close' : 'plus'} size={16} />{showAddBarangay ? 'Cancel' : 'Add Barangay'}</button>}
          </div>

          {notice && (
            <div className={`toast-notice ${notice.type}`} role="alert">
              <div className="toast-notice-body">
                <Icon name={notice.type === 'success' ? 'checkCircle' : 'alert'} size={16} />
                <span>{notice.text}</span>
              </div>
              <button type="button" className="toast-notice-close" onClick={() => setNotice(null)} aria-label="Dismiss">
                <Icon name="close" size={13} />
              </button>
            </div>
          )}

          <div className="content-body">
            {!validRoute ? (
              <div className="sa-management-card"><p role="alert">Page not found. <button type="button" className="ghost-button" onClick={() => navigateTab('dashboard')}>Back to Platform Overview</button></p></div>
            ) : loading && !['activity', 'settings'].includes(activeTab) ? (
              <p className="muted" role="status">Loading platform data…</p>
            ) : loadError ? (
              <div className="sa-management-card"><p className="sa-load-error" role="alert">Data for this page could not be loaded. <button type="button" className="ghost-button" onClick={() => loadAll()}>Retry</button></p></div>
            ) : activeTab === 'dashboard' ? (
              <PlatformOverview barangays={barangays} approvals={pendingApprovals} onNavigate={navigateTab} />
            ) : activeTab === 'barangays' ? (
              <BarangayManagementTab
                onBoundarySaved={() => loadAll()}
                key={barangayFilter}
                initialFilter={barangayFilter}
                showAddForm={showAddBarangay}
                onCloseAdd={() => setShowAddBarangay(false)}
                onRequestConfirmation={setConfirmDialog}
                barangays={barangays}
                users={visibleUsers}
                onPromote={promoteToAdmin}
                onAdminCreated={adminCreated}
                onAddedBarangay={addBarangay}
                onRetryBoundary={retryBoundary}
                onConfirmBoundary={confirmBoundary}
                onDiscardBoundary={discardBoundary}
              />
            ) : activeTab === 'pending' ? (
              <PendingApprovalsTab
                approvals={pendingApprovals}
                barangays={barangays}
                onApprove={approvePending}
                onReject={rejectPending}
                onRequestConfirmation={setConfirmDialog}
              />
            ) : activeTab === 'users' ? (
              <UsersTab users={visibleUsers} onChangeRole={changeRole} onToggleActive={toggleActive} onApprove={approvePending} onReject={rejectPending} onSendEmail={sendEmail} onRequestConfirmation={setConfirmDialog} />
            ) : activeTab === 'activity' ? (
              <ActivityLogTab />
            ) : activeTab === 'support' ? (
              <SupportCenterTab onRequestConfirmation={setConfirmDialog} onSuccess={setCelebration} />
            ) : (
              <SettingsTab setNotice={setNotice} />
            )}
          </div>
        </section>
      </main>

      <WorkspaceFooter />
      <SuccessCelebration celebration={celebration} onDone={endCelebration} />
      <AdminConfirmDialog
        busy={confirmBusy}
        dialog={confirmDialog}
        onCancel={() => setConfirmDialog(null)}
        onConfirm={handleConfirmDialog}
      />
    </div>
  );
}
