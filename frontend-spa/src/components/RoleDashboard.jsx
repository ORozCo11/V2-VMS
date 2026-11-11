import SearchableSelect from './SearchableSelect';
import './RoleDashboard.css';
import { useEffect, useState } from 'react';
import api from '../api/axios';
import Icon from './Icon';
import { didRepairWorkOn } from '../utils/ticketVerification';

const roleCopy = {
  Admin: ['Administrator Dashboard', 'Requests waiting for your decision, and repairs in progress.'],
  Custodian: ['Custodian Dashboard', 'Repairs to verify, issues to follow up, and vehicles to check.'],
  'Maintenance Personnel': ['Maintenance Dashboard', 'Repairs assigned to you and maintenance coming up.'],
};
const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const date = (value) => value ? new Date(value).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' }) : 'No date recorded';

function TaskList({ title, items, onViewAll, allLabel = 'View all', loading, error }) {
  const [expanded, setExpanded] = useState(false);
  return <section className="focus-card">
    <header><h3>{title}</h3>{onViewAll && <button type="button" onClick={onViewAll}>{allLabel} <Icon name="chevronRight" size={14} /></button>}</header>
    {error ? <p className="focus-empty">Task data is unavailable. Open the module or retry above.</p> : loading ? <p className="focus-empty">Loading assignments…</p> : !items.length ? <p className="focus-empty">Nothing needs your attention here.</p> : <ul className="focus-tasks">
      {(expanded ? items : items.slice(0, 5)).map((item) => <li key={item.key}>
        <span className={`focus-task-mark is-kind-${String(item.key).split('-')[0]}`}><Icon name={item.icon ?? 'clipboard'} size={17} /></span>
        <div><strong>{item.title}</strong><span>{item.reference}</span><small>{item.status}{item.date ? ` · ${date(item.date)}` : ''}{item.highPriority ? ' · High priority' : ''}</small></div>
        <button type="button" onClick={item.open}>{item.action ?? 'Review'} <Icon name="chevronRight" size={14} /></button>
      </li>)}
    </ul>}
    {items.length > 5 && <button className="focus-more" type="button" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show fewer' : `Show all ${items.length} items`}</button>}
  </section>;
}

export default function RoleDashboard({ data, user, basePath, onNavigate, onGoToModule, isScheduleOverdue }) {
  const roles = [...new Set([user.role, ...(user.roles ?? [])])].filter((role) => roleCopy[role]);
  const [selectedRole, setSelectedRole] = useState(roles[0]);
  const role = roles.includes(selectedRole) ? selectedRole : roles[0];
  const [feed, setFeed] = useState(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const requests = [api.get('/tickets'), api.get('/maintenance-schedules')];
    Promise.all(requests).then(([tickets, schedules]) => {
      if (!cancelled) { setFeed({ tickets: tickets.data, schedules: schedules.data, role }); setError(''); }
    }).catch(() => { if (!cancelled) setError('Assignments could not be loaded. Retry or open the relevant module.'); });
    return () => { cancelled = true; };
    // Not keyed on `data`: the dashboard summary is re-polled every 15s and on
    // window focus, and refetching the full ticket/schedule lists each time
    // flooded the single-threaded dev server and delayed module switches.
  }, [user.id, role, retry]);

  if (!data) return <p className="empty-state">Dashboard data is not available yet.</p>;
  const pending = !feed || feed.role !== role;
  const loading = pending && !error;
  const tickets = pending ? [] : feed.tickets;
  const schedules = pending ? [] : feed.schedules;
  const admin = role === 'Admin';
  const custodian = role === 'Custodian';
  const mine = tickets.filter((t) => sameId(t.assigned_mechanic_id, user.id) || (t.sub_issues ?? []).some((s) => sameId(s.assigned_mechanic_id, user.id)));
  const mySchedules = schedules.filter((s) => sameId(s.assigned_to, user.id) && s.status === 'Scheduled' && !s.resulting_ticket_id);
  const overdueSchedules = schedules.filter(isScheduleOverdue);
  const myOverdue = mySchedules.filter(isScheduleOverdue);
  const verifications = tickets.filter((t) => t.status === 'For Verification' && sameId(t.assigned_custodian_id, user.id) && !didRepairWorkOn(t, user.id));
  const watch = data.readiness_watch ?? [];
  const pendingTickets = tickets.filter((t) => t.status === 'Pending Approval');
  const pendingSchedules = schedules.filter((s) => s.status === 'Pending Approval');
  const metric = (label) => data.metrics?.find((m) => m.label === label)?.value ?? 0;
  const go = (module, filters = []) => onGoToModule(module, filters);
  const ticketTask = (t, title = t.ticket_title) => ({ key: `ticket-${t.ticket_id}`, title, reference: `${t.vehicle?.vehicle_name ?? 'Vehicle'} · Ticket #${t.ticket_id}`, status: t.status, date: t.created_at, highPriority: t.priority === 'High', open: () => onNavigate(`${basePath}/tickets/${t.ticket_id}`), action: 'View ticket' });
  const scheduleTask = (s) => ({ key: `schedule-${s.schedule_id}`, title: s.maintenance_type, reference: `${s.vehicle?.vehicle_name ?? 'Vehicle'} · Schedule #${s.schedule_id}`, status: isScheduleOverdue(s) ? 'Overdue' : s.status, date: s.scheduled_date, urgent: isScheduleOverdue(s), icon: 'calendar', open: () => onNavigate(`${basePath}/schedules/${s.schedule_id}`), action: 'View schedule' });
  const activeMine = mine.filter((t) => t.status === 'Active');
  const tasks = admin ? [
    ...pendingTickets.map((t) => ticketTask(t, 'Review ticket proposal')),
    ...pendingSchedules.map((s) => ({ ...scheduleTask(s), title: 'Review schedule booking' })),
    ...tickets.filter((t) => t.status === 'Active' && (t.sub_issues ?? []).some((s) => s.status === 'Under Repair' && (s.repair_type === 'external' ? !s.external_tester_id : !s.assigned_mechanic_id)))
      .map((t) => ticketTask(t, (t.sub_issues ?? []).some((s) => s.returned_to_admin_at && s.status === 'Under Repair') ? 'Reassign returned work' : 'Assign maintenance personnel')),
    ...overdueSchedules.filter((s) => !s.resulting_ticket_id).map(scheduleTask),
  ] : custodian ? [
    ...verifications.map((t) => ticketTask(t, 'Verify completed repair')),
    ...tickets.filter((t) => t.status === 'Open' && sameId(t.assigned_custodian_id, user.id)).map((t) => ticketTask(t, 'Inspect reported issue')),
    ...watch.map((v) => ({ key: `readiness-${v.vehicle_id}`, title: 'Check vehicle readiness', reference: v.vehicle_name, status: ({ not_ready: 'Failed last check', stale: 'Check expired', unchecked: 'Not checked' })[v.state] ?? v.state, urgent: v.state === 'not_ready', icon: 'vehicle', open: () => onNavigate(`${basePath}/vehicles/${v.vehicle_id}`), action: 'View vehicle' })),
  ] : [...activeMine.map((t) => ticketTask(t)), ...mySchedules.map(scheduleTask)];
  // Keep the same kind of item together (all proposals, then all bookings, then all overdue ...), oldest first
  // inside each group, instead of mixing kinds by urgency.
  const groupOf = (task) => `${String(task.key).split('-')[0]}|${task.status}`;
  const groupOrder = [];
  tasks.forEach((task) => { if (!groupOrder.includes(groupOf(task))) groupOrder.push(groupOf(task)); });
  tasks.sort((a, b) => groupOrder.indexOf(groupOf(a)) - groupOrder.indexOf(groupOf(b)) || String(a.date ?? '').localeCompare(String(b.date ?? '')));
  const kpis = admin ? [
    { label: 'Pending Approvals', value: pending ? '—' : pendingTickets.length + pendingSchedules.length, detail: 'Ticket proposals and schedule bookings', icon: 'clipboard', open: () => go('tickets', ['Pending Approval']) },
    { label: 'Active Maintenance', value: metric('Vehicles Under Maintenance'), detail: 'Vehicles under maintenance', icon: 'wrench', open: () => go('vehicles', ['Under Maintenance']) },
    { label: 'Overdue Maintenance', value: metric('Overdue Maintenance'), detail: 'Scheduled maintenance past due', icon: 'calendar', open: () => go('schedules', ['Overdue']) },
    { label: 'Available Vehicles', value: metric('Available Vehicles'), detail: 'Availability, separate from readiness', icon: 'vehicle', open: () => go('vehicles', ['Available']) },
  ] : custodian ? [
    { label: 'Pending Verification', value: pending ? '—' : verifications.length, icon: 'checkCircle', open: () => go('ticketVerifications', ['Pending']) },
    { label: 'Readiness Checks Needed', value: watch.length, icon: 'vehicle', open: () => go('vehicles') },
  ] : [
    { label: 'My Active Work Orders', value: pending ? '—' : activeMine.length, icon: 'wrench', open: () => go('ticketWorkOrders', ['Pending']) },
    { label: 'My Upcoming Maintenance', value: pending ? '—' : mySchedules.length - myOverdue.length, icon: 'calendar', open: () => go('schedules', ['MyAssigned']) },
    { label: 'My Overdue Assignments', value: pending ? '—' : myOverdue.length, detail: 'Assigned schedules past due', icon: 'alert', open: () => go('schedules', ['MyAssigned']) },
  ];
  return <div className="focus-dashboard role-dashboard">
    <header className="focus-heading focus-branded-heading"><div><h2>{roleCopy[role][0]}</h2><p>{roleCopy[role][1]}</p></div>{roles.length > 1 && <label>Responsibility<SearchableSelect aria-label="Dashboard responsibility" value={role} onChange={(e) => setSelectedRole(e.target.value)}>{roles.map((r) => <option key={r}>{r}</option>)}</SearchableSelect></label>}</header>
    {error && <div role="alert" className="focus-error">{error}<button type="button" onClick={() => setRetry((n) => n + 1)}>Retry</button></div>}
    <div className="focus-kpis" style={{ '--kpi-count': kpis.length }}>{kpis.map((k) => <button type="button" key={k.label} onClick={k.open}><span className="focus-kpi-icon"><Icon name={k.icon} size={19} /></span><span>{k.label}<strong>{k.value}</strong>{k.detail && <small>{k.detail}</small>}</span><Icon name="chevronRight" size={14} /></button>)}</div>
    <div className="focus-panel-stack">
      <TaskList key={role} title="What needs your attention" items={tasks} loading={loading} error={error} onViewAll={() => go(admin ? 'tickets' : custodian ? 'ticketVerifications' : 'ticketWorkOrders')} />
      {admin && data.sole_active_admin && <section className="focus-card">
        <header><h3>Heads up</h3></header>
        <ul className="focus-risk-list">
          <li><Icon name="alert" size={16} /><span><strong>Only one active Administrator</strong>Add a backup Administrator so account management stays covered. <button type="button" onClick={() => go('users')}>Manage users</button></span></li>
        </ul>
      </section>}
    </div>
  </div>;
}
