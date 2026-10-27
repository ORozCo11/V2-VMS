import { parseTimestamp, scheduleStage, scheduleIsOverdue, relatedRecordLabel } from '../utils/qaWorkflow';
import ThemeToggle from '../components/ThemeToggle';
import SearchableSelect from '../components/SearchableSelect';
import ImpersonationPicker from '../components/ImpersonationPicker';
import { recordNumber, ticketNumber } from '../utils/recordNumber';
import { ticketTimeline } from '../utils/ticketTimeline';
import LoadingOverlay from '../components/LoadingOverlay';
import EndImpersonationAction from '../components/EndImpersonationAction';
import './TicketCreation.css';
import './ScheduleForm.css';
import './MaintenanceDetails.css';
import { FileCabinet, RepairFileCabinet } from '../components/LazyFileCabinets';
import VMSLogo from '../components/VMSLogo';
import { Children, useId, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, createContext, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import api from '../api/axios';
import { LocationDensityMap, VehicleLocationMap, AddLocationMap } from '../components/LazyMaps';
import Icon from '../components/Icon';
import RoleDashboard from '../components/RoleDashboard';
import WorkspaceFooter from '../components/WorkspaceFooter';
import ConfirmDialog from '../components/ConfirmDialog';
import { DonutChart, StackedBarChart } from '../components/charts';
import { AuthContext } from '../context/AuthContextObject';
import { geoJsonToPolygons, isPointWithinBoundaryPolygons, isLocationPointAllowed } from '../utils/boundary';
import { geocodeAddress, reverseGeocode } from '../utils/geocode';
import { calendarDate } from '../utils/adminDate';
import { completedMaintenanceRecords, maintenanceSourceBucket, maintenanceSourceLabel } from '../utils/maintenanceGroups';
import { currentCondition } from '../utils/conditionMonitoring';
import { didRepairWorkOn } from '../utils/ticketVerification';

const FormNoticeContext = createContext(null);
// Lets shared table cells (VehicleCell, UserAvatarName) open the right detail
// view for what was actually clicked — a vehicle cell opens the vehicle, a user
// cell opens that user — instead of the whole row always going to the vehicle.
const RowActionsContext = createContext(null);

const roleRoutes = {
  Admin: '/admin',
  Custodian: '/custodian',
  'Maintenance Personnel': '/maintenance',
  'Super Admin': '/superadmin',
};

// Sidebar structure, grouped into collapsible sections. `section: null` means
// the items render at the top with no header (Dashboard) — everything else
// sits under a labelled, collapsible group. The groupings themselves aren't
// new: they existed as comments here long before they were rendered.
const modulesByRole = {
  Admin: [
    { section: null, items: [['dashboard', 'Dashboard']] },
    { section: 'Operations', icon: 'clipboard', items: [
      // Issue Reports was its own sidebar page — removed as redundant (no
      // ticket linked, Admin's only action was Dismiss). The one thing worth
      // keeping, a glance at the latest reports, now lives on Maintenance
      // Tickets instead (see LatestIssueCard there). The underlying feature
      // and data aren't gone — Custodian/Maintenance Personnel still report
      // issues, and a ticket's "From Issue Report #N" link still opens one.
      ['tickets', 'Maintenance Tickets'],
      ['schedules', 'Maintenance Schedule'],
      ['maintenance', 'Maintenance Records'],
      ['conditions', 'Condition Monitoring'],
    ] },
    // The old cross-vehicle "Vehicle Documents" picker page (VehicleDocumentsPage)
    // was removed (2026-10-10) — unlinked everywhere and reachable only by
    // forcing its module key. Documents now live solely on the vehicle
    // profile's own Files card. Ticket Archives moved into the Maintenance
    // Tickets module itself (a toolbar link there) instead of its own
    // top-level row.
    { section: 'Fleet & Assets', icon: 'vehicle', items: [
      ['vehicles', 'View Vehicles'],
      ['categories', 'Vehicle Types'],
      ['locations', 'Vehicle Location'],
    ] },
    { section: 'Administration', icon: 'key', items: [
      ['users', 'Users'],
      ['reports', 'Reports'],
      ['logs', 'Activity Log'],
    ] },
  ],
  Custodian: [
    { section: null, items: [['dashboard', 'Dashboard']] },
    // 'vehicles' already carries both "View Vehicles" and, for whoever
    // holds vehicle.create, the "+ Add Vehicle" (register) action inline —
    // no separate "Register Vehicle" row for the same page.
    { section: 'Vehicles', icon: 'vehicle', items: [
      ['vehicles', 'View Vehicles'],
      ['conditions', 'Condition Monitoring'],
    ] },
    // 'reportOrPropose' ('issues' module under the hood) is the Issue
    // Reports list, with a "Report Vehicle Issue" action and a "Propose
    // Ticket" action both inline in its header — not a separate chooser
    // screen. 'myTasks' stays a tabbed container (Repair Verification / Work
    // Tracker — see renderModule's tab bar; the old Assigned Inspections tab
    // was removed since inspection is no longer part of the live workflow).
    // Neither key has its own moduleEndpoints entry — both are pure
    // navigation/presentation wrappers around shared components/data.
    { section: 'Vehicle Operations', icon: 'checkCircle', items: [
      ['reportOrPropose', 'Report Vehicle Issue'],
      ['myTasks', 'My Tasks'],
    ] },
    { section: 'Maintenance', icon: 'calendar', items: [
      ['schedules', 'Maintenance Schedule'],
      // Same single ledger Admin sees now — the separate "Needs
      // Verification" tab/page was removed; a Custodian's Verify action is
      // now a row-level button in this same table (see maintenanceColumns'
      // record.verify branch), matching Admin's "no tabs" reference design.
      ['maintenance', 'Maintenance Records'],
    ] },
    { section: 'History', items: [['histories', 'Vehicle History']] },
  ],
  'Maintenance Personnel': [
    // "View Vehicles" used to sit alone under its own collapsible "Vehicles"
    // section — a dropdown for exactly one row. With nothing else ever
    // likely to join it (see the removed-items notes below), it's a plain
    // top-level item next to Dashboard instead, same as the un-sectioned
    // group above.
    { section: null, items: [['dashboard', 'Dashboard'], ['vehicles', 'View Vehicles']] },
    { section: 'Maintenance', icon: 'wrench', items: [
      // Work Tracker used to be its own sidebar entry/page here — merged
      // into My Work Orders as an in-page Archive toggle (mirrors Admin's
      // Maintenance Tickets "Archives" button) so this role has one ticket
      // page instead of two. Custodian's own My Tasks -> History tab still
      // uses the WorkTrackerModule component this used to route to — only
      // this role's standalone entry point was removed.
      ['ticketWorkOrders', 'My Work Orders'],
      ['maintenance', 'Maintenance Records'],
      ['schedules', 'Maintenance Schedule'],
    ] },
    // "Vehicle Issues" removed per product direction — redundant for this
    // role (not necessary; a mechanic's own ticket/work-order flow already
    // captures what's wrong with a vehicle). issue.create still lists
    // Maintenance Personnel in config/permissions.php for now, just with no
    // UI entry point left to reach it from.
    // No standalone "Vehicle Documents" sidebar item for any role — the
    // module lives only on the vehicle profile's own Files card now
    // (document.view/.create abilities). Maintenance Personnel reaches it
    // the same way: open a vehicle from View Vehicles above.
  ],
};

// Multi-role helpers. `role` is the primary (portal/routing); `roles` is
// every hat the account may wear. Permission checks use hasRole so a person
// holding several roles is allowed to act under any of them.
function hasRole(user, role) {
  if (!user) return false;
  const roles = user.roles;
  if (Array.isArray(roles) && roles.length) return roles.includes(role);
  return user.role === role; // fall back to primary role
}

// Ability-based permission check. The backend computes `user.abilities` from
// config/permissions.php (role -> abilities) and returns it on login/GET user.
// Prefer this over hasRole()/raw role checks for authorization decisions —
// role checks should be reserved for display-only logic (e.g. label copy).
function canDo(user, ability) {
  if (!user) return false;
  return Array.isArray(user.abilities) && user.abilities.includes(ability);
}

// Mirrors User::canRegisterVehicles() on the backend. Vehicle registration
// is a standard Custodian duty now — the per-account can_register_vehicles
// delegation flag is no longer required (kept in the data model for history,
// just not read here anymore).
function canRegisterVehicles(user) {
  return hasRole(user, 'Admin') || hasRole(user, 'Custodian');
}

function userRoles(user) {
  if (!user) return [];
  const roles = (Array.isArray(user.roles) && user.roles.length) ? [...user.roles] : (user.role ? [user.role] : []);
  // Keep the primary role first so it drives the default landing module.
  if (user.role && roles.includes(user.role)) {
    return [user.role, ...roles.filter((r) => r !== user.role)];
  }
  return roles;
}

// The sidebar a user sees is the UNION of every module across all their
// roles — a Custodian + Maintenance person gets both portals' modules.
// Sections with the same label merge into one group rather than appearing
// twice. First occurrence of a module key wins, and userRoles() puts the
// primary role first, so a module defined by two roles keeps the label from
// the user's primary portal (e.g. "Report Vehicle Issue" vs "View Vehicle
// Issues" for a Custodian+Maintenance account).
// Phone bottom bar: the first four of these a role actually has, with
// short labels that fit under an icon.
const BOTTOM_NAV_PRIORITY = ['dashboard', 'myTasks', 'ticketWorkOrders', 'tickets', 'reportOrPropose', 'schedules', 'vehicles'];
const BOTTOM_NAV_LABELS = {
  dashboard: 'Home',
  myTasks: 'My Tasks',
  ticketWorkOrders: 'Work Orders',
  tickets: 'Tickets',
  reportOrPropose: 'Report',
  schedules: 'Schedule',
  vehicles: 'Vehicles',
};

function resolveModuleGroups(user) {
  const roles = userRoles(user);
  const source = roles.length ? roles : [user?.role].filter(Boolean);
  const seenKeys = new Set();
  const order = [];
  const bySection = new Map();
  const iconBySection = new Map();

  source.forEach((r) => (modulesByRole[r] ?? []).forEach(({ section, icon, items }) => {
    if (!bySection.has(section)) { bySection.set(section, []); order.push(section); }
    if (icon && !iconBySection.has(section)) iconBySection.set(section, icon);
    const bucket = bySection.get(section);
    items.forEach((item) => {
      if (seenKeys.has(item[0])) return;
      seenKeys.add(item[0]);
      bucket.push(item);
    });
  }));

  // A section can end up empty when every module in it was already claimed by
  // an earlier role's section — don't render a header with nothing under it.
  return order
    .map((section) => ({ section, icon: iconBySection.get(section), items: bySection.get(section) }))
    .filter((g) => g.items.length > 0);
}

// NOTE: the flat [key, label] list that everything outside the sidebar render
// consumes (default landing module, breadcrumb lookup) is derived from these
// groups in the component via `moduleGroups.flatMap(g => g.items)` — grouping
// the sidebar therefore didn't change any of those call sites.

function defaultWorkflowStatuses(module, user) {
  if (module === 'tickets' && hasRole(user, 'Admin')) return ['Pending Approval', 'Active'];
  if (module === 'ticketWorkOrders') return [];
  if (module === 'ticketVerifications') return ['Active', 'Pending'];
  if (module === 'schedules') return ['Pending Approval', 'Scheduled'];
  if (module === 'maintenanceStatus') return ['Assigned', 'Under Repair', 'On Hold - Awaiting Parts', 'For Verification'];
  if (module === 'issues') return ['Pending', 'Under Review', 'In Maintenance'];
  return [];
}

function WorkflowStatusControls({ options, selected, onChange, defaults, showShortcuts = true }) {
  const allowed = options.map((option) => typeof option === 'object' ? option.value : option);
  const statuses = selected.filter((value) => allowed.includes(value));
  return <div className="workflow-status-controls" role="group" aria-label="Work status filters">
    <div className="filter-date-group"><span>Status</span>
      <MultiSelectDropdown placeholder="All statuses" options={options} selected={statuses} onChange={onChange} />
    </div>
    {showShortcuts && <>
      <button type="button" className="ghost-button" onClick={() => onChange([...defaults])}>Ongoing only</button>
      <button type="button" className="ghost-button" onClick={() => onChange([])}>All statuses</button>
    </>}
  </div>;
}

const moduleEndpoints = {
  vehicles: '/vehicles',
  categories: '/categories',
  locations: '/locations',
  conditions: '/conditions',
  issues: '/issues',
  maintenance: '/maintenance-records',
  maintenanceStatus: '/maintenance-records',
  schedules: '/maintenance-schedules',
  histories: '/histories',
  logs: '/logs',
  tickets: '/tickets',
  ticketInspections: '/tickets',
  ticketVerifications: '/tickets',
  ticketWorkOrders: '/tickets',
  workTracker: '/tickets',
  ticketArchives: '/ticket-archives',
  users: '/users',
};

const moduleIcons = {
  dashboard: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  ),
  vehicles: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2" />
      <circle cx="7" cy="17" r="2" />
      <path d="M9 17h6" />
      <circle cx="17" cy="17" r="2" />
    </svg>
  ),
  categories: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16M4 12h16M4 18h7" />
    </svg>
  ),
  locations: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  ),
  conditions: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  ),
  issues: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  maintenance: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  ),
  maintenanceStatus: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  // Merged "Maintenance Status" + "Maintenance Records" — reuses the
  // ledger's own wrench icon, since that's the entry's primary identity.
  maintenanceLedger: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  ),
  schedules: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  ),
  tickets: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  ),
  ticketArchives: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  ),
  // Custodian's Issue Reports entry point — reuses the `issues`
  // warning-triangle glyph since it's the same list/module.
  reportOrPropose: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  // Merged Custodian "queues waiting on me" container (Task 1) — a simple
  // checklist glyph, distinct from the three it now groups (ticketInspections/
  // ticketVerifications/workTracker keep their own icons below, still used
  // for the page-heading icon whenever one of those keys is the active tab
  // but reached from OUTSIDE this container, e.g. Maintenance Personnel's
  // own separate Work Tracker entry).
  myTasks: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 3v2a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V3" />
      <path d="m8 12.5 2 2 4-4.5" />
      <line x1="8" y1="17" x2="16" y2="17" />
    </svg>
  ),
  // Custodian's "propose a ticket" entry point — the same document shape as
  // `tickets`, with a plus instead of the two summary lines, so it reads as
  // "start a new one" rather than "view the list". Kept for the (now
  // unreachable in practice) fallback path in breadcrumbModule below.
  ticketPropose: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="12" x2="12" y2="18" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  ),
  ticketInspections: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <polyline points="11 8 11 11 13 13" />
    </svg>
  ),
  ticketVerifications: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  ticketWorkOrders: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  ),
  workTracker: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11H3v10h6V11z" />
      <path d="M15 3H9v18h6V3z" />
      <path d="M21 7h-6v14h6V7z" />
      <path d="m8 8 1.5 1.5L12 7" />
    </svg>
  ),
  histories: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 8v4l3 3" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  ),
  reports: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  ),
  logs: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <polyline points="13 2 13 9 20 9" />
    </svg>
  ),
  users: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
};

// Sidebar and page-heading icons share the Solar Linear catalogue used by the
// rest of the application, keeping this navigation flat and outline-only.
const moduleIconNames = {
  dashboard: 'grid', vehicles: 'vehicle', categories: 'list', locations: 'pin',
  conditions: 'checkCircle', issues: 'alert', maintenance: 'wrench',
  maintenanceStatus: 'checkCircle', maintenanceLedger: 'wrench', schedules: 'calendar',
  tickets: 'ticket', ticketArchives: 'archive', reportOrPropose: 'alert',
  myTasks: 'clipboard', ticketPropose: 'document', ticketInspections: 'search',
  ticketVerifications: 'checkCircle', ticketWorkOrders: 'wrench', workTracker: 'columns',
  histories: 'undo', reports: 'document', logs: 'document', users: 'users',
};

function renderModuleIcon(key) {
  const iconName = moduleIconNames[key];
  return iconName
    ? <Icon name={iconName} size={20} className="nav-icon" />
    : (moduleIcons[key] ?? null);
}

function Workspace() {
  const navigate = useNavigate();
  const location = useLocation();
  const topbarRef = useRef(null);
  const workspaceRef = useRef(null);
  const vehicleUrlMatch = location.pathname.match(/\/vehicles\/(new|\d+)$/);
  const vehicleProfileId = vehicleUrlMatch && vehicleUrlMatch[1] !== 'new' ? vehicleUrlMatch[1] : null;
  const isNewVehiclePage = vehicleUrlMatch?.[1] === 'new';
  // Vehicle "edit" isn't its own path — VehicleProfilePage seeds its Edit
  // tab from ?tab=edit on the profile URL itself (see its `editing` state).
  const isVehicleEditPage = Boolean(vehicleProfileId) && new URLSearchParams(location.search).get('tab') === 'edit';
  const ticketUrlMatch = location.pathname.match(/\/tickets\/(new|\d+)$/);
  const ticketProfileId = ticketUrlMatch && ticketUrlMatch[1] !== 'new' ? ticketUrlMatch[1] : null;
  const isNewTicketPage = ticketUrlMatch?.[1] === 'new';
  const isNewCategoryPage = /\/categories\/new$/.test(location.pathname);
  const editCategoryId = location.pathname.match(/\/categories\/(\d+)\/edit$/)?.[1] ?? null;
  const isNewSchedulePage = /\/schedules\/new$/.test(location.pathname);
  const editScheduleId = location.pathname.match(/\/schedules\/(\d+)\/edit$/)?.[1] ?? null;
  const scheduleProfileId = location.pathname.match(/\/schedules\/(\d+)$/)?.[1] ?? null;
  const isNewIssuePage = /\/issues\/new$/.test(location.pathname);
  const editIssueId = location.pathname.match(/\/issues\/(\d+)\/edit$/)?.[1] ?? null;
  const viewIssueId = location.pathname.match(/\/issues\/(\d+)$/)?.[1] ?? null;
  const isNewConditionPage = /\/conditions\/new$/.test(location.pathname);
  const editConditionId = location.pathname.match(/\/conditions\/(\d+)\/edit$/)?.[1] ?? null;
  const isNewMaintenancePage = /\/maintenance\/new$/.test(location.pathname);
  const editMaintenanceId = location.pathname.match(/\/maintenance\/(\d+)\/edit$/)?.[1] ?? null;
  const maintenanceProfileId = location.pathname.match(/\/maintenance\/(\d+)$/)?.[1] ?? null;
  const isNewUserPage = /\/users\/new$/.test(location.pathname);
  const editUserId = location.pathname.match(/\/users\/(\d+)\/edit$/)?.[1] ?? null;
  const viewUserId = location.pathname.match(/\/users\/(\d+)$/)?.[1] ?? null;
  const isNewLocationPage = /\/locations\/new$/.test(location.pathname);
  const editLocationVehicleId = location.pathname.match(/\/locations\/(\d+)\/edit$/)?.[1] ?? null;
  const logRepairsMatch = location.pathname.match(/\/work-orders\/(\d+)\/(\d+)\/log-repairs$/);
  const logRepairsTicketId = logRepairsMatch?.[1] ?? null;
  const logRepairsSubIssueId = logRepairsMatch?.[2] ?? null;
  const inspectTicketId = location.pathname.match(/\/inspections\/(\d+)\/inspect$/)?.[1] ?? null;
  const isProfilePage = /\/profile$/.test(location.pathname);
  const isOnSpecialPage = Boolean(
    isNewVehiclePage || vehicleProfileId || isNewTicketPage || ticketProfileId
    || isNewCategoryPage || editCategoryId || isNewSchedulePage || editScheduleId || scheduleProfileId
    || isNewIssuePage || editIssueId || viewIssueId || isNewConditionPage || editConditionId
    || isNewMaintenancePage || editMaintenanceId || maintenanceProfileId || isNewUserPage || editUserId || viewUserId
    || logRepairsTicketId || inspectTicketId || isProfilePage || isNewLocationPage || editLocationVehicleId
  );
  // The bold page title for whichever create/edit/view sub-page is active —
  // null when just looking at a module's own list, in which case the heading
  // falls back to plain "{Module Name}" with no breadcrumb line above it.
  const subPageTitle =
    (isNewVehiclePage && 'Add Vehicle')
    || (vehicleProfileId && 'Vehicle Profile')
    || (isNewTicketPage && 'Create New Ticket')
    || (ticketProfileId && 'Ticket Details')
    || (isNewCategoryPage && 'Add Vehicle Type')
    || (editCategoryId && 'Edit Vehicle Type')
    || (isNewSchedulePage && 'Add Maintenance Schedule')
    || (editScheduleId && 'Update Schedule')
    || (scheduleProfileId && 'Maintenance Schedule Details')
    || (isNewIssuePage && 'Report Vehicle Issue')
    || (editIssueId && 'Update Issue Status')
    || (viewIssueId && 'Issue Details')
    || (isNewConditionPage && 'Add Condition Check')
    || (editConditionId && 'Edit Condition Check')
    || (isNewMaintenancePage && 'Add Maintenance Record')
    || (editMaintenanceId && 'Update Maintenance Record')
    || (maintenanceProfileId && 'Maintenance Record')
    || (isNewUserPage && 'Add User')
    || (editUserId && 'Update User')
    || (viewUserId && 'User Profile')
    || (logRepairsTicketId && 'Record Repair Work')
    || (inspectTicketId && 'Inspect Vehicle')
    || (isProfilePage && 'My Profile')
    || (isNewLocationPage && 'Add Location')
    || (editLocationVehicleId && 'Update Location')
    || null;
  const { user, logout, refreshUser } = useContext(AuthContext);
  // The top bar can become taller when its location selectors wrap. Keep the
  // fixed sidebar aligned to that measured edge instead of the 64px fallback.
  useLayoutEffect(() => {
    const topbar = topbarRef.current;
    const workspace = workspaceRef.current;
    if (!topbar || !workspace) return undefined;

    const syncTopbarHeight = () => {
      workspace.style.setProperty('--topbar-height', `${Math.ceil(topbar.getBoundingClientRect().height)}px`);
    };

    const observer = new ResizeObserver(syncTopbarHeight);
    observer.observe(topbar);
    syncTopbarHeight();
    return () => observer.disconnect();
  }, []);
  // Phase B2 — UX-only redirect for every full-page create/edit route: the
  // backend independently (and exhaustively) enforces each of these
  // abilities on the actual endpoint, so this just keeps someone without the
  // ability from sitting on a form that can only ever 403 on submit, instead
  // of silently rendering it. Mirrors ProtectedRoute's own /unauthorized
  // bounce rather than inventing a second pattern.
  useEffect(() => {
    const deniedNewOrEdit = (
      (isNewVehiclePage && !canRegisterVehicles(user))
      || (isVehicleEditPage && !canDo(user, 'vehicle.edit'))
      || (isNewCategoryPage && !canDo(user, 'vehicle_type.create'))
      || (editCategoryId && !canDo(user, 'vehicle_type.edit'))
      || (isNewSchedulePage && !canDo(user, 'schedule.create') && !canDo(user, 'schedule.suggest'))
      || (editScheduleId && !canDo(user, 'schedule.edit'))
      || (isNewIssuePage && !canDo(user, 'issue.create'))
      || (editIssueId && !canDo(user, 'issue.edit'))
      || (isNewConditionPage && !canDo(user, 'condition.create'))
      || (editConditionId && !canDo(user, 'condition.edit'))
      || (isNewMaintenancePage && !canDo(user, 'record.create'))
      || (editMaintenanceId && !canDo(user, 'record.edit'))
      || (isNewUserPage && !canDo(user, 'user.create'))
      || (editUserId && !canDo(user, 'user.edit'))
      || (isNewLocationPage && !canDo(user, 'vehicle.update_location'))
      || (editLocationVehicleId && !canDo(user, 'vehicle.update_location'))
    );
    if (deniedNewOrEdit) navigate('/unauthorized', { replace: true });
  }, [
    navigate, user,
    isNewVehiclePage, isVehicleEditPage, isNewCategoryPage, editCategoryId,
    isNewSchedulePage, editScheduleId, isNewIssuePage, editIssueId,
    isNewConditionPage, editConditionId, isNewMaintenancePage, editMaintenanceId,
    isNewUserPage, editUserId, isNewLocationPage, editLocationVehicleId,
  ]);
  const moduleGroups = useMemo(() => resolveModuleGroups(user), [user]);
  const modules = useMemo(() => moduleGroups.flatMap((g) => g.items), [moduleGroups]);
  // A fresh mount (hard refresh, a bookmarked/shared link, opening a new tab)
  // always used to default this to the first sidebar module — losing which
  // ticket/record the URL actually pointed at, since these special sub-pages
  // read their record out of `records[activeModule]`, which is only fetched
  // once loadModule(activeModule) runs. Seeding activeModule from the URL
  // itself (instead of always modules[0]) means that fetch fires for the
  // right module on the very first render, so the page renders instead of
  // sitting blank until the user happens to click the matching sidebar item.
  const [activeModule, setActiveModuleState] = useState(() => {
    // Maintenance Personnel no longer has a standalone 'workTracker' sidebar
    // entry (folded into 'ticketWorkOrders' own Archive toggle) — prefer that
    // key so a direct/bookmarked ticket link never seeds activeModule with a
    // key this role can't reach from its own sidebar. Mirrors breadcrumbModule's
    // own fallback below. Custodian still has no 'ticketWorkOrders' entry, so
    // this keeps falling through to 'workTracker' (its My Tasks -> History tab) for them.
    if (ticketProfileId || isNewTicketPage) return user.role === 'Admin' ? 'tickets' : (modules.some(([k]) => k === 'ticketWorkOrders') ? 'ticketWorkOrders' : 'workTracker');
    if (maintenanceProfileId || isNewMaintenancePage || editMaintenanceId) return 'maintenance';
    if (isNewVehiclePage || vehicleProfileId) return 'vehicles';
    if (isNewCategoryPage || editCategoryId) return 'categories';
    if (isNewSchedulePage || editScheduleId || scheduleProfileId) return 'schedules';
    if (isNewIssuePage || editIssueId || viewIssueId) return 'issues';
    if (isNewConditionPage || editConditionId) return 'conditions';
    if (isNewUserPage || editUserId || viewUserId) return 'users';
    if (isNewLocationPage || editLocationVehicleId) return 'locations';
    if (logRepairsTicketId) return 'ticketWorkOrders';
    if (inspectTicketId) return 'ticketInspections';
    return new URLSearchParams(location.search).get('module') || modules[0]?.[0] || 'dashboard';
  });
  const setActiveModule = useCallback((key) => {
    setActiveModuleState(key);
    navigate(`${roleRoutes[user.role]}?module=${encodeURIComponent(key)}`);
  }, [navigate, user.role]);
  const moduleLocationKey = location.pathname + location.search;
  const [previousModuleLocation, setPreviousModuleLocation] = useState(moduleLocationKey);
  if (previousModuleLocation !== moduleLocationKey) {
    setPreviousModuleLocation(moduleLocationKey);
    if (location.pathname === roleRoutes[user.role]) {
      setActiveModuleState(new URLSearchParams(location.search).get('module') || 'dashboard');
    }
  }
  // Custodian's merged "My Tasks" sidebar entry (Task 1 of the sidebar
  // consolidation) is a thin navigation wrapper, not a real module —
  // `activeModule` still ends up literally 'ticketInspections' /
  // 'ticketVerifications' / 'workTracker' exactly as before (so every
  // existing fetch/filter/stat/render keyed off those strings keeps working
  // completely unchanged), this just remembers which of the three tabs was
  // last open so re-clicking the "My Tasks" sidebar row returns you to it.
  const [myTasksLastTab, setMyTasksLastTab] = useState('ticketVerifications');
  // 'workTracker' is the one key shared between Custodian's My Tasks
  // ("History" tab) and Maintenance Personnel's own separate, untouched
  // "Work Tracker" sidebar entry — this disambiguates which context set it,
  // since both simply set activeModule to the same string. Defaults true
  // (Custodian is the only role this whole file's new My Tasks flow
  // targets); Maintenance Personnel's own Work Tracker click flips it false.
  const [workTrackerViaMyTasks, setWorkTrackerViaMyTasks] = useState(true);
  // Jumps into (or switches tabs within) the merged My Tasks container —
  // used by both the sidebar's "My Tasks" row and the in-page tab bar.
  const setMyTasksTab = useCallback((key) => {
    setMyTasksLastTab(key);
    setWorkTrackerViaMyTasks(true);
    setActiveModule(key);
  }, [setActiveModule]);
  // Same thin-wrapper pattern as My Tasks above, merging Custodian's
  // "Maintenance Status" (records awaiting their verification) and
  // "Maintenance Records" (completed repair history) — same underlying data
  // (GET /maintenance-records), just a different filter, so this is a pure
  // navigation/presentation merge with zero change to either module.
  const [maintenanceLedgerLastTab, setMaintenanceLedgerLastTab] = useState('maintenanceStatus');
  const setMaintenanceLedgerTab = useCallback((key) => {
    setMaintenanceLedgerLastTab(key);
    setActiveModule(key);
  }, [setActiveModule]);
  // Any special page can be reached from places that never touch
  // setActiveModule — a notification click, a shared link opened in a new
  // tab, a direct URL/refresh — so `activeModule` itself can't be trusted
  // for the heading icon/breadcrumb or the sidebar's own highlight while on
  // one of these. Computed directly (not synced via an effect) so it's
  // never wrong even for a single frame. Falls back to `activeModule` only
  // for the plain module-list pages, where that state is authoritative.
  // Whether these two merged Custodian entries actually exist in THIS user's
  // sidebar — true for a Custodian, false for Admin/Maintenance Personnel
  // (who keep their own separate, unmerged 'issues'/'ticketInspections'/
  // 'ticketVerifications'/'workTracker' entries untouched). Drives every
  // "should this special page/tab highlight the merged entry instead of the
  // real key" decision below.
  const hasMyTasksNav = modules.some(([k]) => k === 'myTasks');
  const hasReportOrProposeNav = modules.some(([k]) => k === 'reportOrPropose');
  const hasMaintenanceLedgerNav = modules.some(([k]) => k === 'maintenanceLedger');
  const breadcrumbModule = ticketProfileId || isNewTicketPage
    ? (user.role === 'Admin'
      ? 'tickets'
      // The propose form is a brand-new entry point (never reachable before
      // this), so — unlike the ticketProfileId case just below it, which
      // keeps its long-established 'workTracker' fallback — this can safely
      // highlight its own sidebar item instead (now the merged
      // 'reportOrPropose' chooser entry, replacing the old direct-link
      // 'ticketPropose' row it used to point at).
      : (isNewTicketPage && canDo(user, 'ticket.propose')
        ? (hasReportOrProposeNav ? 'reportOrPropose' : 'ticketPropose')
        : (hasMyTasksNav ? 'myTasks' : (modules.some(([k]) => k === 'ticketWorkOrders') ? 'ticketWorkOrders' : 'workTracker'))))
    : maintenanceProfileId || isNewMaintenancePage || editMaintenanceId ? (hasMaintenanceLedgerNav ? 'maintenanceLedger' : 'maintenance')
    : isNewVehiclePage || vehicleProfileId ? 'vehicles'
    : isNewCategoryPage || editCategoryId ? 'categories'
    : isNewSchedulePage || editScheduleId || scheduleProfileId ? 'schedules'
    : isNewIssuePage || editIssueId || viewIssueId ? (hasReportOrProposeNav ? 'reportOrPropose' : 'issues')
    : isNewConditionPage || editConditionId ? 'conditions'
    : isNewUserPage || editUserId || viewUserId ? 'users'
    : isNewLocationPage || editLocationVehicleId ? 'locations'
    : logRepairsTicketId ? 'ticketWorkOrders'
    : inspectTicketId ? (hasMyTasksNav ? 'myTasks' : 'ticketInspections')
    // Plain module-list view (no special sub-page open) for one of the merged
    // "My Tasks" queues — 'ticketVerifications' is Custodian-only regardless,
    // 'workTracker' also covers Maintenance Personnel's own separate entry,
    // disambiguated by workTrackerViaMyTasks. Inspection was removed from
    // this merged container (see showMyTasksContainer above) — no path here
    // highlights it anymore, though the standalone page is left reachable by
    // direct link (inspectTicketId above) for any stale/bookmarked URL.
    : (hasMyTasksNav && (
        activeModule === 'ticketVerifications'
        || (activeModule === 'workTracker' && workTrackerViaMyTasks)
      )) ? 'myTasks'
    : (hasReportOrProposeNav && activeModule === 'issues') ? 'reportOrPropose'
    : (hasMaintenanceLedgerNav && (activeModule === 'maintenanceStatus' || activeModule === 'maintenance')) ? 'maintenanceLedger'
    : activeModule;
  // Always starts expanded — a collapsed sidebar should only ever be a
  // deliberate, in-session choice (the toggle button), never the default a
  // returning user lands on.
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Escape closes the phone drawer.
  useEffect(() => {
    if (!mobileNavOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setMobileNavOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileNavOpen]);
  const [lookups, setLookups] = useState(emptyLookups);
  const [ticketLookups, setTicketLookups] = useState(emptyTicketLookups);
  const [records, setRecords] = useState({});
  const [prefilledScheduleData, setPrefilledScheduleData] = useState(null);
  const [dateDefaults] = useState(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return { tomorrow: calendarDate(tomorrow) };
  });
  // Memoized so the object reference stays stable across unrelated re-renders
  // — SmartForm resets its values whenever this reference changes, which
  // would otherwise wipe out whatever the user has already typed.
  const scheduleInitialValues = useMemo(() => (
    editScheduleId
      ? (records.schedules ?? []).find((s) => String(s.schedule_id) === String(editScheduleId))
      // Default to tomorrow — a schedule is always plotted ahead, so this
      // saves a click for the common case; still fully editable.
      : { scheduled_date: dateDefaults.tomorrow, ...(prefilledScheduleData ?? {}) }
  ), [editScheduleId, records.schedules, prefilledScheduleData, dateDefaults.tomorrow]);
  // Set right before navigating to /conditions/new from the "+" on a
  // specific "Not Checked" vehicle row — same pattern as prefilledScheduleData
  // above, so that vehicle is already selected instead of asking the
  // Custodian to pick it again from a vehicle they just clicked.
  const [prefilledConditionVehicleId, setPrefilledConditionVehicleId] = useState(null);
  const conditionInitialValues = useMemo(() => (
    editConditionId
      ? (records.conditions ?? []).find((c) => String(c.condition_check_id) === String(editConditionId))
      : (prefilledConditionVehicleId ? { vehicle_id: prefilledConditionVehicleId } : EMPTY_OBJ)
  ), [editConditionId, records.conditions, prefilledConditionVehicleId]);
  // Legacy rows may have no `roles` list yet — seed it from the primary role.
  // Memoized (not an inline IIFE) for the same reason as scheduleInitialValues
  // above — otherwise this object gets a new reference on every render and
  // SmartForm keeps resetting the form back over whatever was just typed.
  const editUserInitialValues = useMemo(() => {
    if (!editUserId) return EMPTY_OBJ;
    let u = (records.users ?? []).find((x) => String(x.id) === String(editUserId));
    if (!u) return u;
    if ((!Array.isArray(u.roles) || !u.roles.length) && u.role) u = { ...u, roles: [u.role] };
    return u;
  }, [records.users, editUserId]);
  const [dashboard, setDashboard] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [completeScheduleTarget, setCompleteScheduleTarget] = useState(null);
  // Admin's "Reassign" action on a Scheduled row (schedule.reassign ability,
  // Admin-only) — hands a still-open schedule to a different Maintenance
  // Personnel without cancelling and re-booking it.
  const [reassignScheduleTarget, setReassignScheduleTarget] = useState(null);
  // Admin's "Decline" action on a Pending Approval row (schedule.decline
  // ability, Admin-only) — collects a reason, same modal pattern as Reassign.
  const [declineScheduleTarget, setDeclineScheduleTarget] = useState(null);
  // After a Custodian passes a verification they're already standing at the
  // vehicle — offer the Readiness Check right then instead of making them
  // come back for a second visit. Holds the vehicle to check, or null.
  const [readinessPromptTarget, setReadinessPromptTarget] = useState(null);
  // Admin's Maintenance Schedule defaults to the card ("ticket") view rather
  // than the plain table — a schedule reads more like a ticket now that its
  // row-level actions are ownership-gated (see scheduleColumns). Everyone
  // else keeps the table default. Still just a default: the stored
  // preference (and the view-mode toggle itself) override it either way.
  const [scheduleViewMode, setScheduleViewMode] = useState(
    () => localStorage.getItem('vms_schedule_view') || (hasRole(user, 'Admin') ? 'card' : 'table')
  );
  const changeScheduleViewMode = (mode) => {
    setScheduleViewMode(mode);
    localStorage.setItem('vms_schedule_view', mode);
  };
  // List/Recent-Activities tab for the Activity Log — not persisted, since
  // "recent activities" is a quick-glance view you'd want defaulting back
  // to the full list on your next visit rather than staying sticky.
  const [logsView, setLogsView] = useState('list');
  const [usersViewMode, setUsersViewMode] = useState('list');
  // Drives the conditional External Shop / Vendor / Receipt fields in the
  // Mark Done form below — reset wherever the modal is opened (see
  // openCompleteSchedule) rather than in an effect.
  const [completeScheduleExternal, setCompleteScheduleExternal] = useState(false);
  const openCompleteSchedule = (row) => {
    setCompleteScheduleExternal(false);
    setCompleteScheduleTarget({ ...row, completionDefaultDate: calendarDate() });
  };
  const [report, setReport] = useState(null);
  const [notice, setNotice] = useState(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.lines ? 8000 : 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const [loading, setLoading] = useState(false);
  const [userInfoTarget, setUserInfoTarget] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  // Tracks whether the form on whatever special page is currently open has
  // been touched — set true the moment a field changes, cleared on submit,
  // on an explicit Cancel, or after the user confirms discarding it. Lets
  // the sidebar (and anything else that can navigate away) warn before an
  // accidental click wipes out something like a half-filled Log Repairs or
  // Inspect Vehicle form.
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  // Runs `action` only after confirming with the user if a form is dirty —
  // used anywhere navigation could otherwise silently discard unsaved input.
  // Reuses the same styled ConfirmDialog every other consequential action in
  // this app goes through, instead of the browser's own native confirm().
  const guardedNavigate = useCallback((action) => {
    if (!hasUnsavedChanges) {
      action();
      return;
    }
    setConfirmDialog({
      title: 'Unsaved Changes',
      message: 'You have unsaved changes on this page. Discard them and leave?',
      confirmLabel: 'Discard & Leave',
      onConfirm: () => {
        setHasUnsavedChanges(false);
        action();
      },
    });
  }, [hasUnsavedChanges]);
  // Any route change means whatever page we're now on starts clean — this
  // is what actually clears the flag after a successful save (submitting
  // navigates away on its own, outside guardedNavigate), and also covers
  // navigating directly from one edit form straight into another.
  const routeStateKey = JSON.stringify([location.pathname, location.search]);
  const [previousRouteStateKey, setPreviousRouteStateKey] = useState(routeStateKey);
  if (previousRouteStateKey !== routeStateKey) {
    setPreviousRouteStateKey(routeStateKey);
    setHasUnsavedChanges(false);
    setNotice(null);

  }
  // First-time approval only — a pending self-registration's role is a
  // request, not yet real, so Admin reviews/confirms it here instead of
  // the plain yes/no ConfirmDialog every other activate/deactivate uses.
  const [approvalTarget, setApprovalTarget] = useState(null);
  // The Staff Registration Code the barangay office hands to real staff —
  // Admin-only, fetched once so it's ready whenever they open Users.
  const [registrationCode, setRegistrationCode] = useState(null);
  useEffect(() => {
    if (!hasRole(user, 'Admin')) return;
    api.get('/registration-settings').then((res) => setRegistrationCode(res.data.staff_code)).catch(() => {});
  }, [user]);
  const [notifications, setNotifications] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState([]);
  const [filterCapacity, setFilterCapacity] = useState([]);
  const [filterStatus, setFilterStatus] = useState(() => defaultWorkflowStatuses(activeModule, user));
  const [filterPriority, setFilterPriority] = useState([]);
  // Location/Domain filters — Vehicle Management only (FilterBar shows
  // these whenever it's given the setters, so only this module's own call
  // site passing them determines whether they render).
  const [filterLocation, setFilterLocation] = useState([]);
  const [filterDomain, setFilterDomain] = useState([]);
  // Module-specific extra filter dimensions — each only read/written by its
  // own activeModule branch below, but declared centrally alongside the
  // rest so the module-switch reset effect can clear them all in one place.
  const [filterReadiness, setFilterReadiness] = useState([]); // vehicles: Ready to Respond
  const [filterIssueType, setFilterIssueType] = useState([]); // issues
  const [filterMaintType, setFilterMaintType] = useState([]); // maintenance
  const [filterSource, setFilterSource] = useState([]); // maintenance
  const [filterActive, setFilterActive] = useState([]); // users
  const [filterAssignedTo, setFilterAssignedTo] = useState([]); // schedules
  const [filterVerdict, setFilterVerdict] = useState([]); // ticketVerifications
  const [filterCheckedBy, setFilterCheckedBy] = useState([]); // conditions
  const [filterActivityType, setFilterActivityType] = useState([]); // histories
  const [filterVehicle, setFilterVehicle] = useState([]); // tickets
  const [filterMechanic, setFilterMechanic] = useState([]); // tickets — any sub-issue assigned to
  const [filterCustodian, setFilterCustodian] = useState([]); // tickets
  const [filterDateStart, setFilterDateStart] = useState(''); // issues/maintenance/tickets/histories
  const [filterDateEnd, setFilterDateEnd] = useState('');

  // Ticket Archives date/status filters
  const [archiveDraft, setArchiveDraft] = useState({ start: '', end: '', status: '', quick: '' });
  const [archiveStart, setArchiveStart] = useState('');
  const [archiveEnd, setArchiveEnd] = useState('');
  const [archiveStatusFilter, setArchiveStatusFilter] = useState('');
  const [showDeletedArchives, setShowDeletedArchives] = useState(false);

  // Condition Monitoring Filters
  const [condFilterStartDate, setCondFilterStartDate] = useState('');
  const [condFilterEndDate, setCondFilterEndDate] = useState('');
  // Draft for the condition filter bar — applied only on "Filter" click.
  const [condDraft, setCondDraft] = useState({ category: [], status: [], capacity: [], checkedBy: [], start: '', end: '' });
  const [prefilledTicketData, setPrefilledTicketData] = useState(null);
  // A form page that finishes by switching module wants its success notice to
  // survive the module-change reset below.
  const [keepNotice, setKeepNotice] = useState(false);
  // Pre-filled proposal data (from a flagged issue / condition check) only
  // lives while the ticket form is open — leaving it by ANY route (sidebar,
  // back button, submit) drops it so the next form never re-links stale data.
  const ticketFormModeKey = JSON.stringify([isNewTicketPage]);
  const [previousTicketFormModeKey, setPreviousTicketFormModeKey] = useState(ticketFormModeKey);
  if (previousTicketFormModeKey !== ticketFormModeKey) {
    setPreviousTicketFormModeKey(ticketFormModeKey);
    if (!isNewTicketPage) setPrefilledTicketData(null);

  }
  const [allHubs, setAllHubs] = useState([]);
  const [locationMapSummary, setLocationMapSummary] = useState({ hubs: null, unassigned: null });
  const [locationsTab, setLocationsTab] = useState('map');
  const [selectedMapVehicleId, setSelectedMapVehicleId] = useState(null);
  const profileMenuRef = useRef(null);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const hasVehicles = (lookups.vehicles ?? []).length > 0;

  const loadNotifications = useCallback(async () => {
    try {
      const response = await api.get('/notifications');
      setNotifications(response.data);
    } catch (error) {
      console.error('Failed to load notifications:', error);
    }
  }, []);

  const loadLookups = useCallback(async () => {
    const response = await api.get('/lookups');
    setLookups(response.data);
  }, []);

  const loadHubs = useCallback(async () => {
    const response = await api.get('/hubs');
    setAllHubs(
      response.data
        .filter((hub) => !hub.is_hidden)
        .map((hub) => ({
          ...hub,
          matchNames: Array.isArray(hub.match_names) && hub.match_names.length
            ? hub.match_names
            : [hub.name.toLowerCase()],
        }))
    );
  }, []);

  const loadTicketLookups = useCallback(async () => {
    const response = await api.get('/tickets/lookups');
    setTicketLookups(response.data);
  }, []);

  const loadModule = useCallback(async (key) => {
    if (key === 'reports') {
      return;
    }

    if (key === 'dashboard') {
      const response = await api.get('/dashboard');
      setDashboard(response.data);
      return;
    }

    const endpoint = moduleEndpoints[key];

    if (!endpoint) {
      return;
    }

    const params = {};

    // A Custodian sees every issue report in the barangay, same as Admin —
    // not just their own (VMS-IMPROVEMENT-PLAN.md Phase B3). Maintenance
    // Personnel gets none at all, enforced server-side regardless of params.

    if (key === 'maintenanceStatus') {
      params.for_verification = 1;
    }

    // Ticket workflow — role-scoped status filters
    // ticketInspections, ticketVerifications, and ticketWorkOrders intentionally
    // fetch every ticket assigned to this user (not just the pending-phase
    // status) so each module can show a "Pending" vs "Submitted" toggle instead
    // of only the pending queue — once submitted, a ticket moves to the next
    // phase and would otherwise vanish from view entirely.

    const response = await api.get(endpoint, { params });
    setRecords((current) => ({ ...current, [key]: response.data }));

    // The "My Assigned Maintenance Schedules" card section that used to be
    // piggybacked onto My Work Orders (for when Maintenance Personnel had no
    // 'schedules' sidebar entry of their own) was removed — that entry is
    // back, and GET /maintenance-schedules already scopes to assigned_to =
    // me for a pure Maintenance Personnel account, so it was a plain
    // duplicate of that page. No second fetch needed here anymore.

    // Admin no longer has a standalone Issue Reports sidebar entry (removed
    // as redundant — a report with no ticket just sits there for Admin to
    // dismiss). The "Latest Reports" card that used to live on that page
    // moves to Maintenance Tickets instead, piggybacked onto this same
    // fetch the same way ticketWorkOrders above piggybacks mySchedules.
    if (key === 'tickets' && hasRole(user, 'Admin')) {
      try {
        const issuesResponse = await api.get('/issues');
        setRecords((current) => ({ ...current, issues: issuesResponse.data }));
      } catch { /* optional secondary fetch — the tickets list still loaded fine */ }
    }
  }, [user]);


  useLayoutEffect(() => {
    const header = document.querySelector('.topbar');
    if (!header) return;
    const measure = () => document.documentElement.style.setProperty('--topbar-height', `${header.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => { observer.disconnect(); document.documentElement.style.removeProperty('--topbar-height'); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Start external I/O after commit; a torn-down mount never starts it.
    queueMicrotask(() => {
      if (cancelled) return;
      loadLookups().catch((error) => showError(error, setNotice));
      loadTicketLookups().catch(() => {});
      loadHubs().catch(() => {});

    });
    return () => { cancelled = true; };
  }, [loadLookups, loadTicketLookups, loadHubs]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) loadNotifications().catch(() => {}); });
    const interval = setInterval(() => {
      loadNotifications().catch(() => {});
    }, 10000); // Poll every 10 seconds
    return () => { cancelled = true; clearInterval(interval); };
  }, [loadNotifications]);

  // Sidebar badge counts (dashboard.badge_counts) are visible on every module,
  // but were only ever fetched by loadModule('dashboard') — which only runs
  // when the Dashboard module itself is the active one. Anyone who lands on
  // (or navigates to) a different module first saw stale/zeroed badges until
  // they happened to visit Dashboard. Poll them independently so they reflect
  // live counts no matter what module is currently open.
  // Also refreshed the moment the tab/window regains focus — otherwise work
  // another user did while this tab sat in the background (a mechanic
  // submitting a repair, an Admin approving) only showed up on the next
  // 15s tick, so coming back to the tab briefly showed stale counts.
  useEffect(() => {
    const refreshBadges = () => { loadModule('dashboard').catch(() => {}); };
    refreshBadges();
    const interval = setInterval(refreshBadges, 15000);
    const onVisible = () => { if (document.visibilityState === 'visible') refreshBadges(); };
    window.addEventListener('focus', refreshBadges);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', refreshBadges);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadModule]);

  useEffect(() => {
    function handleClickOutside(event) {
      if (profileMenuRef.current && !profileMenuRef.current.contains(event.target)) {
        setShowProfileMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const moduleResetKey = JSON.stringify([activeModule, user.id]);
  const [previousModuleResetKey, setPreviousModuleResetKey] = useState(moduleResetKey);
  if (previousModuleResetKey !== moduleResetKey) {
    setPreviousModuleResetKey(moduleResetKey);
     setEditTarget(null);
     setReport(null);
     if (keepNotice) setKeepNotice(false); else setNotice(null);
     setSearchQuery('');
     setFilterCategory([]);
     setFilterCapacity([]);
     setFilterStatus(defaultWorkflowStatuses(activeModule, user));
     setFilterPriority([]);
     setFilterLocation([]);
     setFilterDomain([]);
     setFilterReadiness([]);
     setFilterIssueType([]);
     setFilterMaintType([]);
     setFilterSource([]);
     setFilterActive([]);
     setFilterAssignedTo([]);
     setFilterVerdict([]);
     setFilterCheckedBy([]);
     setFilterActivityType([]);
     setFilterVehicle([]);
     setFilterMechanic([]);
     setFilterCustodian([]);
     setFilterDateStart('');
     setFilterDateEnd('');
     setCondFilterStartDate('');
     setCondFilterEndDate('');
     setCondDraft({ category: [], status: [], capacity: [], checkedBy: [], start: '', end: '' });
     setArchiveDraft({ start: '', end: '', status: '', quick: '' });
     setArchiveStart('');
     setArchiveEnd('');
     setArchiveStatusFilter('');
     setLoading(true);

  }
  useEffect(() => {
    let cancelled = false;
    // Start external I/O after commit; a torn-down mount never starts it.
    queueMicrotask(() => {
      if (cancelled) return;
      loadModule(activeModule)
        .catch((error) => { if (!cancelled) showError(error, setNotice); })
        .finally(() => { if (!cancelled) setLoading(false); });


    });
    return () => { cancelled = true; };
  }, [activeModule, loadModule]);

  const refreshCurrent = async () => {
    await Promise.all([
      loadLookups(),
      loadTicketLookups(),
      loadHubs(),
      loadModule(activeModule),
      loadModule('dashboard'),
      loadNotifications(),
    ]);
  };

  const submitModuleForm = async (payload) => {
    setNotice(null);

    try {
      if (activeModule === 'reports') {
        const response = await api.get('/reports', { params: cleanPayload(payload) });
        setReport({ ...response.data, filters: cleanPayload(payload) });
        setNotice({ type: 'success', text: `${payload.report_type} generated.` });
        return;
      }

      if (editTarget?.__verify) {
        await api.put(`/maintenance-records/${editTarget.maintenance_id}/verify`, cleanPayload(payload));
        // Capture before clearing editTarget — a Pass means the Custodian is
        // physically at the vehicle right now, which is the cheapest possible
        // moment to also confirm it's ready to respond (see
        // readinessPromptTarget). A Fail means the vehicle is going back for
        // more work, so there's nothing to check yet.
        const justVerifiedVehicle = payload.verification_result === 'Passed' ? editTarget.vehicle : null;
        setEditTarget(null);
        setNotice({ type: 'success', text: 'Verification submitted.' });
        await refreshCurrent();
        if (justVerifiedVehicle) setReadinessPromptTarget(justVerifiedVehicle);
        return;
      }

      const request = moduleRequest(activeModule, editTarget, payload);
      await sendPayload(request.method, request.path, payload);
      setEditTarget(null);
      setNotice({ type: 'success', text: request.success });
      await refreshCurrent();
    } catch (error) {
      showError(error, setNotice);
    }
  };

  // ── Ticket workflow action dispatchers ──────────────────────────────

  const ticketAction = async (path, payload, successMsg, method = 'put') => {
    setNotice(null);
    try {
      const response = await sendPayload(method, path, payload);
      setEditTarget(null);
      // assign-mechanic/reassign-custodian can succeed while also flagging a
      // self-verification conflict they just created (e.g. the mechanic
      // being assigned is also this ticket's Custodian) — see
      // TicketController's `warning` responses (VMS-IMPROVEMENT-PLAN.md
      // Phase A2). Not an error: the action went through, but it's worth a
      // distinct amber notice instead of blending into an ordinary success.
      const warning = response?.data?.warning;
      setNotice(warning
        ? { type: 'warning', text: `${successMsg} ⚠ ${warning}` }
        : { type: 'success', text: successMsg });
      await refreshCurrent();
      return true;
    } catch (error) {
      showError(error, setNotice);
      return false;
    }
  };

  const createTicket = async (payload) => {
    setNotice(null);
    try {
      await api.post('/tickets', cleanPayload(payload));
      setEditTarget(null);
      setNotice({ type: 'success', text: 'Ticket created & inspection assigned to Custodian.' });
      await refreshCurrent();
      return true;
    } catch (error) {
      showError(error, setNotice);
      return false;
    }
  };

  // Custodian's "propose a ticket" path — a separate endpoint from Admin's
  // createTicket() above (POST /tickets/propose instead of POST /tickets):
  // the backend self-assigns the proposing Custodian and parks it at
  // 'Pending Approval' instead of dispatching an inspection immediately.
  const proposeTicket = async (payload) => {
    setNotice(null);
    try {
      const response = await api.post('/tickets/propose', cleanPayload(payload));
      setNotice({ type: 'success', text: 'Ticket proposal submitted — an Admin will review it.' });
      await refreshCurrent();
      return response.data;
    } catch (error) {
      showError(error, setNotice);
      return false;
    }
  };

  // Admin's one next step on an open issue report that needs no ticket.
  const [dismissIssueTarget, setDismissIssueTarget] = useState(null);
  const dismissIssue = async (issue, payload) => {
    setNotice(null);
    try {
      await api.put(`/issues/${issue.issue_report_id}/dismiss`, { dismiss_reason: payload.dismiss_reason });
      setNotice({ type: 'success', text: 'Issue dismissed.' });
      setDismissIssueTarget(null);
      await refreshCurrent();
    } catch (error) {
      showError(error, setNotice);
    }
  };
  function renderDismissIssueModal() {
    return (
      <FormModal open={!!dismissIssueTarget} title={`Dismiss issue #${dismissIssueTarget?.issue_report_id ?? ''}`} onClose={() => setDismissIssueTarget(null)}>
        {dismissIssueTarget && (
          <>
            <p className="muted" style={{ marginBottom: 10, fontSize: '0.82rem' }}>
              Closes this report without a ticket — it isn't a real problem, or it's already handled. The reporter is told why.
            </p>
            <SmartForm
              fields={[{ label: 'Reason for dismissing', name: 'dismiss_reason', required: true, type: 'textarea', rows: 3 }]}
              key={`dismiss-${dismissIssueTarget.issue_report_id}`}
              onCancel={() => setDismissIssueTarget(null)}
              onSubmit={(payload) => dismissIssue(dismissIssueTarget, payload)}
              submitLabel="Dismiss Issue"
              title=""
            />
          </>
        )}
      </FormModal>
    );
  }

  const handleCreateTicketFromIssue = (issue) => {
    // The custodian who filed this already told us what's wrong — don't make
    // someone re-diagnose it. Pre-diagnosed mode skips straight past
    // inspection to a sub-issue ready for a mechanic; the assigned custodian
    // only re-enters later, to verify the actual repair.
    const reporterId = issue.reported_by?.id;
    const reporterIsCustodian = (ticketLookups.custodians ?? []).some((c) => c.id === reporterId);
    setPrefilledTicketData({
      vehicle_id: issue.vehicle_id,
      ticket_title: `[Issue #${recordNumber(issue, 'issue_report_id')}] ${issue.issue_type}`,
      // Severity and ticket priority share the same Low / Medium / High scale.
      priority: issue.severity_level,
      ticket_description: `Original Reported Issue: ${issue.issue_description}\nSeverity: ${issue.severity_level}`,
      issue_report_id: issue.issue_report_id,
      // In-house repair is by far the usual case — preselected so it's one
      // click less; the Custodian can switch to cannibalized / external.
      entry_mode: canDo(user, 'ticket.propose') ? 'in_house' : 'prediagnosed',
      // The custodian's report is now a list of distinct problems (one per
      // line, see issueFields' 'list' field) — carry each one over as its
      // own sub-issue instead of dumping the whole report into a single line.
      sub_issues_text: (issue.issue_description ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
        .map((line) => `${issue.issue_type}: ${line}`).join('\n'),
      // Defaulted, not locked — Admin can still pick someone else (workload,
      // availability), but the person who already knows this is the sane
      // starting point instead of a blank "Select."
      ...(reporterIsCustodian ? { assigned_custodian_id: reporterId } : {}),
    });
    navigate(`${roleRoutes[user.role]}/tickets/new`);
  };

  // #2 (Mode C) — a "Needs Repair"/"Needs Inspection" condition check
  // already IS the inspection, so spawn a pre-diagnosed ticket carrying the
  // custodian's findings straight in instead of making someone re-describe
  // the same problem all over again via a separate Issue Report. Observations
  // seed the sub-issues. Needs Repair is a confirmed problem (High); Needs
  // Inspection is still just "take a closer look" (Medium) until it is one.
  const handleCreateTicketFromCondition = (cond) => {
    setPrefilledTicketData({
      vehicle_id: cond.vehicle_id,
      ticket_title: `Condition Check: ${cond.condition_result}`,
      ticket_description: `From condition check #${cond.condition_check_id} by ${cond.checked_by?.name ?? 'custodian'}.\nObservations: ${cond.observations ?? '—'}`,
      entry_mode: canDo(user, 'ticket.propose') ? 'in_house' : 'prediagnosed',
      sub_issues_text: cond.observations || cond.condition_result,
      priority: cond.condition_result === 'Needs Repair' ? 'High' : 'Medium',
      condition_check_id: cond.condition_check_id,
    });
    navigate(`${roleRoutes[user.role]}/tickets/new`);
  };

  // The Custodian has daily eyes on the vehicle and is the one most likely
  // to notice "this is due for a checkup soon" — and, since Custodian can
  // book a schedule directly again, this hands off straight to the real Add
  // Schedule form with the vehicle and a note already filled in; nothing is
  // booked until the form is actually submitted.
  const handleSuggestScheduleFromCondition = (cond) => {
    setPrefilledScheduleData({
      vehicle_id: cond.vehicle_id,
      notes: `Suggested from condition check #${cond.condition_check_id} (${cond.condition_result})${cond.observations ? `: ${cond.observations}` : ''}`,
    });
    navigate(`${roleRoutes[user.role]}/schedules/new`);
  };

  // Maintenance Personnel can't open a ticket — this points the Custodians at
  // the exact issue so they can propose one with everything already filled in.
  const recommendTicketForIssue = async (issue) => {
    setNotice(null);
    try {
      await api.post(`/issues/${issue.issue_report_id}/recommend-ticket`);
      setNotice({ type: 'success', text: 'Custodians notified — they can open the ticket from this issue.' });
    } catch (error) {
      showError(error, setNotice);
    }
  };

  const deleteTicket = async (ticket) => {
    setNotice(null);
    try {
      await api.delete(`/tickets/${ticket.ticket_id}`, { data: { expected_revision: ticket.decision_revision ?? 0 } });
      setNotice({ type: 'success', text: 'Ticket deleted successfully.' });
      await refreshCurrent();
      return true;
    } catch (error) {
      showError(error, setNotice);
      return false;
    }
  };

  const updateRecord = async (path, payload, success) => {
    try {
      await api.put(path, payload);
      setNotice({ type: 'success', text: success });
      await refreshCurrent();
    } catch (error) {
      showError(error, setNotice);
    }
  };

  // Readiness check submitted from the post-verification prompt. Separate from
  // the Maintenance Record entirely — two different questions ("was this
  // repair done?" vs "can this vehicle respond right now?") kept as two
  // honest records, just collected in one visit.
  const submitReadinessFromPrompt = async (vehicleId, payload) => {
    setNotice(null);
    try {
      await api.post(`/vehicles/${vehicleId}/readiness-check`, payload);
      setNotice({ type: 'success', text: 'Readiness check recorded.' });
      setReadinessPromptTarget(null);
      await refreshCurrent();
    } catch (error) {
      showError(error, setNotice);
    }
  };

  const deleteRecord = async (path, success, confirmMessage) => {
    setConfirmDialog({
      title: 'Confirm Action',
      message: confirmMessage ?? 'Continue with this action?',
      confirmLabel: 'Continue',
      variant: 'danger',
      onConfirm: async () => {
        try {
          await api.delete(path);
          setNotice({ type: 'success', text: success });
          await refreshCurrent();
        } catch (error) {
          showError(error, setNotice);
        }
      },
    });
  };

  const toggleUserActive = (row, activate) => {
    // First-time approval (never approved before) — review the requested
    // role instead of blindly activating. Re-activating an already-once-
    // approved account, or deactivating, stays the plain confirm dialog.
    if (activate && !row.approved_at) {
      setApprovalTarget(row);
      return;
    }
    setConfirmDialog({
      title: 'Confirm Action',
      message: activate
        ? `Reactivate ${row.name}'s account? They will be able to log in again.`
        : `Deactivate ${row.name}'s account? They won't be able to log in until reactivated.`,
      confirmLabel: activate ? 'Activate' : 'Deactivate',
      variant: activate ? 'primary' : 'danger',
      onConfirm: async () => {
        try {
          await api.put(`/users/${row.id}/${activate ? 'activate' : 'deactivate'}`);
          setNotice({ type: 'success', text: activate ? 'User activated.' : 'User deactivated.' });
          await refreshCurrent();
        } catch (error) {
          showError(error, setNotice);
        }
      },
    });
  };

  const regenerateRegistrationCode = () => {
    setConfirmDialog({
      title: 'Regenerate Staff Registration Code',
      message: 'This immediately invalidates the current code — anyone who still has the old one won\'t be able to register until you share the new one.',
      confirmLabel: 'Regenerate',
      variant: 'danger',
      onConfirm: async () => {
        try {
          const res = await api.post('/registration-settings/regenerate');
          setRegistrationCode(res.data.staff_code);
          setNotice({ type: 'success', text: 'Staff registration code regenerated.' });
        } catch (error) {
          showError(error, setNotice);
        }
      },
    });
  };

  // `message` defaults to the vehicle wording this was originally written for,
  // so existing callers are unchanged, but a schedule restore can say what it
  // actually does instead of claiming to restore a vehicle.
  const restoreRecord = async (path, success, message = 'Restore this vehicle to active service?') => {
    setConfirmDialog({
      title: 'Confirm Action',
      message,
      confirmLabel: 'Restore',
      variant: 'primary',
      onConfirm: async () => {
        try {
          await api.post(path);
          setNotice({ type: 'success', text: success });
          await refreshCurrent();
        } catch (error) {
          showError(error, setNotice);
        }
      },
    });
  };

  const handleConfirmDialog = async () => {
    if (!confirmDialog?.onConfirm || confirmBusy) {
      return;
    }

    setConfirmBusy(true);
    try {
      await confirmDialog.onConfirm();
      setConfirmDialog(null);
    } finally {
      setConfirmBusy(false);
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  const openVehicleProfile = useCallback((vehicle, tab) => {
    if (vehicle?.vehicle_id) {
      const query = tab ? `?tab=${tab}` : '';
      navigate(`${roleRoutes[user.role]}/vehicles/${vehicle.vehicle_id}${query}`);
    }
  }, [navigate, user.role]);

  // Acknowledge unread ticket updates when opening the ticket. Keep the
  // notification data and polling that drive the ticket-list badges.
  const markTicketNotificationsRead = useCallback(async (ticketId) => {
    const toMark = notifications.filter((n) => !n.read_at && String(n.ticket_id) === String(ticketId));
    if (!toMark.length) return;
    try {
      await Promise.all(toMark.map((n) => api.put(`/notifications/${n.notification_id}/read`)));
      await loadNotifications();
    } catch { /* best-effort */ }
  }, [notifications, loadNotifications]);

  // Per-cell click targets shared with tables via context. A user cell opens
  // that user's own profile page (carrying the row's user object as fallback so
  // it renders even for roles that can't list all users).
  const openTicketProfile = useCallback((ticket) => {
    if (ticket?.ticket_id) {
      navigate(`${roleRoutes[user.role]}/tickets/${ticket.ticket_id}`);
      markTicketNotificationsRead(ticket.ticket_id);
    }
  }, [navigate, user.role, markTicketNotificationsRead]);

  const rowActions = (() => ({
      viewVehicle: openVehicleProfile,
      viewTicket: openTicketProfile,
      viewUser: (u) => {
        if (u?.id) navigate(`${roleRoutes[user.role]}/users/${u.id}`, { state: { user: u } });
      },
    }))();

  // Module URLs preserve list context across reload and browser history.
  const returnToModule = useCallback((moduleKey, filter) => {
    if (filter !== undefined) setFilterStatus(filter);
    setHasUnsavedChanges(false);
    setNotice(null);
    setActiveModule(moduleKey);
  }, [setActiveModule]);

  const handleCreateVehicle = async (payload) => {
    setNotice(null);
    try {
      const request = moduleRequest('vehicles', null, payload);
      const response = await sendPayload(request.method, request.path, payload);
      await refreshCurrent();
      setNotice({ type: 'success', text: 'Vehicle added.' });
      const newVehicleId = response?.data?.vehicle_id;
      // Arrived here via another page's "+ Add Vehicle" shortcut (e.g.
      // Report Vehicle Issue) — go back there with the new vehicle already
      // selected, instead of landing on its profile page.
      const returnTo = location.state?.returnTo;
      if (returnTo) {
        navigate(returnTo, { state: newVehicleId ? { prefillVehicleId: newVehicleId } : undefined });
      } else if (newVehicleId) {
        navigate(`${roleRoutes[user.role]}/vehicles/${newVehicleId}`);
      } else {
        returnToModule('vehicles');
      }
      return true;
    } catch (error) {
      showError(error, setNotice);
      return false;
    }
  };

  // Shared submit handler for the simple single-form pages (Vehicle Types,
  // Maintenance Schedules, Condition Checks, Issue Reports) — moduleKey picks
  // the endpoint/method, existing (or null) picks create vs update.
  // Gap 2 — close the loop on a scheduled PM: one call marks it done, logs the
  // record, and (if recurring) seeds the next occurrence.
  const completeSchedule = async (target, payload) => {
    setNotice(null);
    try {
      await sendPayload('put', `/maintenance-schedules/${target.schedule_id}/complete`, payload);
      await refreshCurrent();
      setNotice({ type: 'success', text: target.recurrence_months ? 'Marked done — next service scheduled.' : 'Marked done.' });
      setCompleteScheduleTarget(null);
    } catch (error) {
      showError(error, setNotice);
    }
  };

  // Admin's "Reassign" action (schedule.reassign ability, Admin only): hand a
  // Scheduled row to a different Maintenance Personnel without having to
  // cancel it and book a new one.
  const reassignSchedule = async (target, payload) => {
    setNotice(null);
    try {
      await api.put(`/maintenance-schedules/${target.schedule_id}/reassign`, { assigned_to: payload.assigned_to });
      await refreshCurrent();
      setNotice({ type: 'success', text: 'Schedule reassigned.' });
      setReassignScheduleTarget(null);
    } catch (error) {
      showError(error, setNotice);
    }
  };

  // Admin reviews a Custodian's Pending Approval schedule — approve puts it
  // live (Scheduled); decline collects a reason, same propose/approve/decline
  // shape as a ticket proposal. Both work from Declined too (approve direct,
  // or decline again is a no-op since it's already there).
  const approveScheduleNow = async (target) => {
    setNotice(null);
    try {
      await api.put(`/maintenance-schedules/${target.schedule_id}/approve`);
      await refreshCurrent();
      setNotice({ type: 'success', text: 'Schedule approved.' });
    } catch (error) {
      showError(error, setNotice);
    }
  };
  const approveSchedule = (target) => setConfirmDialog({
    title: 'Approve Maintenance Schedule',
    message: `Approve ${target.maintenance_type} for ${target.vehicle?.vehicle_name ?? 'this vehicle'} on ${formatDate(target.scheduled_date)}?`,
    confirmLabel: 'Approve Schedule',
    onConfirm: () => approveScheduleNow(target),
  });
  const declineSchedule = async (target, payload) => {
    setNotice(null);
    try {
      await api.put(`/maintenance-schedules/${target.schedule_id}/decline`, { decline_reason: payload.decline_reason });
      await refreshCurrent();
      setNotice({ type: 'success', text: 'Schedule declined.' });
      setDeclineScheduleTarget(null);
    } catch (error) {
      showError(error, setNotice);
    }
  };

  // Shared success tail for submitFormPage, below — pulled out so the
  // confirm-and-resubmit branch (a Maintenance Schedule conflict warning)
  // can reach the exact same "what happens after this actually saves" path
  // as an ordinary submit.
  const finishFormPageSuccess = async (moduleKey, existing, successMessage) => {
    await refreshCurrent();
    // If the admin just edited their OWN account, re-pull the logged-in user
    // so the topbar name/avatar/photo update immediately (no reload needed).
    if (moduleKey === 'users' && existing?.id != null && String(existing.id) === String(user.id)) {
      await refreshUser();
    }
    setNotice({ type: 'success', text: successMessage });
    returnToModule(moduleKey);
  };

  const submitFormPage = async (moduleKey, existing, payload) => {
    setNotice(null);
    let finalPayload = payload;
    let request;
    try {
      // "+ Add New Issue" was picked on the maintenance form instead of an
      // existing report — file the Issue Report first, then point the
      // maintenance record at the ID it comes back with. The new report's
      // required description/severity aren't asked for a second time in the
      // "Add New Issue" popup — description reuses this same form's
      // Problem/Reason (already describing what's wrong), and severity
      // defaults to Medium since this form has no better signal for it.
      // Admin owns the maintenance calendar — a Custodian filling in this same
      // form is sending a suggestion, which books nothing.
      if (moduleKey === 'schedules' && !existing && !canDo(user, 'schedule.create') && canDo(user, 'schedule.suggest')) {
        await api.post('/maintenance-schedules/suggest', {
          vehicle_id: payload.vehicle_id,
          maintenance_type: payload.maintenance_type,
          scheduled_date: payload.scheduled_date || undefined,
          notes: payload.notes || undefined,
        });
        await finishFormPageSuccess(moduleKey, existing, 'Suggestion sent to Admin.');
        return true;
      }

      if (moduleKey === 'maintenance' && payload.issue_report_id === '__new_issue__') {
        const { data: newIssue } = await api.post('/issues', {
          vehicle_id: payload.vehicle_id,
          issue_type: payload.new_issue_type,
          issue_description: payload.problem_reason,
          severity_level: 'Medium',
        });
        finalPayload = {
          ...payload,
          issue_report_id: newIssue.issue_report_id,
          new_issue_type: undefined,
          __new_issue_group__: undefined,
        };
      }

      if (moduleKey === 'schedules' && existing) {
        finalPayload = { ...finalPayload };
        delete finalPayload.status;
        if ((records.schedules ?? []).find((row) => String(row.schedule_id) === String(existing.schedule_id))?.status === 'Scheduled') {
          delete finalPayload.assigned_to;
        }
      }
      request = moduleRequest(moduleKey, existing, finalPayload);
      const response = await sendPayload(request.method, request.path, finalPayload);

      // Land on the report just filed — with its own [Create Maintenance
      // Ticket] action right there — instead of back on the list, which
      // would make the reporter search for what they just submitted.
      if (moduleKey === 'issues' && !existing && response?.data?.issue_report_id) {
        await refreshCurrent();
        setNotice({ type: 'success', text: request.success });
        navigate(`${roleRoutes[user.role]}/issues/${response.data.issue_report_id}`);
        return true;
      }

      await finishFormPageSuccess(moduleKey, existing, request.success);
      return true;
    } catch (error) {
      // A Maintenance Schedule create/update that lands on a same-vehicle or
      // barangay daily-volume conflict comes back as a 409 warning, not a
      // hard block — the backend never refuses outright, it just wants an
      // explicit "yes, anyway" first. Surface that as the same confirm
      // dialog used elsewhere in this file, and resubmit the exact same
      // payload with confirm_conflicts: true if the user confirms.
      if (moduleKey === 'schedules' && error.response?.status === 409 && error.response?.data?.warning) {
        setConfirmDialog({
          title: 'Scheduling Conflict',
          message: error.response.data.message,
          confirmLabel: existing ? 'Save Anyway' : 'Add Anyway',
          variant: 'primary',
          onConfirm: async () => {
            try {
              await sendPayload(request.method, request.path, { ...finalPayload, confirm_conflicts: true });
              await finishFormPageSuccess(moduleKey, existing, request.success);
            } catch (confirmError) {
              showError(confirmError, setNotice);
            }
          },
        });
        return false;
      }
      showError(error, setNotice);
      return false;
    }
  };

  // Work Orders still act per sub-issue (a mechanic's own assigned lines) —
  // flatten each ticket's sub_issues into standalone rows so the existing
  // status filters below (which check row.status) keep working unchanged.
  // Verification is now a ticket-level step (one Custodian attestation
  // closes the whole job), so its rows are the tickets themselves —
  // narrowed to this Custodian's own tickets. Once a ticket is approved it
  // graduates out of "Issue Reports" (still a pre-ticket proposal) and into
  // this "My Tickets" queue so the Custodian can trace its progress —
  // Active tickets are included here too, not just the verification stage.
  const completedMaintenanceRows = useMemo(() => completedMaintenanceRecords(records.maintenance), [records.maintenance]);
  const rawRows = useMemo(() => (activeModule === 'ticketWorkOrders'
    // Cancelled tickets aren't work orders — they'd sit in Total but in no bucket.
    ? flattenSubIssueRows(records[activeModule], hasRole(user, 'Admin') ? null : user.id).filter((r) => ['Active', 'For Verification', 'Closed'].includes(r.ticket_status))
    : activeModule === 'ticketVerifications'
      ? (records[activeModule] ?? []).filter((t) => (
          String(t.assigned_custodian_id) === String(user.id)
          && ['Active', 'For Verification', 'Closed'].includes(t.status)
        ))
      : activeModule === 'maintenance' ? completedMaintenanceRows : records[activeModule] ?? []), [activeModule, records, user, completedMaintenanceRows]);
  const visibleRows = useMemo(() => {
    let result = rawRows;

    if (filterCategory.length) {
      result = result.filter((row) => {
        const vehicleObj = row.vehicle || (activeModule === 'vehicles' ? row : null);
        if (!vehicleObj) return false;
        return filterCategory.includes(String(vehicleObj.category_id));
      });
    }

    if (filterCapacity.length) {
      result = result.filter((row) => {
        const vehicleObj = row.vehicle || (activeModule === 'vehicles' ? row : null);
        if (!vehicleObj) return false;
        return filterCapacity.includes(vehicleObj.capacity);
      });
    }

    // Location/Domain filters — shared by Vehicle Management and any module
    // whose rows carry the same fields (Vehicle Location's own current
    // location; Vehicle Types' own domain).
    if ((activeModule === 'vehicles' || activeModule === 'locations') && filterLocation.length) {
      result = result.filter((row) => filterLocation.includes(row.current_location));
    }
    if (activeModule === 'schedules' && filterLocation.length) {
      result = result.filter((row) => filterLocation.includes(row.service_location));
    }
    if (activeModule === 'vehicles' && filterDomain.length) {
      result = result.filter((row) => filterDomain.includes(row.category?.domain));
    }
    if (activeModule === 'categories' && filterDomain.length) {
      result = result.filter((row) => filterDomain.includes(row.domain));
    }

    // Ready to Respond — a real dropdown, independent of the Status filter
    // above and the stat-card quick toggles (which write pseudo-values into
    // filterStatus instead). Retired vehicles stay excluded from both
    // buckets, matching vehicleStats' own count.
    if (activeModule === 'vehicles' && filterReadiness.length) {
      result = result.filter((row) => {
        if (row.readiness_state === 'retired') return false;
        return filterReadiness.includes(row.readiness_state === 'ready' ? 'Ready' : 'Not Ready');
      });
    }

    if (activeModule === 'vehicles' && !filterStatus.length) {
      result = result.filter((row) => row.status !== 'Inactive');
    }

    if (activeModule === 'schedules' && filterStatus.length) {
      result = result.filter((row) => filterStatus.some((key) => {
        if (key === 'MyAssigned') return row.status === 'Scheduled' && String(row.assigned_to) === String(user.id);
        if (key === 'NeedsAttention') return ['Pending Approval', 'Declined'].includes(row.status);
        if (key === 'Closed') return row.status === 'Cancelled' || (row.status === 'Completed' && (!row.resulting_maintenance || row.resulting_maintenance.progress_status === 'Completed'));
        return SCHEDULE_URGENCY_KEYS.includes(key) ? key === scheduleUrgencyBucket(row) : key === scheduleStage(row);
      }));
    } else if (activeModule === 'ticketInspections') {
      result = result.filter((row) => (
        filterStatus.includes('Inspected') ? row.status !== 'Open' : row.status === 'Open'
      ));
    } else if (activeModule === 'ticketWorkOrders') {
      const statuses = filterStatus.map((key) => WORK_ORDER_BUCKET_STATUS[key]).filter(Boolean);
      if (statuses.length) result = result.filter((row) => statuses.includes(row.ticket_status));
    } else if (activeModule === 'ticketVerifications') {
      const statuses = filterStatus.map((key) => VERIFICATION_BUCKET_STATUS[key]).filter(Boolean);
      if (statuses.length) result = result.filter((row) => statuses.includes(row.status));
    } else if (activeModule === 'vehicles' && (filterStatus.includes('ReadyToRespond') || filterStatus.includes('NotReady'))) {
      // Retired vehicles are excluded from both buckets up in vehicleStats —
      // match that here too, or "Not Ready" would list units the card's own
      // count didn't include.
      result = result.filter((row) => row.readiness_state !== 'retired').filter((row) => (
        filterStatus.includes('ReadyToRespond') ? row.readiness_state === 'ready' : row.readiness_state !== 'ready'
      ));
    } else if (filterStatus.length && activeModule === 'users') {
      result = result.filter((row) => filterStatus.includes(row.role));
    } else if (filterStatus.length && activeModule === 'locations') {
      // Location records nest the vehicle status under `.vehicle`, not on
      // the row itself (the row IS a location snapshot, not a vehicle).
      result = result.filter((row) => filterStatus.includes(row.vehicle?.status));
    } else if (filterStatus.length && !['conditions', 'maintenance'].includes(activeModule)) {
      result = result.filter((row) => {
        const statusVal = row.status ?? row.progress_status ?? row.final_status;
        return filterStatus.includes(statusVal);
      });
    }

    if (filterPriority.length) {
      result = result.filter((row) => {
        if (activeModule === 'vehicles') {
          return filterPriority.includes(row.condition);
        }
        if (activeModule === 'issues') {
          return filterPriority.includes(row.severity_level);
        }
        if (activeModule === 'maintenance') {
          return filterPriority.includes(row.maintenance_personnel?.name);
        }
        // Verification queue reuses the Priority slot as a Mechanic filter —
        // the ticket's one assigned mechanic, not a priority level.
        if (activeModule === 'ticketVerifications') {
          return filterPriority.includes(row.assigned_mechanic?.name);
        }
        // Work Order queue reuses it as a Maintenance Type filter.
        if (activeModule === 'ticketWorkOrders') {
          return filterPriority.includes(row.maintenance_type);
        }
        return filterPriority.includes(row.priority);
      });
    }

    // Maintenance Schedule's own "Assigned To" filter — a dedicated
    // dimension since Schedules doesn't otherwise use the Priority slot.
    if (activeModule === 'schedules' && filterAssignedTo.length) {
      result = result.filter((row) => filterAssignedTo.includes(row.assigned_to_user?.name));
    }

    if (activeModule === 'tickets' && filterVehicle.length) {
      result = result.filter((row) => filterVehicle.includes(String(row.vehicle?.vehicle_id)));
    }

    // A ticket has no single mechanic of its own — it's assigned per
    // sub-issue — so this matches any ticket with at least one sub-issue
    // assigned to the selected mechanic(s).
    if (activeModule === 'tickets' && filterMechanic.length) {
      result = result.filter((row) => (row.sub_issues ?? []).some((si) => filterMechanic.includes(si.assigned_mechanic?.name)));
    }

    if (activeModule === 'tickets' && filterCustodian.length) {
      result = result.filter((row) => filterCustodian.includes(row.assigned_custodian?.name));
    }

    if (activeModule === 'issues' && filterIssueType.length) {
      result = result.filter((row) => filterIssueType.includes(row.issue_type));
    }

    // Issue Reports only ever shows pre-ticket reports — once a proposal is
    // approved it graduates into "My Tickets" instead (see issueIsPreTicket).
    if (activeModule === 'issues') {
      result = result.filter((row) => issueIsPreTicket(row));
    }

    if (activeModule === 'maintenance') {
      if (filterMaintType.length) {
        result = result.filter((row) => filterMaintType.includes(row.maintenance_type));
      }
      if (filterSource.length) {
        result = result.filter((row) => filterSource.includes(maintenanceSourceBucket(row)));
      }
    }

    if (activeModule === 'users' && filterActive.length) {
      result = result.filter((row) => filterActive.includes(row.is_active ? 'Active' : 'Inactive'));
    }

    if (activeModule === 'ticketVerifications' && filterVerdict.length) {
      // The verdict now lives per sub-issue, not on the ticket row itself —
      // match a ticket if any of its sub-issues carry the selected verdict.
      // Going forward verifyTicket() only ever writes 'Approved' (the old
      // per-sub-issue reject path is dead), but historical tickets verified
      // under the prior flow may still carry a 'Rejected' verdict.
      result = result.filter((row) => (row.sub_issues ?? []).some((si) => filterVerdict.includes(si.verification_verdict)));
    }

    if (activeModule === 'histories' && filterActivityType.length) {
      result = result.filter((row) => filterActivityType.includes(row.activity_type));
    }

    // Date range — same two fields, applied to whichever date column is
    // meaningful for the active module.
    if (filterDateStart || filterDateEnd) {
      const dateField = activeModule === 'maintenance' ? 'date_completed'
        : activeModule === 'tickets' ? 'created_at'
        : activeModule === 'issues' ? 'created_at'
        : activeModule === 'histories' ? 'created_at'
        : null;
      if (dateField) {
        result = result.filter((row) => {
          const raw = row[dateField];
          if (!raw) return false;
          const rowDate = raw.substring(0, 10);
          if (filterDateStart && rowDate < filterDateStart) return false;
          if (filterDateEnd && rowDate > filterDateEnd) return false;
          return true;
        });
      }
    }

    if (activeModule === 'conditions') {
      if (filterCategory.length) {
        result = result.filter((row) => {
          const catId = row.vehicle?.category_id;
          return catId && filterCategory.includes(String(catId));
        });
      }

      if (filterStatus.length) {
        result = result.filter((row) => {
          return filterStatus.includes(currentCondition(row));
        });
      }

      if (filterCheckedBy.length) {
        result = result.filter((row) => filterCheckedBy.includes(row.checked_by?.name));
      }

      if (condFilterStartDate) {
        result = result.filter((row) => {
          const rowDate = row.created_at ? row.created_at.substring(0, 10) : '';
          return rowDate >= condFilterStartDate;
        });
      }

      if (condFilterEndDate) {
        result = result.filter((row) => {
          const rowDate = row.created_at ? row.created_at.substring(0, 10) : '';
          return rowDate <= condFilterEndDate;
        });
      }
    }

    if (activeModule === 'ticketArchives') {
      result = result.filter((row) => showDeletedArchives ? !!row.deleted_at || row.final_status === 'Deleted' : !row.deleted_at && row.final_status !== 'Deleted');
      if (archiveStart) {
        result = result.filter((row) => row.archived_at && row.archived_at.substring(0, 10) >= archiveStart);
      }
      if (archiveEnd) {
        result = result.filter((row) => row.archived_at && row.archived_at.substring(0, 10) <= archiveEnd);
      }
      if (archiveStatusFilter) {
        result = result.filter((row) => row.final_status === archiveStatusFilter);
      }
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase().trim();
      result = result.filter((row) => {
        const matchesField = (val) => val && String(val).toLowerCase().includes(query);

        if (activeModule === 'maintenance' && matchesField(maintenanceSourceLabel(row))) return true;

        if (activeModule === 'conditions' && (
          matchesField(currentCondition(row)) || matchesField(row.resulting_ticket?.status)
          || matchesField(row.resulting_ticket?.ticket_title)
          || (row.resulting_ticket && matchesField(ticketNumber(row.resulting_ticket)))
        )) return true;

        if (
          matchesField(row.vehicle_name) ||
          matchesField(row.plate_number) ||
          matchesField(row.ticket_title) ||
          matchesField(row.ticket_description) ||
          matchesField(row.problem_reason) ||
          matchesField(row.action_taken) ||
          matchesField(row.activity) ||
          matchesField(row.description) ||
          matchesField(row.observations) ||
          matchesField(row.address_area) ||
          matchesField(row.current_location) ||
          matchesField(row.category_name) ||
          matchesField(row.brand) ||
          matchesField(row.model) ||
          matchesField(row.status) ||
          matchesField(row.progress_status) ||
          matchesField(row.ticket_id) ||
          matchesField(row.maintenance_id) ||
          matchesField(row.issue_report_id) ||
          matchesField(row.schedule_id) ||
          matchesField(row.action) ||
          matchesField(row.module) ||
          matchesField(row.role) ||
          matchesField(row.details) ||
          matchesField(row.affected_record_id) ||
          matchesField(row.log_id)
        ) {
          return true;
        }

        if (row.user && matchesField(row.user.name)) return true;

        if (row.vehicle) {
          if (
            matchesField(row.vehicle.vehicle_name) ||
            matchesField(row.vehicle.plate_number) ||
            matchesField(row.vehicle.brand) ||
            matchesField(row.vehicle.model)
          ) {
            return true;
          }
        }

        if (row.reported_by && matchesField(row.reported_by.name)) return true;
        if (row.checked_by && matchesField(row.checked_by.name)) return true;
        if (row.updated_by && matchesField(row.updated_by.name)) return true;
        if (row.assigned_custodian && matchesField(row.assigned_custodian.name)) return true;
        if (row.assigned_mechanic && matchesField(row.assigned_mechanic.name)) return true;
        if (row.maintenance_personnel && matchesField(row.maintenance_personnel.name)) return true;

        return false;
      });
    }

    // A "Completed" schedule only means the calendar task is done — the
    // record it produced might still need Custodian verification. Float
    // those to the top instead of leaving them buried among rows that are
    // genuinely finished, so the ones still needing attention are the
    // first thing Admin sees.
    if (activeModule === 'schedules') {
      const needsAttention = (row) => (
        row.status === 'Completed' && row.resulting_maintenance && row.resulting_maintenance.progress_status !== 'Completed' ? 0 : 1
      );
      result = [...result].sort((a, b) => needsAttention(a) - needsAttention(b));
    }

    return result;
  }, [rawRows, searchQuery, filterCategory, filterCapacity, filterLocation, filterDomain, filterStatus, filterPriority, filterReadiness, filterIssueType, filterMaintType, filterSource, filterActive, filterAssignedTo, filterVerdict, filterCheckedBy, filterActivityType, filterVehicle, filterMechanic, filterCustodian, filterDateStart, filterDateEnd, activeModule, condFilterStartDate, condFilterEndDate, archiveStart, archiveEnd, archiveStatusFilter, showDeletedArchives, user.id]);

  // Status breakdown for the Vehicle Management stat cards — counted from the
  // full unfiltered fetch so the cards stay accurate regardless of the active
  // search/filter selection.
  // Generic "total + count per value" helper reused by every module's stat
  // card row (Issue Reports, Maintenance Schedule, Condition Monitoring, etc.).
  const countByValues = (rows, getField, values) => {
    const counts = { total: rows.length };
    values.forEach((v) => { counts[v] = rows.filter((r) => getField(r) === v).length; });
    return counts;
  };

  const issueStats = useMemo(
    () => countByValues(records.issues ?? [], (r) => r.status, ['Pending', 'Under Review', 'In Maintenance', 'Resolved']),
    [records.issues]
  );
  const issueSeverityStats = useMemo(
    () => countByValues(records.issues ?? [], (r) => r.severity_level, ['High', 'Medium', 'Low']),
    [records.issues]
  );

  const scheduleStats = useMemo(() => {
    const base = countByValues(records.schedules ?? [], scheduleStage, ['Pending Approval', 'Declined', 'Scheduled', 'Completed', 'Cancelled']);
    // A schedule marked "Completed" only means the calendar task is done —
    // the record it produced might still be sitting unverified. Surface
    // that as its own count so it's findable instead of buried among
    // fully-verified rows.
    const awaitingVerification = (records.schedules ?? []).filter(
      (r) => r.status === 'Completed' && r.resulting_maintenance && r.resulting_maintenance.progress_status !== 'Completed'
    ).length;
    // A mechanic's own pending workload — how many vehicles THEY still need
    // to do, not the fleet-wide total everyone else also sees.
    const myAssigned = (records.schedules ?? []).filter(
      (r) => r.status === 'Scheduled' && String(r.assigned_to) === String(user.id)
    ).length;
    const needsAttention = base['Pending Approval'] + base.Declined;
    const closed = base.Cancelled + base.Completed - awaitingVerification;
    // How soon each still-scheduled row is due — retained for row ordering
    // and future schedule views, while the summary stays intentionally compact.
    const urgency = { Overdue: 0, Due1to3: 0, Due4to7: 0, Due8plus: 0 };
    (records.schedules ?? []).forEach((r) => {
      const bucket = scheduleUrgencyBucket(r);
      if (bucket) urgency[bucket] += 1;
    });
    return {
      ...base,
      ...urgency,
      NeedsAttention: needsAttention,
      AwaitingVerification: awaitingVerification,
      Closed: closed,
      MyAssigned: myAssigned,
    };
  }, [records.schedules, user.id]);

  // A vehicle with no check on file yet is its own bucket ("Not Checked"),
  // not just an absence from the list — so the stat cards (and the list
  // below) reflect the whole fleet's coverage, not only vehicles someone
  // has gotten around to inspecting.
  const conditionRowsForStats = useMemo(() => {
    const latest = new Map();
    [...(records.conditions ?? [])].sort((a, b) => String(b.checked_at ?? b.created_at ?? '').localeCompare(String(a.checked_at ?? a.created_at ?? '')) || (b.condition_check_id ?? 0) - (a.condition_check_id ?? 0)).forEach((row) => {
      if (!latest.has(String(row.vehicle_id))) latest.set(String(row.vehicle_id), row);
    });
    return (lookups.vehicles ?? []).filter((vehicle) => !['Inactive', 'Decommissioned'].includes(vehicle.status)).map((vehicle) => latest.get(String(vehicle.vehicle_id)) ?? { condition_result: 'Not Checked' });
  }, [records.conditions, lookups.vehicles]);

  const vehicleStats = useMemo(() => {
    const rows = records.vehicles ?? [];
    const countByStatus = (status) => rows.filter((row) => row.status === status).length;
    // Retired (Inactive/Decommissioned) vehicles were never expected to
    // respond, so they're excluded from both sides of this split — otherwise
    // a fleet that's mostly retired reads as "not ready to respond" when
    // it's really just not in service.
    const inServiceRows = rows.filter((row) => row.readiness_state !== 'retired');
    return {
      total: rows.length,
      Available: countByStatus('Available'),
      'Under Maintenance': countByStatus('Under Maintenance'),
      Inactive: countByStatus('Inactive'),
      ReadyToRespond: inServiceRows.filter((row) => row.readiness_state === 'ready').length,
      NotReady: inServiceRows.filter((row) => row.readiness_state !== 'ready').length,
    };
  }, [records.vehicles]);

  const conditionStats = useMemo(
    () => countByValues(conditionRowsForStats, currentCondition, ['Good', 'Needs Repair', 'Not Checked']),
    [conditionRowsForStats]
  );

  const maintenanceRecordStats = useMemo(() => countByValues(completedMaintenanceRows, maintenanceSourceBucket, ['In-House Repair', 'External Shop', 'Scheduled Maintenance']), [completedMaintenanceRows]);

  const userStats = useMemo(
    () => countByValues(records.users ?? [], (r) => r.role, ['Admin', 'Custodian', 'Maintenance Personnel']),
    [records.users]
  );
  const userStatusStats = useMemo(
    () => countByValues(records.users ?? [], (r) => (r.is_active ? 'Active' : 'Inactive'), ['Active', 'Inactive']),
    [records.users]
  );

  const inspectionStats = useMemo(() => {
    const rows = records.ticketInspections ?? [];
    const pending = rows.filter((r) => r.status === 'Open').length;
    return { total: rows.length, Pending: pending, Inspected: rows.length - pending };
  }, [records.ticketInspections]);

  const workOrderStats = useMemo(() => {
    const tickets = (records.ticketWorkOrders ?? []).filter((t) => (
      ['Active', 'For Verification', 'Closed'].includes(t.status) && (t.sub_issues ?? []).some((si) => hasRole(user, 'Admin') || si.assigned_mechanic_id === user.id)
    ));
    const count = (status) => tickets.filter((t) => t.status === status).length;
    return { total: tickets.length, Pending: count('Active'), Submitted: count('For Verification'), Completed: count('Closed') };
  }, [records.ticketWorkOrders, user]);

  const verificationStats = useMemo(() => {
    // Mirrors rawRows' own scoping above — one row per ticket, restricted to
    // this Custodian's own tickets ("My Tickets": Active through Closed).
    const rows = (records.ticketVerifications ?? []).filter((t) => (
      String(t.assigned_custodian_id) === String(user.id)
      && ['Active', 'For Verification', 'Closed'].includes(t.status)
    ));
    const active = rows.filter((r) => r.status === 'Active').length;
    const pending = rows.filter((r) => r.status === 'For Verification').length;
    const verified = rows.filter((r) => r.status === 'Closed').length;
    return { total: rows.length, Active: active, Pending: pending, Verified: verified };
  }, [records.ticketVerifications, user.id]);



  // For the Vehicle Location module, every vehicle shown on the map should also
  // appear in the records list. We merge the saved location records (history)
  // with a synthesized "current" row for each vehicle that has no record yet,
  // so the list always mirrors the map.
  const locationRows = useMemo(() => {
    if (activeModule !== 'locations') {
      return visibleRows;
    }

    const vehiclesWithRecord = new Set(visibleRows.map((row) => row.vehicle_id));
    const query = searchQuery.toLowerCase().trim();

    const syntheticRows = (lookups.vehicles ?? [])
      .filter((vehicle) => !vehiclesWithRecord.has(vehicle.vehicle_id))
      .filter((vehicle) => {
        if (!query) return true;
        return [vehicle.vehicle_name, vehicle.plate_number, vehicle.current_location]
          .some((val) => val && String(val).toLowerCase().includes(query));
      })
      .map((vehicle) => ({
        location_record_id: null,
        vehicle_id: vehicle.vehicle_id,
        vehicle,
        current_location: vehicle.current_location,
        address_area: null,
        updated_by: null,
        updated_at: vehicle.updated_at ?? null,
        is_current_snapshot: true,
      }));

    return [...visibleRows, ...syntheticRows];
  }, [activeModule, visibleRows, lookups.vehicles, searchQuery]);

  // Same reasoning as locationRows above: Condition Monitoring should mirror
  // the whole fleet, not just vehicles that happen to have a check on file.
  // Merge the (already-filtered) check records with a synthesized "Not
  // Checked" row for every vehicle missing one — subject to the same active
  // filters, so a vehicle only appears here when it'd also match a real row.
  const conditionRows = useMemo(() => {
    if (activeModule !== 'conditions') {
      return visibleRows;
    }

    // A synthetic row has no checker or date to filter on, so it only
    // belongs in the merged list when none of those filters are narrowing
    // the results — otherwise "checked by Juan" or a date range would be
    // showing vehicles that were never checked at all.
    if (filterCheckedBy.length || condFilterStartDate || condFilterEndDate) {
      return visibleRows;
    }
    if (filterStatus.length && !filterStatus.includes('Not Checked')) {
      return visibleRows;
    }

    const vehiclesWithRecord = new Set((records.conditions ?? []).map((r) => r.vehicle_id));
    const query = searchQuery.toLowerCase().trim();

    const syntheticRows = (lookups.vehicles ?? [])
      .filter((vehicle) => !vehiclesWithRecord.has(vehicle.vehicle_id))
      .filter((vehicle) => !filterCategory.length || filterCategory.includes(String(vehicle.category_id)))
      .filter((vehicle) => !filterCapacity.length || filterCapacity.includes(vehicle.capacity))
      .filter((vehicle) => {
        if (!query) return true;
        return [vehicle.vehicle_name, vehicle.plate_number].some((val) => val && String(val).toLowerCase().includes(query));
      })
      .map((vehicle) => ({
        condition_check_id: null,
        vehicle_id: vehicle.vehicle_id,
        vehicle,
        condition_result: 'Not Checked',
        checked_by: null,
        observations: null,
        created_at: null,
      }));

    return [...visibleRows, ...syntheticRows];
  }, [activeModule, visibleRows, records.conditions, lookups.vehicles, searchQuery, filterCategory, filterCapacity, filterCheckedBy, filterStatus, condFilterStartDate, condFilterEndDate]);

  const viewVehicleOnMap = useCallback((row) => {
    const vehicleId = row.vehicle_id ?? row.vehicle?.vehicle_id;
    if (!vehicleId) return;
    setSelectedMapVehicleId(vehicleId);
    setLocationsTab('map');
  }, []);

  const locationTableColumns = useMemo(
    () => locationColumns(user, viewVehicleOnMap, (row) => navigate(`${roleRoutes[user.role]}/locations/${row.vehicle_id}/edit`)),
    [user, viewVehicleOnMap, navigate],
  );

  // "All Vehicles" is the pilot table for the Choose Columns toolbar button
  // (show/hide + drag to reorder, persisted per browser) — see
  // ColumnChooserButton/useColumnChooser below.
  const vehicleColumnDefs = (() => vehicleColumns(user, (row) => openVehicleProfile(row, 'edit'), deleteRecord, restoreRecord, filterStatus, openTicketProfile, (row) => setReadinessPromptTarget(row)))();
  const vehicleColumnChooser = useColumnChooser('vms_vehicle_columns_v2', vehicleColumnDefs);

  // Every other module's table gets the same Choose Columns / drag-to-reorder
  // treatment as Vehicle Management above — one useColumnChooser call per
  // table, hoisted up here (not inside renderModule's per-module branches)
  // because hooks can't run conditionally; renderModule only executes the
  // branch matching the current activeModule.
  const categoryColumnDefs = (() => categoryColumns((row) => navigate(`${roleRoutes[user.role]}/categories/${row.category_id}/edit`), deleteRecord))();
  const categoryColumnChooser = useColumnChooser('vms_category_columns', categoryColumnDefs);

  const userColumnDefs = (() => userColumns((row) => navigate(`${roleRoutes[user.role]}/users/${row.id}/edit`), toggleUserActive, user.id))();
  const userColumnChooser = useColumnChooser('vms_user_columns', userColumnDefs);

  const locationColumnChooser = useColumnChooser('vms_location_columns', locationTableColumns);

  const conditionColumnDefs = (() => conditionColumns(
      user,
      (row) => navigate(`${roleRoutes[user.role]}/conditions/${row.condition_check_id}/edit`),
      deleteRecord,
      handleCreateTicketFromCondition,
      handleSuggestScheduleFromCondition,
      canDo(user, 'condition.create') ? (row) => {
        setPrefilledConditionVehicleId(row.vehicle_id);
        navigate(`${roleRoutes[user.role]}/conditions/new`);
      } : undefined,
      openTicketProfile,
    ))();
  const conditionColumnDefsWithNote = useMemo(() => withNoteColumn(conditionColumnDefs, (r) => r.observations, { label: 'Observations' }), [conditionColumnDefs]);
  const conditionColumnChooser = useColumnChooser('vms_condition_columns', conditionColumnDefsWithNote);

  const issueColumnDefs = (() => issueColumns(user.role, (row) => navigate(`${roleRoutes[user.role]}/issues/${row.issue_report_id}/edit`), handleCreateTicketFromIssue, setUserInfoTarget, (row) => navigate(`${roleRoutes[user.role]}/issues/${row.issue_report_id}`), deleteRecord, user, openTicketProfile, setDismissIssueTarget))();
  const issueColumnChooser = useColumnChooser('vms_issue_columns', issueColumnDefs);

  const maintenanceColumnDefs = maintenanceColumns((row) => navigate(`${roleRoutes[user.role]}/maintenance/${row.maintenance_id}`));
  const maintenanceColumnChooser = useColumnChooser('vms_completed_maintenance_columns', maintenanceColumnDefs);

  const maintenanceStatusColumnDefs = useMemo(
    () => maintenanceStatusColumns(setEditTarget, user.id),
    [user.id],
  );
  const maintenanceStatusColumnDefsWithNote = useMemo(
    () => withNoteColumn(maintenanceStatusColumnDefs, (r) => [r.problem_reason, r.action_taken].filter(Boolean).join(' — '), { label: 'Details' }),
    [maintenanceStatusColumnDefs],
  );
  const maintenanceStatusColumnChooser = useColumnChooser('vms_maintenance_status_columns', maintenanceStatusColumnDefsWithNote);

  const scheduleColumnDefs = (() => scheduleColumns((row) => navigate(`${roleRoutes[user.role]}/schedules/${row.schedule_id}/edit`), deleteRecord, openCompleteSchedule, user, (row) => navigate(`${roleRoutes[user.role]}/maintenance/${row.resulting_maintenance_id}`), restoreRecord, setReassignScheduleTarget, openTicketProfile, approveSchedule, setDeclineScheduleTarget))();
  const scheduleColumnChooser = useColumnChooser('vms_schedule_columns', scheduleColumnDefs);

  const historyColumnsWithNote = useMemo(() => withNoteColumn(historyColumns, (r) => r.description, { label: 'Description', width: '24%' }), []);
  const vehicleHistoryColumnChooser = useColumnChooser('vms_vehicle_history_columns', historyColumnsWithNote);

  const logColumnDefs = (() => logColumns(lookups.vehicles, openVehicleProfile, openTicketProfile))();
  const logColumnChooser = useColumnChooser('vms_activity_log_columns', logColumnDefs);

  const archiveColumnDefs = [
    ...ticketArchiveColumns,
    {
      key: 'actions',
      label: 'Actions',
      locked: true,
      className: 'cell-center',
      render: (row) => (
        <div className="row-actions">
          {row.final_status === 'Closed' && <button className="btn-view-action icon-btn" type="button" title="View Ticket" aria-label="View Ticket" onClick={() => openTicketProfile({ ticket_id: row.ticket_id })}><Icon name="eye" size={14} /></button>}
          {row.deleted_at || row.final_status === 'Deleted' ? (
            <button className="btn-reopen-action icon-btn" type="button" title="Restore Ticket" aria-label="Restore Ticket" onClick={() => setConfirmDialog({
              title: 'Restore Ticket', message: row.deleted_at ? 'Restore this record to Archived Tickets?' : 'Restore this deleted ticket and its recorded repair progress?', confirmLabel: 'Restore', variant: 'primary',
              onConfirm: () => ticketAction('/ticket-archives/' + row.archive_id + (row.deleted_at ? '/restore' : '/reopen'), {}, 'Ticket restored.'),
            })}><Icon name="undo" size={14} /></button>
          ) : <button className="btn-delete-action icon-btn" type="button" title="Delete Archived Ticket" aria-label="Delete Archived Ticket" onClick={() => setConfirmDialog({
            title: 'Delete Archived Ticket', message: 'Move this archived record to Deleted Tickets? You can restore it later.', confirmLabel: 'Delete', variant: 'danger',
            onConfirm: async () => { try { await api.delete('/ticket-archives/' + row.archive_id); await refreshCurrent(); } catch (err) { setNotice({ type: 'error', text: err.response?.data?.message || 'Could not delete archived ticket.' }); } },
          })}><Icon name="trash" size={14} /></button>}
        </div>
      ),
    },
  ];
  const archiveColumnChooser = useColumnChooser('vms_ticket_archive_columns', archiveColumnDefs);

  // On phones the menu button opens the sidebar as a slide-out drawer
  // instead of collapsing it to the icon rail.
  const isPhoneWidth = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;
  const toggleSidebar = () => {
    if (isPhoneWidth()) {
      setMobileNavOpen((open) => !open);
      return;
    }
    setIsSidebarCollapsed((prev) => !prev);
  };

  // Fleet maps always use the current account's own barangay boundary.
  const [mapBoundaryOverride, setMapBoundaryOverride] = useState({ geometry: null, label: 'Loading barangay boundary' });
  const locationBoundaryPolygons = useMemo(() => geoJsonToPolygons(mapBoundaryOverride?.geometry), [mapBoundaryOverride]);
  const locationBoundaryLabel = mapBoundaryOverride?.label ?? 'Barangay boundary';
  useEffect(() => {
    let cancelled = false;
    const boundaryRequest = user.barangay_id ? api.get('/barangays/' + user.barangay_id) : Promise.resolve(null);
    boundaryRequest.then((response) => {
        if (cancelled) return;
        if (!response) { setMapBoundaryOverride({ geometry: null, label: 'No barangay selected' }); return; }
        const { data } = response;
        const label = data.city_name ? data.name + ', ' + data.city_name : data.name;
        setMapBoundaryOverride({ geometry: data.boundary ?? null, label, barangayName: data.name, cityName: data.city_name, source: data.boundary_source, psgcCode: data.psgc_code, verified: data.boundary_verified === true });
      }).catch(() => {
        if (!cancelled) setMapBoundaryOverride({ geometry: null, label: 'Boundary unavailable' });
      });
    return () => { cancelled = true; };
  }, [user.barangay_id]);

  // Sidebar badge for a given module key — 'myTasks' has no badge_counts
  // entry of its own (it's not a real module), so it's the sum of the two
  // real queues it groups. Shared by each row's own badge and by a
  // collapsed group header's summed badge below.
  const rawBadgeCountFor = (key) => (
    key === 'myTasks'
      ? (dashboard?.badge_counts?.ticketVerifications ?? 0)
      : (dashboard?.badge_counts?.[key] ?? 0)
  );
  // A badge means "new since you last looked": opening a module marks what is
  // there as seen, so its badge clears and only comes back when something new
  // arrives. If the underlying count drops (work gets resolved), the seen mark
  // drops with it so the next new item shows again. Kept per user in
  // localStorage; the count itself still comes from the one shared dashboard
  // payload.
  const seenStorageKey = `vms_badge_seen_${user?.id ?? 'anon'}`;
  const [seenBadges, setSeenBadges] = useState(() => {
    try { return JSON.parse(localStorage.getItem(seenStorageKey) ?? '{}') || {}; } catch { return {}; }
  });
  const badgeResetKey = JSON.stringify([dashboard?.badge_counts, breadcrumbModule, seenStorageKey]);
  const [previousBadgeResetKey, setPreviousBadgeResetKey] = useState(null);
  if (dashboard && previousBadgeResetKey !== badgeResetKey) {
    setPreviousBadgeResetKey(badgeResetKey);

    const viewing = new Set([breadcrumbModule]);
    if (['ticketVerifications', 'ticketInspections', 'workTracker'].includes(breadcrumbModule)) viewing.add('myTasks');
    setSeenBadges((prev) => {
      const next = { ...prev };
      Object.keys(dashboard.badge_counts ?? {}).concat('myTasks').forEach((k) => {
        const raw = rawBadgeCountFor(k);
        if (viewing.has(k)) next[k] = raw;
        else if ((next[k] ?? 0) > raw) next[k] = raw;
      });
      const same = Object.keys(next).length === Object.keys(prev).length && Object.keys(next).every((k) => next[k] === prev[k]);
      if (same) return prev;

      return next;
    });

  }
  useEffect(() => {
    try { localStorage.setItem(seenStorageKey, JSON.stringify(seenBadges)); } catch { /* storage unavailable */ }
  }, [seenStorageKey, seenBadges]);
  const badgeCountFor = (key) => Math.max(0, rawBadgeCountFor(key) - (seenBadges[key] ?? 0));

  // Open a sidebar module — shared by the sidebar, the phone drawer and the
  // phone bottom bar. Closes the drawer once navigation actually happens.
  const goToModule = (key) => guardedNavigate(() => {
    setMobileNavOpen(false);
    // 'ticketPropose' isn't a real module — it's a direct link to the
    // Propose Ticket form.
    if (key === 'ticketPropose') {
      navigate(`${roleRoutes[user.role]}/tickets/new`);
      return;
    }
    // 'myTasks' / 'maintenanceLedger' are thin tabbed wrappers — they reopen
    // whichever tab was last open.
    if (key === 'myTasks') {
      setMyTasksTab(myTasksLastTab);
    } else if (key === 'maintenanceLedger') {
      setMaintenanceLedgerTab(maintenanceLedgerLastTab);
    } else {
      if (key === 'workTracker') setWorkTrackerViaMyTasks(false);
      // 'reportOrPropose' is a relabeled alias for the Issue Reports list.
      setActiveModule(key === 'reportOrPropose' ? 'issues' : key);
    }
  });

  // The phone bottom bar shows up to four of the role's most-used modules.
  const bottomNavItems = BOTTOM_NAV_PRIORITY
    .map((key) => modules.find(([k]) => k === key))
    .filter(Boolean)
    .slice(0, 4);

  return (
    <FormNoticeContext.Provider value={notice}>
    <RowActionsContext.Provider value={rowActions}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="topbar" ref={topbarRef}>
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

        <div className="topbar-right">
          <ThemeToggle /><EndImpersonationAction compact />
          {/* The Return control now lives in the persistent banner below the
              topbar (Phase A5) — a single, more visible home for it instead
              of duplicating the button here too. */}
        <div className="profile-menu-container" ref={profileMenuRef}>
          <ProfileMenu
            user={user}
            open={showProfileMenu}
            setOpen={setShowProfileMenu}
            onLogout={handleLogout}
            onOpenSettings={() => navigate(`${roleRoutes[user.role]}/profile`)}
          />
        </div>
      </div>
      </header>

      <main ref={workspaceRef} className={`workspace${isSidebarCollapsed ? ' sidebar-collapsed' : ''}${mobileNavOpen ? ' mobile-nav-open' : ''}`}>
        <aside className={`sidebar${isSidebarCollapsed ? ' collapsed' : ''}`} id="workspace-sidebar">
          {/* Phone-only: map-boundary pickers move here from the top bar. */}

          <nav className="module-nav" aria-label="Workspace modules">
            {moduleGroups.map(({ section, items }) => {
              const renderItem = ([key, label]) => {
                const badgeCount = badgeCountFor(key);
                return (
                  <button
                    className={key === breadcrumbModule ? 'active' : ''}
                    key={key}
                    onClick={() => goToModule(key)}
                    aria-label={badgeCount > 0 ? `${label} (${badgeCount})` : label}
                    title={isSidebarCollapsed ? label : undefined}
                    type="button"
                  >
                    {renderModuleIcon(key)}
                    <span>{label}</span>
                    {badgeCount > 0 && <span className="module-nav-badge">{badgeCount}</span>}
                  </button>
                );
              };

              // Flat list — no group headings; every item is always visible.
              return <div key={section ?? '__top'} className="module-nav-group">{items.map(renderItem)}</div>;
            })}
          </nav>
        </aside>
        {mobileNavOpen && <div className="mobile-nav-backdrop" onClick={() => setMobileNavOpen(false)} aria-hidden="true" />}

        {/* Phone-only bottom bar: the role's most-used pages plus Menu. */}
        <nav className="mobile-bottom-nav" aria-label="Quick navigation">
          {bottomNavItems.map(([key, label]) => {
            const badgeCount = badgeCountFor(key);
            return (
              <button
                key={key}
                type="button"
                className={key === breadcrumbModule ? 'active' : ''}
                aria-current={key === breadcrumbModule ? 'page' : undefined}
                onClick={() => goToModule(key)}
              >
                <span className="mobile-bottom-nav-icon">
                  {moduleIcons[key]}
                  {badgeCount > 0 && <span className="module-nav-badge">{badgeCount}</span>}
                </span>
                <span className="mobile-bottom-nav-label">{BOTTOM_NAV_LABELS[key] ?? label}</span>
              </button>
            );
          })}
          <button
            type="button"
            className={mobileNavOpen ? 'active' : ''}
            aria-expanded={mobileNavOpen}
            aria-controls="workspace-sidebar"
            onClick={() => setMobileNavOpen((open) => !open)}
          >
            <span className="mobile-bottom-nav-icon"><Icon name="menu" size={20} /></span>
            <span className="mobile-bottom-nav-label">Menu</span>
          </button>
        </nav>

        <section className="content-area" id="main-content" tabIndex={-1}>
          {/* Dashboard has its own greeting banner right below (name, role,
              date) — this generic icon+title bar would just repeat "Dashboard"
              redundantly above it, so it's skipped for that one page only. */}
          {(activeModule !== 'dashboard' || isOnSpecialPage) && (
            <div className="page-heading-row">
              <span className="page-heading-icon">{renderModuleIcon(breadcrumbModule)}</span>
              <div className="page-heading-text">
                {subPageTitle && !isProfilePage && (
                  <p className="breadcrumb-path">{moduleLabel(modules, breadcrumbModule)} »</p>
                )}
                {/* breadcrumbModule (not activeModule) — for the merged
                    My Tasks / Report-Propose entries, activeModule is still
                    the real underlying key (e.g. 'ticketInspections'), which
                    isn't a literal sidebar item any more so moduleLabel
                    couldn't resolve it; breadcrumbModule already maps those
                    to the merged entry's own key/label for exactly this. */}
                <h2>{subPageTitle ?? moduleLabel(modules, breadcrumbModule)}</h2>
              </div>
            </div>
          )}

        {notice && notice.lines ? (
          <div className="form-feedback" aria-live="polite">
            <div className="qa-inline-error" role="alert">
              <Icon name="alert" size={17} className="toast-notice-icon" />
              <div className="toast-notice-lines">
                {notice.lines.map((line, i) => <span key={i}>{line}</span>)}
              </div>
              <button type="button" className="toast-notice-close" onClick={() => setNotice(null)} aria-label="Dismiss">
                <Icon name="close" size={13} />
              </button>
            </div>
          </div>
        ) : notice && (
          <div className={`toast-notice ${notice.type}`} role="alert">
            <div className="toast-notice-body">
              <Icon name={notice.type === 'success' ? 'checkCircle' : 'alert'} size={16} />
              <span>{notice.text}</span>
            </div>
            {notice.openTickets?.length ? (
              <div className="toast-notice-ticket-links">
                {notice.openTickets.map((t) => (
                  <button
                    key={t.ticket_id}
                    type="button"
                    className="toast-notice-ticket-link"
                    onClick={() => {
                      setNotice(null);
                      navigate(`${roleRoutes[user.role]}/tickets/${t.ticket_id}`);
                    }}
                  >
                    Ticket #{ticketNumber(t)}{t.ticket_title ? ` — ${t.ticket_title}` : ''}
                  </button>
                ))}
              </div>
            ) : null}
            <button type="button" className="toast-notice-close" onClick={() => setNotice(null)} aria-label="Dismiss">
              <Icon name="close" size={13} />
            </button>
          </div>
        )}
        <div className="content-body">
          {isProfilePage ? (
            <ProfilePage
              user={user}
              onBack={() => navigate(roleRoutes[user.role])}
              setNotice={setNotice}
              refreshUser={refreshUser}
              onDirty={() => setHasUnsavedChanges(true)}
            />
          ) : isNewVehiclePage ? (
            <NewVehiclePage
              onBack={() => (location.state?.returnTo ? navigate(location.state.returnTo) : returnToModule('vehicles'))}
              lookups={lookups}
              allHubs={allHubs}
              onSubmit={handleCreateVehicle}
              onDirty={() => setHasUnsavedChanges(true)}
            />
          ) : isNewLocationPage ? (
            <NewLocationPage
              onBack={() => returnToModule('locations')}
              boundaryPolygons={locationBoundaryPolygons}
              boundaryLabel={locationBoundaryLabel}
              boundaryVerified={mapBoundaryOverride?.verified === true}
              onSubmit={async (hub) => {
                await api.post('/hubs', hub);
                setNotice({ type: 'success', text: 'Location added.' });
                await refreshCurrent();
                returnToModule('locations');
              }}
            />
          ) : editLocationVehicleId ? (
            <EditLocationPage
              row={locationRows.find((r) => String(r.vehicle_id) === String(editLocationVehicleId)) ?? null}
              allHubs={allHubs}
              boundaryPolygons={locationBoundaryPolygons}
              boundaryLabel={locationBoundaryLabel}
              boundaryVerified={mapBoundaryOverride?.verified === true}
              onBack={() => returnToModule('locations')}
              onSubmit={async ({ name, lat, lng, label, addressArea, remarks }) => {
                // Reuse the hub if that name already exists (case-insensitive
                // — hub names are unique per barangay); otherwise this is a
                // brand-new location, so create it first exactly like Add
                // Location does. Either way the vehicle's location update
                // itself always goes through POST /locations, so it's still
                // one more entry in that vehicle's location history, not an
                // edit of a past one.
                const existingHub = allHubs.find((h) => h.name.toLowerCase() === name.toLowerCase());
                if (!existingHub) {
                  await api.post('/hubs', { name, lat, lng, label });
                }
                await api.post('/locations', {
                  vehicle_id: editLocationVehicleId,
                  current_location: existingHub ? existingHub.name : name,
                  address_area: addressArea,
                  remarks,
                });
                setNotice({ type: 'success', text: 'Location updated.' });
                await refreshCurrent();
                returnToModule('locations');
              }}
            />
          ) : isNewTicketPage ? (
            // Same /tickets/new URL, two entirely separate components: a
            // role with ticket.create gets NewTicketPage untouched; Custodian
            // (ticket.propose) gets ProposeTicketPage — a simpler, purpose-
            // built form for POST /tickets/propose, kept fully separate
            // rather than a shared branch. Nobody currently holds
            // ticket.create (Admin only reviews/edits/approves a Custodian's
            // proposal now — every ticket must originate from one), so the
            // third branch below is what a stray deep-link to this URL hits.
            canDo(user, 'ticket.propose') ? (
              <ProposeTicketPage
                onBack={() => {
                  setPrefilledTicketData(null);
                  // Back to where proposals start (the Issue Reports list, which
                  // now shows this report's ticket), keeping the success notice.
                  setKeepNotice(true);
                  returnToModule(hasReportOrProposeNav ? 'issues' : 'workTracker');
                }}
                ticketLookups={ticketLookups}
                prefilledTicketData={prefilledTicketData}
                onProposeTicket={proposeTicket}
                onCreated={(created) => { setPrefilledTicketData(null); setHasUnsavedChanges(false); setKeepNotice(true); navigate(`${roleRoutes[user.role]}/tickets/${created.ticket_id}`); }}
                onDirty={() => setHasUnsavedChanges(true)}
              />
            ) : canDo(user, 'ticket.create') ? (
              <NewTicketPage
                onBack={() => { setPrefilledTicketData(null); returnToModule('tickets'); }}
                ticketLookups={ticketLookups}
                prefilledTicketData={prefilledTicketData}
                onCreateTicket={createTicket}
                basePath={roleRoutes[user.role]}
                onDirty={() => setHasUnsavedChanges(true)}
              />
            ) : (
              <ModulePanel description="Tickets can only be started by a Custodian's proposal.">
                <p className="empty-state">
                  You don't have permission to start a ticket from scratch. Ask the assigned Custodian to propose one from Report / Propose — it'll show up here for you to review, edit, and approve or decline.
                </p>
                <button className="ghost-button" type="button" onClick={() => returnToModule('tickets')}>Back to Maintenance Tickets</button>
              </ModulePanel>
            )
          ) : vehicleProfileId ? (
            <VehicleProfilePage key={vehicleProfileId}
              vehicleId={vehicleProfileId}
              lookups={lookups}
              allHubs={allHubs}
              basePath={roleRoutes[user.role]}
              canManage={hasRole(user, 'Admin')}
              // 2026-10-06 spec reversal — Maintenance Personnel can now view
              // documents and upload repair evidence (edit only their own
              // upload); Custodian keeps upload + edit-own (VehicleFiles/
              // VehicleFilesModal enforce the ownership half via added_by);
              // Admin unrestricted; delete stays Admin-only everywhere.
              canManageDocuments={canDo(user, 'document.create')}
              canViewDocuments={canDo(user, 'document.view')}
              currentUser={user}
              canCheckReadiness={canDo(user, 'vehicle.readiness_check')}
              canRequestInspection={canDo(user, 'vehicle.request_inspection')}
              // Production-readiness audit finding #8 — the reliability
              // endpoint was fully built with no UI anywhere; surfaced here
              // (an existing Admin page) rather than a new sidebar module.
              canViewReliability={hasRole(user, 'Admin')}
              setNotice={setNotice}
              onSaved={refreshCurrent}
              onRequestConfirmation={setConfirmDialog}
            />
          ) : ticketProfileId ? (
            <TicketProfilePage key={ticketProfileId}
              ticketId={ticketProfileId}
              user={user}
              userId={user.id}
              ticketLookups={ticketLookups}
              onBack={() => returnToModule('tickets')}
              onDeleteTicket={deleteTicket}
              onRequestConfirmation={setConfirmDialog}
              ticketAction={ticketAction}
            />
          ) : maintenanceProfileId ? (
            <MaintenanceRecordProfilePage key={maintenanceProfileId}
              maintenanceId={maintenanceProfileId}
              groupByVehicle={new URLSearchParams(location.search).get('vehicle') === '1'}
              onVerify={(r, payload) => updateRecord(`/maintenance-records/${r.maintenance_id}/verify`, payload, 'Verification submitted.')}
              canManage={hasRole(user, 'Admin')}
              onConfirm={(r) => updateRecord(`/maintenance-records/${r.maintenance_id}/confirm`, { confirmed: true }, 'Maintenance confirmed.')}
              onReopen={(r) => updateRecord(`/maintenance-records/${r.maintenance_id}/confirm`, { confirmed: false }, 'Maintenance reopened.')}
              onDecisionClose={(r, payload) => updateRecord(`/maintenance-records/${r.maintenance_id}/decision-close`, payload, 'Record closed without verification.')}
            />
          ) : (isNewCategoryPage || editCategoryId) ? (
            <>
            <VehicleTypeFormPage
              key={editCategoryId ?? 'new'}
              isEditing={Boolean(editCategoryId)}
              onBack={() => returnToModule('categories')}
              initialValues={editCategoryId ? (records.categories ?? []).find((c) => String(c.category_id) === String(editCategoryId)) : EMPTY_OBJ}
              onSubmit={(payload) => submitFormPage('categories', editCategoryId ? { category_id: editCategoryId } : null, payload)}
              submitLabel={editCategoryId ? 'Update Vehicle Type' : 'Add Vehicle Type'}
              categoryVehicleCount={editCategoryId ? (records.categories ?? []).find((c) => String(c.category_id) === String(editCategoryId))?.vehicles_count : null}
              onDirty={() => setHasUnsavedChanges(true)}
            />
            </>
          ) : (isNewSchedulePage || editScheduleId) ? (
            <FormPage
              description="Plan preventative maintenance and track schedule status."
              onBack={() => { setPrefilledScheduleData(null); returnToModule('schedules'); }}
              fields={scheduleFields(lookups, allHubs, Boolean(editScheduleId), !editScheduleId && !canDo(user, 'schedule.create'), scheduleInitialValues?.status)}
              initialValues={scheduleInitialValues}
              onSubmit={(payload) => submitFormPage('schedules', editScheduleId ? { schedule_id: editScheduleId } : null, payload)}
              submitLabel={editScheduleId ? 'Update Schedule' : (canDo(user, 'schedule.create') ? 'Add Schedule' : 'Send Suggestion')}
              contextVehicles={lookups.vehicles}
              hubs={allHubs}
              wrapperClassName="schedule-entry-form"
              compactVehiclePreview
              onDirty={() => setHasUnsavedChanges(true)}
            />
          ) : viewIssueId ? (
            <>
              <IssueViewPage key={viewIssueId}
                issueId={viewIssueId}
                allIssues={records.issues ?? []}
                allHubs={allHubs}
                user={user}
                onCreateTicketFromIssue={handleCreateTicketFromIssue}
                onDismissIssue={setDismissIssueTarget}
                onRecommendTicket={recommendTicketForIssue}
              />
              {renderDismissIssueModal()}
            </>
          ) : (isNewIssuePage || editIssueId) ? (
            <FormPage
              description={issueDescription(user.role)}
              onBack={() => returnToModule('issues')}
              fields={issueFields(lookups, editIssueId ? { issue_report_id: editIssueId } : null, user.role, (!editIssueId && canRegisterVehicles(user)) ? () => navigate(`${roleRoutes[user.role]}/vehicles/new`, { state: { returnTo: location.pathname } }) : undefined)}
              initialValues={editIssueId
                ? (records.issues ?? []).find((i) => String(i.issue_report_id) === String(editIssueId))
                : (location.state?.prefillVehicleId ? { vehicle_id: location.state.prefillVehicleId } : EMPTY_OBJ)}
              onSubmit={(payload) => submitFormPage('issues', editIssueId ? { issue_report_id: editIssueId } : null, payload)}
              submitLabel={editIssueId ? 'Update Issue' : 'Submit Issue'}
              contextVehicles={lookups.vehicles}
              hubs={allHubs}
              warnEndpoint={editIssueId ? undefined : (vid) => `/vehicles/${vid}/open-issues`}
              warnRender={(rows) => <OpenItemsWarning kind="issue" rows={rows} basePath={roleRoutes[user.role]} />}
              onDirty={() => setHasUnsavedChanges(true)}
            />
          ) : (isNewConditionPage || editConditionId) ? (
            <FormPage
              description="Periodic inspection log — a Custodian's routine check-in on a vehicle's physical condition."
              onBack={() => { setPrefilledConditionVehicleId(null); returnToModule('conditions'); }}
              fields={conditionFields(lookups, Boolean(editConditionId))}
              initialValues={conditionInitialValues}
              onSubmit={(payload) => submitFormPage('conditions', editConditionId ? { condition_check_id: editConditionId } : null, payload)}
              submitLabel={editConditionId ? 'Update Condition' : 'Record Condition'}
              contextVehicles={lookups.vehicles}
              reserveVehiclePreview
              hubs={allHubs}
              onDirty={() => setHasUnsavedChanges(true)}
            />
          ) : (isNewMaintenancePage || editMaintenanceId) ? (
            <FormPage
              description="Directly log external, historical, or third-party vehicle maintenance records and expenses without running the full ticket workflow."
              onBack={() => returnToModule('maintenance')}
              fields={(vals) => maintenanceFields(lookups, user.role, vals)}
              initialValues={editMaintenanceId ? withPerformedBy(withRepairType((records.maintenance ?? []).find((m) => String(m.maintenance_id) === String(editMaintenanceId)))) : EMPTY_OBJ}
              onSubmit={(payload) => submitFormPage('maintenance', editMaintenanceId ? { maintenance_id: editMaintenanceId } : null, applyPerformedBy(applyRepairType(payload)))}
              submitLabel={editMaintenanceId ? 'Update Maintenance' : 'Add Maintenance'}
              contextVehicles={lookups.vehicles}
              hubs={allHubs}
              reviewStep
              wrapperClassName="maintenance-form-grid"
              formTitle="Maintenance Record Details"
              onDirty={() => setHasUnsavedChanges(true)}
            />
          ) : viewUserId ? (
            <UserViewPage
              userId={viewUserId}
              users={records.users}
              currentUser={user}
              onEdit={() => navigate(`${roleRoutes[user.role]}/users/${viewUserId}/edit`)}
            />
          ) : (isNewUserPage || editUserId) ? (
            <UserFormPage
              key={editUserId ?? 'new'}
              isEditing={Boolean(editUserId)}
              onBack={() => returnToModule('users')}
              initialValues={editUserInitialValues}
              onSubmit={(payload) => submitFormPage('users', editUserId ? { id: editUserId } : null, payload)}
              submitLabel="Add User"
              onDirty={() => setHasUnsavedChanges(true)}
            />
          ) : logRepairsTicketId ? (
            <LogRepairsPage
              key={flattenSubIssueRows(records.ticketWorkOrders ?? records.tickets).some((r) => String(r.ticket_id) === String(logRepairsTicketId) && String(r.sub_issue_id) === String(logRepairsSubIssueId)) ? 'ready' : 'loading'}
              ticket={flattenSubIssueRows(records.ticketWorkOrders ?? records.tickets).find((r) => String(r.ticket_id) === String(logRepairsTicketId) && String(r.sub_issue_id) === String(logRepairsSubIssueId))}
              vehicleOptions={lookups.vehicles ?? []}
              onDonorChanged={() => loadModule('ticketWorkOrders')}
              notify={setNotice}
              onBack={() => returnToModule('ticketWorkOrders')}
              onSubmit={(subIssueRow, payload) => ticketAction(`/tickets/${subIssueRow.ticket_id}/sub-issues/${subIssueRow.sub_issue_id}/log-repairs`, payload, 'Repair logged. Once every repair on this ticket is logged, it goes to the Custodian for verification automatically.').then((ok) => { if (ok) returnToModule('ticketWorkOrders'); })}
              onExternalSend={(row, payload) => ticketAction(`/tickets/${row.ticket_id}/sub-issues/${row.sub_issue_id}/external-sent`, payload, 'Marked as sent to the shop.')}
              onExternalReturn={(row, payload) => ticketAction(`/tickets/${row.ticket_id}/sub-issues/${row.sub_issue_id}/external-returned`, payload, 'Marked as returned from the shop.')}
              onDirty={() => setHasUnsavedChanges(true)}
            />
          ) : inspectTicketId ? (
            <InspectTicketPage
              ticket={(records.ticketInspections ?? []).find((t) => String(t.ticket_id) === String(inspectTicketId))}
              ticketLookups={ticketLookups}
              onBack={() => returnToModule('ticketInspections')}
              onSubmit={(ticket, payload) => ticketAction(`/tickets/${ticket.ticket_id}/inspect`, payload, 'Inspection submitted successfully.').then((ok) => { if (ok) returnToModule('ticketInspections'); })}
              onDirty={() => setHasUnsavedChanges(true)}
            />
          ) : (loading ? <ModuleLoader /> : renderModule())}
        </div>
        <WorkspaceFooter />
      </section>
    </main>
    <ConfirmDialog
      busy={confirmBusy}
      dialog={confirmDialog}
      onCancel={() => setConfirmDialog(null)}
      onConfirm={handleConfirmDialog}
    />
    {userInfoTarget && <UserInfoModal user={userInfoTarget} onClose={() => setUserInfoTarget(null)} />}
    <FormModal open={!!approvalTarget} title={`Approve ${approvalTarget?.name ?? ''}`} onClose={() => setApprovalTarget(null)}>
      {approvalTarget && (
        <SmartForm
          fields={[
            {
              label: 'Role',
              name: 'role',
              options: ['Custodian', 'Maintenance Personnel', 'Admin'],
              required: true,
              type: 'select',
              hint: `${approvalTarget.name} requested "${approvalTarget.role}" at signup — confirm it or pick a different role before activating their account.`,
            },
          ]}
          initialValues={{ role: approvalTarget.role }}
          onCancel={() => setApprovalTarget(null)}
          onSubmit={async (payload) => {
            setNotice(null);
            try {
              await api.put(`/users/${approvalTarget.id}/activate`, { role: payload.role });
              setNotice({ type: 'success', text: 'User activated.' });
              setApprovalTarget(null);
              await refreshCurrent();
            } catch (error) {
              showError(error, setNotice);
            }
          }}
          submitLabel="Activate"
          title=""
        />
      )}
    </FormModal>
    </RowActionsContext.Provider>
    </FormNoticeContext.Provider>
  );

  // Shared "Mark Done" modal for a Maintenance Schedule — used both from the
  // Schedules module (Admin/Custodian) and from My Work Orders (Phase B4 —
  // a Maintenance Personnel account's assigned schedules now surface there
  // too), so completing a schedule works identically regardless of which
  // page it was opened from. Pulled out of the Schedules module's own render
  // branch so it isn't limited to only appearing there.
  function renderCompleteScheduleModal() {
    return (
      <FormModal open={!!completeScheduleTarget} title={`Mark Done — ${completeScheduleTarget?.maintenance_type ?? ''}`} onClose={() => setCompleteScheduleTarget(null)}>
        {completeScheduleTarget && (
          <>
            <p className="muted" style={{ marginBottom: 12, fontSize: '0.85rem' }}>
              This logs a maintenance record for the work and closes the schedule
              {completeScheduleTarget.recurrence_months ? `, then auto-schedules the next one (${RECURRENCE_LABEL[completeScheduleTarget.recurrence_months] ?? `every ${completeScheduleTarget.recurrence_months} months`}).` : '.'}
            </p>
            <SmartForm
              fields={[
                { label: 'Date Completed', name: 'date_completed', type: 'date', max: calendarDate() },
                { label: 'Cost (optional)', name: 'maintenance_cost', type: 'number' },
                // Sometimes a scheduled job turns out to need a
                // third-party shop instead of in-house work.
                { label: 'Sent to External Shop?', name: 'is_external', type: 'select', options: [
                  { value: 0, label: 'No — done in-house' },
                  { value: 1, label: 'Yes — external shop repair' },
                ] },
                // Vendor/warranty only matter when it went external.
                ...(completeScheduleExternal ? [
                  { label: 'External Shop', name: 'external_vendor', type: 'text', placeholder: 'e.g. Bautista Auto Shop' },
                  { label: 'Warranty Until', name: 'warranty_until', type: 'date' },
                ] : []),
                {
                  label: 'Receipt / Proof of Completion',
                  name: 'receipt',
                  type: 'file',
                  accept: '.jpg,.jpeg,.png,.pdf',
                  // Final senior system review (2026-10-05, §2) — only the
                  // assigned Maintenance Personnel can even open this modal
                  // now, and a receipt/photo is evidence only; it never skips
                  // the Custodian check, for anyone.
                  hint: 'Attach a receipt or a photo of the completed repair so the Custodian verifying this has proof.',
                },
                { label: 'Notes (what was done)', name: 'notes', type: 'textarea', rows: 2 },
              ]}
              key={`complete-${completeScheduleTarget.schedule_id}`}
              initialValues={{ date_completed: completeScheduleTarget.completionDefaultDate }}
              onValuesChange={(vals) => setCompleteScheduleExternal(vals.is_external === 1 || vals.is_external === '1' || vals.is_external === true)}
              onCancel={() => setCompleteScheduleTarget(null)}
              onSubmit={(payload) => completeSchedule(completeScheduleTarget, payload)}
              submitLabel="Mark as Done"
              title=""
            />
          </>
        )}
      </FormModal>
    );
  }

  // Phase B4 — Admin-only "Reassign" action on a Scheduled row (new
  // schedule.reassign ability): hands the job to a different Maintenance
  // Personnel without cancelling and re-booking it. Reuses the same
  // maintenance_personnel picker the Add/Edit Schedule form already uses for
  // Assigned To.
  function renderReassignScheduleModal() {
    return (
      <FormModal open={!!reassignScheduleTarget} title={`Reassign — ${reassignScheduleTarget?.maintenance_type ?? ''}`} onClose={() => setReassignScheduleTarget(null)}>
        {reassignScheduleTarget && (
          <SmartForm
            fields={[
              {
                label: 'Assigned To',
                name: 'assigned_to',
                // The backend 422s if "reassigned" to whoever already has
                // it — leave the current assignee out of the picker rather
                // than let that be a click away.
                options: options((lookups.maintenance_personnel ?? []).filter((p) => String(p.id) !== String(reassignScheduleTarget.assigned_to)), 'id', 'name'),
                required: true,
                type: 'select',
              },
            ]}
            key={`reassign-${reassignScheduleTarget.schedule_id}`}
            initialValues={{ assigned_to: '' }}
            onCancel={() => setReassignScheduleTarget(null)}
            onSubmit={(payload) => reassignSchedule(reassignScheduleTarget, payload)}
            submitLabel="Reassign"
            title=""
          />
        )}
      </FormModal>
    );
  }

  // Admin's "Decline" action on a Pending Approval row (new schedule.decline
  // ability) — mirrors the ticket proposal decline form exactly: one
  // required reason, visible to the Custodian afterward.
  function renderDeclineScheduleModal() {
    return (
      <FormModal open={!!declineScheduleTarget} title={`Decline — ${declineScheduleTarget?.maintenance_type ?? ''}`} onClose={() => setDeclineScheduleTarget(null)}>
        {declineScheduleTarget && (
          <SmartForm
            fields={[{ label: 'Decline Reason', name: 'decline_reason', type: 'textarea', rows: 2, required: true, placeholder: 'Let the Custodian know why this was declined' }]}
            key={`decline-schedule-${declineScheduleTarget.schedule_id}`}
            onCancel={() => setDeclineScheduleTarget(null)}
            onSubmit={(payload) => declineSchedule(declineScheduleTarget, payload)}
            submitLabel="Decline Schedule"
            title=""
          />
        )}
      </FormModal>
    );
  }

  function renderModule() {
    // Task 1 of the sidebar consolidation — Custodian's merged "My Tasks"
    // container. `activeModule` is still the literal real key here
    // ('ticketInspections'/'ticketVerifications'/'workTracker'); this only
    // decides whether to also show the tab bar above that unchanged module
    // component, reusing the same segmented tab-bar pattern already used for
    // Vehicle Location's Map/Records toggle (see .locations-tab-bar below).
    const showMyTasksContainer = hasMyTasksNav && (
      activeModule === 'ticketVerifications'
      || (activeModule === 'workTracker' && workTrackerViaMyTasks)
    );
    const myTasksTabBar = showMyTasksContainer && (
      <div className="locations-tab-bar" role="tablist" aria-label="My Tasks">
        <button
          type="button"
          role="tab"
          aria-selected={activeModule === 'ticketVerifications'}
          className={`locations-tab-button ${activeModule === 'ticketVerifications' ? 'active' : ''}`}
          onClick={() => setMyTasksTab('ticketVerifications')}
        >
          My Tickets
          {(dashboard?.badge_counts?.ticketVerifications ?? 0) > 0 && (
            <span className="my-tasks-verification-count" title="Assigned tickets awaiting your repair verification">{dashboard.badge_counts.ticketVerifications} to verify</span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeModule === 'workTracker'}
          className={`locations-tab-button ${activeModule === 'workTracker' ? 'active' : ''}`}
          onClick={() => setMyTasksTab('workTracker')}
        >
          History
        </button>
      </div>
    );

    // Same thin-wrapper approach as My Tasks above — `activeModule` is
    // still literally 'maintenanceStatus'/'maintenance', this only decides
    // whether to also show the tab bar above that unchanged module.
    const showMaintenanceLedgerContainer = hasMaintenanceLedgerNav && (
      activeModule === 'maintenanceStatus' || activeModule === 'maintenance'
    );
    const maintenanceLedgerTabBar = showMaintenanceLedgerContainer && (
      <div className="locations-tab-bar" role="tablist" aria-label="Maintenance Records">
        <button
          type="button"
          role="tab"
          aria-selected={activeModule === 'maintenanceStatus'}
          className={`locations-tab-button ${activeModule === 'maintenanceStatus' ? 'active' : ''}`}
          onClick={() => setMaintenanceLedgerTab('maintenanceStatus')}
        >
          Needs Verification
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeModule === 'maintenance'}
          className={`locations-tab-button ${activeModule === 'maintenance' ? 'active' : ''}`}
          onClick={() => setMaintenanceLedgerTab('maintenance')}
        >
          All Records
        </button>
      </div>
    );

    if (activeModule === 'dashboard') {
      return (
              <Dashboard
          data={dashboard}
          hubs={allHubs}
          user={user}
          basePath={roleRoutes[user.role]}
          onNavigate={navigate}
          onGoToSchedules={() => returnToModule('schedules')}
          onGoToModule={returnToModule}
        />
      );
    }

    if (activeModule === 'vehicles') {
      return (
        <ModulePanel
          description={((hasRole(user, 'Custodian') && !hasRole(user, 'Admin')) ? 'View-only fleet information.' : 'Register, edit, and archive vehicle records.') + ' Status = fleet availability. Condition = physical state (does it need repair or inspection?). Click a row to see full vehicle details.'}
          statCards={
            <ModuleStatCards
              totalLabel="Total Repair Records"
              total={vehicleStats.total}
              cards={VEHICLE_STAT_CARDS}
              counts={vehicleStats}
              activeFilter={filterStatus}
              onFilterChange={setFilterStatus}
            />
          }
          filterBar={
            <FilterBar
              categories={lookups.categories}
              vehicles={lookups.vehicles}
              filterCategory={filterCategory}
              setFilterCategory={setFilterCategory}
              filterCapacity={filterCapacity}
              setFilterCapacity={setFilterCapacity}
              filterStatus={filterStatus}
              setFilterStatus={setFilterStatus}
              filterPriority={filterPriority}
              setFilterPriority={setFilterPriority}
              statusOptions={lookups.vehicle_statuses}
              priorityOptions={lookups.condition_results}
              priorityLabel="Condition"
              filterLocation={filterLocation}
              setFilterLocation={setFilterLocation}
              filterDomain={filterDomain}
              setFilterDomain={setFilterDomain}
              extraFilters={[{
                key: 'readiness',
                label: 'Ready to Respond',
                options: ['Ready', 'Not Ready'],
                selected: filterReadiness,
                setSelected: setFilterReadiness,
              }]}
            />
          }
        >
          <div className="panel-header-bar">
            <h3>All Vehicles <span className="count-badge">{visibleRows.length}</span></h3>
            <LocalSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search vehicles..."
              columnChooser={vehicleColumnChooser}
              onAdd={canRegisterVehicles(user) ? () => navigate(`${roleRoutes[user.role]}/vehicles/new`) : undefined}
              addLabel="Add Vehicle"
            />
          </div>
          <PaginatedTable columns={vehicleColumnChooser.visibleColumns} rows={visibleRows} onRowClick={openVehicleProfile} onReorderColumn={vehicleColumnChooser.reorderColumn} emptyMessage="No vehicles here yet — click the + button to register one." />
          <FormModal
            open={!!readinessPromptTarget}
            title={`Readiness Check — ${readinessPromptTarget?.vehicle_name ?? ''}`}
            onClose={() => setReadinessPromptTarget(null)}
          >
            {readinessPromptTarget && (
              <ReadinessCheckForm
                vehicle={readinessPromptTarget}
                onCancel={() => setReadinessPromptTarget(null)}
                onSubmit={(payload) => submitReadinessFromPrompt(readinessPromptTarget.vehicle_id, payload)}
              />
            )}
          </FormModal>
        </ModulePanel>
      );
    }

    if (activeModule === 'categories') {
      const typeSummary = visibleRows.map((type) => ({
        label: type.category_name,
        value: Number(type.vehicles_count) || 0,
        color: type.domain === 'Water' ? '#06b6d4' : '#2563eb',
      }));
      const vehicleTotal = typeSummary.reduce((total, type) => total + type.value, 0);
      const largestTypeCount = Math.max(1, ...typeSummary.map((type) => type.value));
      const populatedTypes = typeSummary.filter((type) => type.value > 0).sort((a, b) => b.value - a.value);
      const unusedTypes = typeSummary.filter((type) => type.value === 0);
      return (
        <ModulePanel
          description="Maintain standard vehicle type choices used across dropdowns."
          statCards={
            <section className="panel vehicle-type-overview">
              <div className="vehicle-type-overview-summary">
                <span className="vehicle-type-eyebrow">Fleet composition</span>
                <h3>Vehicle Type Overview</h3>
                <p>A quick look at your fleet by vehicle type.</p>
                <dl>
                  <div><dt>Vehicle types</dt><dd>{visibleRows.length}</dd></div>
                  <div><dt>Total vehicles</dt><dd>{vehicleTotal}</dd></div>
                  <div><dt>Unused types</dt><dd>{typeSummary.filter((type) => type.value === 0).length}</dd></div>
                </dl>
              </div>
              <div className="vehicle-type-overview-chart">
                <div className="vehicle-type-chart-heading"><h4>Vehicles by type</h4><span>Current selection</span></div>
                {populatedTypes.length > 0 ? <div className="vehicle-type-bars">
                  {populatedTypes.map((type) => <div className="vehicle-type-bar-row" key={type.label}>
                    <span>{type.label}</span>
                    <div className="vehicle-type-bar-track" aria-hidden="true"><div style={{ width: `${type.value / largestTypeCount * 100}%`, background: type.color }} /></div>
                    <strong>{type.value} <span>{type.value === 1 ? 'vehicle' : 'vehicles'}</span></strong>
                  </div>)}
                </div> : <p className="empty-state">No vehicles assigned to the selected types.</p>}
                {unusedTypes.length > 0 && <p className="vehicle-type-unused"><strong>No vehicles yet:</strong> {unusedTypes.map((type) => type.label).join(', ')}</p>}
              </div>
            </section>
          }
          filterBar={
            <div className="filter-bar-container">
              <div className="filter-label"><span>Filters:</span></div>
              <div className="filter-date-group">
                <span>Domain</span>
                <MultiSelectDropdown
                  placeholder="All Domains (Land/Water)"
                  options={['Land', 'Water']}
                  selected={filterDomain}
                  onChange={setFilterDomain}
                />
              </div>
            </div>
          }
        >
          <div className="panel-header-bar">
            <h3>Vehicle Types <span className="count-badge">{visibleRows.length}</span></h3>
            <LocalSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search types..."
              columnChooser={categoryColumnChooser}
              onAdd={() => navigate(`${roleRoutes[user.role]}/categories/new`)}
              addLabel="Add Type"
            />
          </div>
          <DataTable columns={categoryColumnChooser.visibleColumns} onReorderColumn={categoryColumnChooser.reorderColumn} rows={visibleRows} emptyMessage="No vehicle types yet — click the + button to add one." />
        </ModulePanel>
      );
    }

    if (activeModule === 'users') {
      const userRoleSegments = [
        { label: 'Admin', value: userStats.Admin, color: '#7c3aed' },
        { label: 'Custodian', value: userStats.Custodian, color: '#0284c7' },
        { label: 'Maintenance Personnel', value: userStats['Maintenance Personnel'], color: '#d97706' },
      ];
      const userStatusSegments = [
        { label: 'Active', value: userStatusStats.Active, color: '#2563eb' },
        { label: 'Inactive', value: userStatusStats.Inactive, color: '#cbd5e1' },
      ];
      return (
        <ModulePanel
          description="Create and manage user accounts — Admin, Custodian, and Maintenance Personnel."
          statCards={
            <div className="user-analytics-grid">
              <div className="panel user-analytics-card">
                <h4 className="user-analytics-title">Users by Status</h4>
                <div className="dashboard-condition-core">
                  <div className="dashboard-condition-donut">
                    <DonutChart centerLabel={userStatusStats.total} centerSubLabel="Users" segments={userStatusSegments} />
                  </div>
                  <ChartLegend rows={userStatusSegments} />
                </div>
              </div>
              <div className="panel user-analytics-card">
                <h4 className="user-analytics-title">Users by Role</h4>
                <SegmentedBar segments={userRoleSegments} />
                <ChartLegend rows={userRoleSegments} />
              </div>
            </div>
          }
          filterBar={
            <div className="filter-bar-container">
              <div className="filter-label"><span>Filters:</span></div>
              <div className="filter-date-group">
                <span>Role</span>
                <MultiSelectDropdown
                  placeholder="All Roles"
                  options={['Admin', 'Custodian', 'Maintenance Personnel']}
                  selected={filterStatus}
                  onChange={setFilterStatus}
                />
              </div>
              <div className="filter-date-group">
                <span>Status</span>
                <MultiSelectDropdown
                  placeholder="All Statuses"
                  options={['Active', 'Inactive']}
                  selected={filterActive}
                  onChange={setFilterActive}
                />
              </div>
            </div>
          }
        >
          {hasRole(user, 'Admin') && (
            <div className="registration-code-panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 14px', marginBottom: 14, border: '1px solid var(--border-subtle, #e2e8f0)', borderRadius: 8 }}>
              <div>
                <strong style={{ display: 'block', fontSize: '0.8rem' }}>Staff Registration Code</strong>
                <span className="muted" style={{ fontSize: '0.78rem' }}>
                  Share this with real staff — they need it to register. Regenerating it locks out anyone who only has the old one.
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                <code style={{ fontSize: '0.95rem', fontWeight: 700, padding: '6px 12px', background: 'var(--surface-2, #f8fafc)', borderRadius: 6 }}>
                  {registrationCode ?? '…'}
                </code>
                <button className="ghost-button" type="button" onClick={regenerateRegistrationCode}>Regenerate</button>
              </div>
            </div>
          )}
          <div className="panel-header-bar">
            <h3>Users <span className="count-badge">{visibleRows.length}</span></h3>
            <LocalSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search users..."
              columnChooser={usersViewMode === 'card' ? undefined : userColumnChooser}
              onAdd={() => navigate(`${roleRoutes[user.role]}/users/new`)}
              addLabel="Add User"
              onExport={() => exportRowsToCsv('users.csv', USER_EXPORT_COLUMNS, visibleRows)}
            />
          </div>
          <div className="view-tabs">
            <button type="button" className={usersViewMode === 'list' ? 'active' : ''} onClick={() => setUsersViewMode('list')}>List View</button>
            <button type="button" className={usersViewMode === 'card' ? 'active' : ''} onClick={() => setUsersViewMode('card')}>Card View</button>
          </div>
          {usersViewMode === 'card' ? (
            <PaginatedCardGrid
              items={visibleRows}
              keyOf={(row) => row.id}
              emptyMessage="No user accounts yet — click the + button to create one."
              renderItem={(row) => (
                <UserCard user={row} onClick={() => navigate(`${roleRoutes[user.role]}/users/${row.id}/edit`)} />
              )}
            />
          ) : (
            <PaginatedTable
              columns={userColumnChooser.visibleColumns}
              onReorderColumn={userColumnChooser.reorderColumn}
              emptyMessage="No user accounts yet — click the + button to create one."
              rows={visibleRows}
            />
          )}
        </ModulePanel>
      );
    }

    if (activeModule === 'locations') {
      return (
        <>
          <ModulePanel description="Record current vehicle stationing and keep a location history."
            statCards={locationsTab === 'map' ? (
              <dl className="location-map-summary" aria-label="Vehicle location summary">
                <div><dt>Total vehicles</dt><dd>{(lookups.vehicles ?? []).length}</dd><span>In the selected area</span></div>
                <div><dt>Total hubs</dt><dd>{locationMapSummary.hubs ?? '—'}</dd><span>Visible locations on the map</span></div>
                <div className="location-map-summary-unassigned"><dt>Vehicles without a hub</dt><dd>{locationMapSummary.unassigned ?? '—'}</dd><span>No matching hub assigned</span></div>
              </dl>
            ) : null}
          >
            <div className="locations-tab-bar">
              <button
                className={`locations-tab-button ${locationsTab === 'map' ? 'active' : ''}`}
                onClick={() => setLocationsTab('map')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21" />
                  <line x1="9" y1="3" x2="9" y2="18" />
                  <line x1="15" y1="6" x2="15" y2="21" />
                </svg>
                Vehicles Map
              </button>
              <button
                className={`locations-tab-button ${locationsTab === 'records' ? 'active' : ''}`}
                onClick={() => setLocationsTab('records')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <polyline points="10 9 9 9 8 9" />
                </svg>
                Vehicle Location Record
              </button>
            </div>

            {locationsTab === 'map' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
                <div className="map-container-full">
                  <LocationDensityMap
                    selectedVehicleId={selectedMapVehicleId}
                    vehicles={lookups.vehicles ?? []}
                    onClearSelectedVehicle={() => setSelectedMapVehicleId(null)}
                    onHubsChange={setAllHubs}
                    onSummaryChange={setLocationMapSummary}
                    canManageHubs={hasRole(user, 'Admin')}
                    boundaryOverride={mapBoundaryOverride}
                    onAddHub={() => navigate(`${roleRoutes[user.role]}/locations/new`)}
                  />
                </div>
              </div>
            )}

            {locationsTab === 'records' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div className="filter-bar-container">
                  <div className="filter-label"><span>Filters:</span></div>
                  <div className="filter-date-group">
                    <span>Status</span>
                    <MultiSelectDropdown
                      placeholder="All Statuses"
                      options={lookups.vehicle_statuses ?? []}
                      selected={filterStatus}
                      onChange={setFilterStatus}
                    />
                  </div>
                  <div className="filter-date-group">
                    <span>Location</span>
                    <MultiSelectDropdown
                      placeholder="All Locations"
                      options={[...new Set((lookups.vehicles ?? []).map((v) => v.current_location).filter(Boolean))]}
                      selected={filterLocation}
                      onChange={setFilterLocation}
                    />
                  </div>
                </div>
                <div className="panel-header-bar">
                  <h3>Location Records <span className="count-badge">{locationRows.length}</span></h3>
                  <LocalSearchInput
                    value={searchQuery}
                    onChange={setSearchQuery}
                    placeholder="Search records..."
                    // A vehicle's current location is already set from the
                    // Add/Edit Vehicle form (its Current Location field is a
                    // creatable-select, so it can introduce a new hub name
                    // too). What THIS tab had no way to do was define a new
                    // hub's actual map position — "Add Location" is its own
                    // page (fields + a live map, either one fills the
                    // other) instead of a click-the-map-first flow.
                    onAdd={hasRole(user, 'Admin') ? () => navigate(`${roleRoutes[user.role]}/locations/new`) : undefined}
                    addLabel="Add Location"
                    columnChooser={locationColumnChooser}
                  />
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <PaginatedTable
                    columns={locationColumnChooser.visibleColumns}
                    onReorderColumn={locationColumnChooser.reorderColumn}
                    rows={locationRows}
                    emptyMessage="No location records yet."
                  />
                </div>
              </div>
            )}
          </ModulePanel>
        </>
      );
    }

    if (activeModule === 'conditions') {
      return (
        <ModulePanel
          description="Periodic inspection log — a Custodian's routine check-in on a vehicle's physical condition (e.g. a monthly walkaround), separate from Maintenance Records (which logs actual repair work already performed). Each entry here can update the vehicle's Condition field on the fleet list."
          statCards={
            <StackedBarChart
              title="Current fleet condition"
              showPercentages
              segments={CONDITION_STAT_CARDS.map((card) => ({ label: card.label, value: conditionStats[card.key] ?? 0, color: card.color }))}
            />
          }
          filterBar={
            <div className="filter-bar-container">
              <div className="filter-label">
                <span>FILTERS:</span>
              </div>

              {/* Category Dropdown */}
              <div className="filter-date-group">
                <span>Category</span>
                <MultiSelectDropdown
                  placeholder="All Categories"
                  options={(lookups.categories ?? []).map((cat) => ({ value: String(cat.category_id), label: cat.category_name }))}
                  selected={condDraft.category}
                  onChange={(vals) => setCondDraft((d) => ({ ...d, category: vals }))}
                />
              </div>

              {/* Condition Dropdown */}
              <div className="filter-date-group">
                <span>Condition</span>
                <MultiSelectDropdown
                  placeholder="All Conditions"
                  options={['Good', 'Needs Repair', 'Not Checked']}
                  selected={condDraft.status}
                  onChange={(vals) => setCondDraft((d) => ({ ...d, status: vals }))}
                />
              </div>

              {/* Capacity Dropdown */}
              <div className="filter-date-group">
                <span>Capacity</span>
                <MultiSelectDropdown
                  placeholder="All Capacities"
                  options={[...new Set((lookups.vehicles ?? []).map((v) => v.capacity).filter(Boolean))]}
                  selected={condDraft.capacity}
                  onChange={(vals) => setCondDraft((d) => ({ ...d, capacity: vals }))}
                />
              </div>

              {/* Checked By Dropdown — derived from who's actually logged a
                  check, not a fixed lookup. */}
              <div className="filter-date-group">
                <span>Checked By</span>
                <MultiSelectDropdown
                  placeholder="All Checked By"
                  options={[...new Set((records.conditions ?? []).map((r) => r.checked_by?.name).filter(Boolean))]}
                  selected={condDraft.checkedBy}
                  onChange={(vals) => setCondDraft((d) => ({ ...d, checkedBy: vals }))}
                />
              </div>

              {/* From Date */}
              <div className="filter-date-group">
                <span>From Date</span>
                <DateFilterInput
                  value={condDraft.start || '2026-01-01'}
                  onChange={(val) => setCondDraft((d) => ({ ...d, start: val }))}
                />
              </div>

              {/* To Date */}
              <div className="filter-date-group">
                <span>To Date</span>
                <DateFilterInput
                  value={condDraft.end || '2026-12-31'}
                  onChange={(val) => setCondDraft((d) => ({ ...d, end: val }))}
                />
              </div>

              {/* Apply Filter */}
              <button
                type="button"
                className="filter-apply-btn"
                disabled={
                  sameSelection(condDraft.category, filterCategory)
                  && sameSelection(condDraft.status, filterStatus)
                  && sameSelection(condDraft.capacity, filterCapacity)
                  && sameSelection(condDraft.checkedBy, filterCheckedBy)
                  && condDraft.start === condFilterStartDate
                  && condDraft.end === condFilterEndDate
                }
                onClick={() => {
                  setFilterCategory(condDraft.category);
                  setFilterStatus(condDraft.status);
                  setFilterCapacity(condDraft.capacity);
                  setFilterCheckedBy(condDraft.checkedBy);
                  setCondFilterStartDate(condDraft.start);
                  setCondFilterEndDate(condDraft.end);
                }}
              >
                Filter
              </button>
            </div>
          }
        >
            <div className="panel-header-bar">
              <h3>Condition Records <span className="count-badge">{conditionRows.length}</span></h3>
              <LocalSearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Search conditions..."
                columnChooser={conditionColumnChooser}
                onAdd={canDo(user, 'condition.create') ? () => { setPrefilledConditionVehicleId(null); navigate(`${roleRoutes[user.role]}/conditions/new`); } : undefined}
                addLabel="Add Condition Check"
              />
            </div>

            <PaginatedTable
              columns={conditionColumnChooser.visibleColumns}
              onReorderColumn={conditionColumnChooser.reorderColumn}
              emptyMessage="No condition checks logged yet — click the + button to record one."
              rows={conditionRows}
            />
        </ModulePanel>
      );
    }

    // Issue Reports list — Admin, Custodian ('reportOrPropose' in their
    // sidebar), and Maintenance Personnel ('issues') all land here. Its
    // header carries a "Report Vehicle/Technical Issue" action (issue.create)
    // and, for whoever holds ticket.propose, a "Propose Ticket" action.
    if (activeModule === 'issues') {
      if (hasRole(user, 'Custodian') && !hasVehicles) {
        return (
          <ModulePanel description={issueDescription(user.role)}>
            <div className="empty-prereq">
              <h3>No vehicles registered yet</h3>
              <p>Vehicle issue reporting starts after at least one vehicle has been added to the system.</p>
            </div>
          </ModulePanel>
        );
      }

      return (
        <ModulePanel
          description={issueDescription(user.role)}
          statCards={
            <div className="issue-summary-grid">
              <div className="issue-summary-stats">
                <ModuleStatCards
                  totalLabel="Total Issues"
                  total={issueStats.total}
                  cards={ISSUE_STAT_CARDS}
                  counts={issueStats}
                  activeFilter={filterStatus}
                  onFilterChange={setFilterStatus}
                />
              </div>
              <div className="issue-summary-chart">
                <StackedBarChart
                  title="Issue Reports"
                  segments={[
                    { label: 'High', value: issueSeverityStats.High, color: '#dc2626' },
                    { label: 'Medium', value: issueSeverityStats.Medium, color: '#f59e0b' },
                    { label: 'Low', value: issueSeverityStats.Low, color: '#0ea5e9' },
                  ]}
                />
              </div>
              <LatestIssueCard issues={records.issues ?? []} />
              <section className="panel module-filter-panel issue-summary-filters">
                <IssueFilterPanel
                  categories={lookups.categories}
                  vehicles={lookups.vehicles}
                  issueTypes={lookups.issue_types ?? []}
                  severityLevels={lookups.severity_levels ?? []}
                  statusOptions={lookups.issue_statuses ?? []}
                  filterCategory={filterCategory}
                  setFilterCategory={setFilterCategory}
                  filterCapacity={filterCapacity}
                  setFilterCapacity={setFilterCapacity}
                  filterIssueType={filterIssueType}
                  setFilterIssueType={setFilterIssueType}
                  filterStatus={filterStatus}
                  setFilterStatus={setFilterStatus}
                  filterPriority={filterPriority}
                  setFilterPriority={setFilterPriority}
                  filterDateStart={filterDateStart}
                  setFilterDateStart={setFilterDateStart}
                  filterDateEnd={filterDateEnd}
                  setFilterDateEnd={setFilterDateEnd}
                />
              </section>
            </div>
          }
        >
          <div className="panel-header-bar">
            <h3>Issue Reports <span className="count-badge">{visibleRows.length}</span></h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <LocalSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search issues..."
              columnChooser={issueColumnChooser}
              onAdd={canDo(user, 'ticket.propose') ? () => { setPrefilledTicketData(null); navigate(`${roleRoutes[user.role]}/tickets/new`); } : undefined}
              addLabel="Propose Ticket"
            />
          </div>
          </div>
          {renderDismissIssueModal()}
          <PaginatedTable
            columns={issueColumnChooser.visibleColumns}
            onReorderColumn={issueColumnChooser.reorderColumn}
            emptyMessage="No issue reports match the current filters. Clear the filters or choose All statuses."
            rows={visibleRows}
            onRowClick={(row) => navigate(`${roleRoutes[user.role]}/issues/${row.issue_report_id}`)}
          />
        </ModulePanel>
      );
    }

    if (activeModule === 'maintenance') {
      return (
        <>
        <ModulePanel
          tabBar={maintenanceLedgerTabBar}
          description="Finished repair work from in-house repairs, external shops and maintenance schedules. Each row is one completed repair; open it to see the work and verification details."
          statCards={
            <ModuleStatCards
              totalLabel="Total Maintenance Records"
              total={maintenanceRecordStats.total}
              cards={MAINTENANCE_RECORD_STAT_CARDS}
              counts={maintenanceRecordStats}
              activeFilter={filterSource}
              onFilterChange={setFilterSource}
            />
          }
          filterBar={
            <FilterBar
              categories={lookups.categories}
              vehicles={lookups.vehicles}
              filterCategory={filterCategory}
              setFilterCategory={setFilterCategory}
              filterCapacity={filterCapacity}
              setFilterCapacity={setFilterCapacity}
              filterStatus={filterStatus}
              setFilterStatus={setFilterStatus}
              statusOptions={[]}
              filterPriority={filterPriority}
              setFilterPriority={setFilterPriority}
              priorityOptions={(lookups.maintenance_personnel ?? []).map((p) => p.name)}
              priorityLabel="Mechanic"
              extraFilters={[
                {
                  key: 'maintType',
                  label: 'Maintenance Types',
                  options: lookups.maintenance_types ?? [],
                  selected: filterMaintType,
                  setSelected: setFilterMaintType,
                },
                {
                  key: 'source',
                  label: 'Sources',
                  options: [{ value: 'In-House Repair', label: 'In-House Repair' }, { value: 'External Shop', label: 'Sent to External Shop' }, { value: 'Scheduled Maintenance', label: 'Maintenance Schedule' }],
                  selected: filterSource,
                  setSelected: setFilterSource,
                },
              ]}
              dateRange={{
                start: filterDateStart,
                setStart: setFilterDateStart,
                end: filterDateEnd,
                setEnd: setFilterDateEnd,
              }}
            />
          }
        >
          <div className="panel-header-bar">
            <h3>Maintenance Records <span className="count-badge">{visibleRows.length}</span></h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {/* No general "+ Add" entry point here anymore — repair data
                  is now entered through Tickets; Maintenance Schedule
                  completions create records through their own path. */}
              <LocalSearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Search maintenance..."
                columnChooser={maintenanceColumnChooser}
              />
            </div>
          </div>
            <PaginatedTable
              columns={maintenanceColumnChooser.visibleColumns}
              onReorderColumn={maintenanceColumnChooser.reorderColumn}
              emptyMessage="No completed repairs match this view. Finished maintenance work will appear here."
              rows={visibleRows}
              compact
              onRowClick={(row) => navigate(`${roleRoutes[user.role]}/maintenance/${row.maintenance_id}`)}
            />
        </ModulePanel>
        <FormModal open={!!editTarget?.__verify} title={`Verify Maintenance #${recordNumber(editTarget, 'maintenance_id')}`} onClose={() => setEditTarget(null)}>
          <SmartForm
            fields={verificationFields}
            key={editTarget?.maintenance_id}
            onCancel={() => setEditTarget(null)}
            onSubmit={submitModuleForm}
            submitLabel="Submit Verification"
            title=""
          />
        </FormModal>
        </>
      );
    }

    if (activeModule === 'maintenanceStatus') {
      return (
        <>
          <ModulePanel tabBar={maintenanceLedgerTabBar} description="Review records marked for field verification and send the result back to the ticket loop.">
            <div className="panel-header-bar">
              <h3>Pending Verifications <span className="count-badge">{visibleRows.length}</span></h3>
              <LocalSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search verifications..." columnChooser={maintenanceStatusColumnChooser} />
            </div>
            <DataTable
              columns={maintenanceStatusColumnChooser.visibleColumns}
              onReorderColumn={maintenanceStatusColumnChooser.reorderColumn}
              emptyMessage="Nothing awaiting your verification right now."
              rows={visibleRows}
              onRowClick={(row) => navigate(`${roleRoutes[user.role]}/maintenance/${row.maintenance_id}`)}
            />
          </ModulePanel>
          <FormModal open={!!editTarget} title={`Verify Maintenance #${recordNumber(editTarget, 'maintenance_id')}`} onClose={() => setEditTarget(null)}>
            <SmartForm
              fields={verificationFields}
              key={editTarget?.maintenance_id}
              onCancel={() => setEditTarget(null)}
              onSubmit={submitModuleForm}
              submitLabel="Submit Verification"
              title=""
            />
          </FormModal>

          {/* Offered right after a Pass, while the Custodian is still at the
              vehicle. Confirming a repair and confirming the vehicle can
              respond are different facts, so they stay separate records —
              this just removes the second trip needed to collect them. */}
          <FormModal
            open={!!readinessPromptTarget}
            title={`Readiness Check — ${readinessPromptTarget?.vehicle_name ?? ''}`}
            onClose={() => setReadinessPromptTarget(null)}
          >
            {readinessPromptTarget && (
              <>
                <div className="notice success" style={{ marginBottom: 14, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <span style={{ display: 'inline-flex', flexShrink: 0, marginTop: 1 }}><Icon name="checkCircle" size={16} /></span>
                  <span style={{ fontSize: '0.84rem' }}>
                    Verification passed. Since you&apos;re already at this vehicle, you can record its Readiness Check now instead of making a second trip — or skip it with Cancel.
                  </span>
                </div>
                <ReadinessCheckForm
                  vehicle={readinessPromptTarget}
                  onCancel={() => setReadinessPromptTarget(null)}
                  onSubmit={(payload) => submitReadinessFromPrompt(readinessPromptTarget.vehicle_id, payload)}
                />
              </>
            )}
          </FormModal>
        </>
      );
    }

    if (activeModule === 'schedules') {
      if (scheduleProfileId) {
        const schedule = (records.schedules ?? []).find((row) => String(row.schedule_id) === String(scheduleProfileId));
        if (!schedule && (loading || !records.schedules)) return <ModuleLoader label="Loading maintenance schedule" />;
        if (!schedule) {
          return <ModulePanel description="This maintenance schedule could not be found or is not available to your account.">
            <button type="button" className="ghost-button" onClick={() => returnToModule('schedules')}>Back to Maintenance Schedules</button>
          </ModulePanel>;
        }
        return <><MaintenanceScheduleDetailPage
          row={schedule}
          currentUser={user}
          onBack={() => returnToModule('schedules')}
          onViewVehicle={openVehicleProfile}
          onComplete={openCompleteSchedule}
          onEdit={(row) => navigate(`${roleRoutes[user.role]}/schedules/${row.schedule_id}/edit`)}
          onDelete={(row) => deleteRecord(`/maintenance-schedules/${row.schedule_id}`, 'Schedule cancelled.', `Cancel the ${row.maintenance_type} schedule for ${row.vehicle?.vehicle_name ?? 'this vehicle'}? It can be restored later if needed.`)}
          onRestore={(row) => restoreRecord(`/maintenance-schedules/${row.schedule_id}/restore`, 'Schedule restored for Admin approval.', 'Restore this schedule for Admin approval?')}
          onViewRecord={(row) => navigate(`${roleRoutes[user.role]}/maintenance/${row.resulting_maintenance_id}`)}
          onReassign={setReassignScheduleTarget}
          onViewTicket={openTicketProfile}
          onApprove={approveSchedule}
          onDecline={setDeclineScheduleTarget}
        />
          {renderCompleteScheduleModal()}
          {renderReassignScheduleModal()}
          {renderDeclineScheduleModal()}
        </>;
      }

      // A mechanic's own assignments surface first — the shared list still
      // shows everyone's schedules for context, but their own work isn't
      // buried in it. Computed once so the table and card views can't drift
      // into showing different orderings.
      // Ongoing plans are shown first; status controls provide access to history.
      const STATUS_RANK = { 'Pending Approval': 0, Scheduled: 1, Declined: 2, Completed: 3, Cancelled: 4 };
      const mineFirst = (!hasRole(user, 'Admin') && hasRole(user, 'Maintenance Personnel'));
      const scheduleRows = [...visibleRows].sort((a, b) => {
        if (mineFirst) {
          const am = String(a.assigned_to) === String(user.id) ? 0 : 1;
          const bm = String(b.assigned_to) === String(user.id) ? 0 : 1;
          if (am !== bm) return am - bm;
        }
        const ar = STATUS_RANK[a.status] ?? 5, br = STATUS_RANK[b.status] ?? 5;
        if (ar !== br) return ar - br;
        return String(a.scheduled_date).localeCompare(String(b.scheduled_date));
      });

      return (
        <ModulePanel
          description="Plan preventative maintenance and track schedule status."
          statCards={
            <ModuleStatCards
              totalLabel="Total Schedules"
              total={scheduleStats.total}
              cards={SCHEDULE_STAT_CARDS}
              counts={scheduleStats}
              activeFilter={filterStatus}
              onFilterChange={setFilterStatus}
              gridClassName="schedule-stat-grid"
            />
          }
          filterBar={
            <FilterBar
          statusControls={<WorkflowStatusControls options={['Pending Approval','Scheduled','Declined','AwaitingVerification','Completed','Cancelled']} selected={filterStatus} onChange={setFilterStatus} defaults={defaultWorkflowStatuses('schedules', user)} />}
              categories={lookups.categories}
              vehicles={lookups.vehicles}
              filterCategory={filterCategory}
              setFilterCategory={setFilterCategory}
              filterCapacity={filterCapacity}
              setFilterCapacity={setFilterCapacity}
              filterPriority={filterAssignedTo}
              setFilterPriority={setFilterAssignedTo}
              priorityOptions={(lookups.maintenance_personnel ?? []).map((p) => p.name)}
              priorityLabel="Mechanic"
              extraFilters={[{
                key: 'serviceLocation',
                label: 'Locations',
                options: [...new Set((records.schedules ?? []).map((r) => r.service_location).filter(Boolean))],
                selected: filterLocation,
                setSelected: setFilterLocation,
              }]}
            />
          }
        >
          <div className="panel-header-bar schedule-panel-header">
            <div className="schedule-panel-heading">
              <div><h3>Maintenance Schedules</h3><p>Upcoming, overdue, and completed maintenance activities.</p></div>
            </div>
            <div className="schedule-panel-tools">
              <ViewModeDropdown value={scheduleViewMode} onChange={changeScheduleViewMode} />
              {/* Custodian books directly (schedule.create) — they have the
                  day-to-day visibility into a vehicle's condition. Admin keeps
                  oversight (edit any/reassign/cancel) without originating one;
                  Maintenance Personnel never booked schedules directly. */}
              <LocalSearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Search schedules..."
                onAdd={(canDo(user, 'schedule.create') || canDo(user, 'schedule.suggest'))
                  ? () => navigate(`${roleRoutes[user.role]}/schedules/new`)
                  : undefined}
                addLabel={canDo(user, 'schedule.create') ? 'Add Schedule' : 'Suggest Schedule'}
                onExport={() => exportRowsToCsv('maintenance-schedules.csv', SCHEDULE_EXPORT_COLUMNS, visibleRows)}
                columnChooser={scheduleViewMode === 'card' ? undefined : scheduleColumnChooser}
              />
            </div>
          </div>
          {scheduleViewMode === 'card' ? (
            <PaginatedCardGrid
              items={scheduleRows}
              keyOf={(row) => row.schedule_id}
              emptyMessage="No schedules match the selected filters. Choose All statuses to include history."
              renderItem={(row) => (
                <MaintenanceScheduleCard
                  row={row}
                  currentUser={user}
                  onComplete={openCompleteSchedule}
                  onEdit={(r) => navigate(`${roleRoutes[user.role]}/schedules/${r.schedule_id}/edit`)}
                  onDelete={(r) => deleteRecord(`/maintenance-schedules/${r.schedule_id}`, 'Schedule cancelled.', `Cancel the ${r.maintenance_type} schedule for ${r.vehicle?.vehicle_name ?? 'this vehicle'}? It can be restored later if needed.`)}
                  onRestore={(r) => restoreRecord(`/maintenance-schedules/${r.schedule_id}/restore`, 'Schedule restored for Admin approval.', 'Restore this schedule for Admin approval?')}
                  onViewRecord={(r) => navigate(`${roleRoutes[user.role]}/maintenance/${r.resulting_maintenance_id}`)}
                  onReassign={setReassignScheduleTarget}
                  onViewTicket={openTicketProfile}
                  onViewVehicle={openVehicleProfile}
                  onViewSchedule={(r) => navigate(`${roleRoutes[user.role]}/schedules/${r.schedule_id}`)}
                  onApprove={approveSchedule}
                  onDecline={setDeclineScheduleTarget}
                />
              )}
            />
          ) : (
            <PaginatedTable
              columns={scheduleColumnChooser.visibleColumns}
              onReorderColumn={scheduleColumnChooser.reorderColumn}
              emptyMessage="No schedules match the selected filters. Choose All statuses to include history."
              rows={scheduleRows}
            />
          )}

          {renderCompleteScheduleModal()}
          {renderReassignScheduleModal()}
          {renderDeclineScheduleModal()}
        </ModulePanel>
      );
    }

    if (activeModule === 'histories') {
      const historyActivityTypeOptions = [...new Set((records.histories ?? []).map((h) => h.activity_type).filter(Boolean))].sort();
      return (
        <ModulePanel
          description="Automatic vehicle activity timeline across location, issue, condition, and maintenance events."
          filterBar={
            <div className="filter-bar-container">
              <div className="filter-label"><span>Filters:</span></div>
              <div className="filter-date-group">
                <span>Activity Type</span>
                <MultiSelectDropdown
                  placeholder="All Activity Types"
                  options={historyActivityTypeOptions}
                  selected={filterActivityType}
                  onChange={setFilterActivityType}
                />
              </div>
              <div className="filter-date-group">
                <span>From Date</span>
                <DateFilterInput
                  value={filterDateStart || '2026-01-01'}
                  onChange={setFilterDateStart}
                />
              </div>
              <div className="filter-date-group">
                <span>To Date</span>
                <DateFilterInput
                  value={filterDateEnd || '2026-12-31'}
                  onChange={setFilterDateEnd}
                />
              </div>
            </div>
          }
        >
          <div className="panel-header-bar">
            <h3>Activity History <span className="count-badge">{visibleRows.length}</span></h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <LocalSearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Search history..."
                onExport={() => exportRowsToCsv('vehicle-history.csv', VEHICLE_HISTORY_EXPORT_COLUMNS, visibleRows)}
                columnChooser={vehicleHistoryColumnChooser}
              />
            </div>
          </div>
          <PaginatedTable
            columns={vehicleHistoryColumnChooser.visibleColumns}
            onReorderColumn={vehicleHistoryColumnChooser.reorderColumn}
            emptyMessage="No vehicle activity recorded yet."
            rows={visibleRows}
            pageSizeOptions={[10, 20, 40, 50]}
            initialPageSize={10}
          />

          {/* Print-only — same convention as ReportPreview's print view:
              portaled to <body> since the app's @media print rule hides
              #root entirely, so this has to live outside it. */}
          {createPortal(
            <div className="report-print-view">
              <div className="veh-print-header">
                <div className="veh-print-header-left">
                  <h2>Vehicle Activity History</h2>
                  <p>Printed on {formatDate(new Date().toISOString())}</p>
                </div>
                <div className="veh-print-header-right">
                  <VMSLogo variant="blue" size={48} className="topbar-gear-icon" />
                  <span className="vms-wordmark">vms</span>
                </div>
              </div>
              <table className="report-print-table">
                <thead>
                  <tr>{historyColumns.map((col) => <th key={col.label}>{col.label}</th>)}</tr>
                </thead>
                <tbody>
                  {visibleRows.length ? visibleRows.map((row, i) => (
                    <tr key={row.history_id ?? i}>{historyColumns.map((col) => <td key={col.label}>{col.render(row)}</td>)}</tr>
                  )) : (
                    <tr><td colSpan={historyColumns.length}>No records</td></tr>
                  )}
                </tbody>
              </table>
            </div>,
            document.body,
          )}
        </ModulePanel>
      );
    }

    if (activeModule === 'reports') {
      return (
        <ModulePanel description="Pick a report below, then narrow it down with the filters that apply to it.">
          <div className="panel-header-bar">
            <h3>Reports</h3>
          </div>
          <ReportsModule lookups={lookups} onGenerate={submitModuleForm} />
          {report && <ReportPreview report={report} />}
        </ModulePanel>
      );
    }

    if (activeModule === 'logs') {
      return (
        <ModulePanel description="Read-only accountability log of user actions.">
          <div className="panel-header-bar">
            <h3>Activity Log <span className="count-badge">{visibleRows.length}</span></h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <LocalSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search logs..." columnChooser={logsView === 'list' ? logColumnChooser : undefined} />
            </div>
          </div>
          <div className="view-tabs">
            <button type="button" className={logsView === 'list' ? 'active' : ''} onClick={() => setLogsView('list')}>List View</button>
            <button type="button" className={logsView === 'recent' ? 'active' : ''} onClick={() => setLogsView('recent')}>Recent Activities</button>
          </div>
          {logsView === 'list' ? (
            <PaginatedTable columns={logColumnChooser.visibleColumns} onReorderColumn={logColumnChooser.reorderColumn} rows={visibleRows} emptyMessage="No activity logged yet." />
          ) : (
            <ActivityTimeline rows={visibleRows} />
          )}
        </ModulePanel>
      );
    }

    // ── TICKET WORKFLOW MODULES ─────────────────────────────────────────

    // Phase 1 + 4 Tier 2: Admin ticket management
    if (activeModule === 'tickets') {
      return (
        <TicketModule
          tickets={visibleRows}
          allTickets={rawRows}
          ticketLookups={ticketLookups}
          notifications={notifications}
          onViewTicket={openTicketProfile}
          onChangeVisibility={(ticket, hidden) => ticketAction(`/tickets/${ticket.ticket_id}/list-visibility`, { hidden }, hidden ? 'Ticket hidden from your list. Repair tracking remains active.' : 'Ticket restored to your list.')}
          onViewIssue={(id) => navigate(`${roleRoutes[user.role]}/issues/${id}`)}
          onCreateNew={canDo(user, 'ticket.create') ? () => navigate(`${roleRoutes[user.role]}/tickets/new`) : undefined}
          onViewArchives={canDo(user, 'ticket.view_archives') ? () => setActiveModule('ticketArchives') : undefined}
          recentIssues={hasRole(user, 'Admin') ? (records.issues ?? []) : undefined}
          onViewVehicle={openVehicleProfile}
          notice={notice}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          categories={lookups.categories}
          vehicles={lookups.vehicles}
          filterCategory={filterCategory}
          setFilterCategory={setFilterCategory}
          filterCapacity={filterCapacity}
          setFilterCapacity={setFilterCapacity}
          filterVehicle={filterVehicle}
          setFilterVehicle={setFilterVehicle}
          filterMechanic={filterMechanic}
          setFilterMechanic={setFilterMechanic}
          filterCustodian={filterCustodian}
          setFilterCustodian={setFilterCustodian}
          filterStatus={filterStatus}
          setFilterStatus={setFilterStatus}
          filterPriority={filterPriority}
          setFilterPriority={setFilterPriority}
          filterDateStart={filterDateStart}
          setFilterDateStart={setFilterDateStart}
          filterDateEnd={filterDateEnd}
          setFilterDateEnd={setFilterDateEnd}
        />
      );
    }

    // Phase 5: Admin archive view
    if (activeModule === 'ticketArchives') {
      const allArchiveRows = records.ticketArchives ?? [];

      // Year → ticket count map, built from unfiltered data
      const yearCounts = allArchiveRows.reduce((acc, r) => {
        const yr = r.archived_at?.substring(0, 4);
        if (yr) acc[yr] = (acc[yr] ?? 0) + 1;
        return acc;
      }, {});
      const archiveYears = Object.keys(yearCounts).sort().reverse();

      // Final status values present in the data
      const archiveFinalStatuses = [...new Set(allArchiveRows.map((r) => r.final_status).filter(Boolean))];

      // Which year is the current draft's From date pointing at (for year selector sync)
      const selectedYear = archiveDraft.start ? archiveDraft.start.substring(0, 4) : '';

      const applyQuickFilter = (key) => {
        const today = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        let start = '';
        let end = '';
        if (key === 'this_year') {
          start = `${today.getFullYear()}-01-01`;
          end = fmt(today);
        } else if (key === 'last_year') {
          const yr = today.getFullYear() - 1;
          start = `${yr}-01-01`;
          end = `${yr}-12-31`;
        } else if (key === 'over_1yr') {
          const d = new Date(today); d.setFullYear(d.getFullYear() - 1);
          end = fmt(d);
        } else if (key === 'over_3yr') {
          const d = new Date(today); d.setFullYear(d.getFullYear() - 3);
          end = fmt(d);
        }
        const next = { start, end, status: archiveDraft.status, quick: key || '' };
        setArchiveDraft(next);
        setArchiveStart(next.start);
        setArchiveEnd(next.end);
      };

      const applyYearFilter = (yr) => {
        if (!yr) {
          setArchiveDraft({ start: '', end: '', status: archiveDraft.status, quick: '' });
          setArchiveStart('');
          setArchiveEnd('');
        } else {
          const next = { start: `${yr}-01-01`, end: `${yr}-12-31`, status: archiveDraft.status, quick: '' };
          setArchiveDraft(next);
          setArchiveStart(next.start);
          setArchiveEnd(next.end);
        }
      };

      const isDraftDifferent =
        archiveDraft.start !== archiveStart ||
        archiveDraft.end !== archiveEnd ||
        archiveDraft.status !== archiveStatusFilter;

      return (
        <ModulePanel
          description="Completed maintenance tickets and recoverable deleted records."
          filterBar={
            <div className="filter-bar-container" style={{ flexWrap: 'wrap', gap: '8px 12px', alignItems: 'center' }}>
              <div className="filter-label"><span>Vehicle:</span></div>
              <div className="filter-date-group">
                <span>Category</span>
                <MultiSelectDropdown
                  placeholder="All Categories"
                  options={(lookups.categories ?? []).map((c) => ({ value: String(c.category_id), label: c.category_name }))}
                  selected={filterCategory}
                  onChange={setFilterCategory}
                />
              </div>
              <div className="filter-date-group">
                <span>Capacity</span>
                <MultiSelectDropdown
                  placeholder="All Capacities"
                  options={[...new Set((lookups.vehicles ?? []).map((v) => v.capacity).filter(Boolean))]}
                  selected={filterCapacity}
                  onChange={setFilterCapacity}
                />
              </div>

              <div style={{ width: 1, height: 22, background: 'var(--border, #334155)', flexShrink: 0 }} />

              <div className="filter-label"><span>DATE FILTER:</span></div>

              {/* Quick relative filters — dropdown */}
              <div className="filter-date-group">
                <span>Quick Filter</span>
                <SearchableSelect
                  className="filter-select"
                  value={archiveDraft.quick}
                  onChange={(e) => applyQuickFilter(e.target.value)}
                >
                  <option value="">Quick Filter</option>
                  <option value="this_year">This Year</option>
                  <option value="last_year">Last Year</option>
                  <option value="over_1yr">Older than 1 Year</option>
                  <option value="over_3yr">Older than 3 Years</option>
                </SearchableSelect>
              </div>

              <div style={{ width: 1, height: 22, background: 'var(--border, #334155)', flexShrink: 0 }} />

              {/* Year dropdown — only years that actually have archived tickets */}
              <div className="filter-date-group">
                <span>Year</span>
                <SearchableSelect
                  className="filter-select"
                  value={selectedYear}
                  onChange={(e) => applyYearFilter(e.target.value)}
                >
                  <option value="">All Years</option>
                  {archiveYears.map((yr) => (
                    <option key={yr} value={yr}>
                      {yr} — {yearCounts[yr]} {yearCounts[yr] === 1 ? 'ticket' : 'tickets'}
                    </option>
                  ))}
                </SearchableSelect>
              </div>

              {/* Custom date range */}
              <div className="filter-date-group">
                <span>From Date</span>
                <DateFilterInput
                  value={archiveDraft.start || '2026-01-01'}
                  onChange={(val) => setArchiveDraft((d) => ({ ...d, start: val, quick: '' }))}
                />
              </div>
              <div className="filter-date-group">
                <span>To Date</span>
                <DateFilterInput
                  value={archiveDraft.end || '2026-12-31'}
                  onChange={(val) => setArchiveDraft((d) => ({ ...d, end: val, quick: '' }))}
                />
              </div>

              {/* Final status filter */}
              {archiveFinalStatuses.length > 0 && (
                <div className="filter-date-group">
                  <span>Status</span>
                  <SearchableSelect
                    className="filter-select"
                    value={archiveDraft.status}
                    onChange={(e) => setArchiveDraft((d) => ({ ...d, status: e.target.value }))}
                  >
                    <option value="">All Statuses</option>
                    {archiveFinalStatuses.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </SearchableSelect>
                </div>
              )}

              {/* Apply — only shown when draft differs from applied */}
              <button
                type="button"
                className="filter-apply-btn"
                disabled={!isDraftDifferent}
                onClick={() => {
                  setArchiveStart(archiveDraft.start);
                  setArchiveEnd(archiveDraft.end);
                  setArchiveStatusFilter(archiveDraft.status);
                }}
              >
                Apply
              </button>

              {/* Active range summary pill */}
              {(archiveStart || archiveEnd) && (
                <span style={{ fontSize: '0.75rem', opacity: 0.55, fontStyle: 'italic' }}>
                  {archiveStart && archiveEnd
                    ? `${archiveStart} → ${archiveEnd}`
                    : archiveStart
                    ? `From ${archiveStart}`
                    : `Up to ${archiveEnd}`}
                </span>
              )}
            </div>
          }
        >
          <div className="panel-header-bar">
            <h3>
              <button type="button" className="ghost-button" style={{ marginRight: 10 }} onClick={() => setActiveModule('tickets')}>
                <Icon name="arrowLeft" size={14} /> Tickets
              </button>
              {showDeletedArchives ? 'Deleted Tickets' : 'Archived Tickets'} <span className="count-badge">{visibleRows.length}</span>
              {visibleRows.length !== allArchiveRows.length && (
                <span style={{ fontWeight: 400, fontSize: '0.8rem', marginLeft: 6 }}>of {allArchiveRows.length} total</span>
              )}
            </h3>
            <label className="archive-deleted-toggle"><input type="checkbox" checked={showDeletedArchives} onChange={(e) => setShowDeletedArchives(e.target.checked)} />Deleted Tickets</label>
            <LocalSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search archives..." columnChooser={archiveColumnChooser} />
          </div>

          {/* No-result hint when filters are active but nothing matched */}
          {visibleRows.length === 0 && allArchiveRows.length > 0 && (archiveStart || archiveEnd || archiveStatusFilter) && (
            <p className="notice" style={{ margin: '8px 0', opacity: 0.7, fontSize: '0.85rem' }}>
              No archived tickets match the selected filters. Only dates with actual archived tickets will return results — try adjusting the date range or clearing the filter.
            </p>
          )}

          <PaginatedTable
            columns={archiveColumnChooser.visibleColumns}
            onReorderColumn={archiveColumnChooser.reorderColumn}
            emptyMessage={showDeletedArchives ? "No deleted tickets." : "No archived tickets yet — completed tickets are stored here automatically."}
            rows={visibleRows}
          />
        </ModulePanel>
      );
    }

    // Phase 2: Custodian — submit inspection results
    if (activeModule === 'ticketInspections') {
      return (
          <CustodianInspectionModule
            tabBar={myTasksTabBar}
            tickets={visibleRows}
            onOpenInspect={(ticket) => navigate(`${roleRoutes[user.role]}/inspections/${ticket.ticket_id}/inspect`)}
            categories={lookups.categories}
            vehicles={lookups.vehicles}
            filterCategory={filterCategory}
            setFilterCategory={setFilterCategory}
            filterCapacity={filterCapacity}
            setFilterCapacity={setFilterCapacity}
            filterPriority={filterPriority}
            setFilterPriority={setFilterPriority}
            priorityOptions={ticketLookups.priorities}
            onViewVehicle={openVehicleProfile}
            stats={inspectionStats}
            activeFilter={filterStatus}
            onFilterChange={setFilterStatus}
          />
      );
    }

    // Phase 4 Tier 1: Custodian — verify completed repairs
    if (activeModule === 'ticketVerifications') {
      return (
          <CustodianVerificationModule
            tabBar={myTasksTabBar}
            user={user}
            tickets={visibleRows}
            readyToCloseTickets={visibleRows.filter((t) => t.status === 'For Verification' && String(t.assigned_custodian_id) === String(user.id) && !didRepairWorkOn(t, user.id))}
            editTarget={editTarget}
            setEditTarget={setEditTarget}
            onVerify={(ticket, payload) => ticketAction(`/tickets/${ticket.ticket_id}/verify`, payload, verifyOutcomeMessage(payload))}
            onCancelEdit={() => setEditTarget(null)}
            categories={lookups.categories}
            vehicles={lookups.vehicles}
            filterCategory={filterCategory}
            setFilterCategory={setFilterCategory}
            filterCapacity={filterCapacity}
            setFilterCapacity={setFilterCapacity}
            filterPriority={filterPriority}
            setFilterPriority={setFilterPriority}
            mechanicOptions={(lookups.maintenance_personnel ?? []).map((p) => p.name)}
            filterVerdict={filterVerdict}
            setFilterVerdict={setFilterVerdict}
            onViewVehicle={openVehicleProfile}
            onViewTicket={openTicketProfile}
            stats={verificationStats}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            activeFilter={filterStatus}
            onFilterChange={setFilterStatus}
          />
      );
    }

    // Phase 3: Mechanic — view work orders and log repairs
    if (activeModule === 'ticketWorkOrders') {
      return (
        <>
          <MechanicWorkOrderModule
            tickets={visibleRows}
            allTickets={records.ticketWorkOrders ?? []}
            onViewTicket={openTicketProfile}
            categories={lookups.categories}
            vehicles={lookups.vehicles}
            filterCategory={filterCategory}
            setFilterCategory={setFilterCategory}
            filterCapacity={filterCapacity}
            setFilterCapacity={setFilterCapacity}
            filterPriority={filterPriority}
            setFilterPriority={setFilterPriority}
            maintTypeOptions={lookups.maintenance_types}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            stats={workOrderStats}
            activeFilter={filterStatus}
            onFilterChange={setFilterStatus}
            currentUser={user}
          />
          {renderCompleteScheduleModal()}
        </>
      );
    }

    // Cross-phase outcome feed — "vehicles I've worked on and where they stand
    // now" — so Custodians/Mechanics see verdicts (Approved/Rejected/Confirmed/
    // Reopened) without hunting for the ticket or relying on a notification.
    if (activeModule === 'workTracker') {
      return (
          <WorkTrackerModule
            tabBar={myTasksTabBar}
            tickets={records.workTracker ?? []}
            user={user}
            categories={lookups.categories}
            vehicles={lookups.vehicles}
            onViewTicket={openTicketProfile}
          />
      );
    }

    return null;
  }
}

// Maps an Action Queue item's type to where clicking it should go, and what
// it should look like — one place to keep type/icon/route in sync.
function Dashboard(props) {
  return <RoleDashboard {...props} isScheduleOverdue={isScheduleOverdue} />;
}

// Formats a plain YYYY-MM-DD date for the Availability Forecast (e.g. "Jul 14, 2026").
function formatForecastDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// One filled horizontal bar split proportionally into colored segments (e.g.
// role breakdown) — paired with ChartLegend below it for the label/count per
// segment, rather than HorizontalBarChart's stack of separate per-row bars.
// A dual-handle range slider over a small fixed set of labeled stops (e.g.
// severity levels), not a continuous 0-100 value — built from two overlaid
// native <input type="range"> elements (a well-worn CSS trick: both share
// the same track, but only their thumbs are clickable, via pointer-events
// stripped from the input itself and restored on ::-webkit/-moz-range-thumb)
// rather than hand-rolling pointer-drag math.
function DualRangeSlider({ labels, minIndex, maxIndex, onChange }) {
  const lastIndex = labels.length - 1;
  const percentOf = (i) => (lastIndex === 0 ? 0 : (i / lastIndex) * 100);

  return (
    <div className="dual-range-slider">
      <div className="dual-range-track">
        <div
          className="dual-range-fill"
          style={{ left: `${percentOf(minIndex)}%`, right: `${100 - percentOf(maxIndex)}%` }}
        />
        <input
          type="range"
          className="dual-range-input"
          min={0}
          max={lastIndex}
          step={1}
          value={minIndex}
          aria-label="Minimum priority"
          aria-valuetext={labels[minIndex]}
          // Separate coincident handles so either end can widen again.
          style={{ zIndex: 1, top: minIndex === maxIndex ? 'calc(50% - 10px)' : '50%' }}
          onChange={(e) => onChange(Math.min(Number(e.target.value), maxIndex), maxIndex)}
        />
        <input
          type="range"
          className="dual-range-input"
          min={0}
          max={lastIndex}
          step={1}
          value={maxIndex}
          aria-label="Maximum priority"
          aria-valuetext={labels[maxIndex]}
          style={{ zIndex: 2, top: minIndex === maxIndex ? 'calc(50% + 10px)' : '50%' }}
          onChange={(e) => onChange(minIndex, Math.max(Number(e.target.value), minIndex))}
        />
      </div>
      <div className="dual-range-labels">
        {labels.map((label) => <span key={label}>{label}</span>)}
      </div>
    </div>
  );
}

function SegmentedBar({ segments }) {
  const total = segments.reduce((sum, s) => sum + (Number(s.value) || 0), 0);
  return (
    <div className="segmented-bar">
      {total === 0
        ? <span style={{ width: '100%', background: 'var(--surface-2, #f1f5f9)' }} />
        : segments.filter((s) => s.value > 0).map((s) => (
          <span key={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} title={`${s.label}: ${s.value}`} />
        ))}
    </div>
  );
}

function ChartLegend({ rows }) {
  return (
    <ul className="chart-legend">
      {rows.map((row) => (
        <li key={row.label}>
          <span style={{ '--legend-color': row.color }}></span>
          <small>{row.label}</small>
          <strong>{row.value}</strong>
        </li>
      ))}
    </ul>
  );
}



// The "what this page does" hint banner (blue info callout) was removed from
// every module per user request — kept as a no-op rather than touched at
// every call site, so ModulePanel and the 4 ticket-workflow pages that use it
// don't need to change.
function DismissibleHint() {
  return null;
}

function ModulePanel({ children, description, statCards, filterBar, tabBar }) {
  return (
    <div className="module-grid">
      <DismissibleHint description={description} />
      {/* Tabs switch the whole view (stats, filters, list), so they live at
          the top — same spot on every tab — not between filters and list. */}
      {tabBar}
      {statCards}
      {filterBar && (
        <section className="panel module-filter-panel">
          {filterBar}
        </section>
      )}
      <section className="panel">
        {children}
      </section>
    </div>
  );
}

/** Generic modal wrapper that hosts a SmartForm popup. */
// Calls onEscape when Escape is pressed while `active` — shared by the
// app's dialogs so each one can be dismissed from the keyboard.
function useEscapeKey(active, onEscape) {
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onEscape?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onEscape]);
}

function FormModal({ open, title, onClose, children, wide = false, className = '' }) {
  const notice = useContext(FormNoticeContext);
  const titleId = useId();
  useEscapeKey(open, onClose);

  if (!open) return null;

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className={`modal-box${wide ? ' modal-box-wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 id={titleId}>{title}</h3>
          <button className="modal-close-btn" onClick={onClose} type="button" aria-label="Close"><Icon name="close" size={18} /></button>
        </div>
        {notice && notice.type === 'error' && (
          <div className="notice error" role="alert" style={{ margin: '12px 28px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', textAlign: 'center', flexDirection: 'column' }}>
            <span style={{ display: 'inline-flex', flexShrink: 0 }}><Icon name="alert" size={16} /></span>
            <span>{notice.text}</span>
          </div>
        )}
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body
  );
}

function UserInfoModal({ user, onClose }) {
  useEscapeKey(true, onClose);
  const initials = user.name
    ? user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()
    : 'U';

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" role="dialog" aria-modal="true" aria-label="Reporter Information" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Reporter Information</h3>
          <button className="modal-close-btn" onClick={onClose} type="button" aria-label="Close"><Icon name="close" size={18} /></button>
        </div>
        <div className="modal-body">
          <div className="user-info-card">
            <div className="profile-avatar user-info-avatar">{initials}</div>
            <div>
              <p className="user-info-name">{user.name}</p>
              {user.role && <span className="user-info-role">{user.role}</span>}
            </div>
          </div>
          <dl className="user-info-details">
            {user.email && (
              <div>
                <dt>Email</dt>
                <dd>{user.email}</dd>
              </div>
            )}
            {user.id != null && (
              <div>
                <dt>User ID</dt>
                <dd>#{user.id}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>
    </div>,
    document.body
  );
}

// Full-page user profile — clicking a user anywhere (any table, any role) opens
// this instead of a popup. Uses the loaded users list when available, otherwise
// the user object carried on navigation state (so non-admins can view it too).
function UserViewPage({ userId, users = [], currentUser, onEdit }) {
  const location = useLocation();
  const user = (users ?? []).find((u) => String(u.id) === String(userId)) || location.state?.user || null;

  if (!user) {
    return (
      <ModulePanel description="This user account could not be found.">
      </ModulePanel>
    );
  }

  const initials = user.name ? user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() : 'U';
  const isActive = user.is_active !== false;

  return (
    <ModulePanel description="User account profile and contact details.">
      <div className="vehicle-profile-header">
        <div className="vehicle-profile-identity">
          <span className="ticket-detail-id">User ID #{user.id}</span>
          <h3 className="ticket-detail-title">{user.name}</h3>
        </div>
        {canDo(currentUser, 'user.edit') && (
          <button className="primary-button" type="button" onClick={onEdit}><Icon name="edit" size={14} /> Edit User</button>
        )}
      </div>

      <div className="user-view-dash">
        <section className="veh-card">
          <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>User Information</h4></div>
          <div className="user-view-body">
            <div className="user-view-avatar">
              {user.photo_url ? <img src={resolvePhotoUrl(user.photo_url)} alt={user.name} /> : <span>{initials}</span>}
            </div>
            <dl className="veh-kv">
              <div><dt>Full Name</dt><dd>{user.name}</dd></div>
              <div><dt>Role</dt><dd>{user.role ?? '-'}</dd></div>
              <div><dt>Account Status</dt><dd><StatusBadge value={isActive ? 'Active' : 'Inactive'} /></dd></div>
            </dl>
          </div>
        </section>

        <section className="veh-card">
          <div className="veh-card-head"><Icon name="key" size={16} /><h4>Contact &amp; Login</h4></div>
          <dl className="veh-kv">
            <div><dt>Email</dt><dd>{user.email ?? '-'}</dd></div>
            <div><dt>Phone</dt><dd>{user.phone || '-'}</dd></div>
            <div><dt>Address</dt><dd>{user.address || '-'}</dd></div>
          </dl>
        </section>
      </div>
    </ModulePanel>
  );
}



// Full-page issue detail — mirrors the vehicle/ticket profile pages so every
// "View" action opens its own page rather than a modal, consistently for all roles.
// Fetches by ID rather than looking the issue up in an already-loaded list —
// a pure Custodian's own list is filtered to "mine", but a "View" link from
// the duplicate-issue warning is specifically for a report FILED BY SOMEONE
// ELSE on the same vehicle, which that filtered list would never contain.
function IssueViewPage({ issueId, allHubs = [], user, onCreateTicketFromIssue, onDismissIssue, onRecommendTicket }) {
  const actions = useContext(RowActionsContext);
  const [issue, setIssue] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // Recurrence used to only ever surface AFTER a ticket was created — one
  // step too late to change the decision. Checking it here means Admin sees
  // "this fault came back a 3rd time" while still deciding whether to open
  // one, not in a notification once it already exists.
  const [recurrence, setRecurrence] = useState(null);

  useEffect(() => {
    api.get(`/issues/${issueId}`)
      .then((response) => { setIssue(response.data); setNotFound(false); })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [issueId]);

  const issueRecurrenceResetKey = JSON.stringify([issue?.vehicle_id, issue?.issue_type]);
  const [previousIssueRecurrenceResetKey, setPreviousIssueRecurrenceResetKey] = useState(issueRecurrenceResetKey);
  if (previousIssueRecurrenceResetKey !== issueRecurrenceResetKey) { setPreviousIssueRecurrenceResetKey(issueRecurrenceResetKey); setRecurrence(null); }
  useEffect(() => {
    if (!issue?.vehicle_id) return;
    let cancelled = false;
    api.get(`/vehicles/${issue.vehicle_id}/recurrence`, { params: { issue_type: issue.issue_type, title: issue.issue_type } })
      .then((r) => { if (!cancelled) setRecurrence(r.data); })
      .catch(() => { if (!cancelled) setRecurrence(null); });
    return () => { cancelled = true; };
  }, [issue?.vehicle_id, issue?.issue_type]);

  const hub = allHubs.find((h) => h.name === issue?.vehicle?.current_location);

  // This vehicle's full issue-report history, broken down by status — reuses
  // the already-loaded issues list, no extra API call.



  if (loading) return <ModuleLoader label="Loading issue" />;

  if (notFound || !issue) {
    return (
      <ModulePanel description="This issue report could not be found — it may have been deleted.">
      </ModulePanel>
    );
  }

  return (
    <ModulePanel description="Full details of this reported vehicle issue.">
      <div className="vehicle-profile-header">
        <div className="vehicle-profile-identity">
          <span className="ticket-detail-id">Issue #{recordNumber(issue, 'issue_report_id')}</span>
          <h3 className="ticket-detail-title">{issue.issue_type}</h3>
          <div className="ticket-detail-meta">
            <TicketStatusBadge value={issue.severity_level} />
            <StatusBadge value={issue.status} />
          </div>
        </div>
        {/* A repair starts only as a Custodian's proposal, which the Admin
            then approves or declines — so this is the only action here. */}
        {onDismissIssue && canDo(user, 'issue.dismiss') && issueNeedsTicket(issue) && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="ghost-button btn-delete-action" type="button" onClick={() => onDismissIssue(issue)}><Icon name="close" size={14} /> Dismiss</button>
          </div>
        )}
        {onRecommendTicket && canDo(user, 'issue.recommend_ticket') && ['Pending', 'Under Review'].includes(issue.status) && !issue.maintenance_ticket && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="ghost-button btn-confirm-action" type="button" onClick={() => onRecommendTicket(issue)}><Icon name="ticket" size={14} /> Recommend Maintenance Ticket</button>
          </div>
        )}
        {onCreateTicketFromIssue && (canDo(user, 'ticket.create') || canDo(user, 'ticket.propose')) && ['Pending', 'Under Review'].includes(issue.status) && !issue.maintenance_ticket && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="ghost-button btn-confirm-action" type="button" onClick={() => onCreateTicketFromIssue(issue)}><Icon name="ticket" size={14} /> {canDo(user, 'ticket.propose') ? 'Propose Ticket' : 'Create Ticket'}</button>
          </div>
        )}
      </div>

      {recurrence && recurrence.count > 0 && (
        <div className="ticket-alert-banner formaint" style={{ marginBottom: 16 }}>
          <Icon name="alert" size={16} />
          <span>
            {/* Same ordinal-suffix pattern as the ticket detail page's own
                "Recurring — Nth time" badge — recurrence.count is the count
                of PRIOR occurrences, same semantics as ticket.recurrence_count
                there, so it indexes the same way. */}
            <strong>This is the {recurrence.count + 1}{['st', 'nd', 'rd'][recurrence.count] ?? 'th'} time</strong> "{issue.issue_type}" has come up on this vehicle in the last 90 days
            {recurrence.last_occurred && (
              <> — last fixed via {recurrence.last_type === 'record' ? 'Maintenance Record' : 'Ticket'} #{recurrence.last_id} on {formatDate(recurrence.last_occurred)}</>
            )}
            . Consider a deeper fix or a decommission review rather than another routine repair.
          </span>
        </div>
      )}

      <div className="issue-view-dash">
        <div className="issue-view-main">
          <section className="veh-card issue-view-info">
            <div className="veh-card-head"><Icon name="alert" size={16} /><h4>Issue Information</h4></div>
            <div className="issue-view-info-body">
              {issue.vehicle?.photo_url && (
                <div className="issue-view-vehicle-photo">
                  <img src={resolvePhotoUrl(issue.vehicle.photo_url)} alt={issue.vehicle.vehicle_name} />
                </div>
              )}
              <div className="issue-view-identity">
                <div>
                  <span className="veh-remarks-label">Vehicle</span>
                  {issue.vehicle ? (
                    actions?.viewVehicle ? (
                      <button type="button" className="issue-view-identity-link" onClick={() => actions.viewVehicle(issue.vehicle)}>
                        {issue.vehicle.vehicle_name}
                      </button>
                    ) : <p className="issue-view-identity-value">{issue.vehicle.vehicle_name}</p>
                  ) : <p className="issue-view-identity-value">-</p>}
                  {issue.vehicle?.plate_number && <span className="muted"> ({issue.vehicle.plate_number})</span>}
                </div>
                <div>
                  <span className="veh-remarks-label">Reported By</span>
                  <div style={{ marginTop: 4 }}><UserAvatarName user={issue.reported_by} /></div>
                </div>
              </div>

              <div className="issue-view-facts">
                <p><strong>Issue Type:</strong> {issue.issue_type}</p>
                <p><strong>Severity:</strong> <TicketStatusBadge value={issue.severity_level} /></p>
                <p><strong>Status:</strong> <StatusBadge value={issue.status} /></p>
                {issue.maintenance_ticket && (
                  <p>
                    <strong>Linked Ticket:</strong>{' '}
                    {actions?.viewTicket ? (
                      <button type="button" className="issue-view-identity-link" style={{ display: 'inline', fontSize: 'inherit' }} onClick={() => actions.viewTicket(issue.maintenance_ticket)}>
                        Ticket #{ticketNumber(issue.maintenance_ticket)}
                      </button>
                    ) : <>Ticket #{ticketNumber(issue.maintenance_ticket)}</>}
                    {' '}<TicketStatusBadge value={issue.maintenance_ticket.status} />
                  </p>
                )}
              </div>
            </div>
          </section>

          <section className="veh-card issue-view-desc">
            <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>Description</h4></div>
            <div className="issue-view-text">
              <p>{issue.issue_description || '-'}</p>
            </div>
          </section>

          {issue.vehicle && (
            <section className="veh-card issue-view-map">
              <div className="veh-card-head"><Icon name="pin" size={16} /><h4>Vehicle Location — {issue.vehicle.current_location ?? 'Unknown'}</h4></div>
              <div className="issue-view-map-wrap">
                <VehicleLocationMap lat={hub?.lat} lng={hub?.lng} label={issue.vehicle.current_location} />
              </div>
            </section>
          )}
        </div>

        <div className="issue-view-side">
          <IssueFilesCard issue={issue} />

          <section className="veh-card">
            <div className="veh-card-head"><Icon name="calendar" size={16} /><h4>Report Timeline</h4></div>
            <div className="issue-view-timeline">
              <div className="issue-view-timeline-row">
                <span className="issue-view-timeline-dot" />
                <div>
                  <p className="issue-view-timeline-label">Reported</p>
                  <QuietDate value={issue.created_at} />
                </div>
              </div>
              {issue.updated_at && issue.updated_at !== issue.created_at && (
                <div className="issue-view-timeline-row">
                  <span className="issue-view-timeline-dot is-last" />
                  <div>
                    <p className="issue-view-timeline-label">Last Updated</p>
                    <QuietDate value={issue.updated_at} />
                  </div>
                </div>
              )}
            </div>
          </section>

        </div>
      </div>
    </ModulePanel>
  );
}

function ProfileMenu({ user, open, setOpen, onLogout, onOpenSettings }) {
  const initials = user.name
    ? user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()
    : 'U';
  // Show the uploaded profile photo when there is one; fall back to initials.
  const avatarInner = user.photo_url
    ? <img className="profile-menu-avatar-img" src={resolvePhotoUrl(user.photo_url)} alt={user.name} />
    : initials;

  return (
    <>
      <button className="profile-menu-trigger" type="button" onClick={() => setOpen((v) => !v)} aria-label="Account menu">
        <span className="profile-menu-avatar">{avatarInner}</span>
      </button>

      {open && (
        <div className="profile-menu-dropdown">
          <div className="profile-menu-user">
            <span className="profile-menu-avatar">{avatarInner}</span>
            <div className="profile-menu-user-info">
              <span className="profile-menu-name">{user.name}</span>
              <span className="profile-menu-role">{user.role}</span>
            </div>
          </div>

          <div className="profile-menu-divider" />

          <button className="profile-menu-item" type="button" onClick={() => { onOpenSettings(); setOpen(false); }}>
            <Icon name="key" size={15} /> My Settings
          </button>

          <EndImpersonationAction />

          <div className="profile-menu-divider" />

          <button className="profile-menu-item profile-menu-item-danger" type="button" onClick={onLogout}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 15, height: 15 }}>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
              <polyline points="16 17 21 12 16 7"></polyline>
              <line x1="21" y1="12" x2="9" y2="12"></line>
            </svg>
            Logout
          </button>
        </div>
      )}
    </>
  );
}

function profileFields() {
  return [
    { label: 'Full Name', name: 'name', required: true, type: 'text' },
    { label: 'Email', name: 'email', required: true, type: 'text', placeholder: 'name@barangay.gov' },
    { label: 'Phone', name: 'phone', type: 'tel', maxLength: 11, pattern: '09[0-9]{9}', placeholder: '09XXXXXXXXX', title: 'Phone must be 11 digits starting with 09' },
    { label: 'Address', name: 'address', type: 'text' },
  ];
}

/** Self-service profile page (all roles) — editable details (same fields/layout
 * an Admin uses on Update User) plus a separate password-change section, since
 * that one stays gated behind old-password verification. */
function ProfilePage({ user, onBack, setNotice, refreshUser, onDirty }) {
  const photoInputRef = useRef(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const initials = user.name ? user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() : 'U';
  const roles = (Array.isArray(user.roles) && user.roles.length) ? user.roles : [user.role].filter(Boolean);

  const updatePhoto = async (event) => {
    const photo = event.target.files?.[0];
    event.target.value = '';
    if (!photo || uploadingPhoto) return;
    if (!photo.type.startsWith('image/')) {
      setNotice({ type: 'error', text: 'Choose an image for your profile photo.' });
      return;
    }
    if (photo.size > 4 * 1024 * 1024) {
      setNotice({ type: 'error', text: 'Profile photos must be 4 MB or smaller.' });
      return;
    }
    setUploadingPhoto(true);
    setNotice(null);
    try {
      await sendPayload('put', '/profile', { photo });
      await refreshUser();
      setNotice({ type: 'success', text: 'Profile photo updated.' });
    } catch (error) {
      showError(error, setNotice);
    } finally {
      setUploadingPhoto(false);
    }
  };

  const updateDetails = async (payload) => {
    setNotice(null);
    try {
      await sendPayload('put', '/profile', payload);
      await refreshUser();
      setNotice({ type: 'success', text: 'Profile updated.' });
    } catch (error) {
      showError(error, setNotice);
    }
  };

  const updatePassword = async (payload) => {
    setNotice(null);
    try {
      await api.put('/profile/password', cleanPayload(payload));
      setNotice({ type: 'success', text: 'Password updated.' });
    } catch (error) {
      showError(error, setNotice);
    }
  };

  return (
    <ModulePanel description="Your account details and password.">
      <div className="profile-page">
        <div className="profile-hero">
          <div className="profile-avatar-control" aria-busy={uploadingPhoto}>
            <div className="profile-hero-avatar">
              {user.photo_url
                ? <img src={resolvePhotoUrl(user.photo_url)} alt={user.name} />
                : <span>{initials}</span>}
            </div>
            <input ref={photoInputRef} type="file" accept="image/*" hidden onChange={updatePhoto} disabled={uploadingPhoto} aria-label="Choose profile photo" />
            <button
              className="profile-photo-button"
              type="button"
              aria-label={uploadingPhoto ? 'Uploading profile photo' : 'Change profile photo'}
              title={uploadingPhoto ? 'Uploading profile photo...' : 'Change profile photo'}
              disabled={uploadingPhoto}
              onClick={() => photoInputRef.current?.click()}
            >
              <Icon name="camera" size={17} />
            </button>
            {uploadingPhoto && <span className="profile-photo-progress" role="status">Uploading...</span>}
          </div>
          <div className="profile-hero-info">
            <h2>{user.name}</h2>
            <p className="muted">{user.email}</p>
            <div className="profile-hero-roles">{roles.map((r) => <StatusBadge key={r} value={r} />)}</div>
          </div>
        </div>

        <section className="profile-section" aria-label="Edit profile details">
          <h4 className="profile-section-title"><Icon name="edit" size={15} /> Edit Details</h4>
          <p className="muted profile-section-hint">Keep your contact information up to date.</p>
          <div className="form-grid-2col user-form-grid">
            <SmartForm
              fields={profileFields()}
              initialValues={{ name: user.name, email: user.email, phone: user.phone, address: user.address }}
              key="profile-details"
              onCancel={onBack}
              onSubmit={updateDetails}
              onValuesChange={() => onDirty?.()}
              submitLabel="Save Changes"
              title=""
            />
          </div>
        </section>

        <section className="profile-section" aria-label="Change password">
          <h4 className="profile-section-title"><Icon name="key" size={15} /> Change Password</h4>
          <p className="muted profile-section-hint">Use a strong password you don't reuse on other sites.</p>
          <div className="profile-form">
            <SmartForm
              fields={passwordFields}
              key="profile-password"
              onCancel={onBack}
              onSubmit={updatePassword}
              onValuesChange={() => onDirty?.()}
              submitLabel="Update Password"
              title=""
            />
          </div>
        </section>
      </div>
    </ModulePanel>
  );
}

const EMPTY_OBJ = {};

// Keeps an in-progress form's values alive across a route change and back
// (e.g. clicking a vehicle/custodian's name to view their profile, then
// hitting Back) — plain useState resets to its initial value on that round
// trip because the page component fully unmounts and remounts. sessionStorage
// survives that; it only clears itself on an explicit submit/cancel (see
// clearDraftState) or when the tab closes, so an abandoned draft doesn't
// resurrect the next time the same "new X" page is opened fresh.
function useDraftState(key, initialValue) {
  const [state, setState] = useState(() => {
    const fallback = typeof initialValue === 'function' ? initialValue() : initialValue;
    if (!key) return fallback;
    try {
      const saved = sessionStorage.getItem(key);
      return saved != null ? JSON.parse(saved) : fallback;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    if (!key) return;
    try { sessionStorage.setItem(key, JSON.stringify(state)); } catch { /* storage full/unavailable */ }
  }, [key, state]);

  return [state, setState];
}

function clearDraftState(key) {
  if (!key) return;
  try { sessionStorage.removeItem(key); } catch { /* ignore */ }
}

function splitQuantityValue(value, units) {
  const str = String(value ?? '').trim();
  if (!str) return { amount: '', unit: units[0] };
  const lastSpace = str.lastIndexOf(' ');
  if (lastSpace === -1) {
    // No "<amount> <unit>" shape found. If the whole string is actually
    // just a unit name (e.g. the user picked a unit before typing an
    // amount, so the field's value is only that unit), treat it as
    // "no amount yet" with that unit preserved — don't misread the unit
    // name itself as the amount and silently reset the dropdown.
    if (units.includes(str)) return { amount: '', unit: str };
    return { amount: str, unit: units[0] };
  }
  const amount = str.slice(0, lastSpace).trim();
  const unitCandidate = str.slice(lastSpace + 1).trim();
  return units.includes(unitCandidate) ? { amount, unit: unitCandidate } : { amount: str, unit: units[0] };
}

// A quantity field's amount only counts as filled in when it's a genuine
// number — a bare unit string (e.g. "Gallons" picked before any amount was
// typed) must not pass as a valid amount.
function isQuantityAmountFilled(amount) {
  return amount !== '' && amount != null && !Number.isNaN(Number(amount));
}

// Generic required-check: treat only "no value" (empty string/null/undefined)
// as missing, so a legitimate falsy value like the number 0 (e.g. latitude
// 0, longitude 0) still counts as filled in.
function isValueMissing(value) {
  return value === '' || value === null || value === undefined;
}

const SELECT_OR_OTHER_SENTINEL = '__other__';

// A dropdown of presets plus an "Other" option that reveals a free-text box —
// e.g. Service Location: pick a known hub, or specify an outside repair shop.
// Tracks "other mode" locally (not in the form's values), seeded from whether
// the incoming value already fails to match any preset.
// Same look/interaction as CreatableSelect's combobox — a single bordered
// input opening a dropdown with a pinned "+ Add …" row — but for a small
// fixed set of numeric presets (e.g. recurrence intervals). The custom value
// is entered in a small popup form, like CreatableSelect's add-new modal;
// nothing is persisted to a catalog, it's just a value on this one record.
function SelectOrAddNumberField({ field, value, onChange }) {
  const options = field.options ?? [];
  const matchesPreset = options.some((o) => String(o?.value ?? o) === String(value ?? ''));
  const isCustomActive = Boolean(value) && !matchesPreset;
  const [open, setOpen] = useState(false);
  // Non-null while the custom-value popup is open.
  const [customDraft, setCustomDraft] = useState(null);
  const [customError, setCustomError] = useState(null);
  const containerRef = useRef(null);
  const suffix = field.otherSuffix ?? '';
  const addLabel = field.otherLabel ?? 'Add Custom Value';

  useEffect(() => {
    if (!open) return undefined;
    const handleOutsideClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  const customText = (v) => `Every ${v}${suffix ? ` ${suffix}` : ''}`;
  const selectedLabel = matchesPreset
    ? (options.find((o) => String(o?.value ?? o) === String(value ?? ''))?.label ?? '')
    : (isCustomActive ? customText(value) : '');

  const pick = (option) => {
    onChange(String(option?.value ?? option ?? ''));
    setOpen(false);
  };
  const openCustom = () => {
    setCustomDraft(isCustomActive ? String(value) : '');
    setCustomError(null);
    setOpen(false);
  };
  const closeCustom = () => { setCustomDraft(null); setCustomError(null); };
  const saveCustom = (e) => {
    e.preventDefault();
    // The popup is portaled, but React still bubbles its submit to the
    // page's own form — stop it there.
    e.stopPropagation();
    const n = Number(customDraft);
    const min = field.otherMin ?? 1;
    const max = field.otherMax ?? Infinity;
    if (!customDraft || !Number.isInteger(n) || n < min || n > max) {
      setCustomError(`Enter a whole number from ${min} to ${max}.`);
      return;
    }
    onChange(String(n));
    closeCustom();
  };

  return (
    <div className="creatable-select" ref={containerRef}>
      <input
        type="text"
        readOnly
        value={selectedLabel}
        placeholder={field.placeholder ?? 'Select'}
        required={field.required}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
      />
      {open && (
        <div className="creatable-select-panel">
          <button type="button" className="creatable-select-option creatable-select-add creatable-select-add-pinned" onClick={openCustom}>
            <Icon name="plus" size={13} /> {addLabel}
          </button>
          <div className="creatable-select-option-list">
            {options.map((option, i) => (
              <div key={option?.value != null ? option.value : `opt-${i}`} className="creatable-select-option-row">
                <button type="button" className="creatable-select-option" onClick={() => pick(option)}>
                  {option?.label ?? option}
                </button>
              </div>
            ))}
            {isCustomActive && (
              <div className="creatable-select-option-row">
                <button type="button" className="creatable-select-option" onClick={() => setOpen(false)}>
                  {customText(value)} (custom)
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      <FormModal open={customDraft !== null} title={addLabel} onClose={closeCustom}>
        <form className="smart-form" onSubmit={saveCustom} noValidate>
          <label>
            <span>{field.otherInputLabel ?? `Number of ${suffix || 'units'}`} <span className="required-asterisk">*</span></span>
            <input
              type="number"
              autoFocus
              min={field.otherMin}
              max={field.otherMax}
              step="1"
              placeholder={field.otherPlaceholder ?? ''}
              value={customDraft ?? ''}
              onChange={(e) => { setCustomDraft(e.target.value); setCustomError(null); }}
            />
          </label>
          {customError && <p className="form-field-error" role="alert" style={{ color: '#b91c1c', margin: 0, fontSize: '0.82rem' }}>{customError}</p>}
          <div className="form-actions">
            <button className="ghost-button" type="button" onClick={closeCustom}>Cancel</button>
            <button className="primary-button" type="submit">Save</button>
          </div>
        </form>
      </FormModal>
    </div>
  );
}
function SelectOrOtherField({ field, value, onChange }) {
  const options = field.options ?? [];
  const matchesPreset = options.some((o) => String(o?.value ?? o) === String(value ?? ''));
  const [otherMode, setOtherMode] = useState(Boolean(value) && !matchesPreset);

  if (field.otherType === 'number') {
    return <SelectOrAddNumberField field={field} value={value} onChange={onChange} />;
  }

  return (
    <>
      <SearchableSelect
        required={field.required}
        value={otherMode ? SELECT_OR_OTHER_SENTINEL : (value ?? '')}
        onChange={(e) => {
          if (e.target.value === SELECT_OR_OTHER_SENTINEL) {
            setOtherMode(true);
            onChange('');
          } else {
            setOtherMode(false);
            onChange(e.target.value);
          }
        }}
      >
        <option value="">{' '}</option>
        {options.map((option, i) => (
          <option key={option?.value != null ? option.value : `opt-${i}`} value={option?.value ?? option ?? ''}>
            {option?.label ?? option}
          </option>
        ))}
        <option value={SELECT_OR_OTHER_SENTINEL}>{field.otherLabel ?? 'Other (specify)'}</option>
      </SearchableSelect>
      {otherMode && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <input
            type={field.otherType ?? 'text'}
            min={field.otherMin}
            max={field.otherMax}
            placeholder={field.otherPlaceholder ?? 'Specify'}
            required={field.required}
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
            style={{ flex: 1 }}
          />
          {field.otherSuffix && <span className="muted" style={{ fontSize: '0.85rem', whiteSpace: 'nowrap' }}>{field.otherSuffix}</span>}
        </div>
      )}
    </>
  );
}

// User-managed catalogs also support a note when Other is selected.
const CATALOG_OTHER_VALUE = 'Other';

function CatalogOrOtherField({ value, onChange, note, onNoteChange, options = [], required = false, placeholder = 'Select an option', otherNoteLabel = 'Describe the issue/type', catalogEndpoint = '/maintenance-types', newItemLabel = 'repair type' }) {
  const isOther = value === CATALOG_OTHER_VALUE;
  return (
    <>
      <CreatableSelect required={required} value={value ?? ''} onChange={onChange}
        options={options} placeholder={placeholder} catalogEndpoint={catalogEndpoint} newItemLabel={newItemLabel} />
      {isOther && (
        <input
          type="text"
          placeholder={otherNoteLabel}
          value={note ?? ''}
          onChange={(e) => onNoteChange(e.target.value)}
          style={{ marginTop: 8 }}
        />
      )}
    </>
  );
}

// Every required/pattern/confirm-match check SmartForm used to hand off to
// the browser's own constraint validation (native tooltip, positioned and
// styled by the browser, not this app). Re-implemented here so every form
// reports through the same in-app, styled validation card the server-side
// (422) errors already use — one consistent message UI instead of two.
function collectFieldErrors(fields, values) {
  const errs = {};
  fields.forEach((field) => {
    const value = values[field.name];

    if (field.type === 'checkboxes') {
      if (field.required && !(Array.isArray(value) && value.length > 0)) {
        errs[field.name] = (`${field.label}: select at least one.`);
      }
      return;
    }

    if (field.type === 'list') {
      const rows = Array.isArray(value) ? value : [];
      if (field.required && !rows.some((row) => row.trim())) {
        errs[field.name] = (`${field.label} is required.`);
      }
      return;
    }

    if (field.type === 'quantity') {
      // Require the amount portion specifically — a combined value like
      // "Gallons" (unit picked, no amount typed) must not pass just because
      // the raw string is non-empty.
      if (field.required) {
        const { amount } = splitQuantityValue(value, field.units);
        if (!isQuantityAmountFilled(amount)) {
          errs[field.name] = (`${field.label} is required.`);
        }
      }
      return;
    }

    if (field.confirmOf) {
      if (field.required && isValueMissing(value)) {
        errs[field.name] = (`${field.label} is required.`);
      } else if (value && value !== values[field.confirmOf]) {
        errs[field.name] = (`${field.label} does not match.`);
      }
      return;
    }

    if (field.required && isValueMissing(value)) {
      errs[field.name] = (`${field.label} is required.`);
      return;
    }

    if (field.type === 'number' && value !== '' && value != null) {
      const num = Number(value);
      if (field.min != null && num < Number(field.min)) {
        errs[field.name] = (`${field.label} must be at least ${field.min}.`);
      }
      if (field.max != null && num > Number(field.max)) {
        errs[field.name] = (`${field.label} must be at most ${field.max}.`);
      }
    }

    if (field.pattern && value && !new RegExp(`^(?:${field.pattern})$`).test(value)) {
      errs[field.name] = (field.title || `${field.label} is invalid.`);
    }
  });
  return errs;
}

// Opt-in field grouping: fields carrying a `group` label render inside their
// own titled sub-card (Maintenance Records today) instead of one flat list —
// so the section header says what those fields are about at a glance,
// mirroring the realcore reference's "Select Fee Type" / "Other" cards.
// Fields with no `group` fall into a single nameless bucket, which the
// caller renders unwrapped — so forms that never set `group` are unaffected.
function groupFields(fields) {
  const groups = [];
  fields.forEach((field) => {
    const key = field.group ?? null;
    let bucket = groups.find((g) => g.name === key);
    if (!bucket) {
      bucket = { name: key, fields: [] };
      groups.push(bucket);
    }
    bucket.fields.push(field);
  });
  return groups;
}

function SmartForm({ initialValues = EMPTY_OBJ, ...props }) {
  // Reset only when the actual record/defaults change. Conditional fields
  // and unrelated parent renders must preserve typed values and File objects.
  return <SmartFormFields key={JSON.stringify(initialValues)} initialValues={initialValues} {...props} />;
}

function SmartFormFields({ fields, initialValues, onCancel, cancelLabel = 'Cancel', onSubmit, submitLabel, title, onValuesChange }) {
  const [values, setValues] = useState(() => valuesFromFields(fields, initialValues));
  const [submitting, setSubmitting] = useState(false);
  // Per-field show/hide toggle for password inputs — keyed by field name so
  // e.g. Old/New/Confirm Password on the same form toggle independently.
  const [visiblePasswords, setVisiblePasswords] = useState({});
  const [fieldErrors, setFieldErrors] = useState({});
  const [validationLines, setValidationLines] = useState(null);
  useEffect(() => {
    if (!validationLines) return;
    const timer = setTimeout(() => setValidationLines(null), 8000);
    return () => clearTimeout(timer);
  }, [validationLines]);
  const formRef = useRef(null);

  const handleChange = (event) => {
    const { name, type, files, value } = event.target;
    const field = fields.find((f) => f.name === name);
    let nextValue = field?.uppercase ? value.toUpperCase() : value;
    if (field?.type === 'tel' && name === 'phone') {
      nextValue = value.replace(/[^0-9]/g, '').slice(0, 11);
    }
    // 'multi-file' fields render their own dropzone/input with a dedicated
    // onChange (see the field renderer below) — this generic handler only
    // ever sees single-file and non-file fields.
    const finalValue = type === 'file' ? files[0] : nextValue;
    const next = { ...values, [name]: finalValue, ...(name === 'vehicle_domain' ? { category_id: '' } : {}) };
    setValues(next);
    if (fieldErrors[name]) setFieldErrors((current) => {
      const nextErrors = { ...current };
      delete nextErrors[name];
      return nextErrors;
    });
    onValuesChange?.(next);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    const errs = collectFieldErrors(fields, values);
    if (Object.keys(errs).length) {
      setFieldErrors(errs);
      // Bring the first problem into view.
      requestAnimationFrame(() => formRef.current?.querySelector('.has-error input, .has-error select, .has-error textarea')?.focus());
      return;
    }
    setFieldErrors({});

    setSubmitting(true);
    try {
      // 'list' fields edit as an array of rows; flatten back to the
      // newline-joined string the backend column actually stores.
      // 'confirmOf' fields are sent through as-is (not stripped) — some
      // backends (e.g. the self-service password change) rely on Laravel's
      // `confirmed` rule convention, which expects the `{field}_confirmation`
      // value to actually be present in the request; others just ignore it.
      const payload = { ...values };
      fields.forEach((field) => {
        if (field.type === 'list') {
          payload[field.name] = (Array.isArray(payload[field.name]) ? payload[field.name] : [])
            .map((row) => row.trim())
            .filter(Boolean)
            .join('\n');
        }
      });
      // Fold an optional Other note into the existing description field.
      fields.forEach((field) => {
        if (field.type !== 'catalog-or-other') return;
        const noteKey = `${field.name}__other_note`;
        const note = String(payload[noteKey] ?? '').trim();
        delete payload[noteKey];
        if (payload[field.name] === CATALOG_OTHER_VALUE && note && field.otherNoteField) {
          const prefixed = `Other (specified type): ${note}`;
          const existing = String(payload[field.otherNoteField] ?? '').trim();
          payload[field.otherNoteField] = existing ? `${existing}\n${prefixed}` : prefixed;
        }
      });
      await onSubmit(payload);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form ref={formRef} className="smart-form" onSubmit={handleSubmit} noValidate autoComplete="off">
      {validationLines && (
        <div className="form-feedback" onClick={() => setValidationLines(null)}>
          <div className="qa-inline-error" role="alert" onClick={(e) => e.stopPropagation()}>
            <Icon name="alert" size={17} className="toast-notice-icon" />
            <div className="toast-notice-lines">
              {validationLines.map((line, i) => <span key={i}>{line}</span>)}
            </div>
            <button type="button" className="toast-notice-close" onClick={() => setValidationLines(null)} aria-label="Dismiss">
              <Icon name="close" size={13} />
            </button>
          </div>
        </div>
      )}
      {submitting && <LoadingOverlay />}
      <h3>{title}</h3>
      {(() => {
        const renderField = (field) => {
        const quantity = field.type === 'quantity' ? splitQuantityValue(values[field.name], field.units) : null;
        // Drives the floating-label float-up: a value counts even for an
        // array (checkboxes/list), so those fields' captions float too
        // once at least one row/option is filled in.
        const rawFieldValue = values[field.name];
        const fieldHasValue = Array.isArray(rawFieldValue)
          ? rawFieldValue.some((v) => String(v ?? '').trim() !== '')
          : rawFieldValue !== undefined && rawFieldValue !== null && String(rawFieldValue).trim() !== '';
        const FieldWrapper = ['file', 'multi-file'].includes(field.type) ? 'div' : 'label';
        return (
        <Fragment key={field.name}>
        <FieldWrapper
          className={[['file', 'multi-file'].includes(field.type) ? 'cabinet-field' : null, field.compactFile ? 'file-inline' : null, fieldHasValue ? 'has-value' : null, fieldErrors[field.name] ? 'has-error' : null].filter(Boolean).join(' ') || undefined}
          style={field.fullWidth ? { gridColumn: '1 / -1' } : undefined}
        >
          <span style={field.action ? { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } : undefined}>
            <span>{field.label}{field.required ? <span className="required-asterisk"> *</span> : null}</span>
            {field.action && (
              <button
                type="button"
                className="link-button"
                onClick={field.action.onClick}
                style={{ background: 'none', border: 'none', padding: 0, color: 'var(--primary)', cursor: 'pointer', textDecoration: 'underline', fontWeight: 600, fontSize: '0.78rem', whiteSpace: 'nowrap' }}
              >
                {field.action.label}
              </button>
            )}
          </span>
          {field.type === 'quantity' ? (
            <div className="quantity-field">
              <input
                min="0.000001"
                onChange={(e) => { const next = { ...values, [field.name]: `${e.target.value} ${quantity.unit}`.trim() }; setValues(next); onValuesChange?.(next); }}
                placeholder={field.placeholder}
                required={field.required}
                step="any"
                type="number"
                value={quantity.amount}
              />
              <SearchableSelect
                onChange={(e) => { const next = { ...values, [field.name]: `${quantity.amount} ${e.target.value}`.trim() }; setValues(next); onValuesChange?.(next); }}
                value={quantity.unit}
              >
                {field.units.map((u) => <option key={u} value={u}>{u}</option>)}
              </SearchableSelect>
            </div>
          ) : null}
          {field.type === 'textarea' ? (
            <textarea
              name={field.name}
              onChange={handleChange}
              placeholder={field.placeholder ?? field.label}
              required={field.required}
              rows={field.rows ?? 3}
              value={values[field.name] ?? ''}
            />
          ) : null}
          {field.type === 'select' ? (
            <SearchableSelect
              name={field.name}
              onChange={handleChange}
              required={field.required}
              value={values[field.name] ?? ''}
            >
              {/* Blank rather than "Select" — at rest the floating label
                  sits centered over the field like a placeholder, so a
                  visible option here would double up with it. */}
              <option value="">{' '}</option>
              {field.options.map((option, i) => (
                <option
                  key={option?.value != null ? option.value : `opt-${i}`}
                  value={option?.value ?? option ?? ''}
                  disabled={option?.disabled}
                  style={option?.value === NEW_ISSUE_OPTION.value ? { color: '#2563eb', fontWeight: 700 } : undefined}
                >
                  {option?.label ?? option}
                </option>
              ))}
            </SearchableSelect>
          ) : null}
          {field.type === 'select-or-other' ? (
            <SelectOrOtherField
              field={field}
              value={values[field.name]}
              onChange={(v) => {
                const next = { ...values, [field.name]: v };
                setValues(next);
                onValuesChange?.(next);
              }}
            />
          ) : null}
          {field.type === 'creatable-select' ? (
            <CreatableSelect
              optionDomain={field.optionDomain}
              value={values[field.name] ?? ''}
              onChange={(v) => {
                const next = { ...values, [field.name]: v };
                setValues(next);
                onValuesChange?.(next);
              }}
              options={field.options ?? []}
              required={field.required}
              newItemLabel={field.newItemLabel}
              catalogEndpoint={field.catalogEndpoint}
              idField={field.idField}
              nameField={field.nameField}
              valueIsId={field.valueIsId}
              extraFields={field.extraFields}
            />
          ) : null}
          {field.type === 'catalog-or-other' ? (
            <CatalogOrOtherField
              catalogEndpoint="/fault-categories"
              newItemLabel="issue type"
              value={values[field.name] ?? ''}
              onChange={(v) => {
                const next = { ...values, [field.name]: v };
                setValues(next);
                onValuesChange?.(next);
              }}
              note={values[`${field.name}__other_note`] ?? ''}
              onNoteChange={(v) => {
                const next = { ...values, [`${field.name}__other_note`]: v };
                setValues(next);
                onValuesChange?.(next);
              }}
              options={field.options ?? []}
              required={field.required}
              placeholder={field.placeholder}
              otherNoteLabel={field.otherNoteLabel}
            />
          ) : null}
          {field.type === 'new-issue-modal' ? (
            <NewIssueModalField
              value={{ new_issue_type: values.new_issue_type }}
              onChange={(patch) => {
                const next = { ...values, ...patch };
                setValues(next);
                onValuesChange?.(next);
              }}
              issueTypeOptions={field.issueTypeOptions ?? []}
            />
          ) : null}
          {field.type === 'checkboxes' ? (
            <div className="checkbox-group" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(() => {
                const groupHasSelection = Array.isArray(values[field.name]) && values[field.name].length > 0;
                // A native checkbox's `required` only ever means "this exact
                // box must be checked" — there's no built-in "at least one of
                // these" semantic. Marking every box required only while the
                // group is empty gets that behavior for free: checking any
                // one of them clears `required` from the whole group on the
                // very next render, so the browser's own validation bubble
                // (same one every other required field already uses) fires
                // correctly instead of a confusing raw backend error surfacing
                // after a round-trip.
                return field.options.map((option) => {
                  const val = option?.value ?? option;
                  const label = option?.label ?? option;
                  const selected = Array.isArray(values[field.name]) && values[field.name].includes(val);
                  return (
                    <label key={val} style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400, cursor: 'pointer', margin: 0 }}>
                      <input
                        type="checkbox"
                        checked={selected}
                        required={field.required && !groupHasSelection}
                        title={field.required ? 'Select at least one.' : undefined}
                        onChange={() => setValues((current) => {
                          const list = Array.isArray(current[field.name]) ? current[field.name] : [];
                          const next = selected ? list.filter((r) => r !== val) : [...list, val];
                          const merged = { ...current, [field.name]: next };
                          onValuesChange?.(merged);
                          return merged;
                        })}
                        style={{ width: 'auto' }}
                      />
                      <span style={{ margin: 0 }}>{label}</span>
                    </label>
                  );
                });
              })()}
            </div>
          ) : null}
          {field.type === 'list' ? (
            <div className="list-field">
              {(Array.isArray(values[field.name]) ? values[field.name] : ['']).map((row, index) => {
                const rows = Array.isArray(values[field.name]) ? values[field.name] : [''];
                return (
                  <div key={index} style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
                    <span className="muted" style={{ flex: '0 0 20px', textAlign: 'right' }}>{index + 1}.</span>
                    <input
                      type="text"
                      placeholder={field.placeholder}
                      value={row}
                      required={field.required && index === 0}
                      onChange={(e) => setValues((current) => {
                        const list = [...(Array.isArray(current[field.name]) ? current[field.name] : [''])];
                        list[index] = e.target.value;
                        const merged = { ...current, [field.name]: list };
                        onValuesChange?.(merged);
                        return merged;
                      })}
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      className="btn-delete-action icon-btn"
                      onClick={() => setValues((current) => {
                        const list = (Array.isArray(current[field.name]) ? current[field.name] : ['']).filter((_, i) => i !== index);
                        const merged = { ...current, [field.name]: list.length ? list : [''] };
                        onValuesChange?.(merged);
                        return merged;
                      })}
                      disabled={rows.length === 1}
                      title={`Remove ${field.removeLabel ?? 'issue'}`}
                      aria-label={`Remove ${field.removeLabel ?? 'issue'}`}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                className="primary-button"
                onClick={() => setValues((current) => {
                  const merged = { ...current, [field.name]: [...(Array.isArray(current[field.name]) ? current[field.name] : ['']), ''] };
                  onValuesChange?.(merged);
                  return merged;
                })}
              >
                <Icon name="plus" size={14} /> {field.addLabel ?? 'Add another issue'}
              </button>
            </div>
          ) : null}
          {field.type === 'password' ? (
            <div className="password-field">
              <input
                autoComplete="new-password"
                name={field.name}
                onChange={handleChange}
                placeholder={field.placeholder ?? field.label}
                required={field.required}
                title={field.title}
                type={visiblePasswords[field.name] ? 'text' : 'password'}
                value={values[field.name] ?? ''}
              />
              <button
                type="button"
                className="password-field-toggle"
                onClick={() => setVisiblePasswords((current) => ({ ...current, [field.name]: !current[field.name] }))}
                title={visiblePasswords[field.name] ? 'Hide password' : 'Show password'}
                aria-label={visiblePasswords[field.name] ? 'Hide password' : 'Show password'}
              >
                <Icon name={visiblePasswords[field.name] ? 'eyeOff' : 'eye'} size={16} />
              </button>
            </div>
          ) : null}
          {!['textarea', 'select', 'quantity', 'checkboxes', 'select-or-other', 'creatable-select', 'catalog-or-other', 'list', 'password', 'file', 'multi-file'].includes(field.type) ? (
            <input
              accept={field.accept}
              autoComplete="off"
              maxLength={field.maxLength} min={field.min} max={field.max}
              name={field.name}
              onChange={handleChange}
              pattern={field.pattern}
              placeholder={field.placeholder ?? field.label}
              required={field.required}
              title={field.title}
              type={field.type}
              value={values[field.name] ?? ''}
            />
          ) : null}
          {['file', 'multi-file'].includes(field.type) ? (
            <FileCabinet
              name={field.name}
              accept={field.accept}
              required={field.required}
              multiple={field.type === 'multi-file'}
              files={field.type === 'multi-file' ? (Array.isArray(values[field.name]) ? values[field.name] : []) : (isFile(values[field.name]) ? [values[field.name]] : [])}
              existingFiles={field.type === 'multi-file'
                ? (field.existingAttachments ?? []).map((att) => ({ id: att.attachment_id, name: att.original_name || 'File', url: resolvePhotoUrl(att.file_url), original: att }))
                : (!isFile(values[field.name]) && field.existingUrl ? [{ name: 'Saved ' + field.label.toLowerCase(), url: resolvePhotoUrl(field.existingUrl) }] : [])}
              onRemoveExisting={field.onRemoveExisting}
              onChange={(files) => {
                const next = { ...values, [field.name]: field.type === 'multi-file' ? files : (files[0] ?? null) };
                setValues(next);
                setFieldErrors((current) => ({ ...current, [field.name]: undefined }));
                onValuesChange?.(next);
              }}
            />
          ) : null}
          {field.inlineExtra ? (
            <div className="field-extra field-extra-inline">
              {typeof field.inlineExtra === 'function' ? field.inlineExtra(values) : field.inlineExtra}
            </div>
          ) : null}
          {fieldErrors[field.name] ? <small className="fx-error" role="alert">{fieldErrors[field.name]}</small> : null}
          {field.hint && !fieldErrors[field.name] ? <small className="field-hint">{field.hint}</small> : null}
        </FieldWrapper>
        {field.extra ? (
          <div className="field-extra" style={{ gridColumn: field.extraGridColumn ?? '1 / -1' }}>
            {typeof field.extra === 'function' ? field.extra(values) : field.extra}
          </div>
        ) : null}
        </Fragment>
        );
        };

        return fields.some((f) => f.group) ? (
          groupFields(fields).map((group) => (
            <section className="form-group" key={group.name ?? 'ungrouped'}>
              {group.name ? <h4 className="form-group-title">{group.name}</h4> : null}
              <div className="form-group-body">{group.fields.map(renderField)}</div>
            </section>
          ))
        ) : (
          fields.map(renderField)
        );
      })()}
      <div className="form-actions">
        {onCancel ? <button className="ghost-button" onClick={onCancel} type="button">{cancelLabel}</button> : null}
        <button className="primary-button" type="submit">{submitLabel}</button>
      </div>
    </form>
  );
}

// Its own page (not a modal/inline panel) reached at .../locations/new —
// typing a Complete Address geocodes it and drops/moves the map pin there;
// clicking the map instead reverse-geocodes the click back into the Address
// field. Either path has to land inside the active service-area boundary
// (the same polygon the fleet map draws) before Save is allowed — an
// out-of-bounds result shows why instead of silently creating a hub nobody
// can find on the map. Saving POSTs to /hubs, same endpoint and shape the
// map's own "Add Hub" flow uses.
// Shared by NewLocationPage ("Add Location", defines a brand-new hub) and
// EditLocationPage ("Update Location", reassigns a vehicle — to an existing
// hub OR, same as Add, a brand-new one typed/clicked in) — both need the
// exact same address<->map sync and boundary check; only the extra
// Address/Area + Remarks fields and the submit wiring differ by mode.
function LocationAddressMapForm({
  mode = 'add',
  initialName = '',
  initialAddress = '',
  initialMarker = null,
  initialAddressArea = '',
  initialRemarks = '',
  boundaryPolygons,
  boundaryLabel,
  boundaryVerified = true,
  onBack,
  onSubmit,
}) {
  const isEdit = mode === 'edit';
  const [name, setName] = useState(initialName);
  const [address, setAddress] = useState(initialAddress);
  const [marker, setMarker] = useState(initialMarker);
  const [addressArea, setAddressArea] = useState(initialAddressArea);
  const [remarks, setRemarks] = useState(initialRemarks);
  const [error, setError] = useState(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Distinguishes "the map just moved the pin, don't re-geocode the address
  // that produced it" from "the admin is typing" — without it, a map click
  // (which fills Address via reverse geocoding) would immediately trigger
  // the address-typing effect below and re-geocode right back, wasting a
  // lookup and risking a slightly different point than the one clicked.
  const addressFromMapRef = useRef(false);
  // Edit mode starts with `address` already non-empty (the hub's own
  // internal name/address, paired with a marker we already know is correct
  // from initialMarker) — without this, mounting immediately re-triggers
  // the geocode effect below on that pre-filled value, which usually isn't
  // a real searchable address string, showing a spurious "couldn't find
  // that address" error over a perfectly valid pin. Compared by VALUE
  // (not a one-shot consumed flag) so React StrictMode's dev-only double
  // effect invocation — same address, effect body run twice — still skips
  // both times instead of geocoding on the second pass.
  const skipGeocodeForAddressRef = useRef(initialAddress || null);

  // Debounced geocode-as-you-type — waits for a pause in typing so it's not
  // firing a lookup on every keystroke.
  useEffect(() => {
    if (addressFromMapRef.current) {
      addressFromMapRef.current = false;
      return undefined;
    }
    if (skipGeocodeForAddressRef.current !== null && address === skipGeocodeForAddressRef.current) {
      return undefined;
    }
    skipGeocodeForAddressRef.current = null;
    const trimmed = address.trim();
    if (!trimmed) return undefined;

    const timer = setTimeout(async () => {
      setLookingUp(true);
      setError(null);
      try {
        const match = await geocodeAddress(trimmed);
        if (!match) {
          setError(`Couldn't find that address yet — keep typing, or click the map instead.`);
          return;
        }
        setMarker({ lat: match.lat, lng: match.lng });
        if (!isLocationPointAllowed(match, boundaryPolygons, boundaryVerified)) {
          setError(`That address is outside the ${boundaryLabel} boundary — only locations within ${boundaryLabel} can be added.`);
        }
      } catch (err) {
        setError(err.message || 'Address lookup failed.');
      } finally {
        setLookingUp(false);
      }
    }, 700);

    return () => clearTimeout(timer);
  }, [address, boundaryPolygons, boundaryLabel, boundaryVerified]);

  const handleMapPick = useCallback(async (latLng) => {
    setMarker(latLng);
    setError(null);

    if (!isLocationPointAllowed(latLng, boundaryPolygons, boundaryVerified)) {
      setError(`That spot is outside the ${boundaryLabel} boundary — only locations within ${boundaryLabel} can be added.`);
      return;
    }

    setLookingUp(true);
    try {
      const displayName = await reverseGeocode(latLng.lat, latLng.lng);
      if (displayName) {
        addressFromMapRef.current = true;
        setAddress(displayName);
      }
    } catch {
      // Reverse geocoding is a convenience, not a requirement — a failed
      // lookup still leaves a valid, in-bounds pin; the admin can type the
      // address in by hand instead.
    } finally {
      setLookingUp(false);
    }
  }, [boundaryPolygons, boundaryLabel, boundaryVerified]);

  const isPinValid = marker && isLocationPointAllowed(marker, boundaryPolygons, boundaryVerified);
  const canSubmit = name.trim() && isPinValid && !lookingUp && !submitting;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        lat: marker.lat,
        lng: marker.lng,
        label: name.trim().substring(0, 2).toUpperCase(),
        addressArea: addressArea.trim(),
        remarks: remarks.trim(),
      });
    } catch (err) {
      setError(err.response?.data?.message || err.message || `Failed to ${isEdit ? 'update' : 'add'} location.`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModulePanel description={
      isEdit
        ? 'Type the complete address or click the map — either one fills in the other. Pick where this vehicle already is, or move it to a brand-new location the same way you would add one.'
        : 'Type the complete address or click the map — either one fills in the other.'
    }>
      <form className="add-location-page" onSubmit={handleSubmit} noValidate>
        <div className="add-location-fields smart-form">
          {error && (
            <div className="qa-inline-error" role="alert">
              <Icon name="alert" size={17} className="toast-notice-icon" />
              <div className="toast-notice-lines"><span>{error}</span></div>
            </div>
          )}
          <label className={name.trim() ? 'has-value' : undefined}>
            <span>Location Name <span className="required-asterisk">*</span></span>
            <input
              type="text"
              required
              placeholder="e.g. Paknaan Health Center"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {isEdit && <small className="field-hint">An existing name reuses that location; a new one creates it.</small>}
          </label>
          <label className={address.trim() ? 'has-value' : undefined}>
            <span>Complete Address <span className="required-asterisk">*</span></span>
            <input
              type="text"
              required
              placeholder="e.g. Purok 5, Paknaan, Mandaue City, Cebu"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
            <small className="field-hint">
              {lookingUp ? 'Looking up…' : boundaryVerified ? `Must be within the ${boundaryLabel} boundary — you can also click the map to pinpoint it.` : 'This outline is unverified. Confirm the address and pin; the reference outline does not restrict location entry.'}
            </small>
          </label>
          {isEdit && (
            <>
              <label className={addressArea.trim() ? 'has-value' : undefined}>
                <span>Address / Area</span>
                <input
                  type="text"
                  placeholder="e.g. Bay 3, near the north gate"
                  value={addressArea}
                  onChange={(e) => setAddressArea(e.target.value)}
                />
              </label>
              <label className={remarks.trim() ? 'has-value' : undefined}>
                <span>Remarks</span>
                <textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
              </label>
            </>
          )}
          <div className="form-actions">
            <button className="ghost-button" onClick={onBack} type="button" disabled={submitting}>Cancel</button>
            <button className="primary-button" type="submit" disabled={!canSubmit}>
              {submitting ? 'Saving…' : (isEdit ? 'Update Location' : 'Add Location')}
            </button>
          </div>
        </div>
        <div className="add-location-map-shell">
          {!boundaryVerified && <p className="notice info">Unverified reference outline. Check this location's address and pin before saving.{marker && !isPointWithinBoundaryPolygons(marker, boundaryPolygons) ? ' The pin is outside the imported outline.' : ''}</p>}
          <AddLocationMap marker={marker} boundaryPolygons={boundaryPolygons} boundaryLabel={boundaryLabel} boundaryVerified={boundaryVerified} onPick={handleMapPick} />
        </div>
      </form>
    </ModulePanel>
  );
}

function NewLocationPage({ onBack, boundaryPolygons, boundaryLabel, boundaryVerified, onSubmit }) {
  return (
    <LocationAddressMapForm
      mode="add"
      boundaryPolygons={boundaryPolygons}
      boundaryLabel={boundaryLabel} boundaryVerified={boundaryVerified}
      onBack={onBack}
      onSubmit={({ name, lat, lng, label }) => onSubmit({ name, lat, lng, label })}
    />
  );
}

// Its own page (.../locations/:vehicleId/edit), reached from the pencil icon
// on the Location Records table — reassigns a vehicle's current location.
// Reuses the exact same address/map picker Add Location uses (not just a
// dropdown of existing hubs) so moving a vehicle to a genuinely new spot
// doesn't require a separate trip to Add Location first; the parent's
// onSubmit decides whether the typed name matches an existing hub (reuse
// it) or not (create it), same as Add Location's own POST /hubs.
function EditLocationPage({ row, allHubs, boundaryPolygons, boundaryLabel, boundaryVerified, onBack, onSubmit }) {
  if (!row) {
    return (
      <ModulePanel description="Update a vehicle's current location.">
        <p className="empty-state">
          That vehicle's location record couldn't be found — it may have been removed.{' '}
          <button type="button" className="link-button" onClick={onBack}>Back to Location Records</button>
        </p>
      </ModulePanel>
    );
  }

  const currentHub = allHubs.find((h) => h.name === row.current_location);

  return (
    <LocationAddressMapForm
      mode="edit"
      initialName={row.current_location ?? ''}
      initialAddress={currentHub?.address ?? row.current_location ?? ''}
      initialMarker={currentHub ? { lat: currentHub.lat, lng: currentHub.lng } : null}
      initialAddressArea={row.address_area ?? ''}
      initialRemarks={row.remarks ?? ''}
      boundaryPolygons={boundaryPolygons}
      boundaryLabel={boundaryLabel} boundaryVerified={boundaryVerified}
      onBack={onBack}
      onSubmit={onSubmit}
    />
  );
}

function PartsTags({ value }) {
  if (!value) return <span style={{ color: '#94a3b8' }}>-</span>;
  const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return <span style={{ color: '#94a3b8' }}>-</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', maxWidth: '240px' }}>
      {parts.map((part, idx) => (
        <span key={idx} className="part-tag" title={part}>{part}</span>
      ))}
    </div>
  );
}

// Column headers are drag-reorderable in-place whenever `onReorderColumn`
// is passed AND the columns carry a stable `key` (only some tables' column
// functions set one so far, e.g. vehicleColumns — the rest render exactly
// as before, since a column with no `key` just never becomes draggable).
// Mirrors the same reorder semantics ColumnChooserButton's popover list
// uses, so dragging a header does the same thing as dragging its row there
// — just without opening the popover first.
function DataTable({ columns, rows, compact = false, onRowClick, onReorderColumn, emptyMessage = 'No records found.', renderSubRow }) {
  // Which side of which header the dragged column would land on — drawn as
  // a thin vertical line right on that edge (matching the realcore
  // reference), so there's no guessing where a drop will actually land.
  // Declared before the early return below so the hook itself is always
  // called regardless of whether `rows` is empty on a given render.
  const [dropIndicator, setDropIndicator] = useState(null);

  if (!rows?.length) {
    return <p className="empty-state">{emptyMessage}</p>;
  }

  const hasWidths = columns.some((column) => column.width);
  const sideOf = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientX - rect.left < rect.width / 2 ? 'before' : 'after';
  };

  return (
    <div className={`table-shell${compact ? ' is-compact' : ''}${hasWidths ? ' is-fixed' : ''}`}>
      <table>
        {hasWidths && (
          <colgroup>
            {columns.map((column) => (
              <col key={column.label} style={column.width ? { width: column.width } : undefined} />
            ))}
          </colgroup>
        )}
        <thead>
          <tr>
            {columns.map((column) => {
              const draggable = Boolean(onReorderColumn && column.key && !column.locked);
              const isDropTarget = draggable && dropIndicator?.key === column.key;
              return (
                <th
                  key={column.label}
                  className={[
                    column.className,
                    draggable ? 'is-draggable-column' : null,
                    isDropTarget ? `is-drop-${dropIndicator.side}` : null,
                  ].filter(Boolean).join(' ') || undefined}
                  draggable={draggable}
                  title={draggable ? `Drag to move "${column.label}"` : undefined}
                  onDragStart={draggable ? (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', column.key); } : undefined}
                  onDragOver={draggable ? (e) => {
                    e.preventDefault();
                    const side = sideOf(e);
                    setDropIndicator((prev) => (prev?.key === column.key && prev.side === side ? prev : { key: column.key, side }));
                  } : undefined}
                  onDragLeave={draggable ? () => setDropIndicator((prev) => (prev?.key === column.key ? null : prev)) : undefined}
                  onDragEnd={draggable ? () => setDropIndicator(null) : undefined}
                  onDrop={draggable ? (e) => {
                    e.preventDefault();
                    const dragKey = e.dataTransfer.getData('text/plain');
                    if (dragKey) onReorderColumn(dragKey, column.key, sideOf(e));
                    setDropIndicator(null);
                  } : undefined}
                >
                  {column.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const subContent = renderSubRow ? renderSubRow(row) : null;
            return (
              <Fragment key={rowKey(row, index)}>
                <tr
                  className={onRowClick ? 'is-clickable' : undefined}
                  onClick={onRowClick ? (e) => { if (!e.target.closest('button, a')) onRowClick(row); } : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={onRowClick ? (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onRowClick(row); } } : undefined}
                >
                  {columns.map((column) => (
                    <td key={column.label} className={column.className} data-label={typeof column.label === 'string' ? column.label : ''}>{column.render ? column.render(row) : row[column.key]}</td>
                  ))}
                </tr>
                {subContent && (
                  <tr className="table-subrow">
                    <td colSpan={columns.length}>{subContent}</td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Centered modal overlay for a submit-in-progress state — used where a
// small in-button spinner isn't noticeable enough (e.g. Create Ticket,
// which stays on a long scrolled form while it saves). Portaled to <body>
// like FormModal, so it sits above everything regardless of where it's
// rendered from.
function SubmitLoadingOverlay({ label = 'Loading...' }) {
  return <LoadingOverlay label={label} />;
}

function ModuleLoader({ label = 'Loading...' }) {
  return <LoadingOverlay label={label} />;
}

function ReportPreview({ report }) {
  if (!report) {
    return <p className="empty-state">Choose a report type and filters to generate a preview.</p>;
  }

  const rows = report.rows ?? [];
  const columns = reportColumns(rows);
  const generatedAt = report.generated_at ? formatDate(report.generated_at) : '—';
  const reportPeriod = report.filters?.from || report.filters?.to
    ? `${report.filters.from ? formatDate(report.filters.from) : 'Start'} – ${report.filters.to ? formatDate(report.filters.to) : 'Present'}`
    : 'All available dates';
  const reportContext = Object.entries(report.filters ?? {})
    .filter(([key, value]) => !['report_type', 'from', 'to'].includes(key) && value !== '' && value != null)
    .map(([key, value]) => `${prettifyKey(key)}: ${value}`);
  const isLandscape = columns.length > 4;
  const uniqueValues = (key) => new Set(rows.map((row) => resolveRelationLabel(row[key]) ?? row[key]).filter((value) => value != null && value !== '')).size;
  const statusKey = rows.length ? ['status', 'condition', 'availability_status'].find((key) => rows.some((row) => row[key] != null)) : null;
  const statusCounts = statusKey ? [...new Set(rows.map((row) => row[statusKey]).filter(Boolean))].map((status) => ({ label: status, value: rows.filter((row) => row[statusKey] === status).length })) : [];
  const costKey = rows.length ? ['maintenance_cost', 'cost', 'actual_cost', 'total_cost', 'amount'].find((key) => rows.some((row) => row[key] != null && Number.isFinite(Number(row[key])))) : null;
  const distinctVehicleKey = rows.length ? ['vehicle_id', 'vehicle'].find((key) => rows.some((row) => row[key] != null)) : null;
  const summaryMetrics = [{ label: 'Total records', value: rows.length.toLocaleString() }];
  if (report.report_type === 'Vehicle Inventory Report' || report.report_type === 'Vehicle Type Report') {
    if (rows.length && rows[0].category != null) summaryMetrics.push({ label: 'Vehicle types', value: uniqueValues('category').toLocaleString() });
    if (statusCounts.length) summaryMetrics.push(...statusCounts.map(({ label, value }) => ({ label, value: value.toLocaleString() })));
  } else if (report.report_type === 'Vehicle Location Report') {
    if (rows.length && rows.some((row) => row.current_location != null)) summaryMetrics.push({ label: 'Locations represented', value: uniqueValues('current_location').toLocaleString() });
  } else if (report.report_type === 'Vehicle Issue Report' || report.report_type === 'Vehicle Maintenance Report' || report.report_type === 'Vehicle Maintenance Schedule Report') {
    if (statusCounts.length) summaryMetrics.push(...statusCounts.map(({ label, value }) => ({ label, value: value.toLocaleString() })));
    if (costKey) summaryMetrics.push({ label: 'Total recorded cost', value: new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(rows.reduce((sum, row) => sum + (Number(row[costKey]) || 0), 0)) });
  } else if (report.report_type === 'Vehicle History Report' && distinctVehicleKey) {
    summaryMetrics.push({ label: 'Vehicles represented', value: uniqueValues(distinctVehicleKey).toLocaleString() });
  }
  const sectionTitle = ({
    'Vehicle Inventory Report': 'Vehicle Inventory',
    'Vehicle Type Report': 'Vehicle Type Breakdown',
    'Vehicle Location Report': 'Vehicles by Location',
    'Vehicle Issue Report': 'Issue Details',
    'Vehicle Maintenance Report': 'Maintenance Details',
    'Vehicle Maintenance Schedule Report': 'Maintenance Schedule',
    'Vehicle History Report': 'Vehicle Activity History',
  })[report.report_type] ?? 'Report Details';

  const reportDocument = (
    <div className={`report-document${isLandscape ? ' is-landscape' : ''}`}>
      <header className="report-document-header">
        <div className="report-brand">
          <span className="report-brand-mark"><VMSLogo variant="blue" size={28} /></span>
          <span><strong>VMS</strong><small>Barangay Vehicle Management System</small></span>
        </div>
        <div className="report-document-heading"><span>OFFICIAL FLEET REPORT</span><h2>{report.report_type?.toUpperCase()}</h2></div>
        <div className="report-header-meta"><span>Generated</span><strong>{generatedAt}</strong><span>Reporting period</span><strong>{reportPeriod}</strong></div>
      </header>
      <div className="report-document-title">
        <p>Prepared by <strong>{report.generated_by || '—'}</strong>{reportContext.length > 0 && <> · Filters: {reportContext.join(' · ')}</>}</p>
      </div>
      <section className="report-data-section report-summary-section">
        <div className="report-section-bar"><h3>{report.report_type === 'Vehicle History Report' ? 'Vehicle Information' : report.report_type === 'Vehicle Issue Report' ? 'Issue Summary' : report.report_type === 'Vehicle Maintenance Report' ? 'Maintenance Summary' : report.report_type === 'Vehicle Maintenance Schedule Report' ? 'Schedule Overview' : report.report_type === 'Vehicle Location Report' ? 'Location Overview' : report.report_type === 'Vehicle Type Report' ? 'Vehicle Type Summary' : 'Fleet Summary'}</h3></div>
        <div className="report-summary-grid">{summaryMetrics.map((metric) => <div className="report-summary-item" key={metric.label}><strong>{metric.value}</strong><span>{metric.label}</span></div>)}</div>
      </section>
      <section className="report-data-section">
        <div className="report-section-bar"><h3>{sectionTitle}</h3><span>{rows.length.toLocaleString()} {rows.length === 1 ? 'record' : 'records'}</span></div>
        <div className="report-document-table-wrap">
          <table className="report-document-table">
            <thead><tr>{columns.map((col) => <th key={col.label}>{col.label}</th>)}</tr></thead>
            <tbody>
              {rows.length ? rows.map((row, i) => (
                <tr key={row.id ?? i}>{columns.map((col) => <td key={col.label}>{col.render(row)}</td>)}</tr>
              )) : <tr><td className="report-no-records" colSpan={columns.length || 1}>No records match the selected report criteria.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <footer className="report-document-footer"><span>Barangay Vehicle Management System</span><span>Generated {generatedAt}</span></footer>
    </div>
  );

  return (
    <section className="report-preview-shell">
      <div className="report-preview-toolbar">
        <div><strong>Report preview</strong><span>{rows.length.toLocaleString()} records · {reportPeriod}</span></div>
        <div className="report-preview-actions">
          <button
            className="ghost-button"
            onClick={() => exportRowsToCsv(`${report.report_type.toLowerCase().replaceAll(' ', '-')}.csv`, reportExportColumns(rows), rows)}
            type="button"
          >
            Export CSV
          </button>
          <button className="ghost-button" onClick={() => window.print()} type="button">Print</button>
        </div>
      </div>
      <div className="report-preview-canvas">{reportDocument}</div>

      {/* Print-only — kept off-screen (see .report-print-view), shown by the
          Print button above. Portaled to <body>, same reasoning as the
          vehicle profile's .veh-print-report: the app's @media print rule
          hides #root entirely, so the printable content has to live outside
          it or Print produces a blank page. */}
      {createPortal(
        <div className="report-print-view">{reportDocument}</div>,
        document.body,
      )}
    </section>
  );
}

const emptyLookups = {
  categories: [],
  vehicles: [],
  maintenance_personnel: [],
  maintenance_performers: [],
  issue_reports: [],
  issue_types: [],
  maintenance_types: [],
  severity_levels: [],
  vehicle_statuses: [],
  condition_results: [],
  issue_statuses: [],
  maintenance_statuses: [],
  schedule_statuses: [],
};

const emptyTicketLookups = {
  vehicles: [],
  custodians: [],
  maintenance_personnel: [],
  priorities: [],
  maintenance_types: [],
  ticket_statuses: [],
  sub_issue_statuses: [],
};

const CRITICALITY_LEVELS = ['Critical', 'High', 'Normal'];

function defaultCriticalityFor(vehicle, lookups) {
  return (lookups.categories ?? []).find((c) => String(c.category_id) === String(vehicle.category_id))?.default_criticality ?? 'Normal';
}

function vehicleCriticality(vehicle, lookups) {
  return vehicle.criticality ? `${vehicle.criticality} (set for this vehicle)` : `${defaultCriticalityFor(vehicle, lookups)} (from vehicle type)`;
}



// `liveValues` lets Confirm Password become required only once a new
// password has actually been typed — editing an Admin resets someone
// else's password, so unlike the self-service My Profile flow there's
// deliberately no Current Password field: the whole point of an admin
// reset is that they don't (and shouldn't need to) know the old one.


const verificationFields = [
  { label: 'Verification Result', name: 'verification_result', options: ['Passed', 'Failed'], required: true, type: 'select' },
  { label: 'Verification Notes (required if Failed)', name: 'verification_notes', type: 'textarea' },
  { label: 'I personally operated and tested this vehicle (required to pass)', name: 'test_attested', type: 'select', options: [{ value: '1', label: 'Yes, I personally tested it' }, { value: '0', label: 'Not attested' }] },
];

const passwordFields = [
  { label: 'Old Password', name: 'old_password', required: true, type: 'password' },
  { label: 'New Password', name: 'new_password', required: true, type: 'password' },
  { label: 'Confirm New Password', name: 'new_password_confirmation', required: true, type: 'password', confirmOf: 'new_password' },
];

const FUEL_TYPE_OPTIONS = ['Diesel', 'Gasoline', 'Electric', 'Hybrid', 'CNG', 'LPG'];
const HULL_MATERIAL_OPTIONS = ['Fiberglass', 'Aluminum', 'Steel', 'Wood', 'Rubber/Inflatable'];

function capacityUnits(domain) {
  // 'pax' matters for a Water vehicle too — a rescue boat's key spec is how
  // many people it can carry, same reason it matters for an Ambulance.
  return domain === 'Water' ? ['L', 'gal', 'm³', 'pax'] : ['kg', 'tons', 'L', 'pax'];
}

// Same underlying column (plate_number) either way — a boat has no LTO
// plate, so the label/placeholder/validation just read right for whichever
// domain the vehicle actually is.
function plateFieldLabel(domain) {
  return domain === 'Water' ? 'Registration / Hull No.' : 'Plate Number';
}

function vehicleIconName(domain) {
  return domain === 'Water' ? 'boat' : 'vehicle';
}

function vehicleDomainFields(domain) {
  return domain === 'Water'
    ? [
        { label: 'Hull Material', name: 'hull_material', options: HULL_MATERIAL_OPTIONS, required: true, type: 'select' },
        { label: 'Engine Type', name: 'engine_type', required: true, type: 'text' },
        { label: 'Fuel Type', name: 'fuel_type', options: FUEL_TYPE_OPTIONS, required: true, type: 'select' },
      ]
    : [{ label: 'Fuel Type', name: 'fuel_type', options: FUEL_TYPE_OPTIONS, required: true, type: 'select' }];
}

// Admin-defined per-Vehicle-Type fields, rendered as ordinary form inputs
// named cf_<key> (the API folds them into custom_values).
function customFieldInputs(category, group) {
  return (category?.fields ?? []).filter((f) => f.is_active).map((f) => ({
    label: f.unit ? `${f.label} (${f.unit})` : f.label,
    name: `cf_${f.key}`,
    required: f.is_required,
    type: f.field_type === 'number' ? 'number' : f.field_type === 'date' ? 'date' : (f.field_type === 'dropdown' || f.field_type === 'yes_no') ? 'select' : 'text',
    options: f.field_type === 'yes_no' ? ['Yes', 'No'] : (f.options ?? undefined),
    ...(group ? { group } : {}),
  }));
}

function vehicleWithCustomInitials(vehicle) {
  return { ...vehicle, ...Object.fromEntries(Object.entries(vehicle?.custom_values ?? {}).map(([k, v]) => [`cf_${k}`, v])) };
}

// Profile rows for a vehicle's custom values (archived fields still show what they hold).
function customValueRows(vehicle, lookups) {
  const category = (lookups.categories ?? []).find((c) => String(c.category_id) === String(vehicle.category_id));
  return (category?.fields ?? [])
    .filter((f) => vehicle.custom_values?.[f.key] != null && vehicle.custom_values[f.key] !== '')
    .map((f) => (
      <div key={f.key}><dt>{f.label}</dt><dd>{vehicle.custom_values[f.key]}{f.unit ? ` ${f.unit}` : ''}</dd></div>
    ));
}

const VEHICLE_WIZARD_STEP_LABELS = ['Basic Information', 'Specs', 'Photo & Location'];
const VEHICLE_WIZARD_STEP_ICONS = ['clipboard', 'wrench', 'pin'];

function NewVehiclePage({ onBack, lookups, allHubs, onSubmit, onDirty }) {
  // Persisted across a route change and back (e.g. adding a new Vehicle
  // Type mid-wizard opens its own page/modal) — see useDraftState.
  const [step, setStep] = useDraftState('draft:new-vehicle:step', 1);
  const [wizardData, setWizardData] = useDraftState('draft:new-vehicle:data', EMPTY_OBJ);
  const clearNewVehicleDraft = () => {
    clearDraftState('draft:new-vehicle:step');
    clearDraftState('draft:new-vehicle:data');
  };
  // Live-tracks the in-progress Category pick within step 1 (before it's
  // merged into wizardData on "Next") so the Vehicle Type options can
  // filter immediately, without resetting anything else the user has
  // already typed on this step. Re-synced from wizardData wherever `step`
  // actually changes (see setStep call sites below), not via an effect.
  const [domainFilter, setDomainFilter] = useState(wizardData.vehicle_domain ?? '');
  const stepValues = useRef(wizardData);

  const domain = lookups.categories.find(
    (c) => String(c.category_id) === String(wizardData.category_id)
  )?.domain ?? 'Land';

  // Derived from the actual vehicle types on file, not hardcoded — so a
  // newly added domain (beyond today's Land/Water) just works here too.
  const domainOptions = [...new Set(lookups.categories.map((c) => c.domain).filter(Boolean))].sort();

  const stepFields = {
    1: [
      // Asked first, before the vehicle even has a name — everything else on
      // this step (the plate/registration field's label and pattern, which
      // vehicle types are offered below) depends on Land vs Water, so this
      // has to be answered before those can make sense.
      { label: 'Land or Water Vehicle', name: 'vehicle_domain', options: domainOptions, required: true, type: 'select' },
      { label: 'Vehicle Name', name: 'vehicle_name', required: true, type: 'text' },
      domainFilter === 'Water'
        ? {
            label: plateFieldLabel('Water'), name: 'plate_number', required: true, type: 'text',
            placeholder: 'e.g. HULL-24-01', uppercase: true, maxLength: 10,
          }
        : {
            label: plateFieldLabel('Land'), name: 'plate_number', required: true, type: 'text',
            // NOTE: browsers compile `pattern` with the strict `v` flag, where `\s`
            // inside a character class is invalid — use a literal space instead.
            placeholder: 'e.g. ABC 1234', pattern: '^[A-Za-z]{2,6}[ \\-]?\\d{2,6}[A-Za-z]?$',
            title: 'Use letters and digits with optional spaces or dashes, e.g. INEM-112, FDR-303 or AMB-1101', uppercase: true, maxLength: 10,
          },
      {
        label: 'Vehicle Type',
        name: 'category_id',
        options: lookups.categories.filter((c) => c.domain === domainFilter),
        optionDomain: domainFilter,
        required: true,
        type: 'creatable-select',
        newItemLabel: 'vehicle type',
        catalogEndpoint: '/categories',
        idField: 'category_id',
        nameField: 'category_name',
        valueIsId: true,
        // Pre-fills the add-new-type modal's Domain field to match the
        // domain already picked above, instead of leaving it blank.
        extraFields: [{ name: 'domain', label: 'Domain', options: domainOptions.length ? domainOptions : ['Land', 'Water'], required: true, default: domainFilter || 'Land' }],
      },
    ],
    2: [
      { label: 'Brand', name: 'brand', required: true, type: 'text' },
      { label: 'Model', name: 'model', required: true, type: 'text' },
      { label: 'Year Model', name: 'year_model', required: true, type: 'number' },
      { label: 'Capacity', name: 'capacity', required: true, type: 'quantity', units: capacityUnits(domain) },
      // Optional — without it, the per-vehicle reliability lens' lifetime-
      // cost-vs-value (decommission signal) has nothing to compare against
      // and is just skipped for this vehicle (production-readiness audit
      // finding #7 — same field already existed on the Edit Vehicle form,
      // just never on registration itself).
      { label: 'Acquisition Cost (optional)', name: 'acquisition_cost', type: 'number', placeholder: 'e.g. 850000' },
      { label: 'Vehicle Color', name: 'vehicle_color', required: true, type: 'text' },
      ...vehicleDomainFields(domain),
      ...customFieldInputs(lookups.categories.find((c) => String(c.category_id) === String(wizardData.category_id))),
    ],
    3: [
      { label: 'Vehicle Photo', name: 'photo', accept: 'image/*', type: 'file', compactFile: true },
      {
        label: 'Current Location', name: 'current_location', options: allHubs, required: true, type: 'creatable-select',
        newItemLabel: 'location', catalogEndpoint: '/hubs', idField: 'hub_id', nameField: 'name',
        // A hub needs real coordinates to ever show up on the map, so
        // unlike Vehicle Type's Domain (a plain preset dropdown), these are
        // free-typed numbers with no sensible default to pre-fill.
        extraFields: [
          { name: 'lat', label: 'Latitude', type: 'number', required: true, placeholder: 'e.g. 10.3378' },
          { name: 'lng', label: 'Longitude', type: 'number', required: true, placeholder: 'e.g. 123.9422' },
        ],
        // Shows exactly where the hub is as soon as one is picked, instead
        // of leaving the location as just a name in a dropdown. Rendered
        // inline (inside this field's own cell, right under the select)
        // rather than as a separate full-width row, so it sits directly
        // beneath the dropdown and top-aligns with the photo box beside it
        // instead of leaving a gap where a taller sibling row would go.
        inlineExtra: (vals) => {
          const hub = allHubs.find((h) => h.name === vals.current_location);
          return hub ? (
            <div className="veh-map-wrap" style={{ height: 220 }}>
              <VehicleLocationMap lat={hub.lat} lng={hub.lng} label={hub.name} />
            </div>
          ) : null;
        },
      },
      { label: 'Remarks (optional)', name: 'remarks', type: 'textarea' },
    ],
  };

  const isLastStep = step === 3;

  // Also used by the wizard-step-pill "go back" clicks below, so
  // domainFilter always reflects whatever step 1 last had, whichever way
  // the user navigates back to it.
  const goToStep = (n) => {
    const merged = { ...wizardData, ...stepValues.current };
    setWizardData(merged);
    setDomainFilter(merged.vehicle_domain ?? '');
    setStep(n);
  };

  const handleStepSubmit = async (values) => {
    const merged = { ...wizardData, ...values };
    stepValues.current = merged;
    if (isLastStep) {
      const ok = await onSubmit(merged);
      if (ok !== false) clearNewVehicleDraft();
    } else {
      setWizardData(merged);
      setStep((s) => s + 1);
    }
  };

  return (
    <ModulePanel description="Register a new vehicle in the fleet — complete all three steps to add it.">
      <div className="wizard-steps" role="list" aria-label="Add vehicle steps">
        {VEHICLE_WIZARD_STEP_LABELS.map((label, i) => {
          const n = i + 1;
          const state = step === n ? 'active' : step > n ? 'done' : 'upcoming';
          if (state === 'done') {
            return (
              <button
                key={label}
                type="button"
                className="wizard-step-pill is-done"
                role="listitem"
                onClick={() => goToStep(n)}
                title={`Go back to ${label}`}
              >
                <Icon name="checkCircle" size={16} />
                {label}
              </button>
            );
          }
          return (
            <div key={label} className={`wizard-step-pill is-${state}`} role="listitem">
              <Icon name={VEHICLE_WIZARD_STEP_ICONS[i]} size={16} />
              {label}
            </div>
          );
        })}
      </div>
      <div className={`form-grid-2col${step === 3 ? ' wizard-photo-location-grid' : ''}`}>
        <SmartForm
          fields={stepFields[step]}
          initialValues={wizardData}
          key={step}
          cancelLabel={step === 1 ? 'Cancel' : 'Back'}
          onCancel={step === 1 ? () => { clearNewVehicleDraft(); onBack(); } : () => goToStep(step - 1)}
          onSubmit={handleStepSubmit}
          onValuesChange={(vals) => { stepValues.current = vals; setDomainFilter(vals.vehicle_domain ?? ''); onDirty?.(); }}
          submitLabel={isLastStep ? 'Add Vehicle' : 'Next'}
          title=""
        />
      </div>
    </ModulePanel>
  );
}

// Formats one form field's live value for the Entry Summary card — resolves a
// select's option label and pretty-prints dates; returns null when unanswered.
function formSummaryValue(field, raw) {
  if (raw == null || raw === '') return null;
  if (field.type === 'select' && Array.isArray(field.options)) {
    const opt = field.options.find((o) => String(o?.value ?? o) === String(raw));
    const label = opt?.label ?? opt;
    if (label != null) return String(label);
  }
  if (field.type === 'date') return formatForecastDate(raw) || String(raw);
  if (field.type === 'list') {
    const rows = (Array.isArray(raw) ? raw : [raw]).map((r) => String(r).trim()).filter(Boolean);
    return rows.length ? rows.join(' · ') : null;
  }
  if (field.type === 'multi-file') {
    const count = Array.isArray(raw) ? raw.length : 0;
    return count ? `${count} file${count === 1 ? '' : 's'} selected` : null;
  }
  return String(raw);
}

// #7 — non-blocking "this vehicle already has open items" warning, shown on the
// Report Issue form (and reusable for tickets). Lets a second reporter notice a
// duplicate before opening another record. Never blocks — two genuinely
// different problems can be open at once.
function OpenItemsWarning({ kind, rows, basePath }) {
  return (
    <div className="info-callout" style={{ marginBottom: 16, background: 'rgba(245, 158, 11, 0.1)', borderColor: '#f59e0b' }}>
      <span style={{ marginRight: 8, color: '#b45309', display: 'inline-flex', flexShrink: 0 }}><Icon name="alert" size={16} /></span>
      <div style={{ flex: 1 }}>
        <p className="module-description" style={{ color: '#b45309', margin: '0 0 6px', fontWeight: 600 }}>
          This vehicle already has {rows.length} open {kind}{rows.length !== 1 ? 's' : ''} — check it isn&apos;t the same problem before adding another:
        </p>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {rows.map((r) => {
            const id = r.issue_report_id ?? r.ticket_id;
            const label = r.issue_report_id
              ? `#${r.issue_report_id} ${r.issue_type} (${r.severity_level}) — ${r.status}`
              : `#${ticketNumber(r)} ${r.ticket_title} — ${r.status}`;
            const href = basePath ? `${basePath}/${r.issue_report_id ? 'issues' : 'tickets'}/${id}` : null;
            return (
              <li key={id} style={{ fontSize: '0.85rem', color: '#92400e', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1 }}>{label}</span>
                {/* Opens in a new tab — same reasoning as the ticket duplicate
                    warning: whoever's filling this form shouldn't lose their
                    in-progress entry just to go check an existing record. */}
                {href && (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: '0.8rem', fontWeight: 600, color: '#b45309', textDecoration: 'underline', whiteSpace: 'nowrap' }}
                  >
                    View <Icon name="link" size={11} style={{ verticalAlign: 'middle' }} />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// Generic single-form page — used for every simple create/edit flow (Vehicle
// Types, Maintenance Schedules, Condition Checks, Issue Reports) that doesn't
// need its own multi-tab profile like vehicles/tickets do.
// When `contextVehicles` is provided, the page renders Realcore-style: the form
// fields sit in a card on the right, and the left side live-previews the
// selected vehicle (photo, info, location map) as the user picks one.
// =========================================================================
// Add / Edit Vehicle Type and Add / Update User — redesigned form pages.
// Same submit contract as FormPage (submitFormPage(module, ref, payload)),
// same field names, same validation rules; only the layout changed.
// =========================================================================

// Shared page frame: breadcrumb, heading, one white panel.
// =========================================================================
// CANNIBALIZATION — a direct record of parts moved off a vehicle.
// No request / approval / pending state: fill the form, review, record.
// A saved record is final (the API has no edit or delete) and is attributed
// to the signed-in user by the server, never by a form field.
// =========================================================================









// Vehicle profile: parts moved off / onto THIS vehicle, with a button to
// record a new transfer (source pre-filled). Lives on the profile, not in
// the sidebar.


function FxPage({ icon, crumbs, title, description, children }) {
  return (
    <div className="module-grid">
      <section className="panel fx-panel">
        <header className="fx-head">
          <span className="fx-head-icon"><Icon name={icon} size={22} /></span>
          <div>
            <nav className="fx-crumbs" aria-label="Breadcrumb">
              {crumbs.map((c, i) => (
                <span key={c}>{i > 0 && <span aria-hidden="true"> › </span>}{c}</span>
              ))}
            </nav>
            <h2 className="fx-title">{title}</h2>
            <p className="fx-desc">{description}</p>
          </div>
        </header>
        {children}
      </section>
    </div>
  );
}

function FxField({ id, label, required, hint, error, children, className = '' }) {
  return (
    <div className={`fx-field${error ? ' has-error' : ''}${className ? ` ${className}` : ''}`}>
      <label htmlFor={id}>{label}{required && <abbr title="required" className="required-asterisk"> *</abbr>}</label>
      {children}
      {hint && !error && <small className="fx-hint">{hint}</small>}
      {error && <small className="fx-error" role="alert">{error}</small>}
    </div>
  );
}

function VehicleTypeFormPage({ initialValues, isEditing, onBack, onSubmit, submitLabel, onDirty, categoryVehicleCount = null }) {
  const seed = (v) => ({
    category_name: v?.category_name ?? '',
    domain: v?.domain ?? '',
    default_criticality: v?.default_criticality ?? '',
    description: v?.description ?? '',
  });
  const [values, setValues] = useState(() => seed(initialValues));
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const skippedFirst = useRef(false);
  useEffect(() => {
    if (!skippedFirst.current) { skippedFirst.current = true; return; }
    setValues(seed(initialValues));
  }, [initialValues]);

  const set = (name, value) => {
    setValues((v) => ({ ...v, [name]: value }));
    setErrors((e) => ({ ...e, [name]: undefined }));
    onDirty?.();
  };

  // Live preview only — nothing is saved until the form is submitted.
  const previewDomain = values.domain || 'Land';
  const previewFields = [
    { label: plateFieldLabel(previewDomain), note: previewDomain === 'Water' ? 'registration / hull number' : 'plate number' },
    { label: 'Capacity', note: `in ${capacityUnits(previewDomain).join(', ')}` },
    ...vehicleDomainFields(previewDomain).map((f) => ({
      label: f.label,
      note: f.options ? f.options.slice(0, 3).join(', ') + (f.options.length > 3 ? '…' : '') : 'free text',
    })),
  ];

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    const next = {};
    if (!values.category_name.trim()) next.category_name = 'Vehicle Type Name is required.';
    if (!values.domain) next.domain = 'Domain is required.';
    setErrors(next);
    if (Object.keys(next).length) return;
    setSubmitting(true);
    try {
      await onSubmit({ ...values, category_name: values.category_name.trim() });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FxPage
      icon="vehicle"
      crumbs={['Vehicle Types', isEditing ? 'Edit Vehicle Type' : 'Add Vehicle Type']}
      title={isEditing ? 'Edit Vehicle Type' : 'Add Vehicle Type'}
      description={isEditing ? 'Update this vehicle type and the default information it uses.' : 'Create a new vehicle type and define the default information it will use.'}
    >
      <form className="fx-form fx-cols fx-cols--preview" onSubmit={handleSubmit} noValidate autoComplete="off">
        <aside className="fx-aside" aria-label="Vehicle type preview">
          <h3 className="fx-section-title">Vehicle Type Preview</h3>
          <p className="fx-hint">How this type's domain-specific information will be presented when a vehicle is assigned to it.</p>
          <div className="fx-preview">
            <span className="fx-preview-icon"><Icon name={vehicleIconName(previewDomain)} size={40} /></span>
            <strong className={`fx-preview-name${values.category_name.trim() ? '' : ' is-placeholder'}`}>
              {values.category_name.trim() || 'Vehicle type name'}
            </strong>
            <div className="fx-chips">
              <span className="fx-chip">{values.domain || 'Domain not set'}</span>
              <span className="fx-chip fx-chip--muted">{values.default_criticality ? `${values.default_criticality} criticality` : 'Criticality not set'}</span>
            </div>
          </div>
          <h4 className="fx-subtitle">{previewDomain} vehicles also ask for</h4>
          <dl className="fx-kv">
            {previewFields.map((f) => (
              <div key={f.label}><dt>{f.label}</dt><dd>{f.note}</dd></div>
            ))}
          </dl>
          {isEditing && categoryVehicleCount != null && (
            <p className="fx-note">
              <strong>{categoryVehicleCount}</strong> vehicle{categoryVehicleCount === 1 ? '' : 's'} use this type.
              {categoryVehicleCount ? ' Renaming it or switching domain affects every one of them.' : ''}
            </p>
          )}
        </aside>

        <div className="fx-main">
          <h3 className="fx-section-title">Vehicle Type Details</h3>
          <div className="fx-grid">
            <FxField id="vt-name" label="Vehicle Type Name" required error={errors.category_name} className="fx-span-2">
              <input id="vt-name" type="text" maxLength={255} value={values.category_name} onChange={(e) => set('category_name', e.target.value)} placeholder="Ambulance, Fire Truck, Rescue Boat" />
            </FxField>
            <FxField id="vt-domain" label="Domain" required error={errors.domain} hint="Land or Water — decides which vehicle-specific fields a vehicle of this type asks for.">
              <SearchableSelect id="vt-domain" value={values.domain} onChange={(e) => set('domain', e.target.value)}>
                <option value="">Select domain</option>
                <option value="Land">Land</option>
                <option value="Water">Water</option>
              </SearchableSelect>
            </FxField>
            <FxField id="vt-crit" label="Default Criticality" hint="How much vehicles of this type matter operationally. Critical ones surface first on the readiness watch; Admin can override per vehicle.">
              <SearchableSelect id="vt-crit" value={values.default_criticality} onChange={(e) => set('default_criticality', e.target.value)}>
                <option value="">Select criticality</option>
                {CRITICALITY_LEVELS.map((c) => <option key={c} value={c}>{c}</option>)}
              </SearchableSelect>
            </FxField>
            <FxField id="vt-desc" label="Description" className="fx-span-2" hint="Optional — when to use this type.">
              <textarea id="vt-desc" rows={4} value={values.description} onChange={(e) => set('description', e.target.value)} placeholder="Notes about which vehicles belong under this type" />
            </FxField>
          </div>

          <div className="fx-info" role="note">
            <Icon name="info" size={16} />
            <span>Vehicle fields vary by domain: <strong>Land</strong> vehicles use a plate number and capacity; <strong>Water</strong> vehicles use a registration / hull number, hull material and engine type.</span>
          </div>

          <div className="fx-actions">
            <button type="button" className="ghost-button" onClick={onBack} disabled={submitting}>Cancel</button>
            <button type="submit" className="primary-button" disabled={submitting}>{submitting ? 'Saving…' : submitLabel}</button>
          </div>
        </div>
      </form>
    </FxPage>
  );
}

const USER_ROLE_CARDS = [
  { value: 'Admin', icon: 'grid', text: 'Manages barangay fleet information, reviews ticket proposals, assigns mechanics, monitors repairs, and manages users and reports.' },
  { value: 'Custodian', icon: 'checkCircle', text: 'Reports vehicle issues, proposes maintenance tickets, performs inspections, verifies completed repairs, and manages preventive-maintenance activities.' },
  { value: 'Maintenance Personnel', icon: 'wrench', text: 'Reports technical issues, repairs assigned work, and records repair activities and parts used.' },
];

function UserFormPage({ initialValues, isEditing, onBack, onSubmit, submitLabel, onDirty }) {
  const seed = (v) => ({
    name: v?.name ?? '',
    email: v?.email ?? '',
    phone: v?.phone ?? '',
    address: v?.address ?? '',
    roles: Array.isArray(v?.roles) ? v.roles : [],
    password: '',
    password_confirmation: '',
  });
  const [values, setValues] = useState(() => seed(initialValues));
  const [photo, setPhoto] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [photoError, setPhotoError] = useState('');
  const [errors, setErrors] = useState({});
  const [showPw, setShowPw] = useState({ password: false, password_confirmation: false });
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef(null);
  const skippedFirst = useRef(false);
  useEffect(() => {
    if (!skippedFirst.current) { skippedFirst.current = true; return; }
    setValues(seed(initialValues));
  }, [initialValues]);
  useEffect(() => () => { if (photoPreview) URL.revokeObjectURL(photoPreview); }, [photoPreview]);

  const set = (name, value) => {
    setValues((v) => ({ ...v, [name]: value }));
    setErrors((e) => ({ ...e, [name]: undefined }));
    onDirty?.();
  };
  // Selection order matters: the first role selected is the primary one.
  const toggleRole = (role) => {
    setValues((v) => ({ ...v, roles: v.roles.includes(role) ? v.roles.filter((r) => r !== role) : [...v.roles, role] }));
    setErrors((e) => ({ ...e, roles: undefined }));
    onDirty?.();
  };

  const pickPhoto = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { setPhotoError('Choose an image file (JPG, PNG, …).'); e.target.value = ''; return; }
    if (file.size > 4 * 1024 * 1024) { setPhotoError('The photo must be 4 MB or smaller.'); e.target.value = ''; return; }
    setPhotoError('');
    setPhoto(file);
    setPhotoPreview(URL.createObjectURL(file));
    onDirty?.();
  };

  const currentPhoto = photoPreview ?? (initialValues?.photo_url ? resolvePhotoUrl(initialValues.photo_url) : null);
  const initials = (values.name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    const next = {};
    if (!values.name.trim()) next.name = 'Full Name is required.';
    if (!values.email.trim()) next.email = 'Email is required.';
    else if (!/^\S+@\S+\.\S+$/.test(values.email.trim())) next.email = 'Enter a valid email address.';
    if (values.phone && !/^09[0-9]{9}$/.test(values.phone)) next.phone = 'Phone must be 11 digits starting with 09.';
    if (!values.roles.length) next.roles = 'Select at least one role.';
    const wantsPassword = !isEditing || values.password || values.password_confirmation;
    if (wantsPassword) {
      if (!values.password) next.password = 'Password is required.';
      else if (values.password.length < 8) next.password = 'Password must be at least 8 characters.';
      if (!values.password_confirmation) next.password_confirmation = 'Confirm the password.';
      else if (values.password && values.password !== values.password_confirmation) next.password_confirmation = 'Passwords do not match.';
    }
    setErrors(next);
    if (Object.keys(next).length) return;

    // Blank password fields are left out entirely, so the current password
    // is never touched on an ordinary update.
    const payload = {
      name: values.name.trim(),
      email: values.email.trim(),
      phone: values.phone,
      address: values.address,
      roles: values.roles,
      ...(photo ? { photo } : {}),
      ...(values.password ? { password: values.password, password_confirmation: values.password_confirmation } : {}),
    };
    setSubmitting(true);
    try {
      await onSubmit(payload);
    } finally {
      setSubmitting(false);
    }
  };

  const pwField = (name, label, autoComplete) => (
    <FxField id={`u-${name}`} label={label} error={errors[name]}>
      <span className="fx-pw">
        <input
          id={`u-${name}`}
          type={showPw[name] ? 'text' : 'password'}
          value={values[name]}
          autoComplete={autoComplete}
          onChange={(e) => set(name, e.target.value)}
        />
        <button type="button" className="fx-pw-toggle" onClick={() => setShowPw((s) => ({ ...s, [name]: !s[name] }))} aria-label={showPw[name] ? `Hide ${label}` : `Show ${label}`} aria-pressed={showPw[name]}>
          <Icon name={showPw[name] ? 'eyeOff' : 'eye'} size={16} />
        </button>
      </span>
    </FxField>
  );

  return (
    <FxPage
      icon="edit"
      crumbs={['Users', isEditing ? 'Update User' : 'Add User']}
      title={isEditing ? 'Update User' : 'Add User'}
      description={isEditing ? 'Edit account details, roles, and sign-in settings.' : 'Create an account, assign roles, and set its sign-in password.'}
    >
      <form className="fx-form fx-cols fx-cols--user" onSubmit={handleSubmit} noValidate autoComplete="off">
        <div className="fx-main">
          <h3 className="fx-section-title">Personal Information</h3>
          <div className="fx-grid">
            <FxField id="u-name" label="Full Name" required error={errors.name}>
              <input id="u-name" type="text" value={values.name} onChange={(e) => set('name', e.target.value)} />
            </FxField>
            <FxField id="u-email" label="Email" required error={errors.email}>
              <input id="u-email" type="email" value={values.email} placeholder="name@barangay.gov" onChange={(e) => set('email', e.target.value)} />
            </FxField>
            <FxField id="u-phone" label="Phone" error={errors.phone}>
              <input id="u-phone" type="tel" inputMode="numeric" maxLength={11} pattern="09[0-9]{9}" value={values.phone} placeholder="09XXXXXXXXX" onChange={(e) => set('phone', e.target.value.replace(/\D/g, '').slice(0, 11))} />
            </FxField>
            <FxField id="u-address" label="Address">
              <input id="u-address" type="text" value={values.address} onChange={(e) => set('address', e.target.value)} />
            </FxField>
          </div>

          <hr className="fx-divider" />
          <h3 className="fx-section-title">Roles and Permissions</h3>
          <p className="fx-hint">A person can hold more than one role. The first selected role is primary.</p>
          <div className="fx-roles" role="group" aria-label="Roles">
            {USER_ROLE_CARDS.map((r) => {
              const checked = values.roles.includes(r.value);
              const rank = values.roles.indexOf(r.value);
              return (
                <label key={r.value} className={`fx-role${checked ? ' is-selected' : ''}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggleRole(r.value)} />
                  <span className="fx-role-icon"><Icon name={r.icon} size={18} /></span>
                  <span className="fx-role-body">
                    <strong>{r.value}{checked && rank === 0 && values.roles.length > 1 && <em className="fx-primary-tag">Primary</em>}</strong>
                    <small>{r.text}</small>
                  </span>
                </label>
              );
            })}
          </div>
          {errors.roles && <small className="fx-error" role="alert">{errors.roles}</small>}

        </div>

        <aside className="fx-aside">
          <h3 className="fx-section-title">Profile Photo</h3>
          <div className="fx-photo">
            <div className="fx-avatar">
              {currentPhoto ? <img src={currentPhoto} alt={`${values.name || 'User'} profile`} onError={(e) => { e.currentTarget.style.display = 'none'; }} /> : null}
              <span className="fx-avatar-fallback" aria-hidden="true">{initials}</span>
            </div>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickPhoto} />
            <button type="button" className="ghost-button" onClick={() => fileRef.current?.click()}>
              <Icon name="edit" size={14} /> {currentPhoto ? 'Change Photo' : 'Upload Photo'}
            </button>
            <small className="fx-hint">Image files up to 4 MB.</small>
            {photoError && <small className="fx-error" role="alert">{photoError}</small>}
          </div>

          <hr className="fx-divider" />
          <h3 className="fx-section-title">{isEditing ? 'Change Password' : 'Password'}</h3>
          {isEditing && <p className="fx-hint">Leave blank to keep the current password.</p>}
          {pwField('password', isEditing ? 'New Password' : 'Password', 'new-password')}
          {pwField('password_confirmation', isEditing ? 'Confirm New Password' : 'Confirm Password', 'new-password')}
        </aside>

        <div className="fx-actions fx-actions--full">
          <button type="button" className="ghost-button" onClick={onBack} disabled={submitting}>Cancel</button>
          <button type="submit" className="primary-button" disabled={submitting}>{submitting ? 'Saving…' : (isEditing ? 'Save Changes' : submitLabel)}</button>
        </div>
      </form>
    </FxPage>
  );
}

function FormPage({ description, onBack, fields, initialValues, onSubmit, submitLabel, contextVehicles, hubs, warnEndpoint, warnRender, reviewStep = false, wrapperClassName, formTitle = '', onDirty, showDomainPreview = false, categoryVehicleCount = null, compactVehiclePreview = false, reserveVehiclePreview = false }) {
  // Scoped to this exact route (new-X vs. editing record #N are different
  // paths) so a form's in-progress values survive clicking a "view" link
  // (e.g. the selected vehicle/custodian's name) and coming Back, instead of
  // resetting because the page component fully unmounted and remounted —
  // see useDraftState.
  const location = useLocation();
  const draftKey = `draft:form:${location.pathname}`;
  const [liveValues, setLiveValues] = useDraftState(draftKey, initialValues ?? EMPTY_OBJ);
  // SmartForm keeps its own internal `values`, seeded once from whatever
  // `initialValues` prop it's given — passing the plain `initialValues` prop
  // straight through (as before) would silently discard the restored draft,
  // since SmartForm would seed itself from the pre-draft original instead.
  // This snapshot starts as the restored `liveValues` but, unlike liveValues,
  // does NOT track every keystroke (only the reset effect below updates it),
  // so it stays a stable reference SmartForm won't re-sync against mid-typing.
  const [smartFormSeed, setSmartFormSeed] = useState(() => liveValues);
  const [warnRows, setWarnRows] = useState([]);
  // Opt-in two-step flow (Maintenance Records today): fill the fields, hit
  // Next, then review everything on its own full-width step before it
  // actually saves — instead of a live summary sidebar fighting the form for
  // space the whole time it's being filled in. Every other FormPage caller
  // leaves reviewStep unset and keeps the original single-step behavior.
  const [step, setStep] = useState(1);
  const [confirming, setConfirming] = useState(false);

  // Skips its first run (which would otherwise immediately overwrite a
  // restored draft with the plain initialValues right after mount) — still
  // resets on every later change, e.g. once `initialValues` itself finishes
  // loading in from the server.
  const formResetKey = JSON.stringify(initialValues ?? EMPTY_OBJ);
  const [previousFormResetKey, setPreviousFormResetKey] = useState(formResetKey);
  if (previousFormResetKey !== formResetKey) {
    setPreviousFormResetKey(formResetKey);
    setLiveValues(initialValues ?? EMPTY_OBJ);
    setSmartFormSeed(initialValues ?? EMPTY_OBJ);
    setStep(1);
  }

  const hasContext = Boolean(contextVehicles?.length);
  const vehicle = hasContext
    ? contextVehicles.find((v) => String(v.vehicle_id) === String(liveValues?.vehicle_id))
    : null;
  const hub = vehicle ? (hubs ?? []).find((h) => h.name === vehicle.current_location) : null;

  // #7 — when a warn endpoint is provided (e.g. open issues on this vehicle),
  // fetch it as the vehicle is picked so the form can show a duplicate warning.
  const warnVehicleId = liveValues?.vehicle_id ?? null;
  const warnResetKey = JSON.stringify([warnVehicleId, Boolean(warnEndpoint)]);
  const [previousWarnResetKey, setPreviousWarnResetKey] = useState(warnResetKey);
  if (previousWarnResetKey !== warnResetKey) { setPreviousWarnResetKey(warnResetKey); setWarnRows([]); }
  useEffect(() => {
    if (!warnEndpoint || !warnVehicleId) return;
    let cancelled = false;
    api.get(warnEndpoint(warnVehicleId))
      .then((r) => { if (!cancelled) setWarnRows(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (!cancelled) setWarnRows([]); });
    return () => { cancelled = true; };
  }, [warnEndpoint, warnVehicleId]);

  // `fields` may be a function of the live values so a form can grow extra
  // fields in response to what the user picked (e.g. "+ Add New Issue").
  const resolvedFields = typeof fields === 'function' ? fields(liveValues) : fields;

  const handleReviewConfirm = async () => {
    setConfirming(true);
    try {
      const ok = await onSubmit(liveValues);
      if (ok !== false) clearDraftState(draftKey);
    } finally {
      setConfirming(false);
    }
  };

  // Reused on its own in the plain sidebar layout, and folded into the
  // review step (together with the field summary) when reviewStep is on —
  // "put this together with the summary in the next section" instead of it
  // sitting in a separate persistent side panel throughout.
  const vehicleInfoCard = vehicle ? (
    <section className="veh-card">
      <div className="veh-card-head"><Icon name={vehicleIconName(vehicle.category?.domain)} size={16} /><h4>Selected Vehicle</h4></div>
      {vehicle.photo_url && (
        <div className="form-context-photo">
          <img src={resolvePhotoUrl(vehicle.photo_url)} alt={vehicle.vehicle_name} />
        </div>
      )}
      <dl className="veh-kv">
        <div><dt>Vehicle</dt><dd>{vehicle.vehicle_name}</dd></div>
        <div><dt>{plateFieldLabel(vehicle.category?.domain)}</dt><dd>{vehicle.plate_number}</dd></div>
        <div><dt>Type</dt><dd>{vehicle.category?.category_name ?? 'Unassigned'}</dd></div>
        <div><dt>Brand / Model</dt><dd>{`${vehicle.brand ?? '-'} ${vehicle.model ?? ''}`.trim() || '-'}</dd></div>
        <div><dt>Status</dt><dd><StatusBadge value={vehicle.status} /></dd></div>
        <div><dt>Condition</dt><dd><StatusBadge value={vehicle.condition} /></dd></div>
      </dl>
    </section>
  ) : null;

  const vehicleLocationCard = vehicle && !showDomainPreview ? (
    <section className="veh-card form-context-map-inline">
      <div className="veh-card-head"><Icon name="pin" size={16} /><h4>{vehicle.current_location ?? 'Location unknown'}</h4></div>
      <div className="veh-map-wrap form-context-map-expanded">
        <VehicleLocationMap lat={hub?.lat} lng={hub?.lng} label={vehicle.current_location} />
      </div>
    </section>
  ) : null;

  const form = reviewStep && step === 2 ? (
    <div className="form-review-step">
      <h3 className="form-review-title">Review before saving</h3>
      {vehicleInfoCard}
      <dl className="veh-kv form-review-grid">
        {resolvedFields.filter((f) => f.name !== 'vehicle_id' && f.type !== 'file').map((f) => {
          const val = formSummaryValue(f, liveValues?.[f.name]);
          return (
            <div key={f.name}>
              <dt>{f.label}</dt>
              <dd className={val ? 'summary-val' : 'summary-empty'}>{val ?? '—'}</dd>
            </div>
          );
        })}
      </dl>
      <div className="form-review-actions">
        <button type="button" className="ghost-button" onClick={() => setStep(1)} disabled={confirming}>Back</button>
        <button type="button" className="primary-button" onClick={handleReviewConfirm} disabled={confirming}>
          {confirming ? 'Saving…' : `Confirm & ${submitLabel}`}
        </button>
      </div>
    </div>
  ) : (
    <>
      {warnRender && warnRows.length > 0 ? warnRender(warnRows) : null}
      <SmartForm
        fields={resolvedFields}
        initialValues={smartFormSeed}
        onCancel={() => { clearDraftState(draftKey); onBack(); }}
        onSubmit={reviewStep ? (payload) => { setLiveValues(payload); setStep(2); } : async (payload) => {
          const ok = await onSubmit(payload);
          if (ok !== false) clearDraftState(draftKey);
          return ok;
        }}
        onValuesChange={(vals) => { setLiveValues(vals); onDirty?.(); }}
        submitLabel={reviewStep ? 'Next' : submitLabel}
        title={formTitle}
      />
    </>
  );

  // reviewStep forms skip the persistent side panel entirely — step 1 gets
  // the form full-width (no vehicle card competing for space while typing),
  // and step 2 (above) folds the vehicle card back in alongside the summary.
  const useSideLayout = (hasContext || showDomainPreview || reserveVehiclePreview) && !reviewStep;

  // Live preview of what a vehicle's own Add/Edit form will ask for once
  // it's assigned this Vehicle Type — so picking Land vs Water here shows
  // its consequence immediately, instead of only being discovered later
  // when actually adding a vehicle of this type.
  const previewDomain = liveValues?.domain || 'Land';
  const domainPreviewFields = [
    { label: plateFieldLabel(previewDomain), note: previewDomain === 'Water' ? 'registration / hull number' : 'plate number' },
    { label: 'Capacity', note: `in ${capacityUnits(previewDomain).join(', ')}` },
    ...vehicleDomainFields(previewDomain).map((f) => ({ label: f.label, note: f.options ? f.options.slice(0, 3).join(', ') + (f.options.length > 3 ? '…' : '') : 'free text' })),
  ];

  return (
    <ModulePanel description={description}>
      {useSideLayout ? (
        <div className={`form-context-layout${reserveVehiclePreview ? ' form-context-layout--reserved' : ''}`}>
          <div className="form-context-side">
            {showDomainPreview ? (
              <section className="veh-card">
                <div className="veh-card-head"><Icon name={vehicleIconName(previewDomain)} size={16} /><h4>{previewDomain} Vehicle Fields</h4></div>
                <p className="muted" style={{ margin: '0 0 10px', fontSize: '0.8rem' }}>
                  A vehicle assigned this type will additionally ask for:
                </p>
                <dl className="veh-kv">
                  {domainPreviewFields.map((f) => (
                    <div key={f.label}><dt>{f.label}</dt><dd>{f.note}</dd></div>
                  ))}
                </dl>
              </section>
            ) : null}
            {/* Edit only — so a rename/domain change doesn't blindly affect
                a whole fleet without the Admin realizing it first. */}
            {showDomainPreview && categoryVehicleCount != null && (
              <section className="veh-card">
                <div className="veh-card-head"><Icon name="vehicle" size={16} /><h4>Vehicles Using This Type</h4></div>
                <p style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700 }}>{categoryVehicleCount}</p>
                <p className="muted" style={{ margin: '4px 0 0', fontSize: '0.8rem' }}>
                  {categoryVehicleCount ? 'Renaming or switching domain affects every one of these.' : 'No vehicles assigned this type yet.'}
                </p>
              </section>
            )}
            {showDomainPreview ? null : vehicle ? (
              vehicleInfoCard
            ) : (
              <section className="veh-card form-context-empty">
                {compactVehiclePreview && <div className="veh-card-head"><Icon name="vehicle" size={16} /><h4>Vehicle preview</h4></div>}
                <Icon name="vehicle" size={30} />
                <p>Select a vehicle in the form and its photo, details, and location will show here.</p>
              </section>
            )}

            {vehicle && !showDomainPreview && !compactVehiclePreview && (
              <section className="veh-card">
                <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>Entry Summary</h4></div>
                <dl className="veh-kv">
                  {resolvedFields.filter((f) => f.name !== 'vehicle_id' && f.type !== 'file').map((f) => {
                    const val = formSummaryValue(f, liveValues?.[f.name]);
                    return (
                      <div key={f.name}>
                        <dt>{f.label}</dt>
                        <dd className={val ? 'summary-val' : 'summary-empty'}>{val ?? '—'}</dd>
                      </div>
                    );
                  })}
                </dl>
              </section>
            )}

            {compactVehiclePreview && vehicleLocationCard}

          </div>
          <div className="form-context-form-col">
            <div className={`form-grid-2col form-context-form${wrapperClassName ? ` ${wrapperClassName}` : ''}`}>{form}</div>
            {/* Stacked below the form fields, inside the same column, so it
                fills the free space the form's shorter height leaves behind
                instead of floating full-width beneath both columns. */}
            {!compactVehiclePreview && vehicleLocationCard}
          </div>
        </div>
      ) : (
        <div className={`form-grid-2col${wrapperClassName ? ` ${wrapperClassName}` : ''}`}>{form}</div>
      )}
    </ModulePanel>
  );
}

function vehicleFields(lookups, allHubs = [], domain = 'Land', existingPhotoUrl = null, category = null) {
  const hubOptions = allHubs.map((hub) => ({ value: hub.name, label: hub.name }));

  return [
    { label: 'Vehicle Name', name: 'vehicle_name', required: true, type: 'text', group: 'Vehicle identity' },
    { label: plateFieldLabel(domain), name: 'plate_number', required: true, type: 'text', maxLength: 10, group: 'Vehicle identity' },
    { label: 'Vehicle Type', name: 'category_id', options: lookups.categories ?? [], required: true, type: 'creatable-select', group: 'Vehicle identity',
      newItemLabel: 'vehicle type', catalogEndpoint: '/categories', idField: 'category_id', nameField: 'category_name', valueIsId: true,
      extraFields: [{ name: 'domain', label: 'Domain', options: ['Land', 'Water'], required: true, default: domain }],
    },
    { label: 'Operational Criticality (override)', name: 'criticality', options: [...CRITICALITY_LEVELS, 'Inherit'], type: 'select', group: 'Vehicle identity', hint: 'Choose Inherit to use the Vehicle Type default.' },
    { label: 'Vehicle Photo', name: 'photo', accept: 'image/*', type: 'file', existingUrl: existingPhotoUrl, group: 'Vehicle photo' },
    { label: 'Brand', name: 'brand', required: true, type: 'text', group: 'Technical details' },
    { label: 'Model', name: 'model', required: true, type: 'text', group: 'Technical details' },
    { label: 'Year Model', name: 'year_model', required: true, type: 'number', group: 'Technical details' },
    { label: 'Capacity', name: 'capacity', required: true, type: 'quantity', units: capacityUnits(domain), group: 'Technical details' },
    // #10 — optional; without it, lifetime-cost-vs-value (decommission signal)
    // simply has nothing to compare against and is skipped for this vehicle.
    { label: 'Acquisition Cost (optional)', name: 'acquisition_cost', type: 'number', placeholder: 'e.g. 850000', group: 'Technical details' },
    { label: 'Vehicle Color', name: 'vehicle_color', required: true, type: 'text', group: 'Technical details' },
    ...vehicleDomainFields(domain).map((field) => ({ ...field, group: 'Technical details' })),
    ...customFieldInputs(category, 'Technical details'),
    {
      label: 'Current Location', name: 'current_location', options: hubOptions, required: true, type: 'select', group: 'Location & service availability',
      // Full-width (not inline in the select's own half-column) — this map
      // needs real width to read as a map, not a cramped strip. Reflects
      // whatever is currently picked, not just what the vehicle loaded
      // with — re-looks-up the hub from the live form value on every
      // change, so switching the dropdown always re-populates it.
      extra: (vals) => {
        const hub = allHubs.find((h) => h.name === vals.current_location);
        return hub ? (
          <div className="veh-map-wrap" style={{ height: 320 }}>
            <VehicleLocationMap lat={hub.lat} lng={hub.lng} label={hub.name} />
          </div>
        ) : null;
      },
    },
    // Production-readiness audit finding #7 — was accepted by the API and
    // shown read-only on the profile, but had no way to actually be edited.
    { label: 'Remarks (optional)', name: 'remarks', type: 'textarea', group: 'Location & service availability' },
  ];
}

function conditionFields(lookups, editing = false) {
  const vehicles = vehicleOptions(lookups).map((option) => {
    const vehicle = lookups.vehicles.find((row) => String(row.vehicle_id) === String(option.value));
    const blocked = !editing && vehicle?.has_open_maintenance_ticket;
    return { ...option, disabled: Boolean(blocked), label: blocked ? `${option.label} — Open maintenance ticket` : option.label };
  });
  return [
    { label: 'Vehicle', name: 'vehicle_id', options: vehicles, required: true, type: 'select' },
    { label: 'Condition Result', name: 'condition_result', options: lookups.condition_results, required: true, type: 'select' },
    { label: 'Observations', name: 'observations', type: 'textarea' },
  ];
}

function issueFields(lookups, editTarget, role, onAddVehicle) {
  if (editTarget?.issue_report_id && role === 'Custodian') {
    return [
      { label: 'Issue Type', name: 'issue_type', options: lookups.issue_types, required: true, type: 'catalog-or-other', otherNoteField: 'remarks', otherNoteLabel: 'Describe the issue/type' },
      // A list, not one paragraph — each row becomes its own line-item, so
      // when this report is later converted into a Pre-Diagnosed ticket,
      // every distinct problem lands as its own sub-issue instead of the
      // whole description getting dumped into a single sub-issue.
      { label: 'Issues Found', name: 'issue_description', required: true, type: 'list', placeholder: 'e.g. Low coolant level', addLabel: 'Add another issue' },
      { label: 'Severity Level', name: 'severity_level', options: lookups.severity_levels, required: true, type: 'select' },
      { label: 'Files', name: 'attachments', type: 'multi-file', existingAttachments: editTarget.attachments },
    ];
  }

  if (editTarget?.issue_report_id || role === 'Maintenance Personnel') {
    return [
      { label: 'Status', name: 'status', options: lookups.issue_statuses, required: true, type: 'select' },
      { label: 'Remarks', name: 'remarks', type: 'textarea' },
    ];
  }

  return [
    {
      label: 'Vehicle', name: 'vehicle_id', options: vehicleOptions(lookups), required: true, type: 'select',
      // Only offered to whoever actually holds vehicle.create (Admin, and a
      // Custodian) — anyone else would just hit a permissions wall.
      action: onAddVehicle ? { label: '+ Add Vehicle', onClick: onAddVehicle } : undefined,
    },
    (role === 'Admin'
      ? { label: 'Issue Type', name: 'issue_type', options: lookups.issue_types, required: true, type: 'creatable-select', newItemLabel: 'issue type', catalogEndpoint: '/fault-categories' }
      : { label: 'Issue Type', name: 'issue_type', options: lookups.issue_types, required: true, type: 'catalog-or-other', otherNoteField: 'remarks', otherNoteLabel: 'Describe the issue/type' }),
    { label: 'Issue Description', name: 'issue_description', required: true, type: 'textarea' },
    { label: 'Severity Level', name: 'severity_level', options: lookups.severity_levels, required: true, type: 'select' },
    { label: 'Files', name: 'attachments', type: 'multi-file' },
  ];
}

// "Repair Type" is a single virtual selector standing in for two genuinely
// independent backend facts — which vehicle a part came off of, vs. who
// performed the labor — that used to render as two separate dropdowns next
// to each other and read as related when they weren't. repairTypeOf derives
// the selector's value from an existing record (for editing); applyRepairType
// converts it back to the real is_external/source_vehicle_id fields the
// backend expects (for submitting). See FleetController::storeMaintenanceRecord.
function repairTypeOf(record) {
  if (record?.source_vehicle_id) return 'cannibalized';
  if (record?.is_external === 1 || record?.is_external === true || record?.is_external === '1') return 'external';
  return 'in_house';
}

function withRepairType(record) {
  if (!record) return EMPTY_OBJ;
  return { ...record, repair_type: repairTypeOf(record) };
}

function applyRepairType(payload) {
  const { repair_type, ...rest } = payload;
  if (repair_type === 'cannibalized') return { ...rest, is_external: 0 };
  if (repair_type === 'external') return { ...rest, is_external: 1, source_vehicle_id: null };
  return { ...rest, is_external: 0, source_vehicle_id: null };
}

// "Performed By" (Admin-only, select-or-other) shares one field name for two
// mutually-exclusive backend facts: a registered user's id, or a free-text
// name for someone outside the system entirely (a volunteer, an outside
// helper). withPerformedBy seeds the field from whichever the existing
// record actually has (for editing); applyPerformedBy sorts a submitted
// value back into the right one of the two real columns — a plain numeric
// string is treated as a picked user id, anything else as typed "Other"
// text. See FleetController::storeMaintenanceRecord.
function withPerformedBy(record) {
  if (!record) return EMPTY_OBJ;
  return { ...record, maintenance_personnel_id: record.maintenance_personnel_id ?? record.performed_by_other ?? '' };
}

function applyPerformedBy(payload) {
  if (!('maintenance_personnel_id' in payload)) return payload;
  const raw = payload.maintenance_personnel_id;
  const isOther = raw !== '' && raw != null && !/^\d+$/.test(String(raw));
  if (isOther) return { ...payload, maintenance_personnel_id: null, performed_by_other: raw };
  return { ...payload, performed_by_other: null };
}

function maintenanceFields(lookups, role, liveValues = EMPTY_OBJ) {
  const fields = [
    // Leads the form instead of trailing after Parts/Materials Used — it's
    // the single choice that decides which other fields even show up (Source
    // Vehicle for a cannibalized part, vendor/warranty for an external shop),
    // so it belongs first, not buried past fields that don't depend on it.
    // In place of the old "Source Vehicle" + "External Repair?" dropdowns
    // sitting side by side, which read as related when they weren't.
    // Full-width so its follow-up field(s) clearly read as belonging to it,
    // on their own row directly underneath, instead of sharing a row side by side.
    {
      label: 'Repair Type',
      name: 'repair_type',
      type: 'select',
      fullWidth: true,
      group: 'Repair Details',
      options: [
        { value: 'in_house', label: 'In-House Repair' },
        { value: 'cannibalized', label: 'Used Cannibalized Part' },
        { value: 'external', label: 'Sent to External Shop' },
      ],
    },
    { label: 'Vehicle', name: 'vehicle_id', options: vehicleOptions(lookups), required: true, type: 'select', group: 'Vehicle & Issue' },
    { label: 'Related Issue Report', name: 'issue_report_id', options: issueOptions(), type: 'select', group: 'Vehicle & Issue' },
    { label: 'Maintenance Type', name: 'maintenance_type', options: lookups.maintenance_types, required: true, type: 'creatable-select', newItemLabel: 'maintenance type', catalogEndpoint: '/maintenance-types', group: 'Vehicle & Issue' },
    { label: 'Problem / Reason', name: 'problem_reason', required: true, type: 'textarea', group: 'Work Log' },
    { label: 'Date Started', name: 'date_started', type: 'date', group: 'Schedule & Personnel' },
    { label: 'Date Completed', name: 'date_completed', type: 'date', group: 'Schedule & Personnel' },
    { label: 'Action Taken', name: 'action_taken', type: 'textarea', group: 'Work Log' },
    {
      label: 'Parts / Materials Used',
      name: 'parts_used',
      type: 'list',
      group: 'Work Log',
      placeholder: 'e.g. Brake pads',
      addLabel: 'Add another part',
      removeLabel: 'part',
    },
    { label: 'Maintenance Cost (PHP)', name: 'maintenance_cost', type: 'number', min: 0, placeholder: 'e.g. 1500', group: 'Cost & Completion' },
    // Proof-of-completion fast close: what actually justifies skipping
    // Custodian verification is that something REAL is attached — a receipt
    // for an external shop repair, or a photo of the finished work for an
    // in-house fix (e.g. a roadside tire change). Either counts; a typed
    // note does not, so this isn't gated behind Repair Type — only its
    // label/hint change to match, so it's obvious which kind of proof is
    // expected instead of a generic either/or description every time.
    {
      label: liveValues?.repair_type === 'external' ? 'Receipt (Proof of Payment)' : 'Photo of Completed Repair',
      name: 'receipt',
      type: 'file',
      accept: '.jpg,.jpeg,.png,.pdf',
      group: 'Cost & Completion',
      hint: liveValues?.repair_type === 'external'
        ? "Attach the shop's receipt, then set Progress Status to Completed — this closes the record immediately with no separate verification step."
        : 'Attach a photo of the completed repair, then set Progress Status to Completed — this closes the record immediately with no separate verification step.',
    },
    { label: 'Progress Status', name: 'progress_status', options: lookups.maintenance_statuses, type: 'select', group: 'Cost & Completion' },
    { label: 'Remarks', name: 'remarks', type: 'textarea', group: 'Cost & Completion' },
  ];

  if (role === 'Admin') {
    fields.splice(fields.findIndex((f) => f.name === 'action_taken'), 0, {
      label: 'Performed By',
      name: 'maintenance_personnel_id',
      options: options(lookups.maintenance_performers, 'id', 'name'),
      required: true,
      type: 'select-or-other',
      otherLabel: 'Other (not in system)',
      otherPlaceholder: 'e.g. a volunteer or outside helper\'s name',
      group: 'Schedule & Personnel',
      hint: 'Whoever actually did the repair — not necessarily Maintenance Personnel; a Custodian or Admin who fixed it themselves belongs here too. Not registered in the system at all? Pick Other and type their name.',
    });
  }

  // Only one of these ever applies at a time — that's the whole point of
  // collapsing them into one selector above instead of two independent
  // toggles that could (confusingly) both be filled in at once.
  const repairTypeIndex = fields.findIndex((f) => f.name === 'repair_type');
  if (liveValues?.repair_type === 'cannibalized') {
    // Required — "cannibalized" only means something once we know which
    // vehicle the part actually came from.
    fields.splice(repairTypeIndex + 1, 0, {
      label: 'Source Vehicle',
      name: 'source_vehicle_id',
      options: vehicleOptions(lookups).filter((v) => String(v.value) !== String(liveValues?.vehicle_id)),
      type: 'select',
      required: true,
      group: 'Repair Details',
      hint: 'Which vehicle the part was taken from.',
    }, {
      label: 'Part Taken From Donor',
      name: 'part_name',
      type: 'text',
      required: true,
      placeholder: 'e.g. Alternator, Brake caliper',
      group: 'Repair Details',
      hint: 'Which specific part was removed from the source vehicle.',
    });
  } else if (liveValues?.repair_type === 'external') {
    // Vendor required — can't log an external repair without knowing which
    // shop it went to. Warranty stays optional; not every repair carries one.
    fields.splice(repairTypeIndex + 1, 0,
      { label: 'External Shop', name: 'external_vendor', type: 'text', placeholder: 'e.g. Bautista Auto Shop', required: true, group: 'Repair Details' },
      { label: 'Warranty Until', name: 'warranty_until', type: 'date', group: 'Repair Details' },
    );
  }

  // No matching Issue Report yet (e.g. a mechanic self-filing a field repair
  // with nothing on file) — let them create one instead of leaving this
  // module and losing their in-progress record. Picking "+ Add New Issue…"
  // pops the modal open immediately and only asks for Issue Type — the new
  // report's description/severity come from this same form's Problem/Reason
  // and a default (see submitFormPage), not asked for a second time.
  if (liveValues?.issue_report_id === NEW_ISSUE_OPTION.value) {
    const issueReportIndex = fields.findIndex((f) => f.name === 'issue_report_id');
    fields.splice(issueReportIndex + 1, 0,
      {
        label: 'New Issue Type',
        name: '__new_issue_group__',
        required: true,
        type: 'new-issue-modal',
        issueTypeOptions: lookups.issue_types,
        fullWidth: true,
        group: 'Vehicle & Issue',
      },
    );
  }

  return fields;

  function issueOptions() {
    return [
      NEW_ISSUE_OPTION,
      ...(lookups.issue_reports ?? []).map((issue) => ({
        value: issue.issue_report_id,
        label: `#${issue.issue_report_id} ${issue.issue_type}`,
      })),
    ];
  }
}

const NEW_ISSUE_OPTION = { value: '__new_issue__', label: '+ Add New Issue…' };

function scheduleFields(lookups, allHubs = [], isEdit = false, suggestOnly = false, status = null) {
  const hubOptions = allHubs.map((hub) => ({ value: hub.name, label: hub.name }));

  // A Custodian's suggestion only needs what Admin must see: which vehicle,
  // what, roughly when, and why.
  const keep = suggestOnly ? ['vehicle_id', 'maintenance_type', 'scheduled_date', 'notes'] : null;
  const all = [
    { label: 'Vehicle', name: 'vehicle_id', options: vehicleOptions(lookups), required: true, type: 'select', group: '1. Vehicle & maintenance' },
    { label: 'Maintenance Type', name: 'maintenance_type', options: lookups.maintenance_types, required: true, type: 'creatable-select', newItemLabel: 'maintenance type', catalogEndpoint: '/maintenance-types', group: '1. Vehicle & maintenance' },
    { label: 'Scheduled Date', name: 'scheduled_date', required: true, type: 'date', group: '2. Date & recurrence' },
    { label: 'Scheduled Time', name: 'scheduled_time', type: 'time', group: '2. Date & recurrence' },
    // Recurring PM: completing this schedule auto-creates the next at the chosen
    // interval. Left blank = one-time (the default "Select" option).
    {
      label: 'Repeat Every (optional)',
      name: 'recurrence_months',
      group: '2. Date & recurrence',
      fullWidth: true,
      hint: 'Leave blank for a one-time schedule.',
      type: 'select-or-other',
      options: [
        { value: 1, label: 'Month' },
        { value: 3, label: 'Quarter (3 months)' },
        { value: 6, label: '6 Months' },
        { value: 12, label: 'Year' },
      ],
      otherLabel: 'Add Custom Month',
      otherInputLabel: 'Repeat every how many months? (1–60)',
      otherPlaceholder: 'e.g. 4',
      otherSuffix: 'months',
      otherType: 'number',
      otherMin: 1,
      otherMax: 60,
    },
    // A known hub, or "Other" for an outside repair shop not in that list.
    { label: 'Service Location', name: 'service_location', type: 'select-or-other', options: hubOptions, otherLabel: 'Other / External Shop', otherPlaceholder: 'e.g. Toyota Service Center', group: '3. Location & assignment' },
    { label: 'Assigned To', name: 'assigned_to', options: options(lookups.maintenance_personnel, 'id', 'name'), type: 'select', group: '3. Location & assignment' },
    // Status transitions use dedicated actions to preserve approval and proof of work.
    { label: 'Notes', name: 'notes', type: 'textarea', placeholder: 'Add preparation, symptoms, or instructions for the mechanic.', group: '4. Notes' },
  ];
  return all.filter((f) => (!isEdit || status !== 'Scheduled' || f.name !== 'assigned_to') && (!keep || keep.includes(f.name)));
}

const REPORT_CATALOG = [
  {
    category: 'Fleet Reports',
    icon: 'vehicle',
    reports: [
      { type: 'Vehicle Inventory Report', icon: 'grid', description: 'Full list of every registered vehicle.', fields: [] },
      { type: 'Vehicle Type Report', icon: 'list', description: 'Vehicles filtered by vehicle type.', fields: ['category_id'] },
      { type: 'Vehicle Location Report', icon: 'pin', description: 'Vehicles filtered by current location.', fields: ['location'] },
    ],
  },
  {
    category: 'Issue Reports',
    icon: 'alert',
    reports: [
      { type: 'Vehicle Issue Report', icon: 'alert', description: 'Reported issues filtered by type, severity, and date.', fields: ['issue_type', 'severity_level', 'dates'] },
    ],
  },
  {
    category: 'Maintenance Reports',
    icon: 'wrench',
    reports: [
      { type: 'Vehicle Maintenance Report', icon: 'wrench', description: 'Repair records filtered by maintenance type and date.', fields: ['maintenance_type', 'dates'] },
      { type: 'Vehicle Maintenance Schedule Report', icon: 'calendar', description: 'Scheduled maintenance within a date range.', fields: ['dates'] },
    ],
  },
  {
    category: 'History Reports',
    icon: 'clipboard',
    reports: [
      { type: 'Vehicle History Report', icon: 'archive', description: 'Full activity timeline across every vehicle.', fields: [] },
    ],
  },
];

function reportFieldDefs(lookups, reportDef) {
  if (!reportDef) return [];
  const defs = [];
  if (reportDef.fields.includes('dates')) {
    defs.push({ label: 'Date From', name: 'from', type: 'date' });
    defs.push({ label: 'Date To', name: 'to', type: 'date' });
  }
  if (reportDef.fields.includes('category_id')) {
    defs.push({ label: 'Vehicle Type', name: 'category_id', options: options(lookups.categories, 'category_id', 'category_name'), type: 'select' });
  }
  if (reportDef.fields.includes('location')) {
    defs.push({ label: 'Location', name: 'location', type: 'text' });
  }
  if (reportDef.fields.includes('maintenance_type')) {
    defs.push({ label: 'Maintenance Type', name: 'maintenance_type', options: lookups.maintenance_types, type: 'select' });
  }
  if (reportDef.fields.includes('issue_type')) {
    defs.push({ label: 'Issue Type', name: 'issue_type', options: lookups.issue_types, type: 'select' });
  }
  if (reportDef.fields.includes('severity_level')) {
    defs.push({ label: 'Severity Level', name: 'severity_level', options: lookups.severity_levels, type: 'select' });
  }
  return defs;
}

// Cycled per category (not stored on REPORT_CATALOG itself) so adding a
// fifth category just wraps back to blue rather than needing a color picked
// for it — same reasoning as the chart palettes elsewhere in this file.
const REPORT_CATEGORY_TONES = ['blue', 'green', 'purple', 'amber'];

function ReportsModule({ lookups, onGenerate }) {
  // Only one report's form is open at a time, across all categories — same
  // "pick one thing to act on" feel as the reference's report catalog,
  // and it means Generate only ever appears once on screen.
  const [expandedType, setExpandedType] = useState(null);

  return (
    <div className="report-catalog-grid">
      {REPORT_CATALOG.map((group, i) => (
        <section key={group.category} className={`report-category-card tone-${REPORT_CATEGORY_TONES[i % REPORT_CATEGORY_TONES.length]}`}>
          <div className="report-category-card-head">
            <span className="report-category-card-icon"><Icon name={group.icon} size={16} /></span>
            <h4>{group.category}</h4>
            <span className="report-category-count">{group.reports.length}</span>
          </div>
          <div className="report-category-card-body">
            {group.reports.map((r) => {
              const isOpen = expandedType === r.type;
              return (
                <div key={r.type} className={`report-type-row${isOpen ? ' is-open' : ''}`}>
                  <button
                    type="button"
                    className="report-type-item"
                    onClick={() => setExpandedType((t) => (t === r.type ? null : r.type))}
                    aria-expanded={isOpen}
                  >
                    <span className="report-type-icon"><Icon name={r.icon} size={15} /></span>
                    <span className="report-type-text">
                      <strong>{r.type}</strong>
                      <span>{r.description}</span>
                    </span>
                    <Icon name="chevronDown" size={14} className={isOpen ? 'is-expanded' : ''} />
                  </button>
                  {isOpen && (
                    <div className="report-generator-panel">
                      <SmartForm
                        fields={reportFieldDefs(lookups, r)}
                        key={r.type}
                        onSubmit={(values) => onGenerate({ report_type: r.type, ...values })}
                        submitLabel="Generate Report"
                        title=""
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

// Icon/color per dashboard top-metric label, keyed by the exact label text the
// backend returns (varies per role) — falls back to a plain blue chip for any
// label not explicitly mapped.



const ISSUE_STAT_CARDS = [
  { key: 'Pending', label: 'Pending', icon: 'alert', bg: '#fef3c7', color: '#d97706' },
  { key: 'Under Review', label: 'Under Review', icon: 'search', bg: '#e0f2fe', color: '#0284c7' },
  { key: 'In Maintenance', label: 'In Maintenance', icon: 'wrench', bg: '#fee2e2', color: '#dc2626' },
  { key: 'Resolved', label: 'Resolved', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
];

// Keep the schedule overview to Total plus these three status groups.
const SCHEDULE_STAT_CARDS = [
  { key: 'Scheduled', label: 'Scheduled', icon: 'calendar', bg: '#dbeafe', color: '#1d4ed8' },
  { key: 'AwaitingVerification', label: 'Awaiting Verification', icon: 'search', bg: '#fef9c3', color: '#854d0e' },
  { key: 'Closed', label: 'Closed / Cancelled', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
];

const VEHICLE_STAT_CARDS = [
  { key: 'Available', label: 'Available', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
  { key: 'Under Maintenance', label: 'Under Maintenance', icon: 'wrench', bg: '#fef3c7', color: '#d97706' },
  { key: 'Inactive', label: 'Inactive', icon: 'archive', bg: '#fee2e2', color: '#dc2626' },
  // Distinct from "Available" — a vehicle can be Available yet never (or no
  // longer) proven ready by an actual readiness check. See responseReadinessState().
  { key: 'ReadyToRespond', label: 'Ready to Respond', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
  { key: 'NotReady', label: 'Not Ready to Respond', icon: 'alert', bg: '#fee2e2', color: '#dc2626' },
];

const CONDITION_STAT_CARDS = [
  { key: 'Good', label: 'Good', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
  { key: 'Needs Repair', label: 'Needs Repair', icon: 'wrench', bg: '#fef3c7', color: '#d97706' },
  { key: 'Not Checked', label: 'Not Checked', icon: 'eyeOff', bg: '#f1f5f9', color: '#64748b' },
];

const MAINTENANCE_RECORD_STAT_CARDS = [
  { key: 'In-House Repair', label: 'In-House Repair', icon: 'wrench', bg: '#fef3c7', color: '#d97706' },
  { key: 'External Shop', label: 'Sent to External Shop', icon: 'vehicle', bg: '#e0f2fe', color: '#0284c7' },
  { key: 'Scheduled Maintenance', label: 'Maintenance Schedule', icon: 'calendar', bg: '#dcfce7', color: '#16a34a' },
];

// 'Open' removed — no new ticket ever reaches that status (propose goes
// straight to Pending Approval); it only ever existed on tickets created
// before the one-mechanic-per-ticket redesign.
const TICKET_STAT_CARDS = [
  { key: 'Pending Approval', label: 'Proposals', icon: 'clipboard', bg: '#fef3c7', color: '#92400e' },
  // "For Verification" was here, but that's a Custodian action, not
  // something Admin does anything with — Declined is the one Admin needs a
  // quick count of, since those proposals are waiting on a reconsider.
  { key: 'Declined', label: 'Declined', icon: 'close', bg: '#fee2e2', color: '#dc2626' },
  { key: 'Active', label: 'Active', icon: 'wrench', bg: '#dbeafe', color: '#1e40af' },
  { key: 'Closed', label: 'Closed', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
  { key: 'Cancelled', label: 'Cancelled', icon: 'close', bg: '#f1f5f9', color: '#64748b' },
];

const TICKET_INSPECTION_STAT_CARDS = [
  { key: 'Pending', label: 'Pending', icon: 'search', bg: '#fef3c7', color: '#d97706' },
  // Label says "Diagnosed", not "Inspected" — this bucket also holds
  // Pre-Diagnosed tickets this Custodian never actually inspected (the key
  // stays 'Inspected' since that's what the status !== 'Open' filter above
  // keys off of).
  { key: 'Inspected', label: 'Diagnosed', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
];

// Work orders are counted per TICKET (not per sub-issue), by where the ticket
// stands for this mechanic: Pending = still being repaired (Active),
// Submitted = repair logged, waiting on the Custodian (For Verification),
// Completed = verified and closed. Total is every ticket assigned to them.
const WORK_ORDER_BUCKET_STATUS = { Pending: 'Active', Submitted: 'For Verification', Completed: 'Closed' };
const VERIFICATION_BUCKET_STATUS = { Active: 'Active', Pending: 'For Verification', Verified: 'Closed' };
const TICKET_WORK_ORDER_STAT_CARDS = [
  { key: 'Pending', label: 'Pending', icon: 'wrench', bg: '#fef3c7', color: '#d97706' },
  { key: 'Submitted', label: 'Submitted', icon: 'search', bg: '#ede9fe', color: '#7c3aed' },
  { key: 'Completed', label: 'Completed', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
];

// 'Pending' relabeled 'To Verify' — this is the Custodian's verification
// queue (For Verification tickets), same term the Dashboard's own stat uses
// for it; the old label read as just another ticket-status bucket instead
// of the one that needs this Custodian's action.
const TICKET_VERIFICATION_STAT_CARDS = [
  { key: 'Active', label: 'Active', icon: 'wrench', bg: '#dbeafe', color: '#1e40af' },
  { key: 'Pending', label: 'To Verify', icon: 'checkCircle', bg: '#fef3c7', color: '#d97706' },
  { key: 'Verified', label: 'Verified', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
];

// My Tasks -> History: a closed book, not a live board — every bucket here
// is already finished, so the cards break down HOW it finished rather than
// repeating "needs action"/"in progress" counts that would always read 0.
const WORK_TRACKER_STAT_CARDS = [
  { key: 'Done', label: 'Done', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
  { key: 'Deferred', label: 'Deferred', icon: 'alert', bg: '#fef3c7', color: '#d97706' },
];

// Reusable "Total + clickable status breakdown" card row, sitting above a
// module's table, matching the Vehicle Management stat cards exactly.
// `cards` is [{ key, label, icon, bg, color }]; `counts` maps key -> number;
// clicking a card toggles `activeFilter` via `onFilterChange`.
function ModuleStatCards({ totalLabel = 'Total', total, cards, counts, activeFilter, onFilterChange, gridClassName = '', readOnly = false }) {
  if (readOnly) return (
    <section className={`metric-grid stat-one-line ${gridClassName}`} aria-label="Status summary" style={{ marginBottom: 16, '--stat-cols': cards.length + 1 }}>
      {[{ key: 'total', label: totalLabel, icon: 'grid', bg: '#dbeafe', color: '#1d4ed8' }, ...cards].map(({ key, label, icon, bg, color }) => (
        <div key={key} className="metric-card metric-card-iconic ticket-summary-metric">
          <span className="metric-card-icon" style={{ background: bg, color }}><Icon name={icon} size={18} /></span>
          <div className="metric-card-body"><span>{label}</span><strong>{key === 'total' ? total : counts[key] ?? 0}</strong></div>
        </div>
      ))}
    </section>
  );
  const isFilterMulti = Array.isArray(activeFilter);
  const isTotalActive = isFilterMulti ? activeFilter.length === 0 : !activeFilter;
  return (
    <section className={`metric-grid stat-one-line${gridClassName ? ` ${gridClassName}` : ''}`} aria-label="Status summary" style={{ marginBottom: '16px', '--stat-cols': cards.length + 1 }}>
      <button
        type="button"
        className={`metric-card metric-card-iconic stat-filter-card${isTotalActive ? ' is-active' : ''}`}
        style={{
          cursor: 'pointer',
          boxShadow: isTotalActive ? '0 0 0 2px #2563eb' : undefined,
        }}
        onClick={() => onFilterChange(isFilterMulti ? [] : '')}
        title={`Show all ${totalLabel.replace(/^Total\s*/i, '') || 'items'}`.trim()}
      >
        <span className="metric-card-icon is-total">
          <Icon name="grid" size={18} />
        </span>
        <div className="metric-card-body">
          <span>{totalLabel}</span>
          <strong>{total}</strong>
        </div>
      </button>
      {cards.map(({ key, label, icon, bg, color }) => {
        // activeFilter is a plain string in some modules (a dedicated
        // single-purpose bucket filter) and an array in others (the shared
        // filter state now that FilterBar's dropdowns are multi-select) —
        // support both without forcing every caller to convert.
        const isMulti = Array.isArray(activeFilter);
        const isActive = isMulti ? (activeFilter.length === 1 && activeFilter[0] === key) : activeFilter === key;
        return (
          <button
            key={key}
            type="button"
            className={`metric-card metric-card-iconic stat-filter-card${isActive ? ' is-active' : ''}`}
            style={{
              cursor: 'pointer',
              boxShadow: isActive ? `0 0 0 2px ${color}` : undefined,
            }}
            onClick={() => onFilterChange(isActive ? (isMulti ? [] : '') : (isMulti ? [key] : key))}
            title={`Filter: ${label}`}
          >
            <span className="metric-card-icon" style={{ background: bg, color }}>
              <Icon name={icon} size={18} />
            </span>
            <div className="metric-card-body">
              <span>{label}</span>
              <strong>{counts[key] ?? 0}</strong>
            </div>
          </button>
        );
      })}
    </section>
  );
}

function vehicleColumns(user, onEdit, deleteRecord, restoreRecord, filterStatus, onViewTicket, onReadinessCheck) {
  const columns = [
    { key: 'id', label: 'ID', locked: true, className: 'cell-center', render: (row) => recordNumber(row, 'vehicle_id') },
    { key: 'type', label: 'Type', render: (row) => row.category?.category_name ?? 'Unassigned' },
    { key: 'brand_model', label: 'Brand / Model', render: (row) => `${row.brand} ${row.model}` },
    {
      key: 'vehicle',
      label: 'Vehicle',
      locked: true,
      render: (row) => (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
          <PhotoCell alt={row.vehicle_name} url={row.photo_url} />
          <span className="row-title-text">{row.vehicle_name}</span>
        </div>
      ),
    },
    { key: 'plate', label: 'Plate Number', className: 'cell-center', render: (row) => row.plate_number },
    { key: 'capacity', label: 'Capacity', className: 'cell-center', render: (row) => row.capacity },
    { key: 'location', label: 'Location', render: (row) => row.current_location },
    {
      key: 'status',
      label: 'Status',
      className: 'cell-center',
      render: (row) => (
        // centered (not flex-start) so it lines up with every other badge
        // column — a plain <StatusBadge> centers on its own (see
        // `tbody td:has(> .status-badge)` in App.css), but wrapping it in
        // this div to stack the optional second badge below it opts back
        // out of that automatic centering, so it's set explicitly here.
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
          <StatusBadge value={row.status} />
          {/* "Under Maintenance" alone doesn't say whether a mechanic is
              still actively working on it, or the ticket has nothing left
              to do and is just waiting on Admin to click Close — often
              because the last item was deferred for an emergency and
              nobody circled back. This makes that second case visible at a
              glance instead of looking identical to genuine active repair. */}
          {row.awaiting_closure && (
            <span
              className="status-badge awaiting-closure"
              title="Every sub-issue on this vehicle's open ticket is resolved (done or deferred) — it's just waiting for Admin to click Close Ticket to return it to Available."
            >
              <Icon name="checkCircle" size={11} /> Awaiting Closure
            </span>
          )}
        </div>
      ),
    },
    { key: 'condition', label: 'Condition', className: 'cell-center', render: (row) => <StatusBadge value={row.condition} /> },
    {
      key: 'ready',
      label: 'Ready to Respond',
      // A custom-styled pill, not <StatusBadge>, so it misses the
      // `tbody td:has(> .status-badge)` auto-centering — centered
      // explicitly instead.
      className: 'cell-center',
      render: (row) => {
        const badge = READINESS_BADGE[row.readiness_state];
        if (!badge) return <span className="muted">—</span>;
        return (
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.74rem', fontWeight: 700, padding: '3px 9px', borderRadius: 0, background: badge.bg, color: badge.color, border: `1px solid ${badge.border}`, whiteSpace: 'nowrap' }}
            title={row.readiness_last_checked ? `Last checked ${formatDate(row.readiness_last_checked)}` : undefined}
          >
            <Icon name={badge.icon} size={11} /> {badge.label}
          </span>
        );
      },
    },
  ];


  if (filterStatus?.includes?.('Inactive')) {
    columns.push(
      { key: 'archived_at', label: 'Archived At', className: 'cell-center', render: (row) => <DateBadge value={row.archived_at} /> },
      { key: 'archived_by', label: 'Archived By', className: 'cell-center', render: (row) => <UserAvatarName user={row.archived_by} fallback="—" /> },
    );
  }

  const canEditVehicle = canDo(user, 'vehicle.edit');
  const canRestoreVehicle = canDo(user, 'vehicle.restore');
  const canArchiveVehicle = canDo(user, 'vehicle.archive');
  // Readiness checks are a Custodian's hands-on job — give them an Action
  // column even though they can't edit/restore/archive vehicles.
  const canCheckReadiness = canDo(user, 'vehicle.readiness_check') && !!onReadinessCheck;
  if (canEditVehicle || canRestoreVehicle || canArchiveVehicle || canCheckReadiness) {
    columns.push({
      key: 'action',
      label: 'Action',
      locked: true,
      className: 'cell-center',
      render: (row) => (
        <div className="row-actions">
          {/* Jumps straight to whatever ticket is keeping this vehicle
              unavailable — no need to go hunt for it in Maintenance Tickets.
              A same-size invisible spacer holds this slot when absent, so
              Edit/Delete always land in the same column across rows instead
              of shifting depending on whether a row has this button. */}
          {row.open_ticket_id && onViewTicket ? (
            <button className="btn-view-action icon-btn" onClick={() => onViewTicket({ ticket_id: row.open_ticket_id })} type="button" title={`View Ticket #${row.open_ticket_number ?? row.open_ticket_id}`} aria-label={`View Ticket #${row.open_ticket_number ?? row.open_ticket_id}`}><Icon name="ticket" size={14} /></button>
          ) : (
            <span className="icon-btn-spacer" aria-hidden="true" />
          )}
          {canCheckReadiness && (
            (row.status === 'Inactive' || row.status === 'Decommissioned') ? (
              <span className="icon-btn-spacer" aria-hidden="true" />
            ) : (
              <button className={`icon-btn ${row.can_confirm_readiness === false ? 'readiness-check-blocked' : 'btn-confirm-action'}`} onClick={() => onReadinessCheck(row)} type="button" title={row.readiness_block_reason || 'Record Readiness Check'} aria-label="Record Readiness Check"><Icon name={row.can_confirm_readiness === false ? 'alert' : 'checkCircle'} size={14} /></button>
            )
          )}
          {(row.status === 'Inactive' || row.status === 'Decommissioned') ? (
            canRestoreVehicle && (
              <button className="btn-edit-action icon-btn" onClick={() => restoreRecord(`/vehicles/${row.vehicle_id}/restore`, row.status === 'Decommissioned' ? 'Vehicle recommissioned.' : 'Vehicle restored.')} type="button" title={row.status === 'Decommissioned' ? 'Recommission' : 'Restore'} aria-label="Restore"><Icon name="undo" size={14} /></button>
            )
          ) : (
            canArchiveVehicle && (
              <button className="btn-archive-action icon-btn" onClick={() => deleteRecord(`/vehicles/${row.vehicle_id}`, 'Vehicle marked inactive.', `Deactivate ${row.vehicle_name}? It will be marked Inactive and can be restored later.`)} type="button" title="Deactivate (reversible)" aria-label="Deactivate"><Icon name="archive" size={14} /></button>
            )
          )}
        </div>
      ),
    });
  }

  return columns;
}

function categoryColumns(onEdit, deleteRecord) {
  return [
    { key: 'id', label: 'ID', width: '6%', locked: true, className: 'cell-center', render: (row) => row.category_id },
    { key: 'category', label: 'Vehicle Type', width: '18%', render: (row) => row.category_name },
    { key: 'domain', label: 'Domain', width: '10%', className: 'cell-center', render: (row) => <StatusBadge value={row.domain ?? 'Land'} /> },
    { key: 'vehicles', label: 'Vehicles', width: '9%', className: 'cell-center', render: (row) => row.vehicles_count ?? 0 },
    { key: 'description', label: 'Description', width: '49%', render: (row) => row.description ?? '-' },
    {
      key: 'action',
      label: 'Action',
      width: '8%',
      locked: true,
      className: 'cell-center',
      render: (row) => (
        <div className="row-actions">
          <button className="btn-edit-action icon-btn" onClick={() => onEdit(row)} type="button" title="Edit" aria-label="Edit"><Icon name="edit" size={14} /></button>
          <button className="btn-delete-action icon-btn" onClick={() => deleteRecord(`/categories/${row.category_id}`, 'Category deleted.', `Delete the "${row.category_name}" vehicle type? This cannot be undone.`)} type="button" title="Delete" aria-label="Delete"><Icon name="trash" size={14} /></button>
        </div>
      ),
    },
  ];
}

function userColumns(onEdit, onToggleActive, currentUserId) {
  return [
    { key: 'id', label: 'ID', locked: true, className: 'cell-center', render: (row) => recordNumber(row, 'id') },
    { key: 'user', label: 'User', locked: true, render: (row) => <UserAvatarName user={row} /> },
    { key: 'email', label: 'Email', render: (row) => row.email },
    { key: 'phone', label: 'Phone', className: 'cell-center', render: (row) => row.phone ?? '-' },
    { key: 'role', label: 'Role', className: 'cell-center', render: (row) => {
      const roles = (Array.isArray(row.roles) && row.roles.length) ? row.roles : [row.role].filter(Boolean);
      return (
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
          {roles.map((r) => <StatusBadge key={r} value={r} />)}
        </span>
      );
    } },
    { key: 'status', label: 'Status', className: 'cell-center', render: (row) => <StatusBadge value={row.is_active ? 'Active' : 'Inactive'} /> },
    {
      key: 'action',
      label: 'Action',
      locked: true,
      className: 'cell-center',
      render: (row) => (
        <div className="row-actions">
          <button className="btn-edit-action icon-btn" onClick={() => onEdit(row)} type="button" title="Edit" aria-label="Edit"><Icon name="edit" size={14} /></button>
          {row.id !== currentUserId && (
            row.is_active ? (
              <button className="btn-archive-action icon-btn" onClick={() => onToggleActive(row, false)} type="button" title="Deactivate (reversible)" aria-label="Deactivate"><Icon name="archive" size={14} /></button>
            ) : (
              <button className="btn-edit-action icon-btn" onClick={() => onToggleActive(row, true)} type="button" title="Activate" aria-label="Activate"><Icon name="undo" size={14} /></button>
            )
          )}
        </div>
      ),
    },
  ];
}

// Card-view counterpart to the Users table row — avatar, name, role(s), and
// contact details on a single clickable tile, mirroring TicketCard/
// MaintenanceRecordCard's click-to-edit convention for this module's card view.
function UserCard({ user: person, onClick }) {
  const initials = (person.name || '?').split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
  const roles = (Array.isArray(person.roles) && person.roles.length) ? person.roles : [person.role].filter(Boolean);

  return (
    <div className="user-card" onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <div className="user-card-avatar">
        {person.photo_url ? <img src={resolvePhotoUrl(person.photo_url)} alt={person.name} /> : <span>{initials}</span>}
      </div>
      <strong className="user-card-name">{person.name}</strong>
      <span className="user-card-role">{roles.join(', ') || '—'}</span>
      <span className="user-card-underline" />
      <div className="user-card-contact">
        <span>{person.phone || 'No phone on file'}</span>
        <a href={`mailto:${person.email}`} onClick={(e) => e.stopPropagation()}>{person.email}</a>
      </div>
      <StatusBadge value={person.is_active ? 'Active' : 'Inactive'} />
    </div>
  );
}

function locationColumns(currentUser, onViewOnMap, onEdit) {
  return [
  { key: 'id', label: 'ID', locked: true, className: 'cell-center', render: (row) => recordNumber(row, 'location_record_id') ?? 'Current' },
  { key: 'vehicle', label: 'Vehicle', locked: true, render: (row) => <VehicleCell vehicle={row.vehicle} /> }, { key: 'plate', label: 'Plate Number', className: 'cell-center', render: (row) => row.vehicle?.plate_number ?? '-' },
  { key: 'status', label: 'Status', className: 'cell-center', render: (row) => <StatusBadge value={row.vehicle?.status ?? '-'} /> },
  { key: 'current_location', label: 'Current Location', render: (row) => row.current_location ?? '-' },
  { key: 'address_area', label: 'Address / Area', render: (row) => row.address_area ?? '-' },
  {
    key: 'updated_by',
    label: 'Updated By',
    className: 'cell-center',
    render: (row) => <UserAvatarName user={row.is_current_snapshot ? currentUser : row.updated_by} />,
  },
  { key: 'date_updated', label: 'Date Updated', className: 'cell-center', render: (row) => <DateBadge value={row.updated_at} /> },
  { key: 'time', label: 'Time', className: 'cell-center', render: (row) => formatTime(row.updated_at) },
  {
    key: 'action',
    label: 'Action',
    locked: true,
    className: 'cell-center',
    render: (row) => (
      <div className="row-actions">
        {hasRole(currentUser, 'Admin') && (
          <button
            className="btn-edit-action icon-btn"
            onClick={() => onEdit(row)}
            title="Update this vehicle's location"
            aria-label="Update this vehicle's location"
            type="button"
          >
            <Icon name="edit" size={14} />
          </button>
        )}
        <button
          className="btn-view-action icon-btn"
          onClick={() => onViewOnMap(row)}
          title="View vehicle on map"
          aria-label="View vehicle on map"
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>
    ),
  },
  ];
}

function conditionColumns(user, onEdit, deleteRecord, onCreateTicketFromCondition, onSuggestScheduleFromCondition, onAddCondition, onViewTicket) {
  const columns = [
    { key: 'id', label: 'ID', locked: true, className: 'cell-center', render: (row) => recordNumber(row, 'condition_check_id') ?? '-' },
    { key: 'vehicle', label: 'Vehicle', locked: true, render: (row) => <VehicleCell vehicle={row.vehicle} /> }, { key: 'plate', label: 'Plate Number', className: 'cell-center', render: (row) => row.vehicle?.plate_number ?? '-' },
    { key: 'result', label: 'Current Condition', className: 'cell-center', render: (row) => (
      <div>
        <StatusBadge value={currentCondition(row)} />
        {row.resulting_ticket && ['Good', 'Needs Repair'].includes(row.condition_result) && row.condition_result !== currentCondition(row) && (
          <small className="muted" style={{ display: 'block', marginTop: 4 }}>Recorded: {row.condition_result}</small>
        )}
      </div>
    ) },
    { key: 'ticket', label: 'Linked Ticket', render: (row) => row.resulting_ticket ? (
      <div>
        {onViewTicket ? (
          <button type="button" className="cell-link" onClick={() => onViewTicket(row.resulting_ticket)}>
            Ticket #{ticketNumber(row.resulting_ticket)}
          </button>
        ) : <span>Ticket #{ticketNumber(row.resulting_ticket)}</span>}
        <div style={{ marginTop: 4 }}><TicketStatusBadge value={row.resulting_ticket.status} /></div>
      </div>
    ) : <span className="muted">-</span> },
    { key: 'checked_by', label: 'Checked By', className: 'cell-center', render: (row) => <UserAvatarName user={row.checked_by} /> },
    { key: 'date', label: 'Date', className: 'cell-center', render: (row) => <DateBadge value={row.created_at} /> },
    { key: 'time', label: 'Time', className: 'cell-center', render: (row) => formatTime(row.created_at) },
  ];

  if (hasRole(user, 'Custodian')) {
    columns.push({
      key: 'action',
      label: 'Action',
      locked: true,
      className: 'cell-center',
      render: (row) => {
        // condition.edit is Custodian-only, and only for the check THEY
        // performed (backend 403s otherwise). Admin no longer gets this
        // column at all — Condition Monitoring is the Custodian's own data
        // to manage, not something Admin takes row-level action on.
        const canEdit = canDo(user, 'condition.edit') && String(row.checked_by?.id) === String(user.id);
        const canDelete = false;
        return (
        // A synthesized "Not Checked" row has no condition_check_id — there's
        // no record yet to create a ticket from, suggest a schedule against,
        // edit, or delete. Its only real action is filing the first check.
        !row.condition_check_id ? (
          <div className="row-actions condition-record-actions">
            {onAddCondition && (
              <button className="btn-confirm-action icon-btn" onClick={() => onAddCondition(row)} type="button" title="Record Condition" aria-label="Record Condition"><Icon name="plus" size={14} /></button>
            )}
          </div>
        ) : (
        <div className="row-actions condition-record-actions">
          {row.resulting_ticket && onViewTicket && (
            <button className="btn-view-action icon-btn" onClick={() => onViewTicket(row.resulting_ticket)} type="button" title="View linked ticket" aria-label="View linked ticket"><Icon name="ticket" size={14} /></button>
          )}
          {(canDo(user, 'ticket.create') || canDo(user, 'ticket.propose')) && onCreateTicketFromCondition && (
            !row.resulting_ticket_id && !row.resulting_ticket && currentCondition(row) !== 'Good' ? (
              <button className="btn-confirm-action icon-btn" onClick={() => onCreateTicketFromCondition(row)} type="button" title={canDo(user, 'ticket.propose') ? 'Propose Ticket' : 'Create Ticket'} aria-label={canDo(user, 'ticket.propose') ? 'Propose Ticket' : 'Create Ticket'}><Icon name="ticket" size={14} /></button>
            ) : (
              <button
                className="btn-confirm-action icon-btn"
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                disabled
                style={{ visibility: 'hidden', pointerEvents: 'none' }}
              >
                <Icon name="ticket" size={14} />
              </button>
            )
          )}
          {/* Custodian or Admin can propose a preventive schedule from any
              condition check — not gated to a bad result, since "let's plan
              a checkup" is a reasonable call even on a Good vehicle. */}
          {onSuggestScheduleFromCondition && (
            <button className="btn-view-action icon-btn" onClick={() => onSuggestScheduleFromCondition(row)} type="button" title="Suggest Maintenance Schedule" aria-label="Suggest Maintenance Schedule"><Icon name="calendar" size={14} /></button>
          )}
          {canEdit && (
            <button className="btn-edit-action icon-btn" onClick={() => onEdit(row)} type="button" title="Edit" aria-label="Edit"><Icon name="edit" size={14} /></button>
          )}
          {canDelete && (
            <button className="btn-delete-action icon-btn" onClick={() => deleteRecord(`/conditions/${row.condition_check_id}`, 'Condition check deleted.', `Delete this "${row.condition_result}" condition check for ${row.vehicle?.vehicle_name ?? 'this vehicle'}? This cannot be undone.`)} type="button" title="Delete" aria-label="Delete"><Icon name="trash" size={14} /></button>
          )}
        </div>
        )
        );
      },
    });
  }

  return columns;
}

// "X ago" — coarse, single-unit relative time (seconds up to years), the
// same granularity a typical activity-feed timestamp uses.
function timeAgo(value) {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, secondsInUnit] of units) {
    const count = Math.floor(seconds / secondsInUnit);
    if (count >= 1) return `${count} ${unit}${count > 1 ? 's' : ''} ago`;
  }
  return 'Just now';
}

// Quick-glance companion to the stat row — a scrollable activity timeline of
// the newest reports (vehicle, issue, reporter), so "what's come in
// recently" doesn't require scrolling the full table below. Sourced from the
// unfiltered list, so a search/filter on the main table doesn't empty it out.
function LatestIssueCard({ issues = [] }) {
  const sorted = useMemo(
    () => [...issues].sort((a, b) => (b.issue_report_id ?? 0) - (a.issue_report_id ?? 0)),
    [issues]
  );

  const pagination = usePagination(sorted.length, { pageSizeOptions: [5], initialPageSize: 5 });

  return (
    <aside className="panel latest-issue-card latest-issue-timeline">
      <div className="latest-issue-card-head">
        <span className="latest-issue-card-label">Latest Reports</span>
        <span className="count-badge">{issues.length}</span>
      </div>
      <div className="latest-issue-timeline-list">
        {sorted.length === 0 ? (
          <p className="muted">No issues reported yet.</p>
        ) : (
          sorted.slice(pagination.start, pagination.end).map((row) => (
            <div
              key={row.issue_report_id}
              className="latest-issue-timeline-item"
            >
              <span className="latest-issue-timeline-dot" />
              <span className="latest-issue-timeline-icon"><Icon name="mail" size={16} /></span>
              <span className="latest-issue-timeline-body">
                <strong>{row.vehicle?.vehicle_name ?? 'Unknown vehicle'}</strong>
                <span className="muted">
                  {row.issue_type ?? 'Unspecified issue'} reported by {row.reported_by?.name ?? 'Unknown reporter'}.
                </span>
              </span>
              <span className="latest-issue-timeline-time">{timeAgo(row.created_at)}</span>
            </div>
          ))
        )}
      </div>
      <PaginationControls {...pagination} showPageSize={false} />
    </aside>
  );
}

// Maps a set of selected severity labels back to the [minIndex, maxIndex]
// span DualRangeSlider needs — the inverse of what applyFilters below does
// when it turns the slider's span back into that same selected-labels array
// (the actual filter state stays a plain string array, same shape every
// other multi-select filter in this app already uses).
function severityRangeFromSelection(selected, levels) {
  if (!selected?.length) return [0, levels.length - 1];
  const indices = selected.map((s) => levels.indexOf(s)).filter((i) => i !== -1);
  if (!indices.length) return [0, levels.length - 1];
  return [Math.min(...indices), Math.max(...indices)];
}

// A one-off, richer filter panel built specifically for Issue Reports (a
// search box, a severity range slider, and status shown as colored
// checkbox chips instead of a dropdown) rather than stretching the generic
// FilterBar — none of these are concepts the other ~15 FilterBar callers
// share, so bolting them on there would leak Issue-Reports-only UI into a
// shared component. Everything except the search box is staged (a local
// draft, applied together on "Filter") — same convention FilterBar itself
// uses, just with these different field types.
function IssueFilterPanel({
  categories = [],
  vehicles = [],
  issueTypes = [],
  severityLevels = [],
  filterCategory,
  setFilterCategory,
  filterCapacity,
  setFilterCapacity,
  filterIssueType,
  setFilterIssueType,
  filterStatus,
  setFilterStatus,
  filterPriority,
  setFilterPriority,
  filterDateStart,
  setFilterDateStart,
  filterDateEnd,
  setFilterDateEnd,
}) {
  const capacities = useMemo(() => {
    const caps = new Set();
    vehicles.forEach((v) => { if (v.capacity) caps.add(v.capacity.trim()); });
    return Array.from(caps).sort();
  }, [vehicles]);



  // Same default window every time the applied filter is unset — both on
  // first mount AND after "Clear Filters" resets filterDateStart/End back
  // to '' — instead of only seeding it once and then collapsing to a blank
  // "dd/mm/yyyy" the moment this effect's first resync runs.
  const [draft, setDraft] = useState({
    category: filterCategory ?? [],
    capacity: filterCapacity ?? [],
    issueType: filterIssueType ?? [],
    status: filterStatus ?? [],
    severity: filterPriority ?? [],
    dateStart: filterDateStart || '2026-01-01',
    dateEnd: filterDateEnd || '2026-12-31',
  });

  const issueFilterKey = JSON.stringify([filterCategory, filterCapacity, filterIssueType, filterStatus, filterPriority, filterDateStart, filterDateEnd]);
  const [previousIssueFilterKey, setPreviousIssueFilterKey] = useState(issueFilterKey);
  if (previousIssueFilterKey !== issueFilterKey) {
    setPreviousIssueFilterKey(issueFilterKey);
    setDraft({
      category: filterCategory ?? [],
      capacity: filterCapacity ?? [],
      issueType: filterIssueType ?? [],
      status: filterStatus ?? [],
      severity: filterPriority ?? [],
      dateStart: filterDateStart || '2026-01-01',
      dateEnd: filterDateEnd || '2026-12-31',
    });

  }

  // An empty draft.status means "no filter" — every chip should read as
  // checked, the same "everything's included" state the Total/All stat
  // card represents. Unchecking one FROM that implicit-all state has to
  // expand it into an explicit "every status except this one" list first —
  // otherwise toggling off a single chip would (wrongly) read as toggling
  // it on, since d.status.includes(key) is false for all of them.


  const applyFilters = () => {
    setFilterCategory(draft.category);
    setFilterCapacity(draft.capacity);
    setFilterIssueType(draft.issueType);
    setFilterStatus(draft.status);
    setFilterPriority(draft.severity);
    setFilterDateStart(draft.dateStart);
    setFilterDateEnd(draft.dateEnd);
  };

  const isDirty = !sameSelection(draft.category, filterCategory ?? [])
    || !sameSelection(draft.capacity, filterCapacity ?? [])
    || !sameSelection(draft.issueType, filterIssueType ?? [])
    || !sameSelection(draft.status, filterStatus ?? [])
    || !sameSelection(draft.severity, filterPriority ?? [])
    || draft.dateStart !== (filterDateStart || '2026-01-01')
    || draft.dateEnd !== (filterDateEnd || '2026-12-31');

  return (
    <div className="issue-filter-panel is-inline">
      <div className="filter-date-group">
        <span>Category</span>
        <MultiSelectDropdown
          placeholder="All Categories"
          options={categories.map((cat) => ({ value: String(cat.category_id), label: cat.category_name }))}
          selected={draft.category}
          onChange={(vals) => setDraft((d) => ({ ...d, category: vals }))}
        />
      </div>
      <div className="filter-date-group">
        <span>Capacity</span>
        <MultiSelectDropdown
          placeholder="All Capacities"
          options={capacities}
          selected={draft.capacity}
          onChange={(vals) => setDraft((d) => ({ ...d, capacity: vals }))}
        />
      </div>
      <div className="filter-date-group">
        <span>Issue Type</span>
        <MultiSelectDropdown
          placeholder="All Issue Types"
          options={issueTypes}
          selected={draft.issueType}
          onChange={(vals) => setDraft((d) => ({ ...d, issueType: vals }))}
        />
      </div>
      {/* Severity used to be a card of three coloured checkboxes that pushed
          the Filter button onto a second line; it's now a dropdown like the
          other filters (same multi-select, empty = all) so the whole filter
          bar sits on one line. */}
      <div className="filter-date-group">
        <span>Severity</span>
        <MultiSelectDropdown
          placeholder="All Severities"
          options={severityLevels.map((level) => ({ value: level, label: level }))}
          selected={draft.severity}
          onChange={(vals) => setDraft((d) => ({ ...d, severity: vals.length === severityLevels.length ? [] : vals }))}
        />
      </div>
      <div className="filter-date-group">
        <span>From Date</span>
        <DateFilterInput value={draft.dateStart} onChange={(val) => setDraft((d) => ({ ...d, dateStart: val }))} />
      </div>
      <div className="filter-date-group">
        <span>To Date</span>
        <DateFilterInput value={draft.dateEnd} onChange={(val) => setDraft((d) => ({ ...d, dateEnd: val }))} />
      </div>
      <button type="button" className="filter-apply-btn issue-filter-apply-btn is-inline" onClick={applyFilters} disabled={!isDirty}>Filter</button>
    </div>
  );
}

// Same bespoke filter panel design as IssueFilterPanel, adapted for
// Maintenance Tickets: no Issue Type dropdown (tickets don't have one),
// the range slider covers ticket Priority (Low/Medium/High) instead of
// Severity, and the status chips use TICKET_STAT_CARDS (Open/Active/
// Closed/Cancelled) instead of ISSUE_STAT_CARDS.
function TicketFilterPanel({
  categories = [],
  vehicles = [],
  custodians = [],
  maintenancePersonnelRoster = [],
  priorityLevels = [],
  statusOptions = [],
  filterCategory,
  setFilterCategory,
  filterCapacity,
  setFilterCapacity,
  filterVehicle,
  setFilterVehicle,
  filterMechanic,
  setFilterMechanic,
  filterCustodian,
  setFilterCustodian,
  filterStatus,
  setFilterStatus,
  filterPriority,
  setFilterPriority,
  filterDateStart,
  setFilterDateStart,
  filterDateEnd,
  setFilterDateEnd,
}) {
  const priorities = ['Low', 'Medium', 'High'].filter((value) => !priorityLevels.length || priorityLevels.includes(value));
  const statuses = [...new Set([...TICKET_STAT_CARDS.map((card) => card.key), 'For Verification', ...statusOptions])];
  const toggleStatus = (status) => setDraft((current) => {
    const selected = current.status.length ? current.status.filter((value) => value !== '__none__') : statuses;
    const next = selected.includes(status) ? selected.filter((value) => value !== status) : [...selected, status];
    return { ...current, status: next.length === statuses.length ? [] : next.length ? next : ['__none__'] };
  });
  const capacities = useMemo(() => {
    const caps = new Set();
    vehicles.forEach((v) => { if (v.capacity) caps.add(v.capacity.trim()); });
    return Array.from(caps).sort();
  }, [vehicles]);

  const maintenancePersonnelNames = useMemo(
    () => maintenancePersonnelRoster.map((p) => p.name).sort(),
    [maintenancePersonnelRoster],
  );
  const custodianNames = useMemo(() => custodians.map((c) => c.name).sort(), [custodians]);

  // Same default window every time the applied filter is unset — both on
  // first mount AND after "Clear Filters" resets filterDateStart/End back
  // to '' — instead of only seeding it once and then collapsing to a blank
  // "dd/mm/yyyy" the moment this effect's first resync runs.
  const [draft, setDraft] = useState({
    category: filterCategory ?? [],
    capacity: filterCapacity ?? [],
    vehicle: filterVehicle ?? [],
    mechanic: filterMechanic ?? [],
    custodian: filterCustodian ?? [],
    status: filterStatus ?? [],
    priority: filterPriority ?? [],
    dateStart: filterDateStart || '2026-01-01',
    dateEnd: filterDateEnd || '2026-12-31',
  });

  const ticketFilterKey = JSON.stringify([filterCategory, filterCapacity, filterVehicle, filterMechanic, filterCustodian, filterStatus, filterPriority, filterDateStart, filterDateEnd]);
  const [previousTicketFilterKey, setPreviousTicketFilterKey] = useState(ticketFilterKey);
  if (previousTicketFilterKey !== ticketFilterKey) {
    setPreviousTicketFilterKey(ticketFilterKey);
    setDraft({
      category: filterCategory ?? [],
      capacity: filterCapacity ?? [],
      vehicle: filterVehicle ?? [],
      mechanic: filterMechanic ?? [],
      custodian: filterCustodian ?? [],
      status: filterStatus ?? [],
      priority: filterPriority ?? [],
      dateStart: filterDateStart || '2026-01-01',
      dateEnd: filterDateEnd || '2026-12-31',
    });

  }

  const applyFilters = () => {
    setFilterCategory(draft.category);
    setFilterCapacity(draft.capacity);
    setFilterVehicle(draft.vehicle);
    setFilterMechanic(draft.mechanic);
    setFilterCustodian(draft.custodian);
    setFilterStatus(draft.status);
    setFilterPriority(draft.priority);
    setFilterDateStart(draft.dateStart);
    setFilterDateEnd(draft.dateEnd);
  };

  const isDirty = !sameSelection(draft.category, filterCategory ?? [])
    || !sameSelection(draft.capacity, filterCapacity ?? [])
    || !sameSelection(draft.vehicle, filterVehicle ?? [])
    || !sameSelection(draft.mechanic, filterMechanic ?? [])
    || !sameSelection(draft.custodian, filterCustodian ?? [])
    || !sameSelection(draft.status, filterStatus ?? [])
    || !sameSelection(draft.priority, filterPriority ?? [])
    || draft.dateStart !== (filterDateStart || '2026-01-01')
    || draft.dateEnd !== (filterDateEnd || '2026-12-31');

  return (
    <div className="issue-filter-panel is-inline is-wrap">
      <div className="filter-date-group">
        <span>Category</span>
        <MultiSelectDropdown
          placeholder="All Categories"
          options={categories.map((cat) => ({ value: String(cat.category_id), label: cat.category_name }))}
          selected={draft.category}
          onChange={(vals) => setDraft((d) => ({ ...d, category: vals }))}
        />
      </div>
      <div className="filter-date-group">
        <span>Capacity</span>
        <MultiSelectDropdown
          placeholder="All Capacities"
          options={capacities}
          selected={draft.capacity}
          onChange={(vals) => setDraft((d) => ({ ...d, capacity: vals }))}
        />
      </div>
      <div className="filter-date-group">
        <span>Vehicle</span>
        <MultiSelectDropdown
          placeholder="All Vehicles"
          options={vehicles.map((v) => ({ value: String(v.vehicle_id), label: `${v.vehicle_name} · ${v.plate_number}` }))}
          selected={draft.vehicle}
          onChange={(vals) => setDraft((d) => ({ ...d, vehicle: vals }))}
        />
      </div>
      <div className="filter-date-group">
        <span>Personnel</span>
        <MultiSelectDropdown
          placeholder="All Personnel"
          options={maintenancePersonnelNames}
          selected={draft.mechanic}
          onChange={(vals) => setDraft((d) => ({ ...d, mechanic: vals }))}
        />
      </div>
      <div className="filter-date-group">
        <span>Custodian</span>
        <MultiSelectDropdown
          placeholder="All Custodians"
          options={custodianNames}
          selected={draft.custodian}
          onChange={(vals) => setDraft((d) => ({ ...d, custodian: vals }))}
        />
      </div>

      <div className="filter-date-group">
        <span>From Date</span>
        <DateFilterInput value={draft.dateStart} onChange={(value) => setDraft((current) => ({ ...current, dateStart: value }))} />
      </div>
      <div className="filter-date-group">
        <span>To Date</span>
        <DateFilterInput value={draft.dateEnd} onChange={(value) => setDraft((current) => ({ ...current, dateEnd: value }))} />
      </div>
      <div className="ticket-filter-controls">
        <div className="issue-filter-severity-card">
          <span className="issue-filter-severity-label">Priority</span>
          <DualRangeSlider labels={priorities} minIndex={severityRangeFromSelection(draft.priority, priorities)[0]} maxIndex={severityRangeFromSelection(draft.priority, priorities)[1]} onChange={(min, max) => setDraft((current) => ({ ...current, priority: min === 0 && max === priorities.length - 1 ? [] : priorities.slice(min, max + 1) }))} />
        </div>
        <div className="issue-filter-status-grid" role="group" aria-label="Ticket status">
          {statuses.map((status) => {
            const card = TICKET_STAT_CARDS.find((item) => item.key === status);
            return <label key={status} className="issue-filter-status-chip" data-status={status} style={{ background: card?.bg ?? '#ede9fe', color: card?.color ?? '#6d28d9' }}>
              <input type="checkbox" checked={!draft.status.length || draft.status.includes(status)} onChange={() => toggleStatus(status)} />
              <span>{card?.label ?? status}</span>
            </label>;
          })}
        </div>
        <button type="button" className="filter-apply-btn" onClick={applyFilters} disabled={!isDirty}>Filter</button>
      </div>
    </div>
  );
}

// An unresolved report that no ticket has been started from yet.
function issueNeedsTicket(row) {
  return ['Pending', 'Under Review'].includes(row.status) && !row.maintenance_ticket;
}

// A "pre-ticket" report — either no ticket yet, or one still awaiting Admin
// review. Once a proposal is approved it graduates into a trackable ticket
// (see the Custodian's "My Tickets" tab) and drops out of this list, so the
// Issue Reports table only ever shows what's still a plain report.
function issueIsPreTicket(row) {
  return !row.maintenance_ticket || ['Pending Approval', 'Declined'].includes(row.maintenance_ticket.status);
}

// A table's free-text description used to hang under each row as a grey
// sub-row; it is now its own "Note" column (two clamped lines, full text on
// hover) placed just before the Action column. `render` returns the text.
function withNoteColumn(columns, render, { label = 'Note', width = '16%' } = {}) {
  const note = {
    key: 'note',
    label,
    width,
    render: (row) => {
      const text = render(row);
      return text ? <span className="issue-note-cell" title={text}>{text}</span> : <span className="muted">—</span>;
    },
  };
  const actionAt = columns.findIndex((c) => c.key === 'action' || c.key === 'actions' || c.label === 'Action');
  return actionAt < 0 ? [...columns, note] : [...columns.slice(0, actionAt), note, ...columns.slice(actionAt)];
}

// Collapses a row's action icons behind a single "…" button; clicking it
// opens a small popover with the icons (rendered in a portal so table
// overflow never clips it). Keeps narrow Action columns tidy.
function RowActionsMenu({ children, alwaysVisible = false }) {
  // Only worth hiding behind "…" when there are several actions; one or two
  // icons fit in the cell, so they just show.
  const actionCount = Children.toArray(children).length;
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  useEffect(() => {
    if (!pos) return undefined;
    const close = (e) => {
      if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setPos(null);
    };
    const dismiss = () => setPos(null);
    document.addEventListener('mousedown', close);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [pos]);
  const toggle = (e) => {
    e.stopPropagation();
    if (pos) { setPos(null); return; }
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  };
  if (alwaysVisible || actionCount <= 2) {
    return <div className={`row-actions${alwaysVisible ? ' row-actions-visible' : ''}`} style={{ flexWrap: 'nowrap', justifyContent: 'center' }}>{children}</div>;
  }
  return (
    <>
      <button ref={btnRef} type="button" className="row-actions-trigger" onClick={toggle} title="Actions" aria-label="Actions" aria-haspopup="true" aria-expanded={!!pos}>…</button>
      {pos && createPortal(
        <div ref={popRef} className="row-actions-popover" style={{ top: pos.top, right: pos.right }} role="menu" onClick={() => setPos(null)}>
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

function issueColumns(role, onEdit, onCreateTicketFromIssue, setUserInfoTarget, onView, deleteRecord, user, onViewTicket, onDismiss) {
  const columns = [
    { key: 'id', label: 'ID', width: '4%', locked: true, className: 'cell-center', render: (row) => recordNumber(row, 'issue_report_id') },
    {
      key: 'issue',
      label: 'Issue',
      width: '10%',
      render: (row) => (
        <div className="issue-cell">
          <div className="issue-cell-top">
            <span className="issue-type">{row.issue_type}</span>
          </div>
        </div>
      ),
    },
    { key: 'vehicle', label: 'Vehicle', width: '19%', render: (row) => <VehicleCell vehicle={row.vehicle} link={false} /> },
    { key: 'plate', label: 'Plate Number', width: '8%', className: 'cell-center', render: (row) => row.vehicle?.plate_number ?? '-' },
    { key: 'severity', label: 'Severity', width: '8%', className: 'cell-center', render: (row) => <TicketStatusBadge value={row.severity_level} /> },
    { key: 'status', label: 'Status', width: '10%', className: 'cell-center', render: (row) => <StatusBadge value={row.status} /> },
    {
      key: 'reported_by',
      label: 'Reported By',
      width: '12%',
      className: 'cell-center',
      render: (row) => (
        row.reported_by
          ? <UserAvatarName user={row.reported_by} />
          : <span className="issue-reporter">-</span>
      ),
    },
    { key: 'date', label: 'Date', width: '7%', className: 'cell-center', render: (row) => <DateBadge value={row.created_at} /> },
    {
      key: 'note',
      label: 'Note',
      width: '10%',
      render: (row) => (row.issue_description
        ? <span className="issue-note-cell" title={row.issue_description}>{row.issue_description}</span>
        : <span className="muted">—</span>),
    },
  ];

  // Which ticket (if any) this report became — a link, or a dash when nobody
  // has started one. Only roles that can open tickets see it.
  if (['Admin', 'Custodian'].includes(role) && onViewTicket) {
    columns.splice(columns.findIndex((c) => c.key === 'date'), 0, {
      key: 'ticket',
      label: 'Ticket',
      width: '7%',
      className: 'cell-center',
      render: (row) => (row.maintenance_ticket
        ? (
          <button
            type="button"
            className="issue-reporter-link"
            onClick={(e) => { e.stopPropagation(); onViewTicket({ ticket_id: row.maintenance_ticket.ticket_id }); }}
          >
            Ticket #{ticketNumber(row.maintenance_ticket)}
          </button>
        )
        : <span className="muted" title="No ticket has been started for this report yet">—</span>),
    });
  }

  if (['Admin', 'Maintenance Personnel'].includes(role)) {
    columns.push({
      key: 'action',
      label: 'Action',
      width: '6%',
      locked: true,
      className: 'cell-center',
      render: (row) => (
        <RowActionsMenu alwaysVisible>
          {row.maintenance_ticket && onViewTicket ? (
            <button className="btn-view-action icon-btn" onClick={() => onViewTicket({ ticket_id: row.maintenance_ticket.ticket_id })} type="button" title={`View Ticket #${ticketNumber(row.maintenance_ticket)}`} aria-label={`View Ticket #${ticketNumber(row.maintenance_ticket)}`}><Icon name="eye" size={14} /></button>
          ) : (
            <button className="btn-view-action icon-btn" onClick={() => onView(row)} type="button" title="View" aria-label="View"><Icon name="eye" size={14} /></button>
          )}
          {/* issue.edit is Admin+Custodian only (Phase B4 narrowed Maintenance
              Personnel out) — gated by ability rather than this block's role
              condition since the two no longer match. */}
          {canDo(user, 'issue.edit') && (
            <button className="btn-edit-action icon-btn" onClick={() => onEdit(row)} type="button" title="Update" aria-label="Update"><Icon name="edit" size={14} /></button>
          )}
          {canDo(user, 'issue.dismiss') && onDismiss && issueNeedsTicket(row) && (
            <button className="btn-delete-action icon-btn" onClick={() => onDismiss(row)} type="button" title="Dismiss this issue" aria-label="Dismiss this issue"><Icon name="close" size={14} /></button>
          )}
          {(canDo(user, 'ticket.create') || canDo(user, 'ticket.propose')) && ['Pending', 'Under Review'].includes(row.status) && !row.maintenance_ticket && (
            <button className="btn-confirm-action icon-btn" onClick={() => onCreateTicketFromIssue(row)} type="button" title={canDo(user, 'ticket.propose') ? 'Propose Ticket' : 'Create Ticket'} aria-label={canDo(user, 'ticket.propose') ? 'Propose Ticket' : 'Create Ticket'}><Icon name="ticket" size={14} /></button>
          )}
        </RowActionsMenu>
      ),
    });
  }

  if (role === 'Custodian') {
    columns.push({
      label: 'Action',
      width: '6%',
      className: 'cell-center',
      render: (row) => (
        <RowActionsMenu alwaysVisible>
          {row.maintenance_ticket && onViewTicket ? (
            <button className="btn-view-action icon-btn" onClick={() => onViewTicket({ ticket_id: row.maintenance_ticket.ticket_id })} type="button" title={`View Ticket #${ticketNumber(row.maintenance_ticket)}`} aria-label={`View Ticket #${ticketNumber(row.maintenance_ticket)}`}><Icon name="eye" size={14} /></button>
          ) : (
            <button className="btn-view-action icon-btn" onClick={() => onView(row)} type="button" title="View" aria-label="View"><Icon name="eye" size={14} /></button>
          )}
          {row.status === 'Pending' && (
            <>
              <button className="btn-edit-action icon-btn" onClick={() => onEdit(row)} type="button" title="Edit" aria-label="Edit"><Icon name="edit" size={14} /></button>
              <button className="btn-delete-action icon-btn" onClick={() => deleteRecord(`/issues/${row.issue_report_id}`, 'Issue deleted.', `Delete this "${row.issue_type}" report for ${row.vehicle?.vehicle_name ?? 'this vehicle'}? This cannot be undone.`)} type="button" title="Delete" aria-label="Delete"><Icon name="trash" size={14} /></button>
            </>
          )}
        </RowActionsMenu>
      ),
    });
  }

  return columns;
}

function maintenanceColumns(onViewRecord) {
  return [
    { key: 'vehicle', width: '16%', label: 'Vehicle', locked: true, render: (row) => <VehicleCell vehicle={row.vehicle} /> },
    { key: 'plate', width: '9%', label: 'Plate Number', className: 'cell-center', render: (row) => row.vehicle?.plate_number ?? '-' },
    { key: 'source', width: '15%', label: 'Source', locked: true, render: (row) => <span className="maintenance-record-source"><StatusBadge value={maintenanceSourceLabel(row)} /></span> },
    { key: 'type', width: '11%', label: 'Repair Type', render: (row) => row.maintenance_type || '-' },
    { key: 'work', width: '19%', label: 'Work Performed', render: (row) => row.action_taken || '-' },
    { key: 'personnel', width: '14%', label: 'Completed By / Shop', render: (row) => row.is_external && row.external_vendor ? row.external_vendor : <UserAvatarName user={row.maintenance_personnel} fallback={row.performed_by_other ?? row.external_vendor ?? '-'} /> },
    { key: 'date_completed', width: '9%', label: 'Completed', className: 'cell-center', render: (row) => <DateBadge value={row.date_completed} /> },
    { key: 'action', width: '7%', label: 'Action', locked: true, className: 'cell-center', render: (row) => (
      <button className="btn-view-action icon-btn" onClick={() => onViewRecord(row)} type="button" title="View completed repair" aria-label="View completed repair"><Icon name="eye" size={14} /></button>
    ) },
  ];
}

const MAINTENANCE_PROGRESS_STAGES = ['Assigned', 'Under Repair', 'For Verification', 'Completed'];

// Where a record sits on the stage trail. Shared by the detail page's stepper
// and the card view's progress bar so the two can never disagree. "On Hold -
// Awaiting Parts" isn't its own stage — it's a stalled 'Under Repair'.
function maintenanceStageIndex(record) {
  if (record.progress_status === 'On Hold - Awaiting Parts') {
    return MAINTENANCE_PROGRESS_STAGES.indexOf('Under Repair');
  }
  return MAINTENANCE_PROGRESS_STAGES.indexOf(record.progress_status);
}

// A record that reached Completed with no verification result was closed on an
// Admin decision, not on verified work (see decisionCloseMaintenance).
function isClosedUnverified(record) {
  return record.progress_status === 'Completed' && !record.verification_result;
}

// Card-view counterpart to the Maintenance Records table — mirrors TicketCard
// (and reuses its themed .ticket-card-* classes) so both modules read as the
// same product rather than two different card systems.
function MaintenanceRecordDetail({ record, onConfirm, onReopen, onDecisionClose, canManage }) {
  const [closing, setClosing] = useState(false);
  const onHold = record.progress_status === 'On Hold - Awaiting Parts';
  const stageIndex = maintenanceStageIndex(record);
  const canConfirm = canManage && record.verification_result === 'Passed' && record.progress_status !== 'Completed';
  // Decision-close is only offered where it's actually meaningful: not
  // already finished, and not already passed verification (a pass should go
  // through Confirm so it isn't overwritten as "unverified").
  const canDecisionClose = canManage && record.progress_status !== 'Completed' && record.verification_result !== 'Passed';
  // A record that reached Completed with no verification result was closed on
  // an Admin decision, not on verified work — never let the two look alike.
  const closedUnverified = isClosedUnverified(record);

  return (
    <ModulePanel description={`Maintenance #${recordNumber(record, 'maintenance_id')}`}>
      <div className="maintenance-record-detail">
        <header className="maintenance-report-heading">
          <div><span className="maintenance-detail-label">Service record #{recordNumber(record, 'maintenance_id')}</span><h2>{record.maintenance_type || 'Maintenance record'}</h2><p>Repair details, completion evidence, and verification.</p></div>
          <StatusBadge value={record.progress_status} />
        </header>
        <div className="maintenance-record-hero">
          <VehicleCell vehicle={record.vehicle} />
          <span className="muted">{record.maintenance_type}</span>
          <StatusBadge value={maintenanceSourceLabel(record)} />
          {onHold && (
            <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: 0, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>ON HOLD — AWAITING PARTS</span>
          )}
          {record.is_external && (
            <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: 0, background: '#f0f9ff', color: '#0369a1', border: '1px solid #bae6fd' }}>External{record.external_vendor ? ` — ${record.external_vendor}` : ''}</span>
          )}
          {record.source_vehicle && (
            <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: 0, background: '#fff7ed', color: '#9a3412', border: '1px solid #fed7aa' }}>⚙ Part from {record.source_vehicle.vehicle_name}</span>
          )}
          {closedUnverified && (
            <span
              style={{ fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: 0, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}
              title="Admin closed this without waiting for Custodian verification — nobody independently checked the work."
            >
              <Icon name="alert" size={11} /> CLOSED WITHOUT VERIFICATION
            </span>
          )}
        </div>

        <div className="maintenance-record-layout">
          <div className="maintenance-record-main">
        <h3 className="maintenance-section-title">Work progress</h3>
        {/* Progress trail — where this record actually sits, not just a
            status word. Filled/checked nodes are stages already passed. */}
        <div className="maintenance-progress">
          {MAINTENANCE_PROGRESS_STAGES.map((stage, i) => (
            <div key={stage} style={{ display: 'flex', alignItems: 'flex-start', flex: i === MAINTENANCE_PROGRESS_STAGES.length - 1 ? '0 0 auto' : 1 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 56 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  background: i < stageIndex || (i === stageIndex && stage === 'Completed') ? '#16a34a' : i === stageIndex ? '#2563eb' : '#e2e8f0',
                  color: i <= stageIndex ? '#fff' : '#94a3b8', fontSize: '0.74rem', fontWeight: 700,
                }}>
                  {i < stageIndex || (i === stageIndex && stage === 'Completed') ? <Icon name="checkCircle" size={14} /> : i + 1}
                </div>
                <span style={{ fontSize: '0.7rem', color: i <= stageIndex ? '#0f172a' : '#94a3b8', fontWeight: i === stageIndex ? 700 : 500, textAlign: 'center' }}>{stage}</span>
              </div>
              {i < MAINTENANCE_PROGRESS_STAGES.length - 1 && (
                <div style={{ flex: 1, height: 2, marginTop: 13, background: i < stageIndex ? '#16a34a' : '#e2e8f0' }} />
              )}
            </div>
          ))}
        </div>

        <h3 className="maintenance-section-title">Service summary</h3>
        <div className="maintenance-detail-grid">
          <div>
            <span className="maintenance-detail-label">Problem / Reason</span>
            {record.problem_reason || '—'}
          </div>
          <div>
            <span className="maintenance-detail-label">Action Taken</span>
            {record.action_taken || '—'}
          </div>
          <div>
            <span className="maintenance-detail-label">Parts Used</span>
            {record.parts_used || '—'}
          </div>
          <div>
            <span className="maintenance-detail-label">Cost</span>
            {record.maintenance_cost != null ? `₱${Number(record.maintenance_cost).toLocaleString()}` : '—'}
          </div>
          <div>
            <span className="maintenance-detail-label">Personnel</span>
            <UserAvatarName user={record.maintenance_personnel} fallback={record.performed_by_other ?? '-'} />
          </div>
          <div>
            <span className="maintenance-detail-label">Date Started / Completed</span>
            {formatDate(record.date_started)} — {formatDate(record.date_completed)}
          </div>
        </div>
          </div>

          <aside className="maintenance-record-sidebar" aria-label="Verification and completion details">
        <h3 className="maintenance-section-title">Completion & verification</h3>
        {/* Proof shown inline — the whole point of this view over the plain
            edit form is not having to click away just to see it. */}
        {record.receipt_url && (
          <a className="maintenance-proof-file" href={resolvePhotoUrl(record.receipt_url)} target="_blank" rel="noopener noreferrer">
            <Icon name="clipboard" size={22} /><span><strong>Proof of completion</strong><small>Open attached receipt or repair evidence</small></span><Icon name="link" size={16} />
          </a>
        )}

        {!record.verification_result && <p className="muted" style={{ margin: 0, fontSize: '0.8rem' }}>No verification result recorded.</p>}
        {record.verification_result && (
          <div style={{ padding: '10px 12px', borderRadius: 8, maxWidth: 480, background: record.verification_result === 'Passed' ? '#ecfdf5' : '#fef2f2', border: `1px solid ${record.verification_result === 'Passed' ? '#a7f3d0' : '#fecaca'}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem', fontWeight: 700, color: record.verification_result === 'Passed' ? '#065f46' : '#991b1b' }}>
              <Icon name={record.verification_result === 'Passed' ? 'checkCircle' : 'alert'} size={15} />
              Verification: {record.verification_result}
            </div>
            {record.verification_notes && <p style={{ margin: '4px 0 0', fontSize: '0.82rem' }}>{record.verification_notes}</p>}
            {record.verified_by && <p className="muted" style={{ margin: '4px 0 0', fontSize: '0.76rem' }}>By {record.verified_by.name} · {formatDate(record.verified_at)}</p>}
          </div>
        )}

        {/* Why verification was skipped — mandatory at close time, so it's
            always here when the badge above is showing. */}
        {record.closure_reason && (
          <div style={{ padding: '10px 12px', borderRadius: 8, maxWidth: 480, background: '#fffbeb', border: '1px solid #fde68a' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem', fontWeight: 700, color: '#92400e' }}>
              <Icon name="alert" size={15} /> Reason for closing without verification
            </div>
            <p style={{ margin: '4px 0 0', fontSize: '0.82rem' }}>{record.closure_reason}</p>
          </div>
        )}

        {record.confirmed_by && (
          <p className="muted" style={{ fontSize: '0.78rem', margin: 0 }}>
            {closedUnverified ? 'Closed' : 'Confirmed'} by {record.confirmed_by.name} · {formatDate(record.confirmed_at)}
          </p>
        )}

        {canConfirm && (
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="primary-button" type="button" onClick={() => onConfirm(record)}>Confirm</button>
            <button className="ghost-button" type="button" onClick={() => onReopen(record)}>Reopen</button>
          </div>
        )}

        {canDecisionClose && !closing && (
          <div>
            <button className="ghost-button" type="button" onClick={() => setClosing(true)}>
              Close Without Verification
            </button>
            <p className="muted" style={{ fontSize: '0.76rem', margin: '6px 0 0', maxWidth: 480 }}>
              Ends this record now without waiting for a Custodian to check the work. Requires a reason, and the record stays permanently marked as unverified.
            </p>
          </div>
        )}

        {canDecisionClose && closing && (
          <div style={{ padding: '14px 16px', borderRadius: 8, maxWidth: 520, background: '#fffbeb', border: '1px solid #fde68a' }}>
            <h4 style={{ margin: '0 0 4px', fontSize: '0.92rem', color: '#92400e' }}>Close without Custodian verification</h4>
            <p className="muted" style={{ fontSize: '0.78rem', margin: '0 0 12px' }}>
              Nobody will have independently checked this work. The record will be permanently flagged as closed unverified, and Custodians will be notified the verification is no longer needed.
            </p>
            <SmartForm
              fields={[
                { label: 'Reason for closing without verification', name: 'closure_reason', type: 'textarea', rows: 2, required: true, fullWidth: true },
                {
                  label: 'Is the vehicle fit to return to service?',
                  name: 'returned_to_service',
                  type: 'select',
                  required: true,
                  fullWidth: true,
                  options: [
                    { value: 1, label: 'Yes — return it to Available' },
                    { value: 0, label: 'No — keep it Under Maintenance' },
                  ],
                },
              ]}
              onCancel={() => setClosing(false)}
              onSubmit={(payload) => onDecisionClose(record, payload)}
              submitLabel="Close Record"
              title=""
            />
          </div>
        )}
          </aside>
        </div>
      </div>
    </ModulePanel>
  );
}

// Fetch-by-id wrapper — same pattern as TicketProfilePage: load once by the
// URL's :id, show a loader/not-found state, then hand the fetched record to
// the read-rich detail view above. Re-fetches after Confirm/Reopen so the
// progress trail reflects the new state without a manual refresh.
function MaintenanceRecordProfilePage({ maintenanceId, groupByVehicle = false, onConfirm, onReopen, onDecisionClose, onVerify, canManage }) {
  const { user } = useContext(AuthContext);
  const [verifying, setVerifying] = useState(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [vehicleRecords, setVehicleRecords] = useState([]);
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const loadRecord = useCallback(() => {
    return api.get(`/maintenance-records/${maintenanceId}`).then(async (response) => {
      if (groupByVehicle) {
        // Preserve old grouped links, but keep the history limited to completed work.
        const ledger = await api.get('/maintenance-records');
        const vehicleId = response.data.vehicle_id ?? response.data.vehicle?.vehicle_id;
        setVehicleRecords(vehicleId == null ? completedMaintenanceRecords([response.data]) : completedMaintenanceRecords(ledger.data).filter((repair) => String(repair.vehicle_id ?? repair.vehicle?.vehicle_id) === String(vehicleId)));
      }
      setRecord(response.data);
      setNotFound(false);
    }).catch(() => setNotFound(true)).finally(() => setLoading(false));
  }, [maintenanceId, groupByVehicle]);

  useEffect(() => { loadRecord(); }, [loadRecord]);

  if (loading) return <ModuleLoader label="Loading maintenance record" />;

  if (notFound || !record) {
    return <ModulePanel description="This maintenance record could not be found — it may have been deleted." />;
  }

  if (groupByVehicle) {
    return (
      <ModulePanel description="Maintenance work for this vehicle">
        <div className="panel-header-bar">
          <VehicleCell vehicle={record.vehicle} />
          <span>{vehicleRecords.length} repair {vehicleRecords.length === 1 ? 'entry' : 'entries'}</span>
        </div>
        <FormModal open={Boolean(verifying)} title="Verify repair" onClose={() => setVerifying(null)}>
          <SmartForm fields={verificationFields} onCancel={() => setVerifying(null)} onSubmit={async (payload) => {
            await onVerify(verifying, payload);
            setVerifying(null);
            await loadRecord();
          }} submitLabel="Submit Verification" title="" />
        </FormModal>
        {vehicleRecords.map((repair) => (
          <details key={repair.maintenance_id} className="veh-card" open>
            <summary className="veh-card-head">
              <strong>{repair.problem_reason || repair.maintenance_type || 'Repair entry'}</strong>
              <StatusBadge value={repair.progress_status} />
            </summary>
            {canDo(user, 'record.edit') && <button className="ghost-button" type="button" onClick={() => navigate(location.pathname.replace(/\/maintenance\/[^/]+$/, `/maintenance/${repair.maintenance_id}/edit`))}>Edit this repair</button>}
            {onVerify && canDo(user, 'record.verify') && repair.progress_status === 'For Verification' && String(repair.maintenance_personnel_id) !== String(user?.id) && (
              <button className="primary-button" type="button" onClick={() => setVerifying(repair)}>Verify this repair</button>
            )}
            <MaintenanceRecordDetail
              record={repair}
              canManage={canManage}
              onConfirm={(r) => onConfirm(r).then(loadRecord)}
              onReopen={(r) => onReopen(r).then(loadRecord)}
              onDecisionClose={(r, payload) => onDecisionClose(r, payload).then(loadRecord)}
            />
          </details>
        ))}
      </ModulePanel>
    );
  }

  return (
    <MaintenanceRecordDetail
      record={record}
      canManage={canManage}
      onConfirm={(r) => onConfirm(r).then(loadRecord)}
      onReopen={(r) => onReopen(r).then(loadRecord)}
      onDecisionClose={(r, payload) => onDecisionClose(r, payload).then(loadRecord)}
    />
  );
}

function maintenanceStatusColumns(setEditTarget, currentUserId) {
  return [
    { key: 'id', label: 'ID', locked: true, className: 'cell-center', render: (row) => recordNumber(row, 'maintenance_id') },
    { key: 'vehicle', label: 'Vehicle', locked: true, render: (row) => <VehicleCell vehicle={row.vehicle} /> }, { key: 'plate', label: 'Plate Number', className: 'cell-center', render: (row) => row.vehicle?.plate_number ?? '-' },
    { key: 'type', label: 'Type', className: 'cell-center', render: (row) => row.maintenance_type },
    { key: 'source', label: 'Source', className: 'cell-center', render: (row) => <StatusBadge value={row.source} /> },
    { key: 'personnel', label: 'Personnel', className: 'cell-center', render: (row) => <UserAvatarName user={row.maintenance_personnel} fallback={row.performed_by_other ?? '-'} /> },
    { key: 'progress', label: 'Progress', className: 'cell-center', render: (row) => <StatusBadge value={row.progress_status} /> },
    {
      key: 'action',
      label: 'Action',
      locked: true,
      className: 'cell-center',
      render: (row) => {
        // The backend blocks a Custodian from verifying their own repair
        // (dual-role Custodian/mechanic accounts can log one) — matching
        // that here instead of showing a button that just 403s on submit.
        const isOwnRepair = currentUserId != null && String(row.maintenance_personnel_id) === String(currentUserId);
        if (isOwnRepair) {
          return <span className="muted" title="You performed this repair — another Custodian needs to verify it.">Awaiting another Custodian</span>;
        }
        return <button className="btn-edit-action icon-btn" onClick={() => setEditTarget(row)} type="button" title="Verify" aria-label="Verify"><Icon name="checkCircle" size={14} /></button>;
      },
    },
  ];
}

function scheduleColumns(onEdit, deleteRecord, onComplete, currentUser, onViewRecord, restoreRecord, onReassign, onViewTicket, onApprove, onDecline) {
  const currentUserId = currentUser?.id;
  return [
    { key: 'id', label: 'ID', locked: true, className: 'cell-center', render: (row) => recordNumber(row, 'schedule_id') },
    { key: 'vehicle', label: 'Vehicle', locked: true, render: (row) => <VehicleCell vehicle={row.vehicle} /> }, { key: 'plate', label: 'Plate Number', className: 'cell-center', render: (row) => row.vehicle?.plate_number ?? '-' },
    { key: 'type', label: 'Type', className: 'cell-center', render: (row) => row.maintenance_type },
    {
      key: 'assigned_to',
      label: 'Assigned To',
      className: 'cell-center',
      render: (row) => {
        const name = row.assigned_to_user?.name;
        if (!name) return <span className="muted">Unassigned</span>;
        const isMe = currentUserId != null && String(row.assigned_to) === String(currentUserId);
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <TicketPersonnelAvatars people={[{ ...row.assigned_to_user, role: 'Maintenance Personnel' }]} />
            {name}
            {isMe && <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 0, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>YOU</span>}
          </span>
        );
      },
    },
    { key: 'date', label: 'Date', className: 'cell-center', render: (row) => <DateBadge value={row.scheduled_date} /> },
    { key: 'time', label: 'Time', className: 'cell-center', render: (row) => row.scheduled_time ? String(row.scheduled_time).slice(0, 5) : '-' },
    // "One-time" (plain text, no badge) needs the same explicit centering the
    // recurring branch gets for free from <StatusBadge> — otherwise it'd
    // sit flush left while every other row in this column is centered.
    { key: 'repeat', label: 'Repeat', className: 'cell-center', render: (row) => row.recurrence_months ? <StatusBadge value={RECURRENCE_LABEL[row.recurrence_months] ?? `Every ${row.recurrence_months} mo`} /> : <span className="muted">One-time</span> },
    { key: 'location', label: 'Location', render: (row) => row.service_location ?? '-' },
    {
      key: 'status',
      label: 'Status',
      // Wrapping <StatusBadge> to add the optional OVERDUE/Done tags beside
      // it opts out of the `tbody td:has(> .status-badge)` auto-centering
      // (the badge is no longer a direct child of the <td>) — centered
      // explicitly instead.
      className: 'cell-center',
      render: (row) => (
        <span className="schedule-table-status">
          {/* TicketStatusBadge, not the plain StatusBadge — its colorMap
              already covers Pending Approval/Declined (shared with tickets);
              Scheduled/Completed/Cancelled fall back to the same plain
              style StatusBadge gave them, so this is a strict addition. */}
          <TicketStatusBadge value={row.status} />
          {/* #11 — a scheduled PM whose date has passed is overdue: flag it
              loudly instead of leaving it to sit silently on the calendar. */}
          {isScheduleOverdue(row) && (
            <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 0, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>OVERDUE</span>
          )}
          {/* Traceability — the schedule row only ever showed "Completed" as
              a label with nothing to verify it against. This shows what the
              linked Maintenance Record actually reached: still awaiting
              Custodian verification, or genuinely Completed with a real
              date (only fast-closed records get date_completed immediately;
              others get it once verification/confirmation goes through). */}
          {row.status === 'Completed' && row.resulting_maintenance && (
            row.resulting_maintenance.progress_status === 'Completed' ? (
              <span
                style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 0, background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0' }}
                title={`Verification: ${row.resulting_maintenance.verification_result ?? 'Pending'}`}
              >
                Done {formatDate(row.resulting_maintenance.date_completed)}
              </span>
            ) : (
              <span
                style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 0, background: '#fef9c3', color: '#854d0e', border: '1px solid #fde68a' }}
                title="The calendar task is done, but the record it created still needs Custodian verification before it's fully closed."
              >
                Record: {row.resulting_maintenance.progress_status}
              </span>
            )
          )}
          {row.status === 'Declined' && row.decline_reason && (
            <span
              style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 0, background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca', cursor: 'help' }}
              title={`Reason: ${row.decline_reason}`}
            >
              Why? <Icon name="info" size={11} />
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'action',
      label: 'Action',
      locked: true,
      className: 'cell-center schedule-action-cell',
      render: (row) => (
        <div className="schedule-table-actions">
          <MaintenanceScheduleActions
            iconOnly
            row={row} currentUser={currentUser} onEdit={onEdit} onComplete={onComplete}
            onViewRecord={onViewRecord} onReassign={onReassign} onViewTicket={onViewTicket}
            onApprove={onApprove} onDecline={onDecline}
            onRestore={restoreRecord ? () => restoreRecord(`/maintenance-schedules/${row.schedule_id}/restore`, 'Schedule restored for Admin approval.', 'Restore this schedule for Admin approval?') : undefined}
            onDelete={() => deleteRecord(`/maintenance-schedules/${row.schedule_id}`, 'Schedule cancelled.', `Cancel the ${row.maintenance_type} schedule for ${row.vehicle?.vehicle_name ?? 'this vehicle'}? It can be restored later if needed.`)}
          />
        </div>
      ),
    },
  ];
}

const RECURRENCE_LABEL = { 1: 'Monthly', 3: 'Every 3 months', 6: 'Every 6 months', 12: 'Every 12 months' };

// #11 — a schedule is overdue when it's still 'Scheduled' but its date has
// already passed (compared date-only, so "today" is never overdue).
function isScheduleOverdue(row) { return scheduleIsOverdue(row); }

const SCHEDULE_URGENCY_KEYS = ['Overdue', 'Due1to3', 'Due4to7', 'Due8plus'];

// How soon a still-Scheduled row is due, in the same 4 buckets the top-row
// urgency stat cards count and filter by. Null for anything that isn't an
// upcoming Scheduled row (Completed/Cancelled rows have no "due in" left).
function scheduleUrgencyBucket(row) {
  if (row.status !== 'Scheduled' || !row.scheduled_date) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(row.scheduled_date); due.setHours(0, 0, 0, 0);
  const days = Math.round((due - today) / 86400000);
  if (days <= 0) return 'Overdue';
  if (days <= 3) return 'Due1to3';
  if (days <= 7) return 'Due4to7';
  return 'Due8plus';
}

// Card-view counterpart to scheduleColumns — same information and the same
// action affordances, so neither view can do something the other can't.
// Deliberately NOT one big click target: unlike a Maintenance Record, a
// schedule has no detail page to open, and a whole-card click would fight
// with the action buttons it needs to carry.
function MaintenanceScheduleDetailPage({ row, currentUser, onBack, ...actions }) {
  const overdue = isScheduleOverdue(row);
  const completedRecord = row.resulting_maintenance;
  const recurrence = row.recurrence_months ? (RECURRENCE_LABEL[row.recurrence_months] ?? `Every ${row.recurrence_months} mo`) : 'One-time';
  const dateLabel = `${formatDate(row.scheduled_date)}${row.scheduled_time ? ` · ${String(row.scheduled_time).slice(0, 5)}` : ''}`;
  const linkedTicket = row.resulting_ticket_id && actions.onViewTicket;
  const linkedRecord = row.resulting_maintenance_id && actions.onViewRecord;
  const statusMessage = row.status === 'Pending Approval'
    ? 'This schedule is waiting for an administrator to review it.'
    : row.status === 'Declined'
      ? 'This schedule was declined and needs review before it can be booked again.'
      : linkedTicket
        ? 'This scheduled service has been converted to a maintenance ticket. Follow the ticket for repair progress.'
        : row.status === 'Completed' && completedRecord && completedRecord.progress_status !== 'Completed'
          ? 'The scheduled work is complete. The linked maintenance record is waiting for custodian verification.'
          : row.status === 'Completed'
            ? completedRecord ? 'The scheduled service and its verification are complete.' : 'The scheduled maintenance is marked complete.'
            : 'Review the service details, assignment, and location below.';
  return (
    <ModulePanel>
      <div className="maintenance-schedule-detail">
        <button type="button" className="ghost-button schedule-detail-back" onClick={onBack}><Icon name="arrowLeft" size={15} /> Maintenance Schedules</button>
        <header className={`schedule-detail-hero${overdue ? ' is-overdue' : ''}`}>
          <div className="schedule-detail-hero-main">
            <button className="schedule-detail-vehicle-photo" type="button" disabled={!actions.onViewVehicle || !row.vehicle} onClick={() => actions.onViewVehicle?.(row.vehicle)} aria-label={row.vehicle ? `Open ${row.vehicle.vehicle_name} vehicle profile` : undefined}>
              {row.vehicle?.photo_url ? <img src={resolvePhotoUrl(row.vehicle.photo_url)} alt={row.vehicle.vehicle_name} /> : <Icon name="vehicle" size={26} />}
            </button>
            <div className="schedule-detail-heading">
              <div className="schedule-detail-eyebrow">Maintenance schedule <span>#{recordNumber(row, 'schedule_id')}</span></div>
              <h2>{row.maintenance_type}</h2>
              <p>{row.vehicle?.vehicle_name || 'Vehicle not assigned'}{row.vehicle?.plate_number ? <span> · {row.vehicle.plate_number}</span> : null}</p>
            </div>
          </div>
          <div className="schedule-detail-status">
            <TicketStatusBadge value={row.status} />
            {overdue && <span className="sch-overdue-pill">OVERDUE</span>}
          </div>
        </header>

        <div className="schedule-detail-layout">
          <section className="schedule-detail-main">
            <div className="schedule-detail-section-heading">
              <div><span className="schedule-detail-kicker">Service plan</span><h3>Schedule information</h3></div>
              <span className="schedule-detail-count"><Icon name="calendar" size={14} /> Schedule #{recordNumber(row, 'schedule_id')}</span>
            </div>
            <dl className="schedule-detail-facts">
              <div className={`schedule-detail-fact${overdue ? ' is-alert' : ''}`}><dt><Icon name="calendar" size={15} /> Scheduled date</dt><dd>{dateLabel}</dd></div>
              <div className="schedule-detail-fact"><dt><Icon name="undo" size={15} /> Repeat</dt><dd>{recurrence}</dd></div>
              <div className="schedule-detail-fact"><dt><Icon name="wrench" size={15} /> Assigned mechanic</dt><dd>{row.assigned_to_user?.name ? <><TicketPersonnelAvatars people={[{ ...row.assigned_to_user, role: 'Maintenance Personnel' }]} /> {row.assigned_to_user.name}{String(row.assigned_to) === String(currentUser?.id) && <span className="sch-you-tag">You</span>}</> : <span className="muted">Unassigned</span>}</dd></div>
              <div className="schedule-detail-fact"><dt><Icon name="pin" size={15} /> Service location</dt><dd>{row.service_location || <span className="muted">Not set</span>}</dd></div>
              <div className="schedule-detail-fact"><dt><Icon name="vehicle" size={15} /> Vehicle</dt><dd>{row.vehicle?.vehicle_name || 'Not assigned'}{row.vehicle?.plate_number ? <span className="schedule-detail-subvalue">{row.vehicle.plate_number}</span> : null}</dd></div>
              <div className="schedule-detail-fact"><dt><Icon name="checkCircle" size={15} /> Schedule status</dt><dd><TicketStatusBadge value={row.status} />{overdue && <span className="schedule-detail-overdue-text">Past due</span>}</dd></div>
            </dl>
            {row.notes && <section className="schedule-detail-notes"><div className="schedule-detail-section-heading"><div><span className="schedule-detail-kicker">Additional details</span><h3>Schedule notes</h3></div></div><p>{row.notes}</p></section>}
            {row.status === 'Declined' && row.decline_reason && <section className="schedule-detail-notes is-declined"><div className="schedule-detail-section-heading"><div><span className="schedule-detail-kicker">Review outcome</span><h3>Decline reason</h3></div></div><p>{row.decline_reason}</p></section>}
          </section>

          <aside className="schedule-detail-side">
            <section className="schedule-detail-workflow">
              <span className="schedule-detail-kicker">Workflow</span>
              <div className="schedule-detail-workflow-title"><span className="schedule-detail-workflow-icon"><Icon name={linkedTicket ? 'ticket' : linkedRecord ? 'wrench' : 'calendar'} size={17} /></span><h3>{linkedTicket ? 'Maintenance ticket' : linkedRecord ? 'Maintenance record' : row.status === 'Pending Approval' ? 'Approval pending' : 'Schedule tracking'}</h3></div>
              <p>{statusMessage}</p>
              {linkedTicket && <button type="button" className="btn-view-action sch-linked-action schedule-detail-link" onClick={() => actions.onViewTicket({ ticket_id: row.resulting_ticket_id })}><Icon name="ticket" size={15} /> Open Ticket #{ticketNumber(row.resulting_ticket ?? { ticket_id: row.resulting_ticket_id })}</button>}
              {linkedRecord && <button type="button" className="btn-view-action sch-linked-action schedule-detail-link" onClick={() => actions.onViewRecord(row)}><Icon name="wrench" size={15} /> Open Record #{recordNumber(row.resulting_maintenance ?? { maintenance_id: row.resulting_maintenance_id }, 'maintenance_id')}</button>}
              {row.status === 'Completed' && completedRecord && <div className={`schedule-detail-verification${completedRecord.progress_status === 'Completed' ? ' is-done' : ''}`}><span>{completedRecord.progress_status === 'Completed' ? 'Verification complete' : 'Record awaiting verification'}</span><strong>{completedRecord.date_completed ? formatDate(completedRecord.date_completed) : completedRecord.progress_status}</strong></div>}
            </section>
            <section className="schedule-detail-actions"><span className="schedule-detail-kicker">Available actions</span><h3>Schedule actions</h3><MaintenanceScheduleActions row={row} currentUser={currentUser} {...actions} /></section>
          </aside>
        </div>
      </div>
    </ModulePanel>
  );
}

function MaintenanceScheduleActions({ iconOnly = false, row, currentUser, onComplete, onEdit, onDelete, onViewRecord, onRestore, onReassign, onViewTicket, onApprove, onDecline }) {
  const actionClass = (tone = '') => `sch-action ${tone}${iconOnly ? ' icon-btn' : ''}`;
  const isMine = currentUser?.id != null && String(row.assigned_to) === String(currentUser.id);
  const canComplete = row.status === 'Scheduled' && !row.resulting_ticket_id && canDo(currentUser, 'schedule.complete') && onComplete && isMine;
  const becameTicket = row.status === 'Scheduled' && row.resulting_ticket_id && onViewTicket;
  return (
    <div className="sch-card-actions">
      {canComplete && <button className={actionClass('is-success')} onClick={() => onComplete(row)} type="button" title="Mark as Done" aria-label="Mark as Done"><Icon name="checkCircle" size={14} />{!iconOnly && <span>Mark as Done</span>}</button>}
      {becameTicket && <button className={actionClass('is-info')} onClick={() => onViewTicket({ ticket_id: row.resulting_ticket_id })} type="button" aria-label={`View Ticket #${ticketNumber(row.resulting_ticket ?? { ticket_id: row.resulting_ticket_id })}`} title={`This schedule became Ticket #${ticketNumber(row.resulting_ticket ?? { ticket_id: row.resulting_ticket_id })} — open it`}><Icon name="ticket" size={14} />{!iconOnly && <span>Ticket #{ticketNumber(row.resulting_ticket ?? { ticket_id: row.resulting_ticket_id })}</span>}</button>}
      {row.status === 'Completed' && row.resulting_maintenance_id && onViewRecord && <button className={actionClass('is-info')} onClick={() => onViewRecord(row)} type="button" title="View Maintenance Record" aria-label={`View Maintenance Record #${recordNumber(row.resulting_maintenance ?? { maintenance_id: row.resulting_maintenance_id }, 'maintenance_id')}`}><Icon name="wrench" size={14} />{!iconOnly && <span>Record #{recordNumber(row.resulting_maintenance ?? { maintenance_id: row.resulting_maintenance_id }, 'maintenance_id')}</span>}</button>}
      {canDo(currentUser, 'schedule.approve') && ['Pending Approval', 'Declined'].includes(row.status) && onApprove && <button className={actionClass('is-success')} onClick={() => onApprove(row)} type="button" title="Approve" aria-label="Approve"><Icon name="checkCircle" size={14} />{!iconOnly && <span>Approve</span>}</button>}
      {canDo(currentUser, 'schedule.decline') && row.status === 'Pending Approval' && onDecline && <button className={actionClass('is-danger')} onClick={() => onDecline(row)} type="button" title="Decline" aria-label="Decline"><Icon name="close" size={14} />{!iconOnly && <span>Decline</span>}</button>}
      {(canManageSchedulePlan(row) && canDo(currentUser, 'schedule.edit') && String(row.created_by?.id ?? row.created_by) === String(currentUser.id)) && <button className={actionClass('')} onClick={() => onEdit(row)} type="button" title="Edit" aria-label="Edit"><Icon name="edit" size={14} />{!iconOnly && <span>Edit</span>}</button>}
      {!schedulePlanLocked(row) && canDo(currentUser, 'schedule.reassign') && row.status === 'Scheduled' && onReassign && <button className={actionClass('is-info')} onClick={() => onReassign(row)} type="button" title="Reassign" aria-label="Reassign"><Icon name="undo" size={14} />{!iconOnly && <span>Reassign</span>}</button>}
      {row.status === 'Cancelled'
        ? canManageSchedulePlan(row) && canDo(currentUser, 'schedule.restore') && onRestore && <button className={actionClass('is-success')} onClick={() => onRestore(row)} type="button" title="Restore" aria-label="Restore"><Icon name="undo" size={14} />{!iconOnly && <span>Restore</span>}</button>
        : (canManageSchedulePlan(row) && canDo(currentUser, 'schedule.delete')) && <button className={actionClass('is-danger')} onClick={() => onDelete(row)} type="button" title="Cancel Schedule" aria-label="Cancel Schedule"><Icon name="trash" size={14} />{!iconOnly && <span>Cancel Schedule</span>}</button>}
    </div>
  );
}

function schedulePlanLocked(row) {
  return row.status === 'Completed' || !!row.resulting_ticket_id || !!row.resulting_maintenance_id;
}

function canManageSchedulePlan(row) {
  return !schedulePlanLocked(row);
}

function MaintenanceScheduleCard({ row, currentUser, onComplete, onEdit, onDelete, onViewRecord, onRestore, onReassign, onViewTicket, onViewVehicle, onViewSchedule, onApprove, onDecline }) {
  const currentUserId = currentUser?.id;
  const isMine = currentUserId != null && String(row.assigned_to) === String(currentUserId);
  const overdue = isScheduleOverdue(row);
  const resulting = row.resulting_maintenance;
  // Once a due schedule has become a ticket, the ticket is where the work is
  // done — completing the schedule directly would be refused. Final senior
  // system review (2026-10-05, §2) — Admin no longer completes a schedule
  // directly (that's physically performing the work); only the assigned
  // Maintenance Personnel can.
  const canComplete = row.status === 'Scheduled' && !row.resulting_ticket_id && canDo(currentUser, 'schedule.complete') && onComplete && isMine;
  const becameTicket = row.status === 'Scheduled' && row.resulting_ticket_id && onViewTicket;

  const canViewSchedule = Boolean(onViewSchedule);
  const canViewVehicle = Boolean(onViewVehicle && row.vehicle);
  const statusClass = String(row.status ?? 'unknown').toLowerCase().replace(/[^a-z]+/g, '-');
  const ticketStatusClass = ({
    Scheduled: 'ticket-open',
    'Pending Approval': 'ticket-formaint',
    Completed: 'ticket-done',
    Cancelled: 'ticket-cancelled',
    Declined: 'ticket-declined',
  })[row.status] ?? '';
  const vehicleName = row.vehicle?.vehicle_name || 'Vehicle not specified';

  return (
    <div
      className={`sch-card sch-${String(row.status).toLowerCase().replace(/[^a-z]+/g, '-')}${overdue ? ' is-overdue' : ''}${row.status === 'Completed' && resulting && resulting.progress_status !== 'Completed' ? ' sch-awaiting-verification' : ''}`}
      style={{ cursor: canViewSchedule ? 'pointer' : 'default' }}
      onClick={canViewSchedule ? () => onViewSchedule(row) : undefined}
      role={canViewSchedule ? 'link' : undefined}
      tabIndex={canViewSchedule ? 0 : undefined}
      onKeyDown={canViewSchedule ? (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onViewSchedule(row); } } : undefined}
    >
      <div className="sch-card-head">
        <div className="sch-card-heading">
          <h4 className="sch-card-title" title={row.maintenance_type}>{row.maintenance_type || 'Maintenance'}</h4>
          <span className="sch-card-id">Schedule #{recordNumber(row, 'schedule_id')}</span>
        </div>
        <div className="sch-card-statuses">
          <span className={`sch-status-badge ${ticketStatusClass || `is-${statusClass}`}`}>{row.status}</span>
          {overdue && <span className="sch-overdue-pill"><Icon name="alert" size={12} /> Overdue</span>}
        </div>
      </div>

      <div className="sch-card-main">
        <div className="sch-card-vehicle-info">
          <strong className="sch-card-vehicle-name" title={vehicleName}>{vehicleName}</strong>
          {row.vehicle?.plate_number && <span className="sch-card-plate">{row.vehicle.plate_number}</span>}
        </div>
        <button className="sch-card-photo sch-card-vehicle-link" type="button" disabled={!canViewVehicle} aria-label={canViewVehicle ? `Open ${row.vehicle.vehicle_name} vehicle profile` : undefined} title={canViewVehicle ? 'Open vehicle profile' : undefined} onClick={(e) => { e.stopPropagation(); onViewVehicle?.(row.vehicle); }}>
          {row.vehicle?.photo_url
            ? <img src={resolvePhotoUrl(row.vehicle.photo_url)} alt={row.vehicle.vehicle_name} />
            : <Icon name="vehicle" size={26} />}
        </button>
      </div>

      <dl className="sch-card-meta sch-card-meta-summary">
        <div className={`sch-card-date${overdue ? ' is-overdue' : ''}`}>
          <dt><Icon name="calendar" size={14} /> Scheduled date &amp; time</dt>
          <dd>{formatDate(row.scheduled_date)}{row.scheduled_time ? ` · ${String(row.scheduled_time).slice(0, 5)}` : ''}</dd>
        </div>
      </dl>

      {/* Traceability, same as the table's Status column: "Completed" alone
          doesn't say whether the record it produced was ever verified. */}
      {row.status === 'Completed' && resulting && (
        <div className="sch-record-verification">
          {resulting.progress_status === 'Completed' ? (
            <span className="is-done">
              Verification complete · {formatDate(resulting.date_completed)}
            </span>
          ) : (
            <span className="is-pending" title="The schedule is complete, but its maintenance record still requires Custodian verification.">
              Maintenance record: {resulting.progress_status}
            </span>
          )}
        </div>
      )}

      {/* ticket-card-bottom pins this to the bottom of the card (margin-top:
          auto) the same way TicketCard's own footer does, so action buttons
          line up across a row of cards regardless of how much optional
          content (overdue flag, location, verification badge) a given card
          has above it. */}
      <div className={`sch-card-actions${row.status === 'Pending Approval' && canDo(currentUser, 'schedule.decline') ? ' is-review' : ''}`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        {canViewSchedule && <button className="sch-action is-info" onClick={() => onViewSchedule(row)} type="button"><Icon name="eye" size={14} /> View</button>}
        {canComplete && (
          <button className="sch-action is-success" onClick={() => onComplete(row)} type="button"><Icon name="checkCircle" size={14} /> Complete</button>
        )}
        {becameTicket && (
          <button className="sch-action is-primary" onClick={() => onViewTicket({ ticket_id: row.resulting_ticket_id })} type="button"><Icon name="ticket" size={14} /> View ticket #{ticketNumber(row.resulting_ticket ?? { ticket_id: row.resulting_ticket_id })}</button>
        )}
        {row.status === 'Completed' && row.resulting_maintenance_id && onViewRecord && (
          <button className="sch-action is-success" onClick={() => onViewRecord(row)} type="button"><Icon name="wrench" size={14} /> View record #{row.resulting_maintenance_id}</button>
        )}
        {/* Admin reviews a Custodian's booked schedule before it goes live —
            see scheduleColumns' matching Action column for the full
            reasoning. A Declined row can still be approved directly. */}
        {canDo(currentUser, 'schedule.approve') && ['Pending Approval', 'Declined'].includes(row.status) && onApprove && (
          <button className="sch-action is-success" onClick={() => onApprove(row)} type="button"><Icon name="checkCircle" size={14} /> Approve</button>
        )}
        {canDo(currentUser, 'schedule.decline') && row.status === 'Pending Approval' && onDecline && (
          <button className="sch-action is-danger" onClick={() => onDecline(row)} type="button"><Icon name="close" size={14} /> Decline</button>
        )}
        {/* Edit/Delete/Restore are Custodian-only abilities (config/
            permissions.php — Admin doesn't hold schedule.edit/.delete/
            .restore), gated by canDo so this matches what the backend
            actually accepts — see scheduleColumns' matching Action column
            for the full reasoning. Custodians can change unlocked plans within their barangay. */}
        {/* schedule.reassign (Admin only) — Admin's one remaining lever over
            an already-booked schedule. */}
        {!schedulePlanLocked(row) && canDo(currentUser, 'schedule.reassign') && row.status === 'Scheduled' && onReassign && (
          <button className="sch-action is-warning" onClick={() => onReassign(row)} type="button"><Icon name="undo" size={14} /> Reassign</button>
        )}
        {((canManageSchedulePlan(row) && canDo(currentUser, 'schedule.edit') && String(row.created_by?.id ?? row.created_by) === String(currentUser.id)) || canDo(currentUser, row.status === 'Cancelled' ? 'schedule.restore' : 'schedule.delete')) && <div className="sch-card-edit-cancel">
          {(canManageSchedulePlan(row) && canDo(currentUser, 'schedule.edit') && String(row.created_by?.id ?? row.created_by) === String(currentUser.id)) && (
            <button className="sch-action is-info" onClick={() => onEdit(row)} type="button"><Icon name="edit" size={14} /> Edit</button>
          )}
          {/* Same swap as the table: a cancelled schedule offers Restore, not a
              Delete that would just re-cancel something already cancelled. */}
          {row.status === 'Cancelled'
            ? canManageSchedulePlan(row) && canDo(currentUser, 'schedule.restore') && onRestore && (
              <button className="sch-action is-success" onClick={() => onRestore(row)} type="button"><Icon name="undo" size={14} /> Restore</button>
            )
            : (canManageSchedulePlan(row) && canDo(currentUser, 'schedule.delete')) && (
              <button className="sch-action is-danger" onClick={() => onDelete(row)} type="button"><Icon name="trash" size={14} /> Cancel</button>
            )}
        </div>}
      </div>
    </div>
  );
}

const historyColumns = [
  { key: 'id', label: 'ID', locked: true, render: (row) => recordNumber(row, 'history_id') },
  { key: 'vehicle', label: 'Vehicle', locked: true, render: (row) => <VehicleCell vehicle={row.vehicle} /> }, { key: 'plate', label: 'Plate Number', render: (row) => row.vehicle?.plate_number ?? '-' },
  { key: 'activity', label: 'Activity', render: (row) => row.activity_type },
  { key: 'related_record', label: 'Related Record', render: relatedRecordLabel },
  { key: 'updated_by', label: 'Updated By', render: (row) => <UserAvatarName user={row.updated_by} /> },
  { key: 'date', label: 'Date', render: (row) => <DateBadge value={row.created_at} /> },
  { key: 'time', label: 'Time', render: (row) => formatTime(row.created_at) },
];

const VEHICLE_HISTORY_EXPORT_COLUMNS = [
  { label: 'ID', value: (r) => recordNumber(r, 'history_id') },
  { label: 'Vehicle', value: (r) => (r.vehicle ? `${r.vehicle.vehicle_name} (${r.vehicle.plate_number})` : '') },
  { label: 'Activity', value: (r) => r.activity_type },
  { label: 'Related Record', value: relatedRecordLabel },
  { label: 'Updated By', value: (r) => r.updated_by?.name ?? '' },
  { label: 'Description', value: (r) => r.description ?? '' },
  { label: 'Date', value: (r) => r.created_at },
];

// "09/16/26 - 7:05 am" — a single plain-text column combining date and time,
// in place of the DateBadge/Time column pair every other table uses; the
// activity log reads as a dense audit trail, not a dashboard, so the chunky
// colored badge tile is more visual weight than the row needs.
function formatLogDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const yy = String(date.getFullYear()).slice(-2);
  const time = new Intl.DateTimeFormat('en-US', { timeStyle: 'short' }).format(date).toLowerCase();
  return `${mm}/${dd}/${yy} - ${time}`;
}

// One consistent pill color per module string, picked deterministically (a
// hash of the name) from a fixed palette — so "Vehicle Management" is always
// the same color everywhere it appears, without hand-maintaining a lookup
// table for every module string the backend might ever log.
const MODULE_BADGE_PALETTE = [
  { bg: '#fef3c7', color: '#92400e' },
  { bg: '#dbeafe', color: '#1d4ed8' },
  { bg: '#dcfce7', color: '#166534' },
  { bg: '#fce7f3', color: '#9d174d' },
  { bg: '#ede9fe', color: '#5b21b6' },
  { bg: '#e0f2fe', color: '#075985' },
  { bg: '#fee2e2', color: '#991b1b' },
  { bg: '#f1f5f9', color: '#334155' },
];
function moduleBadgeTone(moduleName = '') {
  let hash = 0;
  for (let i = 0; i < moduleName.length; i += 1) hash = (hash * 31 + moduleName.charCodeAt(i)) >>> 0;
  return MODULE_BADGE_PALETTE[hash % MODULE_BADGE_PALETTE.length];
}

function logColumns(vehicles, onViewVehicle, onViewTicket) {
  return [
    { key: 'datetime', label: 'Date and Time', className: 'cell-center', render: (row) => formatLogDateTime(row.created_at) },
    {
      key: 'item',
      label: 'Item',
      render: (row) => {
        if (row.affected_record_id == null) return <span className="muted">—</span>;
        // Only these two modules have an affected_record_id guaranteed to be
        // that record's own id (a vehicle_id / ticket_id) — every other
        // module logs a mix of ids (issue/maintenance/schedule/category ids)
        // that would need their own lookup dataset to resolve safely.
        if (row.module === 'Vehicle Management') {
          const vehicle = vehicles.find((v) => String(v.vehicle_id) === String(row.affected_record_id));
          return vehicle
            ? <button type="button" className="issue-reporter-link" onClick={() => onViewVehicle(vehicle)}>{vehicle.vehicle_name}</button>
            : `Vehicle #${row.affected_record_id}`;
        }
        if (row.module === 'Maintenance Tickets') {
          return <button type="button" className="issue-reporter-link" onClick={() => onViewTicket({ ticket_id: row.affected_record_id })}>Ticket #{row.affected_record_id}</button>;
        }
        return `#${row.affected_record_id}`;
      },
    },
    {
      key: 'module',
      label: 'Category',
      className: 'cell-center',
      render: (row) => {
        const tone = moduleBadgeTone(row.module ?? '');
        return <span className="log-category-tag" style={{ background: tone.bg, color: tone.color }}>{row.module ?? '-'}</span>;
      },
    },
    { key: 'action', label: 'Action', className: 'cell-text', render: (row) => row.details || row.action },
    {
      key: 'user',
      label: 'User',
      locked: true,
      className: 'cell-center',
      render: (row) => (
        <div className="log-user-cell">
          <UserAvatarName user={row.user} />
          {row.role && <div className="log-user-role">{row.role}</div>}
        </div>
      ),
    },
  ];
}

// Toolbar button + popover offering a few pre-shaped CSV exports over
// whatever activity rows are currently in view (same filtered/searched set
// the table shows) — a raw chronological dump, and two rollups (by user, by
// module) that are actually useful for "who's been doing what" questions a
// raw log dump doesn't answer directly.
// Same rows as the List View table, rendered as a connected vertical
// timeline instead — its own pagination via the same usePagination hook, so
// switching tabs doesn't lose your place in a 14,000-row activity log.
function ActivityTimeline({ rows }) {
  const { page, setPage, pageSize, setPageSize, totalPages, start, end } = usePagination(rows.length, { pageSizeOptions: [10, 25, 50, 100], initialPageSize: 10 });

  if (!rows.length) {
    return <p className="empty-state">No activity yet.</p>;
  }

  const pageRows = rows.slice(start, end);

  return (
    <div className="activity-timeline-wrap">
      <h3 className="activity-timeline-title">Recent Activities</h3>
      <ol className="activity-timeline">
        {pageRows.map((row) => (
          <li key={row.log_id} className="activity-timeline-item">
            <span className="activity-timeline-dot" aria-hidden="true">
              <Icon name="link" size={13} />
            </span>
            <div className="activity-timeline-body">
              <strong>{row.user?.name ?? 'System'} {row.action}</strong>
              <p>{row.details}</p>
            </div>
            <span className="activity-timeline-time">{timeAgo(row.created_at)}</span>
          </li>
        ))}
      </ol>
      <PaginationControls page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} pageSizeOptions={[10, 25, 50, 100]} totalPages={totalPages} />
    </div>
  );
}

// Shared paging state for PaginatedTable/PaginatedCardGrid/any future
// paginated view (e.g. an activity timeline) — one hook so all of them page
// identically and reset to page 1 the same way when the row count/page size
// changes out from under them (a filter narrowing results, etc).
function usePagination(count, { pageSizeOptions, initialPageSize }) {
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [page, setPage] = useState(1);

  const paginationKey = JSON.stringify([count, pageSize]);
  const [previousPaginationKey, setPreviousPaginationKey] = useState(paginationKey);
  if (previousPaginationKey !== paginationKey) {
    setPreviousPaginationKey(paginationKey);
    setPage(1);

  }

  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const clampedPage = Math.min(page, totalPages);
  const start = (clampedPage - 1) * pageSize;
  const end = Math.min(start + pageSize, count);

  return { page: clampedPage, setPage, pageSize, setPageSize, pageSizeOptions, totalPages, start, end };
}

// Numbered-page pager (‹ 1 2 [3] 4 5 … N ›) + a page-size picker rendered as
// its own row of circular buttons — replaces the old Prev/Next + dropdown
// footer to match the reference pagination design. Windows 2 pages on each
// side of the current one, always keeping page 1 and the last page visible
// with a single-ellipsis gap between, since jumping straight to the last of
// hundreds of pages is common (e.g. "578" in the activity log).
function paginationPageList(current, total) {
  const delta = 2;
  const pages = [];
  for (let i = 1; i <= total; i += 1) {
    if (i === 1 || i === total || (i >= current - delta && i <= current + delta)) pages.push(i);
  }
  const withGaps = [];
  let prev;
  pages.forEach((p) => {
    if (prev != null && p - prev > 1) withGaps.push('…');
    withGaps.push(p);
    prev = p;
  });
  return withGaps;
}

function PaginationControls({ page, setPage, pageSize, setPageSize, pageSizeOptions, totalPages, showPageSize = true }) {
  if (totalPages <= 1 && (!showPageSize || pageSizeOptions.length <= 1)) return null;
  const pageList = paginationPageList(page, totalPages);
  return (
    <div className="table-pagination">
      <div className="table-pagination-pages">
        <button type="button" className="pagination-arrow" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">‹</button>
        {pageList.map((p, i) => (
          p === '…'
            ? <span key={`gap-${i}`} className="pagination-ellipsis">…</span>
            : <button key={p} type="button" className={`pagination-page${p === page ? ' active' : ''}`} onClick={() => setPage(p)}>{p}</button>
        ))}
        <button type="button" className="pagination-arrow" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">›</button>
      </div>
      {showPageSize && <div className="table-pagination-size">
        <span className="muted">Page size:</span>
        {pageSizeOptions.map((n) => (
          <button key={n} type="button" className={`pagination-page${n === pageSize ? ' active' : ''}`} onClick={() => setPageSize(n)}>{n}</button>
        ))}
      </div>}
    </div>
  );
}

function PaginatedTable({ columns, rows, onRowClick, onReorderColumn, emptyMessage, compact = false, pageSizeOptions = [10, 25, 50, 100], initialPageSize = 25, renderSubRow }) {
  const { page, setPage, pageSize, setPageSize, totalPages, start, end } = usePagination(rows?.length ?? 0, { pageSizeOptions, initialPageSize });

  if (!rows?.length) {
    return <DataTable columns={columns} rows={rows} onRowClick={onRowClick} onReorderColumn={onReorderColumn} emptyMessage={emptyMessage} compact={compact} renderSubRow={renderSubRow} />;
  }

  const pageRows = rows.slice(start, end);

  return (
    <>
      <DataTable columns={columns} rows={pageRows} onRowClick={onRowClick} onReorderColumn={onReorderColumn} compact={compact} renderSubRow={renderSubRow} />
      <PaginationControls page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} pageSizeOptions={pageSizeOptions} totalPages={totalPages} />
    </>
  );
}

// Card-grid counterpart to PaginatedTable — same PaginationControls footer,
// so switching between List and Card view doesn't change how paging looks or
// behaves. Page size defaults lower than the table's: cards are much taller,
// so 25 of them is a very long scroll.
function PaginatedCardGrid({ items, renderItem, keyOf, emptyMessage, pageSizeOptions = [12, 24, 48, 96], initialPageSize = 12 }) {
  const { page, setPage, pageSize, setPageSize, totalPages, start, end } = usePagination(items?.length ?? 0, { pageSizeOptions, initialPageSize });

  if (!items?.length) {
    return <p className="empty-state">{emptyMessage}</p>;
  }

  const pageItems = items.slice(start, end);

  return (
    <>
      <div className="ticket-card-grid">
        {pageItems.map((item, i) => (
          <div key={keyOf ? keyOf(item) : i}>{renderItem(item)}</div>
        ))}
      </div>
      <PaginationControls page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} pageSizeOptions={pageSizeOptions} totalPages={totalPages} />
    </>
  );
}

// Common "this is the human-readable name" field on the loaded relation
// objects reports eager-load (Vehicle, VehicleCategory, User, ...) — tried
// in order so a resolved name shows instead of a bare foreign-key id.
function resolveRelationLabel(value) {
  if (!value || typeof value !== 'object') return null;
  return value.name ?? value.vehicle_name ?? value.category_name ?? value.title ?? (value.id != null ? `#${value.id}` : null);
}

function prettifyKey(key) {
  return key.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bId\b/g, 'ID');
}

function formatReportValue(key, value) {
  if (value == null || value === '') return /(cost|amount|expense|price)$/i.test(key) ? 'Not recorded' : '—';
  if (Array.isArray(value)) return value.length ? value.join('; ') : '-';
  if (typeof value === 'object') return resolveRelationLabel(value) ?? JSON.stringify(value);
  if (/(date|_at)$/i.test(key) && !Number.isNaN(Date.parse(value))) return formatDate(value);
  if (/(cost|amount|expense|price)$/i.test(key) && Number.isFinite(Number(value))) {
    return new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(Number(value));
  }
  if (key.endsWith('_id')) return `${prettifyKey(key).replace(/ ID$/, '')} #${value}`;
  return String(value);
}

function reportColumns(rows) {
  if (!rows?.length) {
    return [{ label: 'Result', render: () => 'No records' }];
  }

  const sample = Object.assign({}, ...rows);
  // A loaded relation (e.g. `category`, `maintenance_personnel`) is an
  // object in the row — resolve it to a readable name instead of hiding it
  // outright, and hide its matching raw `<key>_id` column so the report
  // shows "Fire Truck" instead of a bare category_id number.
  const relationKeys = Object.keys(sample).filter((key) => sample[key] && typeof sample[key] === 'object' && !Array.isArray(sample[key]));
  const hiddenKeys = new Set(relationKeys.map((key) => `${key}_id`));

  const relationColumns = relationKeys.map((key) => ({
    label: prettifyKey(key),
    render: (row) => resolveRelationLabel(row[key]) ?? '-',
  }));

  const plainKeys = Object.keys(sample).filter((key) => !relationKeys.includes(key) && !hiddenKeys.has(key));
  const maintenanceKeys = new Set(['maintenance_id', 'issue_report_id', 'maintenance_type', 'problem_reason', 'action_taken', 'date_completed', 'progress_status', 'maintenance_cost', 'verified_at', 'data_quality_warnings']);
  const displayKeys = sample.maintenance_id != null ? plainKeys.filter((key) => maintenanceKeys.has(key)) : plainKeys.filter((key) => !['custom_values', 'decision_history', 'work_history', 'attachment_files', 'external_cycles', 'readiness_invalidated_at'].includes(key));
  const plainColumns = displayKeys.map((key) => ({
    label: prettifyKey(key),
    render: (row) => formatReportValue(key, row[key]),
  }));

  return [...relationColumns, ...plainColumns];
}

// Flat, CSV-exportable version of the same columns `reportColumns` renders
// for on-screen/print display — `exportRowsToCsv` needs a `value(row)`
// shape rather than `render(row)`.
function reportExportColumns(rows) {
  return reportColumns(rows).map((col) => ({ label: col.label, value: (row) => col.render(row) }));
}

function StatusBadge({ value }) {
  return <span className={`status-badge ${String(value).toLowerCase().replaceAll(' ', '-')}`}>{value ?? '-'}</span>;
}

// The backend stores absolute image URLs built from APP_URL, which often points
// at a different host/port than where the API is actually served (e.g. stored as
// localhost:8000 but served on 127.0.0.1:8001). Rewrite local-host URLs to the
// real API origin so images load; leave external URLs (e.g. Supabase) untouched.
const API_ORIGIN = (api.defaults.baseURL || '').replace(/\/api\/?$/, '');

// Only these protocols may ever reach an href/src. Blocks javascript:, data:,
// vbscript: etc. from rendering live — defense in depth, since these URLs are
// server-generated today but this guarantees it stays safe regardless.
const SAFE_URL_PROTOCOLS = ['http:', 'https:'];

function resolvePhotoUrl(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url, window.location.origin);
    if (!SAFE_URL_PROTOCOLS.includes(parsed.protocol)) {
      return ''; // unsafe scheme — refuse to render it
    }
    const isLocalHost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(parsed.hostname);
    if (isLocalHost && API_ORIGIN) {
      const base = new URL(API_ORIGIN);
      parsed.protocol = base.protocol;
      parsed.host = base.host;
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

function PhotoCell({ url, alt }) {
  if (!url) {
    return '-';
  }

  const resolved = resolvePhotoUrl(url);

  return (
    <a className="photo-cell" href={resolved} rel="noreferrer" target="_blank">
      <img alt={alt} className="photo-thumb" src={resolved} loading="lazy" />
    </a>
  );
}

// Consistent "avatar + name" cell used everywhere a table references a user
// (Reported By, Checked By, Personnel, Updated By, Archived By, etc.).
// Clicking it opens that user's info — so a user cell no longer inherits the
// row's "open vehicle" click.
function UserAvatarName({ user, fallback = '-' }) {
  const actions = useContext(RowActionsContext);

  if (!user || !user.name) {
    return <span className="user-avatar-name-empty">{fallback}</span>;
  }

  const initials = user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
  const inner = (
    <>
      {user.photo_url ? (
        <img className="user-avatar-name-photo" src={resolvePhotoUrl(user.photo_url)} alt={user.name} />
      ) : (
        <span className="user-avatar-name-initials">{initials}</span>
      )}
      <span>{user.name}</span>
    </>
  );

  if (actions?.viewUser) {
    return (
      <button
        type="button"
        className="user-avatar-name cell-link"
        onClick={(e) => { e.stopPropagation(); actions.viewUser(user); }}
        title={`View ${user.name}`}
      >
        {inner}
      </button>
    );
  }

  return <span className="user-avatar-name">{inner}</span>;
}

// Vehicle cell (photo + name). The name opens the vehicle profile; the photo
// still opens the full-size image in a new tab.
// `isRowTitle` (default true) marks whether THIS column is also what the
// row's own onRowClick opens — true in every table except the Maintenance
// Tickets list, whose row click opens the ticket (the Title column) rather
// than this vehicle, so only that one caller passes false. Drives whether
// hovering anywhere in the row underlines this name too (row-title-text) —
// leaving it on everywhere would underline two different "click targets"
// at once on that one table.
function VehicleCell({ vehicle, isRowTitle = true, link = true }) {
  const actions = useContext(RowActionsContext);

  if (!vehicle) {
    return '-';
  }

  const textClassName = `vcn-text${isRowTitle ? ' row-title-text' : ''}`;

  return (
    <div className="vehicle-cell">
      <PhotoCell alt={vehicle.vehicle_name} url={vehicle.photo_url} />
      {link && actions?.viewVehicle && vehicle.vehicle_id ? (
        <button
          type="button"
          className="vehicle-cell-name cell-link"
          onClick={(e) => { e.stopPropagation(); actions.viewVehicle(vehicle); }}
          title={vehicle.vehicle_name}
        >
          <span className={textClassName}>{vehicle.vehicle_name}</span>
        </button>
      ) : (
        <span className="vehicle-cell-name" title={vehicle.vehicle_name}>
          <span className={textClassName}>{vehicle.vehicle_name}</span>
        </span>
      )}
    </div>
  );
}

// "Card View / List View" selector — a labeled dropdown (Realcore-style) that
// replaces the old two-icon toggle in panel header bars.
const VIEW_MODE_OPTIONS = [
  { value: 'card', label: 'Card View', icon: 'grid' },
  { value: 'table', label: 'List View', icon: 'list' },
];

function ViewModeDropdown({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const current = VIEW_MODE_OPTIONS.find((o) => o.value === value) ?? VIEW_MODE_OPTIONS[0];

  return (
    <div className="view-dropdown" ref={ref}>
      <button
        type="button"
        className="view-dropdown-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Icon name={current.icon} size={14} /> {current.label} <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div className="view-dropdown-menu" role="listbox">
          {VIEW_MODE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`view-dropdown-item${o.value === value ? ' active' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              <Icon name={o.icon} size={14} /> {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function moduleRequest(moduleKey, editTarget, payload) {
  const clean = cleanPayload(payload);

  if (moduleKey === 'vehicles') {
    return (editTarget && editTarget.vehicle_id)
      ? { method: 'put', path: `/vehicles/${editTarget.vehicle_id}`, success: 'Vehicle updated.' }
      : { method: 'post', path: '/vehicles', success: 'Vehicle added.' };
  }

  if (moduleKey === 'categories') {
    return (editTarget && editTarget.category_id)
      ? { method: 'put', path: `/categories/${editTarget.category_id}`, success: 'Vehicle type updated.' }
      : { method: 'post', path: '/categories', success: 'Vehicle type added.' };
  }

  if (moduleKey === 'users') {
    return (editTarget && editTarget.id)
      ? { method: 'put', path: `/users/${editTarget.id}`, success: 'User updated.' }
      : { method: 'post', path: '/users', success: 'User added.' };
  }

  if (moduleKey === 'conditions') {
    return (editTarget && editTarget.condition_check_id)
      ? { method: 'put', path: `/conditions/${editTarget.condition_check_id}`, success: 'Condition check updated.' }
      : { method: 'post', path: '/conditions', success: 'Condition check recorded.' };
  }

  if (moduleKey === 'issues') {
    return (editTarget && editTarget.issue_report_id)
      ? { method: 'put', path: `/issues/${editTarget.issue_report_id}`, success: 'Issue updated.' }
      : { method: 'post', path: '/issues', success: 'Issue report submitted.' };
  }

  if (moduleKey === 'maintenance') {
    return (editTarget && editTarget.maintenance_id)
      ? { method: 'put', path: `/maintenance-records/${editTarget.maintenance_id}`, success: 'Maintenance record updated.' }
      : { method: 'post', path: '/maintenance-records', success: 'Maintenance record added.' };
  }

  if (moduleKey === 'schedules') {
    return (editTarget && editTarget.schedule_id)
      ? { method: 'put', path: `/maintenance-schedules/${editTarget.schedule_id}`, success: 'Schedule updated for Admin approval.' }
      : { method: 'post', path: '/maintenance-schedules', success: 'Schedule added.' };
  }

  return { method: 'post', path: moduleEndpoints[moduleKey], payload: clean, success: 'Saved.' };
}

async function sendPayload(method, path, payload) {
  // A 'multi-file' field's value is an array of File objects, not a single
  // File — checked here too so a payload whose ONLY file-shaped field is one
  // of these (e.g. new attachments with no single-file field alongside)
  // still switches this request into FormData/multipart mode.
  const hasFile = Object.values(payload).some((value) => (
    Array.isArray(value) ? value.some((item) => isFile(item) && item.size > 0) : isFile(value) && value.size > 0
  ));

  if (hasFile) {
    const formData = new FormData();
    Object.entries(payload).forEach(([key, value]) => {
      if (value === '' || value === null || value === undefined) return;
      if (Array.isArray(value)) {
        // Send arrays (e.g. multi-role `roles`) as roles[] so PHP parses a list.
        value.forEach((item) => formData.append(`${key}[]`, item));
      } else {
        formData.append(key, value);
      }
    });
    if (method !== 'post') {
      formData.append('_method', method.toUpperCase());
      return api.post(path, formData);
    }

    return api.post(path, formData);
  }

  return api[method](path, cleanPayload(payload));
}

function cleanPayload(payload) {
  return Object.fromEntries(
    Object.entries(payload)
      .filter(([, value]) => value !== '' && value !== undefined && !(isFile(value) && value.size === 0))
      .map(([key, value]) => [key, value === '' ? null : value]),
  );
}

function valuesFromFields(fields, initialValues) {
  return Object.fromEntries(fields.map((field) => {
    const raw = initialValues?.[field.name];
    if (field.type === 'checkboxes') {
      return [field.name, Array.isArray(raw) && raw.length ? raw : []];
    }
    // A 'list' field edits as separate rows but is stored as one
    // newline-joined string (see handleSubmit) — no backend/schema change
    // needed, and it stays a plain string for any code that just displays it.
    if (field.type === 'list') {
      const rows = typeof raw === 'string' && raw.trim() ? raw.split('\n') : (Array.isArray(raw) ? raw : []);
      return [field.name, rows.length ? rows : ['']];
    }
    return [field.name, raw ?? ''];
  }));
}

function options(items, valueKey, labelKey) {
  return items.map((item) => ({
    value: item[valueKey],
    label: item[labelKey],
  }));
}

// Inactive (archived) vehicles are excluded from every "pick a vehicle"
// dropdown app-wide — you can't schedule/report/record work against a
// vehicle that's been taken out of service.
function vehicleOptions(lookups) {
  return lookups.vehicles
    .filter((vehicle) => vehicle.status !== 'Inactive' && vehicle.status !== 'Decommissioned')
    .map((vehicle) => ({
      value: vehicle.vehicle_id,
      label: vehicleLabel(vehicle),
    }));
}

function vehicleLabel(vehicle) {
  if (!vehicle) {
    return '-';
  }

  return `${vehicle.vehicle_name} (${vehicle.plate_number})`;
}

function formatDate(value) {
  if (!value) {
    return '-';
  }

  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila', dateStyle: 'medium',
    timeStyle: value.includes?.('T') ? 'short' : undefined,
  }).format(parseTimestamp(value));
}

// Compact "table cell" version of a date: a colored month/day pill plus the
// year underneath — used in place of the long formatDate() string inside
// table columns. Time (when the source field carries one) is its own
// adjacent "Time" column via formatTime(), so it never repeats here.
function DateBadge({ value }) {
  if (!value) {
    return '-';
  }

  const date = parseTimestamp(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return (
    <span className="date-badge">
      <span className="date-badge-pill">
        <span className="date-badge-month">{date.toLocaleDateString('en-US', { timeZone: 'Asia/Manila', month: 'short' })}</span>
        <span className="date-badge-day">{date.toLocaleDateString('en-US', { timeZone: 'Asia/Manila', day: '2-digit' })}</span>
      </span>
      <span className="date-badge-meta">
        <span>{date.toLocaleDateString('en-US', { timeZone: 'Asia/Manila', year: 'numeric' })}</span>
      </span>
    </span>
  );
}

// Muted inline date for calm contexts (the ticket detail cards) where the
// chunky red DateBadge tile reads as an alert. Dense tables keep the tile.
function QuietDate({ value }) {
  if (!value) return <span className="muted">—</span>;
  const date = parseTimestamp(value);
  if (Number.isNaN(date.getTime())) return <span className="muted">—</span>;
  return (
    <span className="quiet-date">
      <Icon name="calendar" size={12} /> {formatDate(value)}
    </span>
  );
}

// Plain time-of-day text for the "Time" column that sits next to a
// DateBadge column — blank for date-only fields (no time component).
function formatTime(value) {
  if (!value || typeof value !== 'string' || !value.includes('T')) {
    return '-';
  }

  const date = parseTimestamp(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', timeStyle: 'short' }).format(date);
}

// Mechanic repair logs are stored as plain text, one entry per submission in
// the form "[YYYY-MM-DD HH:MM] message", separated by a blank line. Parse
// that back out so each entry can show a proper DateBadge instead of a raw
// bracketed timestamp buried in a wall of text.
// `limit` (compact mode only, optional): show just the latest N entries
// with a toggle to reveal the rest, so a long history stays one line tall.
function RepairLogEntries({ text, compact = false, limit = null }) {
  const [showAll, setShowAll] = useState(false);

  if (!text) {
    return <p className="empty-state">No logs yet.</p>;
  }

  const entries = text.split(/\n\s*\n/).map((chunk) => {
    const match = chunk.match(/^\[(.+?)\]\s*([\s\S]*)$/);
    if (!match) {
      return { iso: null, message: chunk.trim() };
    }
    return { iso: parseTimestamp(match[1].trim()).toISOString(), message: match[2].trim() };
  }).filter((entry) => entry.message || entry.iso);

  if (compact) {
    const collapsed = limit != null && !showAll && entries.length > limit;
    const shown = collapsed ? entries.slice(-limit) : entries;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {shown.map((entry, i) => (
          <p key={i} style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text, #334155)' }}>
            {entry.iso && <span className="muted" style={{ fontSize: '0.7rem', marginRight: 6 }}>{formatDate(entry.iso)}</span>}
            {entry.message}
          </p>
        ))}
        {limit != null && entries.length > limit && (
          <button type="button" className="lr-link-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show latest only' : `View full repair history (${entries.length})`}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="repair-log-entries">
      {entries.map((entry, i) => (
        <div className="repair-log-entry" key={i}>
          <div className="repair-log-entry-date">
            <DateBadge value={entry.iso} />
            {entry.iso && <span className="repair-log-entry-time">{formatTime(entry.iso)}</span>}
          </div>
          <p className="repair-log-entry-message">{entry.message}</p>
        </div>
      ))}
    </div>
  );
}

// Builds a CSV file from `columns` (each { label, value(row) }) and `rows`,
// then triggers a browser download named `filename`.
function exportRowsToCsv(filename, columns, rows) {
  const escapeCell = (value) => {
    const str = String(value ?? '');
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const lines = [columns.map((c) => escapeCell(c.label)).join(',')];
  rows.forEach((row) => {
    lines.push(columns.map((c) => escapeCell(c.value(row))).join(','));
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

const USER_EXPORT_COLUMNS = [
  { label: 'ID', value: (r) => recordNumber(r, 'id') },
  { label: 'Name', value: (r) => r.name },
  { label: 'Email', value: (r) => r.email },
  { label: 'Phone', value: (r) => r.phone ?? '' },
  { label: 'Role', value: (r) => ((Array.isArray(r.roles) && r.roles.length) ? r.roles : [r.role].filter(Boolean)).join(', ') },
  { label: 'Status', value: (r) => (r.is_active ? 'Active' : 'Inactive') },
];

const SCHEDULE_EXPORT_COLUMNS = [
  { label: 'ID', value: (r) => recordNumber(r, 'schedule_id') },
  { label: 'Vehicle', value: (r) => (r.vehicle ? `${r.vehicle.vehicle_name} (${r.vehicle.plate_number})` : '') },
  { label: 'Type', value: (r) => r.maintenance_type },
  { label: 'Date', value: (r) => r.scheduled_date },
  { label: 'Time', value: (r) => r.scheduled_time ? String(r.scheduled_time).slice(0, 5) : '' },
  { label: 'Location', value: (r) => r.service_location },
  { label: 'Status', value: (r) => r.status },
];

function rowKey(row, index) {
  // An explicit override wins — lets a flattened row (e.g. many sub-issues under
  // one ticket) supply a guaranteed-unique key instead of colliding on ticket_id.
  if (row._rowKey != null)            return row._rowKey;
  // Use the most-specific ID first so tickets sharing a vehicle never collide.
  if (row.ticket_id != null)          return `t-${row.ticket_id}`;
  if (row.log_id != null)             return `l-${row.log_id}`;
  if (row.history_id != null)         return `h-${row.history_id}`;
  if (row.schedule_id != null)        return `sc-${row.schedule_id}`;
  if (row.maintenance_id != null)     return `m-${row.maintenance_id}`;
  if (row.issue_report_id != null)    return `ir-${row.issue_report_id}`;
  if (row.condition_check_id != null) return `cc-${row.condition_check_id}`;
  if (row.location_record_id != null) return `loc-${row.location_record_id}`;
  // vehicle_id before category_id: vehicle rows carry both, and keying them by
  // their (shared) category_id collides whenever vehicles share a type.
  if (row.vehicle_id != null)         return `v-${row.vehicle_id}`;
  if (row.category_id != null)        return `cat-${row.category_id}`;
  return index;
}

function moduleLabel(modules, activeModule) {
  return modules.find(([key]) => key === activeModule)?.[1] ?? 'Workspace';
}


function issueDescription(role) {
  if (role === 'Custodian') {
    return 'Submit vehicle problems and track issues you reported.';
  }

  if (role === 'Maintenance Personnel') {
    return 'Review reported vehicle issues and add technical remarks.';
  }

  return 'Manage reported vehicle problems and update review status.';
}

function isFile(value) {
  return typeof File !== 'undefined' && value instanceof File;
}

function showError(error, setNotice) {
  const validation = error.response?.data?.errors;
  if (validation) {
    const lines = Object.values(validation).flat();
    setNotice({ type: 'error', text: lines.join(' '), lines });
    return;
  }

  const message = error.response?.data?.message ?? 'Something went wrong while saving.';
  const openTickets = error.response?.data?.open_tickets;
  setNotice(
    openTickets?.length
      ? { type: 'error', text: message, openTickets }
      : { type: 'error', text: message }
  );
}


// =========================================================================
// TICKET WORKFLOW FIELD FACTORIES
// =========================================================================

// Flattens a ticket's sub_issues into standalone rows carrying their parent
// ticket's context (vehicle, priority, custodian, etc.) — used by the
// Mechanic Work Order queue and the Custodian Verification queue, which now
// act on one sub-issue at a time instead of a whole ticket. Pass
// `mechanicId` to further restrict to that mechanic's own assigned lines
// (a ticket can carry sub-issues split across several mechanics).
function flattenSubIssueRows(tickets, mechanicId = null) {
  const rows = [];
  (tickets ?? []).forEach((ticket) => {
    (ticket.sub_issues ?? []).forEach((subIssue) => {
      if (mechanicId && subIssue.assigned_mechanic_id !== mechanicId) return;
      rows.push({
        ...subIssue,
        ticket_id: ticket.ticket_id,
        barangay_number: ticket.barangay_number,
        ticket_title: ticket.ticket_title,
        ticket_description: ticket.ticket_description,
        ticket_status: ticket.status,
        vehicle: ticket.vehicle,
        priority: ticket.priority,
        assigned_custodian: ticket.assigned_custodian,
        created_at: ticket.created_at,
      });
    });
  });
  return rows;
}

// One entry per ticket (a sub-issue belongs to exactly one ticket, which
// belongs to exactly one vehicle) — so a vehicle with several sub-issues
// dispatched to the same mechanic collapses into a single list entry
// instead of a separate table row per Cause. Mirrors groupWorkTrackerByTicket
// below, but tailored to flattenSubIssueRows' shape (no isMechanic/isVerifier
// flags — "needs action" here is just "still Under Repair").
function groupMechanicRowsByTicket(rows) {
  const map = new Map();
  rows.forEach((row) => {
    if (!map.has(row.ticket_id)) {
      map.set(row.ticket_id, {
        ticket_id: row.ticket_id,
        barangay_number: row.barangay_number,
        ticket_title: row.ticket_title,
        vehicle: row.vehicle,
        subIssues: [],
      });
    }
    map.get(row.ticket_id).subIssues.push(row);
  });
  return Array.from(map.values()).map((group) => ({
    ...group,
    needsAction: group.subIssues.some((s) => s.status === 'Under Repair'),
  }));
}

// =========================================================================
// WORK TRACKER — cross-phase outcome feed (Custodian + Maintenance)
// =========================================================================

// Reads the FK that may arrive either as an eager-loaded relation object or as
// the raw integer column (both serialize under the same snake_case key).
function idOf(value) {
  return (value && typeof value === 'object') ? value.id : value;
}

// Flattens role-scoped tickets into one row per sub-issue THIS user is tied to,
// tagged with how they're involved (Mechanic / Custodian / both). A ticket may
// carry sibling sub-issues owned by other people — those are skipped.
function flattenWorkTrackerRows(tickets, user) {
  const uid = user?.id;
  const rows = [];
  (tickets ?? []).forEach((ticket) => {
    (ticket.sub_issues ?? []).forEach((si) => {
      const isMechanic = si.assigned_mechanic_id === uid;
      const isVerifier = ticket.assigned_custodian_id === uid || idOf(si.verification_assigned_to) === uid;
      if (!isMechanic && !isVerifier) return;

      const relationship = (isMechanic && isVerifier) ? 'Mechanic + Custodian'
        : isMechanic ? 'Mechanic' : 'Custodian';

      // Latest timestamp across every event that could have touched this line,
      // so "Last Update" reflects real activity rather than row creation.
      const stamps = [
        si.reopened_at, si.confirmed_at, si.verified_at, si.repair_completed_at,
        si.mechanic_assigned_at, si.deferred_at, ticket.created_at,
      ].filter(Boolean);
      let lastIso = ticket.created_at ?? null;
      let lastTs = 0;
      stamps.forEach((s) => {
        const t = new Date(s).getTime();
        if (t >= lastTs) { lastTs = t; lastIso = s; }
      });

      rows.push({
        _rowKey: `wt-${ticket.ticket_id}-${si.sub_issue_id}`,
        ticket_id: ticket.ticket_id,
        barangay_number: ticket.barangay_number,
        ticket_title: ticket.ticket_title,
        sub_issue_id: si.sub_issue_id,
        title: si.title,
        status: si.status,
        vehicle: ticket.vehicle,
        relationship,
        isMechanic,
        isVerifier,
        maintenance_type: si.maintenance_type,
        assigned_mechanic: si.assigned_mechanic,
        verification_verdict: si.verification_verdict,
        confirmation_verdict: si.confirmation_verdict,
        reopened_at: si.reopened_at,
        confirmed_at: si.confirmed_at,
        deferred_at: si.deferred_at,
        lastActivityIso: lastIso,
        lastActivityTs: lastTs,
      });
    });
  });
  return rows;
}

// The single outcome label a user cares about at a glance, plus a tone that
// drives its color. Ordered from most-final (Confirmed) to earliest (Open).
function workTrackerOutcome(row) {
  const { status, verification_verdict, confirmation_verdict, reopened_at } = row;
  if (status === 'Done' && confirmation_verdict === 'Confirmed') return { label: 'Confirmed — Done', tone: 'success' };
  if (reopened_at && status === 'For Inspection')                return { label: 'Reopened by Admin', tone: 'warning' };
  if (status === 'For Confirmation')                             return { label: 'Approved — awaiting Admin', tone: 'info' };
  if (status === 'Under Repair' && verification_verdict === 'Rejected') return { label: 'Rejected — redo repair', tone: 'warning' };
  if (status === 'For Inspection')                               return { label: 'Awaiting your verification', tone: 'info' };
  if (status === 'Under Repair')                                 return { label: 'In repair', tone: 'info' };
  if (status === 'Deferred')                                     return { label: 'Deferred', tone: 'warning' };
  if (status === 'Open')                                         return { label: 'Awaiting assignment', tone: 'neutral' };
  return { label: status ?? '—', tone: 'neutral' };
}

// True when the item is sitting in THIS user's court needing action — the
// mechanic still owes a repair log, or the verifier still owes a verification.
function workTrackerNeedsAction(row) {
  if (row.isMechanic && row.status === 'Under Repair') return true;
  if (row.isVerifier && row.status === 'For Inspection') return true;
  return false;
}

function workTrackerBucket(row) {
  if (workTrackerNeedsAction(row)) return 'attention';
  if (row.status === 'Done' || row.status === 'Deferred') return 'completed';
  return 'progress';
}

// Master-detail grouping: one entry per ticket (a sub-issue belongs to exactly
// one ticket, which belongs to exactly one vehicle), so a vehicle with many
// sub-issues collapses to a single list entry instead of many table rows.
// Sorted the same way the old flat list was — action-needed first, then most
// recently active — so the master list surfaces what matters without scrolling.
function groupWorkTrackerByTicket(rows) {
  const map = new Map();
  rows.forEach((row) => {
    if (!map.has(row.ticket_id)) {
      map.set(row.ticket_id, {
        ticket_id: row.ticket_id,
        barangay_number: row.barangay_number,
        ticket_title: row.ticket_title,
        vehicle: row.vehicle,
        subIssues: [],
        lastActivityTs: 0,
        lastActivityIso: null,
      });
    }
    const group = map.get(row.ticket_id);
    group.subIssues.push(row);
    if (row.lastActivityTs >= group.lastActivityTs) {
      group.lastActivityTs = row.lastActivityTs;
      group.lastActivityIso = row.lastActivityIso;
    }
  });

  return Array.from(map.values())
    .map((group) => ({ ...group, needsAction: group.subIssues.some(workTrackerNeedsAction) }))
    .sort((a, b) => {
      const an = a.needsAction ? 1 : 0;
      const bn = b.needsAction ? 1 : 0;
      if (an !== bn) return bn - an;
      return b.lastActivityTs - a.lastActivityTs;
    });
}

// My Tasks -> History: a plain record of work that's actually finished — a
// sub-issue reached Done (confirmed) or Deferred. Anything still Open/Under
// Repair/For Inspection/etc. belongs in the My Tickets tab, not here; this
// used to also surface in-progress work ("Work Tracker"'s original scope),
// but that read as unfinished tickets showing up in a "History" list, so
// it's completed-only now, with no 30-day cutoff — it's meant to be the
// full record, not a recent-activity feed.
function WorkTrackerModule({ tickets, user, categories = [], vehicles = [], onViewTicket, tabBar }) {
  const [activeFilter, setActiveFilter] = useState('');
  const [search, setSearch] = useState('');
  const historyColumns = useMemo(() => ticketTableColumns({}, onViewTicket), [onViewTicket]);
  const historyColumnChooser = useColumnChooser('vms_my_tasks_history_columns', historyColumns);
  // FilterBar (draft/apply) state — Category + Capacity + Status + My Role.
  const [filterCategory, setFilterCategory] = useState([]);
  const [filterCapacity, setFilterCapacity] = useState([]);
  const [filterStatus, setFilterStatus] = useState([]);
  const [filterRole, setFilterRole] = useState([]);
  const [filterOutcome, setFilterOutcome] = useState([]);

  const allRows = useMemo(() => {
    return flattenWorkTrackerRows(tickets, user)
      .filter((row) => row.status === 'Done' || row.status === 'Deferred')
      // Most recently finished first.
      .sort((a, b) => b.lastActivityTs - a.lastActivityTs);
  }, [tickets, user]);

  const counts = useMemo(() => {
    const c = { Done: 0, Deferred: 0 };
    allRows.forEach((row) => { c[row.status] += 1; });
    return c;
  }, [allRows]);

  const visibleRows = useMemo(() => {
    let result = allRows;
    if (activeFilter) result = result.filter((row) => row.status === activeFilter);
    if (filterCategory.length) result = result.filter((row) => filterCategory.includes(String(row.vehicle?.category_id)));
    if (filterCapacity.length) result = result.filter((row) => filterCapacity.includes(row.vehicle?.capacity));
    if (filterStatus.length) result = result.filter((row) => filterStatus.includes(row.status));
    if (filterRole.length) {
      result = result.filter((row) => (
        (filterRole.includes('Mechanic') && row.isMechanic) || (filterRole.includes('Custodian') && row.isVerifier)
      ));
    }
    if (filterOutcome.length) result = result.filter((row) => filterOutcome.includes(workTrackerOutcome(row).label));
    const q = search.trim().toLowerCase();
    if (q) {
      result = result.filter((row) => (
        (row.vehicle?.vehicle_name ?? '').toLowerCase().includes(q)
        || (row.vehicle?.plate_number ?? '').toLowerCase().includes(q)
        || (row.ticket_title ?? '').toLowerCase().includes(q)
        || (row.title ?? '').toLowerCase().includes(q)
      ));
    }
    return result;
  }, [allRows, activeFilter, filterCategory, filterCapacity, filterStatus, filterRole, filterOutcome, search]);

  const groupedTickets = useMemo(() => groupWorkTrackerByTicket(visibleRows), [visibleRows]);
  // Use the original tickets so the shared list retains status, priority and personnel.
  const ticketById = useMemo(() => {
    const map = new Map();
    (tickets ?? []).forEach((t) => map.set(t.ticket_id, t));
    return map;
  }, [tickets]);
  const historyTickets = useMemo(
    () => groupedTickets.map((g) => ticketById.get(g.ticket_id)).filter(Boolean),
    [groupedTickets, ticketById]
  );

  return (
    <div className="module-grid">
      <ModuleStatCards
        totalLabel="Total"
        total={allRows.length}
        cards={WORK_TRACKER_STAT_CARDS}
        counts={counts}
        activeFilter={activeFilter}
        onFilterChange={setActiveFilter}
      />
      {tabBar}
      <section className="panel module-filter-panel">
        <FilterBar
          categories={categories}
          vehicles={vehicles}
          filterCategory={filterCategory}
          setFilterCategory={setFilterCategory}
          filterCapacity={filterCapacity}
          setFilterCapacity={setFilterCapacity}
          filterStatus={filterStatus}
          setFilterStatus={setFilterStatus}
          filterPriority={filterRole}
          setFilterPriority={setFilterRole}
          statusOptions={['Done', 'Deferred']}
          priorityOptions={(hasRole(user, 'Custodian') && hasRole(user, 'Maintenance Personnel')) ? ['Mechanic', 'Custodian'] : []}
          priorityLabel="Role"
          extraFilters={[{
            key: 'outcome',
            label: 'Outcomes',
            options: ['Confirmed — Done', 'Deferred'],
            selected: filterOutcome,
            setSelected: setFilterOutcome,
          }]}
        />
      </section>
      <section className="panel operations-board work-tracker-board">
        <div className="operations-board-head">
          <div>
            <span className="operations-kicker">Service history</span>
            <h3>History <span className="count-badge">{visibleRows.length}</span></h3>
            <p>Every ticket you've worked on that's already done or deferred — still-open work stays on My Tickets.</p>
          </div>
          <LocalSearchInput
            value={search}
            onChange={setSearch}
            columnChooser={historyColumnChooser}
            placeholder="Search vehicle, plate, or ticket..."
            onExport={() => exportRowsToCsv('work-tracker.csv', [
              { label: 'Ticket', value: (r) => `#${ticketNumber(r)} ${r.ticket_title}` },
              { label: 'Vehicle', value: (r) => r.vehicle?.vehicle_name ?? '' },
              { label: 'Plate Number', value: (r) => r.vehicle?.plate_number ?? '' },
              { label: 'Sub-Issue', value: (r) => r.title ?? '' },
              { label: 'My Role', value: (r) => r.relationship },
              { label: 'Status', value: (r) => r.status ?? '' },
              { label: 'Outcome', value: (r) => workTrackerOutcome(r).label },
              { label: 'Last Update', value: (r) => r.lastActivityIso ?? '' },
            ], visibleRows)}
          />
        </div>
        <div style={{ height: '16px' }} />
        <PaginatedTable
          columns={historyColumnChooser.visibleColumns}
          onReorderColumn={historyColumnChooser.reorderColumn}
          rows={historyTickets}
          onRowClick={onViewTicket}
          emptyMessage="Nothing here yet — tickets you've worked on will show up here once they're done or deferred."
        />
      </section>
    </div>
  );
}

// Problem 2 — the functional test ("UAT") checklist. What must be physically
// operated and confirmed depends on the KIND of vehicle, keyed off the same
// Land/Water domain that drives the specs form (plus a fire-truck extra).


// The Custodian's verification IS the functional test: operate the vehicle
// against the checklist, mark each Pass/Fail, and the verdict follows the
// result — any Fail => Rejected (bounced back to the mechanic); all Pass =>
// Approved, but only once the tester attests they actually operated it.


// Success toast for /verify — the same endpoint either closes the ticket or
// sends it back, so the message has to follow the verdict actually sent.
function verifyOutcomeMessage(payload) {
  return payload?.verification_verdict === 'Rejected'
    ? 'Returned for repair — the mechanic has been notified.'
    : 'Repair verified — ticket closed.';
}

// The Custodian's whole-ticket verification — the vehicle-type functional
// test above (VerificationForm), not a bare checkbox: operate the vehicle,
// mark each check, then either Approve (all pass + attestation; closes the
// ticket) or Return for Repair (any failed check; ticket goes back to the
// mechanic). POSTs to /tickets/{id}/verify, which re-checks all of it and
// enforces who may verify (TicketController::verifyTicket).
function TicketVerificationForm({ ticket, onCancel, onSubmit }) {
  const [decision, setDecision] = useState('');
  const [attested, setAttested] = useState(false);
  const [failedIds, setFailedIds] = useState([]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    if (!decision) { setError('Choose Approve or Disapprove.'); return; }
    if (decision === 'Approved' && !attested) { setError('Confirm that you personally tested the vehicle.'); return; }
    if (decision === 'Rejected' && !failedIds.length) { setError('Select the work items that need rework.'); return; }
    if (decision === 'Rejected' && !reason.trim()) { setError('A reason is required so the mechanic knows what to fix.'); return; }
    setSubmitting(true);
    try {
      await onSubmit(decision === 'Rejected'
        ? { verification_verdict: 'Rejected', verification_notes: reason.trim(), failed_sub_issue_ids: failedIds }
        : { verification_verdict: 'Approved', test_attested: attested, ...(reason.trim() ? { verification_notes: reason.trim() } : {}) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="verify-decision" onSubmit={submit} noValidate>
      <p className="verify-decision-lead">Has the repair been checked and does the vehicle work as it should?</p>
      <div className="verify-decision-choices" role="radiogroup" aria-label="Verification decision">
        <button type="button" role="radio" aria-checked={decision === 'Approved'} className={`verify-choice is-approve${decision === 'Approved' ? ' is-selected' : ''}`} onClick={() => { setDecision('Approved'); setError(''); }}>
          <Icon name="checkCircle" size={22} />
          <strong>Approve</strong>
          <small>Closes this ticket after your test passes.</small>
        </button>
        <button type="button" role="radio" aria-checked={decision === 'Rejected'} className={`verify-choice is-reject${decision === 'Rejected' ? ' is-selected' : ''}`} onClick={() => { setDecision('Rejected'); setError(''); }}>
          <Icon name="close" size={22} />
          <strong>Disapprove</strong>
          <small>Sends it back to the mechanic to fix.</small>
        </button>
      </div>
      {decision === 'Approved' && <label className="verify-decision-reason"><span><input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} /> I personally tested this vehicle and confirm the repairs passed.</span></label>}
      {decision === 'Rejected' && (
        <fieldset className="verify-rework-items">
          <legend>Which work items need rework?</legend>
          <p>Other submitted work stays submitted. The ticket stays open until every repair passes.</p>
          {(ticket?.sub_issues ?? []).filter((item) => item.status === 'For Inspection').map((item) => (
            <label key={item.sub_issue_id}>
              <input type="checkbox" checked={failedIds.includes(item.sub_issue_id)} onChange={(e) => setFailedIds((ids) => e.target.checked ? [...ids, item.sub_issue_id] : ids.filter((id) => id !== item.sub_issue_id))} />
              <span>{item.title}</span>
            </label>
          ))}
        </fieldset>
      )}
      {decision && (
        <label className="verify-decision-reason">
          <span>{decision === 'Rejected' ? 'Reason' : 'Note (optional)'}{decision === 'Rejected' && <abbr className="required-asterisk" title="required"> *</abbr>}</span>
          <textarea rows={3} value={reason} onChange={(e) => { setReason(e.target.value); setError(''); }} placeholder={decision === 'Rejected' ? 'What is still wrong or incomplete?' : 'Anything the Admin or mechanic should know'} />
        </label>
      )}
      {error && <p className="verify-decision-error" role="alert">{error}</p>}
      <div className="verify-decision-actions">
        <button type="button" className="ghost-button" onClick={onCancel} disabled={submitting}>Cancel</button>
        <button type="submit" className={decision === 'Rejected' ? 'danger-button' : 'primary-button'} disabled={submitting || !decision}>
          {submitting ? 'Saving…' : decision === 'Rejected' ? 'Disapprove' : 'Approve'}
        </button>
      </div>
    </form>
  );
}

// =========================================================================
// TICKET STATUS BADGE
// =========================================================================

function TicketStatusBadge({ value, size = 'normal' }) {
  if (['Pending Approval', 'Active', 'Open'].includes(value)) {
    return <TicketStatusPill status={value} size={size} />;
  }
  const colorMap = {
    'For Maintenance': 'ticket-formaint',
    'Under Repair': 'ticket-repair',
    'Declined': 'ticket-cancelled',
    'For Verification': 'ticket-forinspect',
    'For Inspection': 'ticket-forinspect',
    'For Confirmation': 'ticket-forconfirm',
    'Done': 'ticket-done',
    'Deferred': 'ticket-deferred',
    'Closed': 'ticket-done',
    'Deleted': 'ticket-cancelled',
    'Cancelled': 'ticket-cancelled',
    'Low': 'priority-low',
    'Medium': 'priority-medium',
    'High': 'priority-high',
    'Critical': 'priority-critical',
    'Needs Maintenance': 'ticket-formaint',
    'No Issues': 'ticket-done',
    'Approved': 'ticket-done',
    'Rejected': 'ticket-repair',
    'Confirmed': 'ticket-done',
    'Reopened': 'ticket-repair',
  };
  const cls = colorMap[value] ?? 'status-badge';
  return <span className={`status-badge ${cls} ${size === 'large' ? 'badge-large' : ''}`}>{value ?? '-'}</span>;
}

// Ticket-level status → colour family. One source of truth for every ticket
// view (cards, tables, archives, the repair workspace header): the card
// border/accent and the status pill both read the same class, so a ticket
// never changes colour just because the view switched. Unknown or missing
// statuses fall back to a neutral tone instead of breaking the render.
const TICKET_STATUS_TONE = {
  'Pending Approval': 'pending',
  Declined: 'declined',
  Active: 'active',
  Open: 'active',
  'For Verification': 'verify',
  Closed: 'closed',
  Cancelled: 'cancelled',
  Deleted: 'cancelled',
};
function ticketStatusClass(status) {
  return `ts-${TICKET_STATUS_TONE[status] ?? 'unknown'}`;
}

// The ticket's overall status as a tinted pill in its status colour —
// separate from priority (TicketStatusBadge keeps its own priority colours).
function TicketStatusPill({ status, size = 'normal' }) {
  return <span className={`status-badge ticket-status-pill ${ticketStatusClass(status)} ${size === 'large' ? 'badge-large' : ''}`}>{status ?? 'Unknown'}</span>;
}

// =========================================================================
// TICKET PROPOSAL REVIEW — Admin's approve/decline screen for a Custodian's
// proposed ticket (status 'Pending Approval'). Kept as its own pair of
// components (not folded into the sub-issue cards below) so the existing
// read-only rendering for every other status stays completely untouched —
// TicketDetailPanel only ever mounts this while ticket.status is exactly
// 'Pending Approval', and swaps in a plain read-only notice instead for
// anyone viewing it without ticket.approve (i.e. the proposing Custodian).
// =========================================================================

function TicketProposalReview({ user, ticket, lookups, onApprove, onDecline, onUndecline, onRequestCorrections, onResubmit }) {
  if (ticket.correction_requested_at) {
    if (canDo(user, 'ticket.resubmit') && String(user.id) === String(ticket.assigned_custodian_id)) {
      return <TicketCorrectionForm key={`${ticket.ticket_id}:${ticket.decision_revision}`} ticket={ticket} lookups={lookups} onSubmit={onResubmit} />;
    }
    return <TicketCorrectionsPending ticket={ticket} onDecline={canDo(user, 'ticket.decline') ? onDecline : null} />;
  }
  if (ticket.status === 'Declined' && canDo(user, 'ticket.approve')) {
    return <TicketReconsiderForm ticket={ticket} onUndecline={onUndecline} />;
  }
  if (!canDo(user, 'ticket.approve')) {
    if (ticket.status === 'Declined') {
      return (
        <section className="ticket-section">
          <h4><Icon name="clipboard" size={14} /> Proposal Status</h4>
          <div className="notice danger" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="alert" size={15} /> Declined{ticket.decline_reason ? ` — ${ticket.decline_reason}` : '.'}
          </div>
        </section>
      );
    }
    return (
      <section className="ticket-section">
        <h4><Icon name="clipboard" size={14} /> Proposal Status</h4>
        <div className="notice warning" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="alert" size={15} /> Awaiting Admin review — you'll be notified once this is approved or declined.
        </div>
      </section>
    );
  }

  // Keyed by ticket id so a fresh mount (a different ticket) always starts
  // from that ticket's own values instead of whatever was last typed here.
  return <TicketProposalReviewForm key={`${ticket.ticket_id}:${ticket.decision_revision}`} ticket={ticket} lookups={lookups} onApprove={onApprove} onDecline={onDecline} onUndecline={onUndecline} onRequestCorrections={onRequestCorrections} />;
}

function TicketCorrectionsPending({ ticket, onDecline }) {
  const [declining, setDeclining] = useState(false);
  return <section className="ticket-section"><h4>Corrections requested</h4><p className="notice warning">{ticket.correction_reason}</p><p>Waiting for {ticket.assigned_custodian?.name ?? 'the assigned Custodian'} to correct and resubmit. Approval is blocked until then.</p>{onDecline && (declining ? <SmartForm fields={[{ label: 'Decline reason', name: 'decline_reason', type: 'textarea', rows: 3, required: true }]} title="" onCancel={() => setDeclining(false)} onSubmit={onDecline} submitLabel="Decline Proposal" /> : <button type="button" className="danger-button" onClick={() => setDeclining(true)}>Decline Proposal</button>)}</section>;
}

function TicketReconsiderForm({ ticket, onUndecline }) {
  const [busy, setBusy] = useState(false);
  return <section className="ticket-section"><h4>Declined proposal</h4><p className="notice danger">{ticket.decline_reason}</p><p>Undecline returns this proposal for Admin review. It does not approve or start work. The original decline remains in decision history.</p><button type="button" className="ghost-button" disabled={busy} onClick={async () => { if (busy) return; setBusy(true); try { await onUndecline(); } finally { setBusy(false); } }}>{busy ? 'Reconsidering...' : 'Undecline'}</button></section>;
}

function TicketCorrectionForm({ ticket, lookups, onSubmit }) {
  const [description, setDescription] = useState(ticket.ticket_description ?? '');
  const [priority, setPriority] = useState(ticket.priority ?? 'Medium');
  const [rows, setRows] = useState(() => (ticket.sub_issues ?? []).map((item) => ({ sub_issue_id: item.sub_issue_id, title: item.title, maintenance_type: item.maintenance_type ?? '' })));
  const external = (ticket.sub_issues ?? []).find((item) => item.repair_type === 'external');
  const [scope, setScope] = useState(external?.external_work_scope ?? '');
  const [reason, setReason] = useState(external?.external_reason ?? '');
  const [busy, setBusy] = useState(false);
  return (
    <section className="ticket-section smart-form">
      <h4>Correct this proposal</h4>
      <p className="notice warning">{ticket.correction_reason}</p>
      <p>Update the same proposal. It will return to Admin review; no repair work starts until approved.</p>
      <form onSubmit={async (event) => { event.preventDefault(); if (busy) return; setBusy(true); try { await onSubmit({ ticket_description: description, priority, sub_issues: rows.map((row) => ({ ...row, maintenance_type: row.maintenance_type || null })), ...(external ? { external_work_scope: scope, external_reason: reason } : {}) }); } finally { setBusy(false); } }}>
        <label><span>Details *</span><textarea required rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <label><span>Priority *</span><SearchableSelect required value={priority} onChange={(event) => setPriority(event.target.value)}>{(lookups.priorities ?? []).map((value) => <option key={value} value={value}>{value}</option>)}</SearchableSelect></label>
        {rows.map((row, index) => <div className="proposal-subissue" key={row.sub_issue_id}>
          <label><span>Work item {index + 1} *</span><input required maxLength={255} value={row.title} onChange={(event) => setRows((values) => values.map((value, i) => i === index ? { ...value, title: event.target.value } : value))} /></label>
          <label><span>Repair Type (optional)</span><CreatableSelect value={row.maintenance_type} options={lookups.maintenance_types ?? []} catalogEndpoint="/maintenance-types" newItemLabel="repair type" onChange={(value) => setRows((values) => values.map((item, i) => i === index ? { ...item, maintenance_type: value } : item))} /></label>
        </div>)}
        {external && <><label><span>Reason for external work *</span><SearchableSelect required value={reason} onChange={(event) => setReason(event.target.value)}>{(lookups.external_reasons ?? []).map((value) => <option key={value} value={value}>{value}</option>)}</SearchableSelect></label><label><span>External work details *</span><textarea required rows={3} value={scope} onChange={(event) => setScope(event.target.value)} /></label></>}
        <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Submitting...' : 'Resubmit for Admin Review'}</button>
      </form>
    </section>
  );
}

// What a cannibalized / external-shop sub-issue actually involves — the
// Admin's basis for approving it, shown wherever that sub-issue is reviewed.
function RepairContextDetails({ si }) {
  if (!si) return null;
  const rows = si.repair_type === 'cannibalized'
    ? [
      ['Donor Vehicle', si.source_vehicle ? `${si.source_vehicle.vehicle_name} (${si.source_vehicle.plate_number})` : null],
      ['Missing / Faulty Part', si.part_missing],
      ['Part From Donor', si.part_needed],
    ]
    : si.repair_type === 'external'
      ? [
        ['Reason for Sending Out', si.external_reason],
        ['External Shop', si.external_vendor],
        ['Contact Person', si.external_contact_person],
        ['Contact Number', si.external_shop_contact],
        ['Sent By', si.external_sent_by],
        ['Shop Address', si.external_shop_address],
        ['Date Sent', si.external_sent_at ? formatDate(si.external_sent_at) : null],
        ['Expected Return', si.external_expected_return ? formatDate(si.external_expected_return) : null],
        ['Returned', si.external_returned_at ? `${formatDate(si.external_returned_at)}${si.external_receiver?.name ? ` · received by ${si.external_receiver.name}` : ''}` : (si.external_sent_at ? 'Not yet returned' : null)],
        ['Actual Cost', si.external_actual_cost != null ? `₱${Number(si.external_actual_cost).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : null],
        ['Shop Result', si.external_return_notes],
        ['Estimated Cost', si.external_estimated_cost != null ? `₱${Number(si.external_estimated_cost).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : null],
        ['Details', si.external_work_scope],
      ]
      : [];
  const shown = rows.filter(([, v]) => v);
  if (!shown.length) return null;
  return (
    <dl className="veh-kv" style={{ marginTop: 8, padding: '8px 10px', background: si.repair_type === 'cannibalized' ? '#fff7ed' : '#f5f3ff', borderRadius: 8, fontSize: '0.8rem' }}>
      {shown.map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{value}</dd></div>
      ))}
    </dl>
  );
}

function TicketProposalReviewForm({ ticket, lookups, onApprove, onDecline, onUndecline, onRequestCorrections }) {
  const isDeclined = ticket.status === 'Declined';
  // Pre-fill from whatever the Custodian suggested when adding sub-issues
  // (if any) — Admin can still change it before approving.
  const [fields, setFields] = useState({
    ticket_description: ticket.ticket_description ?? '',
    priority: ticket.priority ?? '',
  });
  const [subRows, setSubRows] = useState(() => (ticket.sub_issues ?? []).map((si) => ({
    sub_issue_id: si.sub_issue_id,
    title: si.title ?? '',
    maintenance_type: si.maintenance_type ?? '',
    assigned_mechanic_id: String(si.assigned_mechanic_id ?? si.suggested_mechanic_id ?? ''),
    repair_type: si.repair_type,
  })));
  const [declining, setDeclining] = useState(false);
  const [requestingCorrections, setRequestingCorrections] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [validationLine, setValidationLine] = useState(null);
  // An external-shop ticket goes to an outside shop: no in-house mechanic.
  const extSub = (ticket.sub_issues ?? []).find((si) => si.repair_type === 'external');
  const isExternalTicket = (ticket.sub_issues ?? []).length > 0 && (ticket.sub_issues ?? []).every((si) => si.repair_type === 'external');

  const setField = (name, value) => setFields((f) => ({ ...f, [name]: value }));
  const updateSubRow = (index, patch) => setSubRows((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  // One mechanic does the whole ticket now — approving is the single
  // moment the ticket gets both activated AND dispatched, in one step.
  const submitApprove = async () => {
    if (subRows.some((row) => row.repair_type !== 'external' && !row.assigned_mechanic_id)) {
      setValidationLine('Assign Maintenance Personnel to every sub-issue before approving.');
      return;
    }
    if (subRows.some((row) => row.repair_type !== 'external' && String(row.assigned_mechanic_id) === String(ticket.assigned_custodian_id))) {
      setValidationLine('The verifying Custodian cannot repair this ticket. Choose a different mechanic or reassign the Custodian before approval.');
      return;
    }
    // A blank value is dropped before it reaches the server, which then keeps
    // the old text — so the edit would silently not happen.
    if (!String(fields.ticket_description ?? '').trim() || subRows.some((r) => !String(r.title ?? '').trim())) {
      setValidationLine('The description and every sub-issue title need text before approving.');
      return;
    }
    setValidationLine(null);
    setSubmitting(true);
    try {
      await onApprove({
        ticket_description: fields.ticket_description,
        priority: fields.priority,
        sub_issues: subRows.map((r) => ({
          sub_issue_id: r.sub_issue_id,
          title: r.title,
          maintenance_type: r.maintenance_type || null,
          assigned_mechanic_id: r.repair_type === 'external' ? null : r.assigned_mechanic_id,
        })),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const custodianName = ticket.assigned_custodian?.name ?? 'the Custodian';
  const repairTypeLabel = { in_house: 'In-House', cannibalized: 'Cannibalized Part', external: 'External Shop' };

  return (
    <section className="ticket-section smart-form proposal-review">
      <div className="proposal-review-head">
        <span className="proposal-review-head-icon"><Icon name="checkCircle" size={18} /></span>
        <div className="proposal-review-head-text">
          <h4>Review Proposal</h4>
          <p>Proposed by <strong>{custodianName}</strong></p>
        </div>
        <span className={`proposal-review-pill${isDeclined ? ' is-declined' : ''}`}>{isDeclined ? 'Declined' : 'Pending Approval'}</span>
      </div>

      {isDeclined && (
        <div className="notice danger" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 12px' }}>
          <Icon name="alert" size={15} /> You declined this proposal{ticket.decline_reason ? `: ${ticket.decline_reason}` : '.'} Undecline it first to send it back to Pending Approval, then approve and assign.
        </div>
      )}

      <div className="proposal-review-body">
        <div className="proposal-review-group">
          <div className="proposal-review-group-title"><Icon name="clipboard" size={14} /> Ticket Details</div>
          <div className="ticket-form-grid-2" style={{ padding: 0, marginBottom: 12 }}>
            <label>
              <span>Ticket</span>
              <input type="text" value={ticket.ticket_title ?? ''} readOnly title="Generated by the system" />
            </label>
            <label>
              <span>Priority</span>
              <SearchableSelect value={fields.priority} onChange={(e) => setField('priority', e.target.value)}>
                {(lookups.priorities ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
              </SearchableSelect>
            </label>
          </div>
          <label>
            <span>Details</span>
            <textarea rows={3} value={fields.ticket_description} onChange={(e) => setField('ticket_description', e.target.value)} />
          </label>
          {isExternalTicket ? (
            <div className="external-approve-note">
              <strong><Icon name="vehicle" size={14} /> Sent to an external shop: no in-house mechanic needed</strong>
              <dl>
                <div><dt>Shop</dt><dd>{extSub?.external_vendor || 'To be recorded at dispatch'}</dd></div>
                <div><dt>Sent by / responsible</dt><dd>{extSub?.external_sent_by || 'Recorded from the signed-in user at dispatch'}</dd></div>
                <div><dt>Reason</dt><dd>{extSub?.external_reason || '—'}</dd></div>
              </dl>
            </div>
          ) : null}
        </div>

        <div className="proposal-review-group">
          <div className="proposal-review-group-title">
            <Icon name="wrench" size={14} /> Sub-Issues
            {subRows.length > 0 && <span className="proposal-review-count">{subRows.length}</span>}
          </div>
      {subRows.map((row, index) => {
        const original = (ticket.sub_issues ?? []).find((s) => s.sub_issue_id === row.sub_issue_id);
        const repairType = original?.repair_type;
        return (
        <div key={row.sub_issue_id} className={`proposal-subissue is-${repairType ?? 'none'}`}>
          <div className="proposal-subissue-head">
            <span className="proposal-subissue-num">{index + 1}</span>
            <input className="proposal-subissue-title" type="text" aria-label="Sub-issue title" value={row.title} onChange={(e) => updateSubRow(index, { title: e.target.value })} />
            {repairType && <span className={`proposal-subissue-type is-${repairType}`}>{repairTypeLabel[repairType] ?? repairType}</span>}
          </div>
          <div className="ticket-form-grid-2 proposal-assignment-row"><label>
            <span>Repair Type</span>
            <CreatableSelect
              value={row.maintenance_type}
              onChange={(v) => updateSubRow(index, { maintenance_type: v })}
              options={lookups.maintenance_types ?? []}
              newItemLabel="repair type"
              catalogEndpoint="/maintenance-types"
            />
          </label>
          {repairType !== 'external' && <label>
            <span>Maintenance Personnel <span className="required-asterisk">*</span></span>
            <SearchableSelect aria-label={`Maintenance Personnel for sub-issue ${index + 1}`} value={row.assigned_mechanic_id} onChange={(e) => updateSubRow(index, { assigned_mechanic_id: e.target.value })}>
              <option value="">Assign Maintenance Personnel</option>
              {(lookups.maintenance_personnel ?? []).map((mechanic) => <option key={mechanic.id} value={mechanic.id}>{mechanicWorkloadLabel(mechanic)}</option>)}
            </SearchableSelect>
          </label>}
          </div>
          <RepairContextDetails si={original} />
        </div>
        );
      })}
        </div>
      </div>

      {validationLine && <p className="notice danger" style={{ margin: '0 0 12px' }}><Icon name="alert" size={14} /> {validationLine}</p>}

      {requestingCorrections ? (
        <SmartForm fields={[{ label: 'What needs correcting?', name: 'correction_reason', type: 'textarea', required: true, rows: 3 }]} onCancel={() => setRequestingCorrections(false)} onSubmit={onRequestCorrections} submitLabel="Request Corrections" title="Return to Custodian" />
      ) : declining ? (
        <div className="proposal-review-actions is-declining">
          <SmartForm
            fields={[{ label: 'Decline Reason', name: 'decline_reason', type: 'textarea', rows: 2, required: true, placeholder: 'Let the Custodian know why this was declined' }]}
            key={`decline-proposal-${ticket.ticket_id}`}
            onCancel={() => setDeclining(false)}
            // The proposal stays on screen as Declined, so close the form or
            // it keeps offering a second decline the server will refuse.
            onSubmit={(payload) => onDecline(payload).then((ok) => { if (ok !== false) setDeclining(false); return ok; })}
            submitLabel="Decline Proposal"
            title=""
          />
        </div>
      ) : (
        <div className="proposal-review-actions">
          <p className="proposal-review-hint">
            {isDeclined
              ? 'Undecline this proposal first — Approve & Assign appears once it is back to Pending Approval.'
              : 'Edit anything above before approving or declining.'}
          </p>
          <div className="proposal-review-buttons">
            {!isDeclined && onRequestCorrections && <button className="ghost-button proposal-decision-btn" type="button" disabled={submitting} onClick={() => setRequestingCorrections(true)}>Request Corrections</button>}
            {isDeclined ? (
              <button className="btn-sm ghost-button" type="button" onClick={onUndecline} disabled={submitting}>
                <Icon name="undo" size={14} /> Undecline
              </button>
            ) : (
              <button className="danger-button proposal-decision-btn" type="button" onClick={() => setDeclining(true)} disabled={submitting}>
                <Icon name="close" size={14} /> Decline
              </button>
            )}
            {!isDeclined && (
              <button className="primary-button proposal-decision-btn" type="button" onClick={submitApprove} disabled={submitting}>
                <Icon name="checkCircle" size={14} /> Approve
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// Two-column sub-issue builder: left is a single add/edit form, right is the
// numbered list of what's saved so far. Replaces the old "N open rows, each
// editable live" grid — a sub-issue is either being drafted or it's saved,
// never both at once, which is what makes Edit/Delete on the right
// unambiguous. Shared by the Custodian's Propose form and the ticket's own
// "Add Sub-issue" panel so both look and behave the same way.
// "Jake Engana — 5 active tickets": the mechanic's current load, so whoever
// is assigning (or suggesting) can balance work and reassign if needed.
function mechanicWorkloadLabel(m) {
  const t = Number(m.active_tickets ?? 0);
  const j = Number(m.scheduled_jobs ?? 0);
  if (m.active_tickets == null) return m.name;
  return `${m.name} — ${t} active ticket${t === 1 ? '' : 's'}${j ? ` · ${j} scheduled` : ''}`;
}

function TwoColumnSubIssueEditor({ items, onChange, maintenanceTypeOptions, mechanicOptions, minItems = 1 }) {
  const [draft, setDraft] = useState({ index: null, title: '', maintenance_type: '', suggested_mechanic_id: '' });
  const isEditing = draft.index !== null;

  const startEdit = (index) => setDraft({
    index,
    title: items[index].title ?? '',
    maintenance_type: items[index].maintenance_type ?? '',
    suggested_mechanic_id: items[index].suggested_mechanic_id ?? '',
  });
  const resetDraft = () => setDraft({ index: null, title: '', maintenance_type: '', suggested_mechanic_id: '' });

  const draftRow = () => ({ title: draft.title.trim(), maintenance_type: draft.maintenance_type || null, suggested_mechanic_id: draft.suggested_mechanic_id || null });

  // "Save" commits whatever's currently typed — appends it as a new
  // sub-issue, or updates the one being edited if a row's pencil icon was
  // clicked. "+ Add" doesn't commit anything; it just clears the fields
  // (and drops out of edit mode) so a fresh sub-issue can be typed next.
  const save = () => {
    if (!draft.title.trim()) return;
    const row = draftRow();
    if (isEditing) {
      onChange(items.map((it, i) => (i === draft.index ? { ...it, ...row } : it)));
    } else {
      onChange([...items, row]);
    }
    resetDraft();
  };

  const remove = (index) => {
    onChange(items.filter((_, i) => i !== index));
    if (draft.index === index) resetDraft();
  };

  return (
    <div className="subissue-two-col">
      <div className="subissue-editor-panel">
        <span className="subissue-editor-title">Add a specific problem</span>
        <label>
          <span>Subissue</span>
          <input
            type="text"
            placeholder="e.g. Low coolant level"
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
          />
        </label>
        <label style={{ marginTop: 10 }}>
          <span>Repair Type</span>
          <CreatableSelect
            value={draft.maintenance_type}
            onChange={(v) => setDraft((d) => ({ ...d, maintenance_type: v }))}
            options={maintenanceTypeOptions ?? []}
            placeholder="Select a category or type to add new"
            newItemLabel="repair type"
            catalogEndpoint="/maintenance-types"
          />
        </label>
        {mechanicOptions && (
          <label style={{ marginTop: 10 }}>
            <span>Maintenance Personnel</span>
            <SearchableSelect
              value={draft.suggested_mechanic_id}
              onChange={(e) => setDraft((d) => ({ ...d, suggested_mechanic_id: e.target.value }))}
            >
              <option value="">Unassigned — Admin will decide</option>
              {mechanicOptions.map((m) => <option key={m.id} value={m.id}>{mechanicWorkloadLabel(m)}</option>)}
            </SearchableSelect>
          </label>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button type="button" className="primary-button" disabled={!draft.title.trim()} onClick={save}>
            <Icon name="plus" size={13} /> Add
          </button>
        </div>
      </div>

      <div className="subissue-editor-panel">
        <span className="subissue-editor-title">Added problems <span className="subissue-count">{items.length}</span></span>
        {items.length === 0 ? (
          <div className="subissue-empty-state"><span className="subissue-empty-icon"><Icon name="wrench" size={17} /></span><strong>No problems added yet</strong><span>Add each specific repair item here. You can include multiple problems on one ticket.</span></div>
        ) : (
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {items.map((it, index) => (
              <li key={index} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8 }}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', background: '#eff6ff', color: '#2563eb', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', fontWeight: 700, flexShrink: 0 }}>{index + 1}</span>
                <span style={{ flex: 1, fontSize: '0.85rem' }}>
                  {it.title}
                  {it.maintenance_type && <span className="muted"> — {it.maintenance_type}</span>}
                  {mechanicOptions && (
                    <span className="muted"> · Personnel: {it.suggested_mechanic_id ? (mechanicOptions.find((m) => String(m.id) === String(it.suggested_mechanic_id))?.name ?? '—') : 'Unassigned'}</span>
                  )}
                </span>
                <button type="button" className="icon-btn btn-edit-action" title="Edit" aria-label="Edit" onClick={() => startEdit(index)}><Icon name="edit" size={13} /></button>
                <button type="button" className="icon-btn btn-delete-action" title="Delete" aria-label="Delete" disabled={items.length <= minItems} onClick={() => remove(index)}><Icon name="trash" size={13} /></button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

// =========================================================================
// TICKET DETAIL PANEL — shown when admin clicks a ticket row
// =========================================================================

function TicketDetailPanel({ user, userId, ticket, lookups, onAssignTicketMechanic, onReassignCustodian, onReopenDone, onLogRepairs, onSubmitForVerification, onVerifyTicket, onCancel, onUncancel, onDelete, onRequestConfirmation, onApproveCannibalization, onRejectCannibalization, onApproveProposal, onDeclineProposal, onUndeclineProposal, onRequestCorrections, onResubmitProposal, onClose, asPage = false }) {
  // Cannibalization approval — tracks which sub-issue's reject form is
  // open; Approve has no form of its own (it needs no input beyond the
  // click itself), so it doesn't need a tracked id.
  const [reviewingCannibalizationId, setReviewingCannibalizationId] = useState(null);
  const [approvingCannibalId, setApprovingCannibalId] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [reassigningCustodian, setReassigningCustodian] = useState(false);
  const [reassigningMechanic, setReassigningMechanic] = useState(false);
  const [editingDoneId, setEditingDoneId] = useState(null);
  // The ticket's one assigned Custodian giving their plain attestation —
  // replaces the old per-sub-issue verify/confirm pair with a single
  // ticket-level step.
  const [verifying, setVerifying] = useState(false);
  const [submittingForVerification, setSubmittingForVerification] = useState(false);
  // Which sub-issue cards show their full repair details. null = untouched,
  // so a short list starts open and a long one starts collapsed.
  const [expandedSubIds, setExpandedSubIds] = useState(null);

  if (!ticket) return null;

  const subIssues = ticket.sub_issues ?? [];
  const hasEvidence = subIssues.some((item) => ['For Inspection', 'For Confirmation', 'Done', 'Deferred'].includes(item.status) || item.repair_logs || item.parts_used || item.repair_started_at || item.repair_completed_at || item.part_installed_at || item.maintenance_cost != null || item.attachment_url || item.attachment_files?.length || item.external_sent_at || item.external_returned_at || item.external_cycles?.length || item.work_history?.length || item.donor_parts?.length);
  const progress = ticket.progress ?? {
    done: subIssues.filter((s) => s.status === 'Done').length,
    deferred: subIssues.filter((s) => s.status === 'Deferred').length,
    total: subIssues.length,
  };
  const defaultExpandedSubs = subIssues.length <= 3 ? subIssues.map((s) => s.sub_issue_id) : [];
  const expandedSubs = expandedSubIds ?? defaultExpandedSubs;
  const isSubExpanded = (id) => expandedSubs.includes(id);
  const allSubsExpanded = subIssues.length > 0 && subIssues.every((s) => expandedSubs.includes(s.sub_issue_id));
  const toggleSubExpanded = (id) => setExpandedSubIds((prev) => {
    const ids = prev ?? defaultExpandedSubs;
    return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
  });
  const isAssignedMechanic = String(ticket.assigned_mechanic_id) === String(userId) || subIssues.some((sub) => String(sub.assigned_mechanic_id) === String(userId));
  const isAssignedCustodian = ticket.assigned_custodian_id != null && String(ticket.assigned_custodian_id) === String(userId);
  // Every sub-issue has to have its repair logged (For Inspection) before
  // the mechanic can hand the whole ticket to the Custodian — a cannibalized
  // line item still sitting at Pending Approval naturally blocks this,
  // since it isn't at For Inspection yet either.
  const allLogged = subIssues.length > 0 && subIssues.every((s) => s.status === 'For Inspection');
  const canSubmitForVerification = ticket.status === 'Active' && isAssignedMechanic && allLogged && canDo(user, 'ticket.submit_for_verification');
  const awaitingMyVerification = ticket.status === 'For Verification' && isAssignedCustodian && canDo(user, 'ticket.verify');
  // The server refuses a verification from anyone who repaired this ticket.
  const repairedByMe = didRepairWorkOn(ticket, userId);
  const canVerifyTicket = awaitingMyVerification && !repairedByMe;
  // External-shop ticket: where the vehicle actually is right now.
  const isExternalTicket = subIssues.length > 0 && subIssues.every((s) => s.repair_type === 'external');
  const extSubs = subIssues.filter((s) => s.repair_type === 'external');
  const extStage = (() => {
    if (!isExternalTicket) return { label: '', hint: '' };
    const sent = extSubs.every((s) => s.external_sent_at);
    const anySent = extSubs.some((s) => s.external_sent_at);
    const returned = extSubs.every((s) => s.external_returned_at);
    if (!anySent) return { label: 'Awaiting dispatch', hint: 'Waiting to be sent to the shop', detail: 'Approved. The vehicle has not been sent to the shop yet — record the dispatch.' };
    if (!sent || !returned) return { label: 'At external shop', hint: 'Sent to the shop; service in progress', detail: 'The vehicle is with the outside shop. Record its return when it comes back.' };
    return { label: 'Returned — record service report', hint: 'Vehicle returned; service report next', detail: 'The vehicle is back. Record the service report so the Custodian can verify it.' };
  })();
  const canHandleExternal = isExternalTicket && ticket.status === 'Active' && canDo(user, 'external.handle');
  // "How long has this been sitting?" — the aging signal. Flagged past 30 days.
  const daysOpen = ticket.days_open;
  const isAging = ticket.status !== 'Closed' && ticket.status !== 'Cancelled' && typeof daysOpen === 'number' && daysOpen >= 30;

  const requestDelete = () => {
    onRequestConfirmation({
      title: 'Delete Ticket',
      message: `Are you sure you want to completely delete Ticket #${ticketNumber(ticket)}? This action cannot be undone.`,
      confirmLabel: 'Delete Ticket',
      variant: 'danger',
      onConfirm: () => onDelete(ticket),
    });
  };

  const requestCancel = () => setCancelling(true);

  const panel = (
      <div className={`ticket-detail-panel${asPage ? ' is-page' : ''}`} onClick={asPage ? undefined : (e) => e.stopPropagation()}>
        <section className="ticket-process-hero ticket-process-hero--simple">
          <div className="ticket-process-hero-main">
            <div className="ticket-process-kicker">
              <span>Ticket #{ticketNumber(ticket)}</span>
              {typeof daysOpen === 'number' && (
                <span className="ticket-age-badge">{daysOpen === 0 ? 'Opened today' : `${daysOpen} day${daysOpen === 1 ? '' : 's'} open`}</span>
              )}
            </div>
            <h3 className="ticket-detail-title">{ticket.ticket_title}</h3>
            <div className="ticket-detail-meta">
              <div className="ticket-hero-badges">
                <TicketStatusBadge value={ticket.priority} />
                <TicketStageBadge ticket={ticket} variant="pill" />
              </div>
              {isAging && (
                <span className="status-badge ticket-cancelled" title="This ticket has been open a long time; resolve or close it.">
                  <Icon name="alert" size={12} /> Aging: {daysOpen} days
                </span>
              )}
              {ticket.recurrence_count > 0 && (
                <span className="status-badge rework-warning" title="This Main Issue was already fixed on this vehicle recently; a recurring failure.">
                  <Icon name="undo" size={12} /> Recurring: {ticket.recurrence_count + 1}
                  {['st', 'nd', 'rd'][ticket.recurrence_count] ?? 'th'} time
                </span>
              )}
            </div>
            {progress.deferred > 0 && (
              <div className="ticket-detail-subline">
                <span><Icon name="alert" size={12} /> {progress.deferred} deferred</span>
              </div>
            )}
          </div>

          {!asPage && <button className="icon-btn ticket-process-close" onClick={onClose} type="button" title="Close" aria-label="Close"><Icon name="close" size={18} /></button>}

        </section>

        {ticket.status === 'Cancelled' ? (
          <p className="notice danger ticket-process-cancelled"><Icon name="alert" size={15} /> This ticket was cancelled.</p>
        ) : ticket.status === 'Declined' ? (
          <p className="notice danger ticket-process-cancelled">
            <Icon name="alert" size={15} /> This proposal was declined.{ticket.decline_reason ? ` Reason: ${ticket.decline_reason}` : ''}
          </p>
        ) : (
          <div className="ticket-process-flow" role="list" aria-label="Ticket progress">
            {phaseOrder.map((s, i) => {
              const current = phaseOrder.indexOf(ticket.status);
              const state = i < current ? 'done' : i === current ? 'active' : 'upcoming';
              const hint = (isExternalTicket ? {
                'Pending Approval': 'Admin reviews the outsourcing request',
                Active: extStage.hint,
                'For Verification': 'Custodian verifies the returned vehicle',
                Closed: 'Verified and closed',
              } : {
                'Pending Approval': 'Admin approves & assigns a mechanic',
                Active: 'Mechanic repairs, logs, submits',
                'For Verification': 'Custodian verifies',
                Closed: 'Return or archive',
              })[s];
              return (
                <div key={s} className={`ticket-process-flow-step is-${state}`} role="listitem" style={state === 'active' ? { '--ticket-flow-active-color': PHASE_STEP_COLORS[s] } : undefined}>
                  <span className="ticket-process-flow-marker" style={state === 'active' ? { background: PHASE_STEP_COLORS[s], borderColor: PHASE_STEP_COLORS[s] } : undefined}>
                    {state === 'done' ? <Icon name="checkCircle" size={16} /> : <Icon name={PHASE_STEP_ICONS[s]} size={16} />}
                  </span>
                  <span className="ticket-process-flow-label" style={state !== 'upcoming' ? { color: PHASE_STEP_COLORS[s] } : undefined}>{s}</span>
                  <small>{hint}</small>
                </div>
              );
            })}
          </div>
        )}
        <div className="ticket-detail-body ticket-detail-body-columns">
          <div className="ticket-detail-col-left">
            <section className="ticket-section">
              <h4><Icon name="vehicle" size={14} /> Overview</h4>
              <div className="ticket-preview-card ticket-preview-card--detail ticket-preview-card--stacked">
                {ticket.vehicle?.photo_url ? (
                  <img className="ticket-preview-photo" src={resolvePhotoUrl(ticket.vehicle.photo_url)} alt={ticket.vehicle.vehicle_name} />
                ) : (
                  <span className="ticket-preview-photo ticket-preview-photo-empty"><Icon name="vehicle" size={34} /></span>
                )}
                <div className="ticket-preview-body">
                  <strong>{ticket.vehicle?.vehicle_name}</strong>
                  <span>{ticket.vehicle?.plate_number} &middot; {ticket.vehicle?.category?.category_name ?? 'Unclassified'}</span>
                  <span className="muted">{[ticket.vehicle?.brand, ticket.vehicle?.model].filter(Boolean).join(' ') || '—'} &middot; {ticket.vehicle?.current_location ?? 'No location on file'}</span>
                  <div className="ticket-preview-badges ticket-overview-status-text">
                    <StatusBadge value={ticket.vehicle?.status} />
                    <StatusBadge value={ticket.vehicle?.condition} />
                  </div>

                </div>
              </div>
            </section>

            {ticket.assigned_custodian_id && (
              <section className={`ticket-section${ticket.inspection_result === 'Needs Maintenance' ? ' ticket-section--flag-warn' : ticket.inspection_result === 'No Issues' ? ' ticket-section--flag-ok' : ''}`}>
                <h4><Icon name="search" size={14} /> Custodian Inspection</h4>
                <div className="ticket-kv-row" style={{ marginBottom: (ticket.inspection_notes ? 8 : 0) }}>
                  <div>
                    <span>Assigned To</span>
                    <UserAvatarName user={ticket.assigned_custodian} />
                  </div>
                </div>
                {ticket.inspection_notes && <p className="muted" style={{ margin: 0, fontSize: '0.82rem' }}>{ticket.inspection_notes}</p>}

                {/* This Custodian is hard-locked as both the inspector AND the
                    verifier of every repair on this ticket. If they become
                    unavailable the ticket is otherwise unworkable — and if it's
                    still Open it can't even be closed. Same escape hatch the
                    mechanic work orders already have. */}
                {canDo(user, 'ticket.reassign_custodian') && onReassignCustodian && !['Closed', 'Cancelled'].includes(ticket.status) && (
                  <button className="ghost-button btn-reassign-action" style={{ marginTop: 10 }} type="button" onClick={() => setReassigningCustodian(true)}>
                    <Icon name="undo" size={12} /> Reassign Custodian
                  </button>
                )}
              </section>
            )}

            {canDo(user, 'ticket.reassign_custodian') && onReassignCustodian && (
              <FormModal className="ticket-reassignment-modal" open={reassigningCustodian} title="Reassign Custodian" onClose={() => setReassigningCustodian(false)}>
                <p className="muted" style={{ marginBottom: 8, fontSize: '0.8rem' }}>
                  Hand this ticket to a different Custodian (e.g. the current one is on leave). Any repairs already awaiting verification move with it.
                </p>
                <SmartForm
                  fields={[
                    { label: 'Reassign to Custodian', name: 'assigned_custodian_id', options: (lookups.custodians ?? []).filter((c) => c.id !== ticket.assigned_custodian_id).map((c) => ({ value: c.id, label: c.name })), required: true, type: 'select' },
                    { label: 'Reason for reassigning', name: 'reassign_reason', required: true, type: 'textarea', rows: 2 },
                  ]}
                  key={`reassign-custodian-${ticket.ticket_id}`}
                  onCancel={() => setReassigningCustodian(false)}
                  onSubmit={(payload) => onReassignCustodian(ticket, payload).then((ok) => { if (ok !== false) setReassigningCustodian(false); })}
                  submitLabel="Reassign Custodian"
                  title=""
                />
              </FormModal>
            )}

            {(ticket.assigned_mechanic_id || subIssues.some((sub) => sub.assigned_mechanic_id)) && (
              <section className="ticket-section">
                <h4><Icon name="wrench" size={14} /> Assigned Mechanic</h4>
                <div className="ticket-kv-row">
                  <div>
                    <span>Doing the repair</span>
                    <div className="ticket-person-row">
                      {[...new Map([ticket.assigned_mechanic, ...subIssues.map((sub) => sub.assigned_mechanic)].filter(Boolean).map((mechanic) => [mechanic.id, mechanic])).values()].map((mechanic) => <UserAvatarName key={mechanic.id} user={mechanic} />)}
                      <span className="ticket-role-tag">Maintenance Personnel</span>
                    </div>
                  </div>
                </div>
                {canDo(user, 'ticket.assign_mechanic') && onAssignTicketMechanic && !['Closed', 'Cancelled'].includes(ticket.status) && (
                  <button className="ghost-button btn-reassign-action" style={{ marginTop: 10 }} type="button" disabled={ticket.status !== 'Active' || !subIssues.some((item) => item.status === 'Under Repair' && item.repair_type !== 'external')} onClick={() => setReassigningMechanic(true)}>
                    <Icon name="undo" size={12} /> Reassign Mechanic
                  </button>
                )}
              </section>
            )}

            {canDo(user, 'ticket.assign_mechanic') && onAssignTicketMechanic && (
              <FormModal className="ticket-reassignment-modal" open={reassigningMechanic} title="Reassign Mechanic" onClose={() => setReassigningMechanic(false)}>
                <p className="muted" style={{ marginBottom: 8, fontSize: '0.8rem' }}>
                  Choose one unfinished work item to hand over. Submitted repairs and other mechanics' work stay unchanged. Return a submitted repair for rework before reassigning it.
                </p>
                <SmartForm
                  fields={[
                    { label: 'Work item', name: 'sub_issue_id', required: true, type: 'select', options: subIssues.filter((item) => item.status === 'Under Repair' && item.repair_type !== 'external').map((item) => ({ value: item.sub_issue_id, label: item.title })) },
                    { label: 'Reassign to Mechanic', name: 'assigned_mechanic_id', options: (lookups.maintenance_personnel ?? []).filter((m) => m.id !== ticket.assigned_mechanic_id).map((m) => ({ value: m.id, label: mechanicWorkloadLabel(m) })), required: true, type: 'select' },
                    { label: 'Reason for reassigning', name: 'reassign_reason', required: true, type: 'textarea', rows: 2 },
                  ]}
                  key={`reassign-mechanic-${ticket.ticket_id}`}
                  onCancel={() => setReassigningMechanic(false)}
                  onSubmit={(payload) => onAssignTicketMechanic(ticket, { assigned_mechanic_id: payload.assigned_mechanic_id, reassign_reason: payload.reassign_reason, sub_issue_ids: [Number(payload.sub_issue_id)] }).then((ok) => { if (ok !== false) setReassigningMechanic(false); })}
                  submitLabel="Reassign Mechanic"
                  title=""
                />
              </FormModal>
            )}

            {/* Recaps the ticket's own lifecycle dates in one place — also
                fills the left column so it doesn't end in a large empty gap
                below the (usually taller) Sub-Issues column on the right. */}
            <section className="ticket-section">
              <h4><Icon name="calendar" size={14} /> Ticket Timeline</h4>
              <div className="ticket-timeline">
                {ticketTimeline(ticket).map((ev, i, all) => (
                  <div key={ev.id} className="ticket-timeline-item">
                    <div className="ticket-timeline-marker">
                      <span className="ticket-timeline-dot"><Icon name={ev.icon} size={11} /></span>
                      {i < all.length - 1 && <span className="ticket-timeline-line" />}
                    </div>
                    <div className="ticket-timeline-content">
                      <p>{ev.label}</p>
                      {ev.details && <p className="muted">{ev.details}</p>}
                      <div className="ticket-timeline-meta">
                        {ev.by?.name && <span>by {ev.by.name}</span>}
                        <span>{new Date(ev.at).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', ...(ev.dateOnly ? {} : { timeStyle: 'short' }) })}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div className="ticket-detail-col-right">
          {/* Custodian-proposed ticket awaiting Admin review — a completely
              separate block from the normal sub-issue cards just below
              (which are explicitly excluded for this one status right
              after), so nothing about how every other status renders
              changes. */}
          {(ticket.status === 'Pending Approval' || ticket.status === 'Declined') && (
            <TicketProposalReview
              user={user}
              ticket={ticket}
              lookups={lookups}
              onApprove={(payload) => onApproveProposal(ticket, payload)}
              onDecline={(payload) => onDeclineProposal(ticket, payload)}
              onUndecline={() => onUndeclineProposal(ticket)}
              onRequestCorrections={(payload) => onRequestCorrections(ticket, payload)}
              onResubmit={(payload) => onResubmitProposal(ticket, payload)}
            />
          )}
          {ticket.status !== 'Open' && ticket.status !== 'Pending Approval' && ticket.status !== 'Declined' && (
            <section className="ticket-section">
              <h4>
                <Icon name="wrench" size={14} /> Sub-Issues
                {progress.total > 0 && <span className="ticket-count-pill">{progress.total}</span>}
                <span
                  className="ticket-section-info-icon"
                  title="Keep sub-issues and the mechanic's Repair Type scoped to this Main Issue — an unrelated repair belongs on its own ticket instead."
                >
                  <Icon name="info" size={13} />
                </span>
                {subIssues.length > 1 && (
                  <button
                    type="button"
                    className="ticket-subissue-toggle-all"
                    onClick={() => setExpandedSubIds(allSubsExpanded ? [] : subIssues.map((s) => s.sub_issue_id))}
                  >
                    {allSubsExpanded ? 'Collapse all' : 'Expand all'}
                  </button>
                )}
              </h4>

              {/* The actionable "ready to close" banner lives once, down in
                  ticket-detail-actions, covering both this case (no
                  sub-issues) and the all-resolved-via-defer case — so there's
                  one consistent prompt instead of two different ones. */}
              {subIssues.length === 0 && (
                <p className="muted">No sub-issues — inspection found nothing to repair.</p>
              )}

              <div className="ticket-subissue-scroll">
              {subIssues.map((si, index) => {
                const stageBanner = {
                  'Pending Approval': { color: '#d97706', bg: '#fffbeb', text: '#92400e', icon: 'alert', label: 'Cannibalized repair — awaiting Admin approval' },
                  'For Inspection':   { color: '#7c3aed', bg: '#f5f3ff', text: '#5b21b6', icon: 'search', label: ticket.status === 'For Verification' ? 'Repair logged — awaiting Custodian verification' : 'Repair logged — waiting on the rest of the ticket' },
                }[si.status];
                const open = isSubExpanded(si.sub_issue_id);
                const detailsId = `subissue-details-${si.sub_issue_id}`;

                return (
                <div key={si.sub_issue_id} className={`subissue-card${open ? ' is-open' : ' is-collapsed'}`}>
                  <div className="subissue-card-head">
                    <button
                      type="button"
                      className="subissue-toggle"
                      aria-expanded={open}
                      aria-controls={detailsId}
                      title={open ? 'Hide repair details' : 'Show repair details'}
                      onClick={() => toggleSubExpanded(si.sub_issue_id)}
                    >
                      <Icon name="chevronDown" size={14} />
                    </button>
                    <span className="subissue-index">{index + 1}</span>
                    <strong className="subissue-title">{si.title}</strong>
                    <TicketStatusBadge value={si.status} />
                  </div>

                  <div className="subissue-body-grid">
                  <div className="subissue-body-main">
                  {/* Compact single-line meta strip — was a 4-box label/value
                      grid; each value is now self-descriptive (avatar =
                      mechanic, wrench icon = category, ₱ = cost, colored
                      badge = verdict), which cuts the block's height by more
                      than half without losing any information. */}
                  {(si.assigned_mechanic || si.maintenance_type || si.verification_verdict || si.source_vehicle || si.external_vendor || (si.maintenance_cost !== null && si.maintenance_cost !== undefined)) && (
                    <div className="subissue-meta-strip">
                      {si.assigned_mechanic && <UserAvatarName user={si.assigned_mechanic} />}
                      {si.maintenance_type && (
                        <span className="subissue-meta-chip">
                          <Icon name="wrench" size={11} /> {si.maintenance_type}
                        </span>
                      )}
                      {/* Cannibalized/External are set once, at ticket creation —
                          surfaced here so the donor vehicle/vendor is visible
                          right away instead of only reappearing when a mechanic
                          opens Log Repairs (where it's pre-filled but otherwise
                          invisible on the ticket itself in the meantime). */}
                      {si.source_vehicle && (
                        <span className="subissue-meta-chip">
                          <Icon name="vehicle" size={11} /> Donor: {si.source_vehicle.vehicle_name} ({si.source_vehicle.plate_number})
                        </span>
                      )}
                      {si.external_vendor && (
                        <span className="subissue-meta-chip">
                          <Icon name="clipboard" size={11} /> External Shop: {si.external_vendor}
                          {si.warranty_until && ` (warranty until ${formatDate(si.warranty_until)})`}
                        </span>
                      )}
                      {si.maintenance_cost !== null && si.maintenance_cost !== undefined && (
                        <strong className="subissue-meta-cost">₱{Number(si.maintenance_cost).toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong>
                      )}
                      {si.verification_verdict && <TicketStatusBadge value={si.verification_verdict} />}
                    </div>
                  )}
                  {si.verification_verdict === 'Rejected' && <div className="lr-alert lr-alert-warning" role="alert"><strong>Returned for rework</strong><p>{si.verification_notes || 'Review the failed work items before resubmitting.'}</p></div>}
                  {open && <RepairContextDetails si={si} />}

                  {onLogRepairs && canHandleExternal && si.repair_type === 'external' && si.status === 'Under Repair' && !si.assigned_mechanic_id && (
                    <div className="subissue-head-right">
                      <button className="primary-button" type="button" onClick={() => onLogRepairs(ticket, si)}>
                        <Icon name="vehicle" size={14} /> {si.verification_verdict === 'Rejected' ? 'Record shop rework' : !si.external_sent_at ? 'Send to shop' : !si.external_returned_at ? 'Record return' : 'Record service report'}
                      </button>
                    </div>
                  )}
                  {onLogRepairs && ticket.status === 'Active' && canDo(user, 'subissue.log_repair') && si.status === 'Under Repair' && String(si.assigned_mechanic_id) === String(userId) && (
                    <div className="subissue-head-right">
                      <button className="primary-button" type="button" onClick={() => onLogRepairs(ticket, si)}>
                        <Icon name="wrench" size={14} /> Log Repairs
                      </button>
                    </div>
                  )}

                  {/* Makes every handoff visible — in particular, the Custodian's
                      verification step between the mechanic's repair and the
                      Admin's final confirmation, so it never looks skipped. */}
                  {open && stageBanner && (
                    <span className="subissue-stage-banner" style={{ '--stage-color': stageBanner.color, '--stage-bg': stageBanner.bg, '--stage-text': stageBanner.text }}>
                      <Icon name={stageBanner.icon} size={12} /> {stageBanner.label}
                    </span>
                  )}

                  {open && (
                  <div className="subissue-details" id={detailsId}>
                  {si.repair_logs && <RepairLogEntries text={si.repair_logs} compact />}
                  {!!si.external_cycles?.length && <details><summary>Earlier shop visits ({si.external_cycles.length})</summary>{si.external_cycles.map((cycle, index) => <p key={index}>Visit {index + 1}: {cycle.external_vendor} | sent {formatDate(cycle.external_sent_at)} | returned {formatDate(cycle.external_returned_at)} | {cycle.external_actual_cost == null ? 'Cost not recorded' : `PHP ${Number(cycle.external_actual_cost).toLocaleString('en-US', { minimumFractionDigits: 2 })}`} | {cycle.verification_notes}</p>)}</details>}
                  {!!si.work_history?.length && <details><summary>Work and verification history</summary><ul>{si.work_history.map((event, index) => <li key={index}>{event.event} | {event.name} | {formatDate(event.at)}{event.details?.notes ? ` | ${event.details.notes}` : ''}{event.details?.reason ? ` | ${event.details.reason}` : ''}</li>)}</ul></details>}
                  {si.parts_used && (
                    <div className="subissue-field">
                      <span className="subissue-field-label">Parts Used</span>
                      <PartsTags value={si.parts_used} />
                    </div>
                  )}
                  {(si.attachment_files ?? []).map((file, i) => <a key={file.url ?? i} className="subissue-attachment-link" href={resolvePhotoUrl(file.url)} target="_blank" rel="noreferrer"><Icon name="clipboard" size={13} />{file.name || 'Repair attachment'}</a>)}
                  {si.attachment_url && (
                    <a className="subissue-attachment-link" href={resolvePhotoUrl(si.attachment_url)} target="_blank" rel="noreferrer">
                      <Icon name="clipboard" size={13} /> View attached photo/document
                    </a>
                  )}
                  {Array.isArray(si.functional_test) && si.functional_test.length > 0 && (
                    <div className="subissue-functional-test">
                      <span className="subissue-field-label">
                        Functional Test{si.test_attested ? ' · operator-attested' : ''}
                      </span>
                      <div className="subissue-test-chip-row">
                        {si.functional_test.map((t, ti) => (
                          <span key={ti} className={`subissue-test-chip ${t.passed ? 'is-pass' : 'is-fail'}`}>
                            <Icon name={t.passed ? 'checkCircle' : 'alert'} size={11} /> {t.item}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {si.confirmation_verdict && si.status !== 'Deferred' && (
                    <p className="muted">Final verification: <TicketStatusBadge value={si.confirmation_verdict} /> {si.confirmation_notes}</p>
                  )}
                  </div>
                  )}

                  {si.reopened_at && si.status === 'For Inspection' && (
                    <div className="subissue-alert-banner">
                      <div className="subissue-alert-banner-head">
                        <Icon name="alert" size={14} /> <strong>Reopened by {si.reopened_by?.name || 'Admin'}</strong>
                      </div>
                      {si.confirmation_notes && <p><strong>Reason:</strong> {si.confirmation_notes}</p>}
                      <p className="subissue-alert-banner-footnote">This repair was unconfirmed and needs to be re-verified.</p>
                    </div>
                  )}

                  {si.status === 'Deferred' && (
                    <div className="subissue-alert-banner">
                      <div className="subissue-alert-banner-head">
                        <Icon name="alert" size={14} /> <strong>Deferred{si.deferred_by?.name ? ` by ${si.deferred_by.name}` : ''}</strong>
                      </div>
                      {si.deferred_reason && <p>{si.deferred_reason}</p>}
                      <p className="subissue-alert-banner-footnote">
                        A follow-up issue report{si.deferred_issue_report_id ? ` (Issue #${si.deferred_issue_report_id})` : ''} was opened so this defect isn't forgotten — the Custodian can propose a ticket from it.
                      </p>
                    </div>
                  )}

                  {/* Cannibalization approval (Phase A3) — a repair that used
                      a part taken from another vehicle waits here for an
                      Admin's sign-off before it's allowed on to Custodian
                      verification. Approving auto-opens an Issue Report on
                      the donor vehicle (backend side effect); rejecting
                      requires a reason and sends the sub-issue back to the
                      mechanic. */}
                  {ticket.status === 'Active' && (canDo(user, 'repair.approve_cannibalized') || canDo(user, 'repair.reject_cannibalized')) && si.status === 'Pending Approval' && (
                    reviewingCannibalizationId === si.sub_issue_id ? (
                      <div className="ticket-inline-form subissue-inline-form">
                        <SmartForm
                          fields={[
                            { label: 'Rejection Reason', name: 'cannibalization_rejection_reason', type: 'textarea', rows: 2, required: true, placeholder: 'e.g., Needed on the donor vehicle itself' },
                          ]}
                          key={`reject-cannibalization-${si.sub_issue_id}`}
                          onCancel={() => setReviewingCannibalizationId(null)}
                          onSubmit={(payload) => onRejectCannibalization(ticket, si, payload).then((ok) => { if (ok !== false) setReviewingCannibalizationId(null); })}
                          submitLabel="Reject Repair"
                          title=""
                        />
                      </div>
                    ) : (
                      <div className="subissue-cannibal-approval">
                        <p className="muted">
                          Donor vehicle: <strong>{si.source_vehicle?.vehicle_name ?? 'Unknown'}</strong> ({si.source_vehicle?.plate_number ?? '-'}). Approving opens an Issue Report on it for the removed part.
                        </p>
                        <div className="subissue-cannibal-approval-actions">
                          {canDo(user, 'repair.approve_cannibalized') && (
                            <button
                              className="primary-button"
                              type="button"
                              disabled={approvingCannibalId === si.sub_issue_id}
                              onClick={async () => {
                                setApprovingCannibalId(si.sub_issue_id);
                                try { await onApproveCannibalization(ticket, si, {}); } finally { setApprovingCannibalId(null); }
                              }}
                            >
                              <Icon name="checkCircle" size={14} /> Approve Cannibalization
                            </button>
                          )}
                          {canDo(user, 'repair.reject_cannibalized') && (
                            <button className="ghost-button" type="button" onClick={() => setReviewingCannibalizationId(si.sub_issue_id)}>
                              Reject
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  )}

                  {ticket.status === 'Active' && canDo(user, 'subissue.reopen_confirmed') && si.status === 'Done' && (
                    editingDoneId === si.sub_issue_id ? (
                      <div className="ticket-inline-form subissue-inline-form">
                        <p className="muted" style={{ marginBottom: 8, fontSize: '0.8rem' }}>Unconfirm this repair so you can make adjustments and re-confirm it.</p>
                        <SmartForm
                          fields={[
                            { label: 'Notes (optional)', name: 'reopen_reason', type: 'textarea', rows: 2, placeholder: 'e.g., Needs adjustment, additional notes' },
                          ]}
                          key={`unconfirm-done-${si.sub_issue_id}`}
                          onCancel={() => setEditingDoneId(null)}
                          onSubmit={(payload) => onReopenDone(ticket, si, payload).then((ok) => { if (ok !== false) setEditingDoneId(null); })}
                          submitLabel="Unconfirm"
                          title=""
                        />
                      </div>
                    ) : (
                      <button className="ghost-button btn-edit-action" type="button" onClick={() => setEditingDoneId(si.sub_issue_id)}>
                        <Icon name="undo" size={14} /> Unconfirm
                      </button>
                    )
                  )}

                  </div>
                  </div>
                </div>
                );
              })}
              </div>
            </section>
          )}
          {ticket.status === 'Open' && (
            <p className="empty-state">No sub-issues yet — they'll show up here once the assigned Custodian inspects the vehicle and confirms what's actually wrong.</p>
          )}

          {/* The mechanic's one handoff for the whole ticket — every
              sub-issue is logged, so there's nothing left but to tell the
              Custodian it's ready. */}
          {canSubmitForVerification && (
            <section className="ticket-section">
              <h4><Icon name="checkCircle" size={14} /> Ready for Verification</h4>
              <p className="muted" style={{ fontSize: '0.85rem' }}>Every sub-issue on this ticket has its repair logged. Submit it so {ticket.assigned_custodian?.name ?? 'the assigned Custodian'} can verify the work.</p>
              <button
                className="primary-button"
                type="button"
                disabled={submittingForVerification}
                onClick={async () => {
                  setSubmittingForVerification(true);
                  try { await onSubmitForVerification(ticket); } finally { setSubmittingForVerification(false); }
                }}
              >
                <Icon name="checkCircle" size={14} /> Submit for Verification
              </button>
            </section>
          )}

          {/* The Custodian's verification for the whole ticket: the vehicle-type
              popup, then Approve (closes it) or Disapprove with a reason. */}
          {awaitingMyVerification && repairedByMe && (
            <section className="ticket-section">
              <h4><Icon name="checkCircle" size={14} /> Verify Repair</h4>
              <p className="muted">You did repair work on this ticket, so a different Custodian has to verify it. Ask an Admin to reassign the Custodian.</p>
            </section>
          )}
          {canVerifyTicket && (
            <section className="ticket-section">
              <h4><Icon name="checkCircle" size={14} /> Verify Repair</h4>
              <button className="primary-button" type="button" onClick={() => setVerifying(true)}>
                <Icon name="checkCircle" size={14} /> Verify Repair
              </button>
              <FormModal open={verifying} title={`Verify Repair — Ticket #${ticketNumber(ticket)}`} onClose={() => setVerifying(false)}>
                <TicketVerificationForm
                  ticket={ticket}
                  onCancel={() => setVerifying(false)}
                  onSubmit={(payload) => onVerifyTicket(ticket, payload).then((ok) => { if (ok !== false) setVerifying(false); })}
                />
              </FormModal>
            </section>
          )}
          </div>
        </div>

        <div className="ticket-detail-actions">
          {/* Closing now happens only one way: the Custodian's verification
              above (Verify Repair) finalizes every sub-issue and closes the
              ticket in one step. There is no separate close/decision-close
              action anymore — if work genuinely can't be finished, cancel
              the ticket instead (below). */}
          <FormModal open={cancelling} title="Cancel Ticket" onClose={() => setCancelling(false)}>
            <p>Work stops, but repair evidence is retained. Cancellation does not mean the defect was repaired.</p>
            <SmartForm fields={[{ label: 'Cancellation reason', name: 'closing_notes', type: 'textarea', rows: 3, required: true }]} title="" submitLabel="Cancel Ticket" onCancel={() => setCancelling(false)} onSubmit={(payload) => onCancel(ticket, payload).then((ok) => { if (ok !== false) setCancelling(false); return ok; })} />
          </FormModal>
          {hasEvidence && ticket.status !== 'Closed' && <p className="muted">Repair evidence is retained. An Admin can cancel this ticket with a reason.</p>}
          {!!ticket.decision_history?.length && <details className="ticket-decision-history"><summary>Decision history</summary><ul>{ticket.decision_history.map((event, index) => <li key={index}><strong>{event.event}</strong> - {event.name} - {formatDate(event.at)}{event.details?.reason ? `: ${event.details.reason}` : ''}{event.details?.cancellation_reason ? `: ${event.details.cancellation_reason}` : ''}</li>)}</ul></details>}
          <div className="ticket-detail-actions-row">
            {canDo(user, 'ticket.uncancel') && ticket.status === 'Cancelled' && onUncancel && (
              <button className="primary-button" type="button" disabled={restoring} onClick={async () => { if (restoring) return; setRestoring(true); try { await onUncancel(ticket); } finally { setRestoring(false); } }}>{restoring ? 'Restoring...' : 'Restore Ticket'}</button>
            )}
            {/* A Pending Approval or Declined proposal isn't a live ticket
                yet — Approve/Decline/Undecline in the Review Proposal block
                above are its real actions; Cancel/Delete here are for
                already-live tickets. */}
            {canDo(user, 'ticket.cancel') && ticket.status !== 'Closed' && ticket.status !== 'Cancelled' && ticket.status !== 'Pending Approval' && ticket.status !== 'Declined' && (
              <button className="ghost-button" type="button" onClick={requestCancel}>Cancel Ticket</button>
            )}
            {/* Once a ticket is Closed there's real, confirmed work on
                record — Delete is only for genuine mistakes, not for
                discarding finished repairs. */}
            {canDo(user, 'ticket.delete') && !hasEvidence && ['Declined', 'Cancelled'].includes(ticket.status) && (
              <button className="danger-button ticket-detail-actions-danger" type="button" onClick={requestDelete}>Delete Ticket</button>
            )}
          </div>
        </div>
      </div>
  );

  if (asPage) return panel;

  return (
    <div className="ticket-detail-overlay" onClick={onClose}>
      {panel}
    </div>
  );
}

function TicketProfilePage({ ticketId, user, userId, ticketLookups, onBack, onDeleteTicket, onRequestConfirmation, ticketAction: sendTicketAction }) {
  const navigate = useNavigate();
  const [ticket, setTicket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const loadTicket = useCallback(() => {
    return api.get(`/tickets/${ticketId}`)
      .then((response) => {
        setTicket(response.data);
        setNotFound(false);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [ticketId]);

  useEffect(() => { loadTicket(); }, [loadTicket]);

  // After an action: refresh in place (no full-page spinner, which would
  // unmount the panel and wipe whatever the user typed if it failed) and
  // hand the action's success flag on so forms only close on success.
  const afterAction = (ok) => api.get(`/tickets/${ticketId}`)
    .then((response) => setTicket(response.data))
    .catch(() => {})
    .then(() => ok);

  // Silent background refresh — same request as loadTicket, but doesn't
  // flip the page back to the loading spinner, so it can run on an interval
  // without being disruptive. This is what makes the board reflect a
  // mechanic's or custodian's action on this same ticket while it's still
  // open on screen, instead of only updating on this viewer's own actions
  // (which already refetch via the .then(afterAction) chains below) or the
  // next time they happen to reopen it.
  useEffect(() => {
    const interval = setInterval(() => {
      api.get(`/tickets/${ticketId}`)
        .then((response) => setTicket(response.data))
        .catch(() => {});
    }, 15000);
    return () => clearInterval(interval);
  }, [ticketId]);

  if (loading) return <ModuleLoader label="Loading ticket" />;

  if (notFound || !ticket) {
    return (
      <ModulePanel>
        <div role="alert"><h3>Ticket unavailable</h3><p>You may not have permission to view this ticket, or it may have been deleted or archived.</p><button type="button" className="ghost-button" onClick={onBack}>Back to tickets</button></div>
      </ModulePanel>
    );
  }

  return (
    <TicketDetailPanel
      asPage
      user={user}
      userId={userId}
      ticket={ticket}
      lookups={ticketLookups}
      onAddSubIssue={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues`, payload, 'Sub-issue added.', 'post').then(afterAction)}
      onEditSubIssue={(t, id, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${id}`, payload, 'Sub-issue updated.').then(afterAction)}
      onDeleteSubIssue={(t, si) => onRequestConfirmation({ title: 'Remove sub-issue?', message: `"${si.title}" will be removed from this ticket.`, confirmLabel: 'Remove', onConfirm: () => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${si.sub_issue_id}`, {}, 'Sub-issue removed.', 'delete').then(afterAction) })}
      onAssignTicketMechanic={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/assign-mechanic`, payload, 'Mechanic reassigned.').then(afterAction)}
      onReassignCustodian={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/reassign-custodian`, payload, 'Custodian reassigned.').then(afterAction)}
      onReopenDone={(t, subIssue, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${subIssue.sub_issue_id}/reopen-confirmed`, payload, 'Sub-issue reopened for re-verification.').then(afterAction)}
      onSubmitForVerification={(t) => sendTicketAction(`/tickets/${t.ticket_id}/submit-for-verification`, {}, 'Ticket submitted for verification.').then(afterAction)}
      onVerifyTicket={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/verify`, payload, verifyOutcomeMessage(payload)).then(afterAction)}
      onApproveCannibalization={(t, subIssue, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${subIssue.sub_issue_id}/approve-cannibalization`, payload, 'Cannibalized repair approved — a donor-vehicle issue report was opened.').then(afterAction)}
      onRejectCannibalization={(t, subIssue, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${subIssue.sub_issue_id}/reject-cannibalization`, payload, 'Cannibalized repair rejected.').then(afterAction)}
      onViewIssue={(id) => navigate(`${roleRoutes[user.role]}/issues/${id}`)}
      onLogRepairs={(t, si) => navigate(`${roleRoutes[user.role]}/work-orders/${t.ticket_id}/${si.sub_issue_id}/log-repairs`)}
      onCancel={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/cancel`, { ...payload, expected_revision: t.decision_revision ?? 0 }, 'Ticket cancelled.').then(afterAction)}
      onUncancel={(t) => sendTicketAction(`/tickets/${t.ticket_id}/uncancel`, { expected_revision: t.decision_revision ?? 0 }, 'Ticket restored.').then(afterAction)}
      onDelete={(t) => onDeleteTicket(t).then((ok) => { if (ok !== false) onBack(); else afterAction(false); return ok; })}
      onApproveProposal={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/approve`, { ...payload, expected_revision: t.decision_revision ?? 0 }, 'Ticket proposal approved.').then(afterAction)}
      // Declining no longer deletes the ticket — it becomes a visible,
      // reversible Declined status, so this stays on the page and refreshes
      // in place, same as every other action here.
      onDeclineProposal={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/decline`, { ...payload, expected_revision: t.decision_revision ?? 0 }, 'Ticket proposal declined.').then(afterAction)}
      onUndeclineProposal={(t) => sendTicketAction(`/tickets/${t.ticket_id}/undecline`, { expected_revision: t.decision_revision ?? 0 }, 'Proposal restored to Pending Approval.').then(afterAction)}
      onRequestCorrections={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/request-corrections`, { ...payload, expected_revision: t.decision_revision ?? 0 }, 'Corrections requested from the Custodian.').then(afterAction)}
      onResubmitProposal={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/resubmit`, { ...payload, expected_revision: t.decision_revision ?? 0 }, 'Corrected proposal submitted for Admin review.').then(afterAction)}
      onRequestConfirmation={onRequestConfirmation}
      onClose={onBack}
    />
  );
}

// The four ways a ticket can be reported. Everything but 'inspection' means
// the issue AND its repair type are already known — Repair Type used to
// only live on the separate Maintenance Record form; it's captured here
// instead so it isn't asked for twice. Shared with the Log Repairs step,
// where the same repair type gets confirmed/corrected once work starts.
const ENTRY_MODE_OPTIONS = [
  { value: 'inspection', label: 'Needs Inspection' },
  { value: 'in_house', label: 'In-House Repair' },
  { value: 'cannibalized', label: 'Used Cannibalized Part' },
  { value: 'external', label: 'Sent to External Shop' },
];

function NewTicketPage({ onBack, ticketLookups, prefilledTicketData, onCreateTicket, basePath, onDirty }) {
  // Stable across re-renders (only changes if prefilledTicketData itself
  // changes) — resetting on every render would wipe out whatever the user
  // already typed.
  const initialTicketValues = useMemo(() => {
    const base = { entry_mode: 'inspection', ...(prefilledTicketData ?? {}) };
    // 'prediagnosed' no longer exists as its own entry mode — the issue is
    // known (carried over from an Issue Report/Condition Check) but WHICH
    // repair type applies isn't, so leave the toggle unselected instead of
    // guessing one, forcing an explicit pick before submit.
    if (base.entry_mode === 'prediagnosed') base.entry_mode = null;
    return base;
  }, [prefilledTicketData]);
  // Scoped to whichever Issue Report/Condition Check (if any) this ticket is
  // being created from — a fresh "New Ticket" with no prefill, or one from a
  // different source, gets its own key instead of resurrecting an unrelated
  // abandoned draft. Persisted to sessionStorage (not just useState) so
  // clicking a vehicle/custodian link to view their profile, then Back,
  // doesn't wipe out everything already typed here — see useDraftState.
  const draftKeyBase = `draft:new-ticket:${prefilledTicketData?.issue_report_id ?? prefilledTicketData?.condition_check_id ?? 'blank'}`;
  const [liveValues, setLiveValues] = useDraftState(`${draftKeyBase}:values`, initialTicketValues);
  const [subIssueRows, setSubIssueRows] = useDraftState(`${draftKeyBase}:sub-issues`, () => {
    const seeded = (prefilledTicketData?.sub_issues_text ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    return seeded.length ? seeded : [''];
  });
  // Captured once here, up front — same reasoning as the Custodian's
  // inspection form: "pre-diagnosed" means the Admin already knows what
  // kind of repair this is, so asking again when a mechanic gets assigned
  // later would just be re-asking something already known.
  const [subIssueCategory, setSubIssueCategory] = useDraftState(`${draftKeyBase}:maintenance-type`, () => '');
  const clearNewTicketDraft = () => {
    clearDraftState(`${draftKeyBase}:values`);
    clearDraftState(`${draftKeyBase}:sub-issues`);
    clearDraftState(`${draftKeyBase}:maintenance-type`);
  };
  const [submitting, setSubmitting] = useState(false);
  const [validationLines, setValidationLines] = useState(null);
  useEffect(() => {
    if (!validationLines) return;
    const timer = setTimeout(() => setValidationLines(null), 8000);
    return () => clearTimeout(timer);
  }, [validationLines]);
  const selectedVehicleId = liveValues.vehicle_id ?? null;
  const [openTicketsOnVehicle, setOpenTicketsOnVehicle] = useState([]);
  // Same reasoning as the open-tickets check above, for recurrence instead of
  // duplicates: this used to only ever reach Admin in a notification sent
  // AFTER the ticket was created — too late to change the decision. Checking
  // it here means "this fault came back a 3rd time" is visible while Admin is
  // still choosing, not after.
  const [recurrence, setRecurrence] = useState(null);

  const ticketVehicleResetKey = JSON.stringify([selectedVehicleId]);
  const [previousTicketVehicleResetKey, setPreviousTicketVehicleResetKey] = useState(ticketVehicleResetKey);
  if (previousTicketVehicleResetKey !== ticketVehicleResetKey) { setPreviousTicketVehicleResetKey(ticketVehicleResetKey); setOpenTicketsOnVehicle([]); }
  useEffect(() => {
    if (!selectedVehicleId) return;
    let cancelled = false;
    api.get(`/vehicles/${selectedVehicleId}/open-tickets`)
      .then((response) => { if (!cancelled) setOpenTicketsOnVehicle(response.data); })
      .catch(() => { if (!cancelled) setOpenTicketsOnVehicle([]); });
    return () => { cancelled = true; };
  }, [selectedVehicleId]);

  const ticketRecurrenceResetKey = JSON.stringify([selectedVehicleId, subIssueCategory, liveValues.ticket_title]);
  const [previousTicketRecurrenceResetKey, setPreviousTicketRecurrenceResetKey] = useState(ticketRecurrenceResetKey);
  if (previousTicketRecurrenceResetKey !== ticketRecurrenceResetKey) { setPreviousTicketRecurrenceResetKey(ticketRecurrenceResetKey); setRecurrence(null); }
  useEffect(() => {
    const title = (liveValues.ticket_title ?? '').trim();
    if (!selectedVehicleId || !title) return;
    let cancelled = false;
    api.get(`/vehicles/${selectedVehicleId}/recurrence`, { params: { maintenance_types: subIssueCategory ? [subIssueCategory] : undefined, title } })
      .then((r) => { if (!cancelled) setRecurrence(r.data); })
      .catch(() => { if (!cancelled) setRecurrence(null); });
    return () => { cancelled = true; };
  }, [selectedVehicleId, subIssueCategory, liveValues.ticket_title]);

  const setField = (name, value) => { setLiveValues((v) => ({ ...v, [name]: value })); onDirty?.(); };
  // Any repair-type-specific entry mode means the issue (and how it'll be
  // fixed) is already known — 'inspection' is the only mode where it isn't,
  // and a null/unset mode (only reachable via the legacy prefill case above)
  // means the choice hasn't been made yet.
  const preDiagnosed = Boolean(liveValues.entry_mode) && liveValues.entry_mode !== 'inspection';
  const isCannibalized = liveValues.entry_mode === 'cannibalized';
  const isExternal = liveValues.entry_mode === 'external';
  // Cannibalized/External each carry ONE shared context value (a single
  // donor vehicle, or a single vendor+warranty) for every sub-issue on the
  // ticket — a multi-item list would wrongly imply several distinct
  // problems all used the same donor part or went to the same shop visit,
  // when in practice each would need its own. In-House has no such
  // per-ticket constraint, so a real list of independently assignable
  // problems still makes sense there.
  const isSingleIssueMode = isCannibalized || isExternal;

  // Same add/remove list pattern as Root Causes on the Inspect Ticket page —
  // one consistent way to build a list of findings anywhere in the app,
  // instead of a free-text "one per line" box.
  const updateSubIssue = (index, value) => { setSubIssueRows((rows) => rows.map((r, i) => (i === index ? value : r))); onDirty?.(); };
  const addSubIssueRow = () => setSubIssueRows((rows) => [...rows, '']);
  const removeSubIssueRow = (index) => setSubIssueRows((rows) => rows.filter((_, i) => i !== index));
  // Switching INTO Cannibalized/External drops any extra rows already
  // typed under In-House — those modes only ever submit one sub-issue (see
  // isSingleIssueMode above), so a leftover second/third row would just be
  // silently discarded on submit otherwise.
  const selectEntryMode = (value) => {
    setField('entry_mode', value);
    if (value === 'cannibalized' || value === 'external') {
      setSubIssueRows((rows) => rows.slice(0, 1));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    // The submit button used to just stay disabled until every required
    // field (entry mode included) was filled — silent and easy to miss,
    // especially "1. Choose a repair method", which isn't a native form
    // control the browser could nudge about on its own. Clicking now
    // always works; a toast spells out exactly what's still needed instead.
    const errors = [];
    if (!liveValues.entry_mode) errors.push('Pick how this is being reported, above.');
    if (!liveValues.vehicle_id) errors.push('Vehicle is required.');
    if (!liveValues.assigned_custodian_id) errors.push('Assign to Custodian is required.');
    if (!(liveValues.ticket_title ?? '').trim()) errors.push('Ticket Title is required.');
    if (!(liveValues.ticket_description ?? '').trim()) errors.push('Details is required.');
    if (!liveValues.priority) errors.push('Priority is required.');
    if (preDiagnosed && !subIssueRows.some((row) => row.trim())) {
      errors.push(`At least one ${isSingleIssueMode ? 'issue' : 'sub-issue'} is required.`);
    }
    if (isCannibalized && !liveValues.source_vehicle_id) errors.push('Source Vehicle is required.');
    if (errors.length) {
      setValidationLines(errors);
      return;
    }

    setSubmitting(true);
    try {
      const out = {
        vehicle_id: liveValues.vehicle_id,
        assigned_custodian_id: liveValues.assigned_custodian_id,
        ticket_title: liveValues.ticket_title,
        ticket_description: liveValues.ticket_description,
        priority: liveValues.priority,
        entry_mode: liveValues.entry_mode,
        issue_report_id: prefilledTicketData?.issue_report_id,
        condition_check_id: prefilledTicketData?.condition_check_id,
      };
      if (preDiagnosed) {
        out.sub_issues = subIssueRows.map((t) => t.trim()).filter(Boolean).map((title) => ({ title, maintenance_type: subIssueCategory || null }));
        if (isCannibalized) out.source_vehicle_id = liveValues.source_vehicle_id;
        if (isExternal) {
          out.external_vendor = liveValues.external_vendor || undefined;
          out.warranty_until = liveValues.warranty_until || undefined;
        }
      }
      const created = await onCreateTicket(out);
      if (created) { clearNewTicketDraft(); onBack(); }
    } finally {
      setSubmitting(false);
    }
  };

  const vehicleOptions = (ticketLookups.vehicles ?? []).filter((v) => v.status !== 'Inactive' && v.status !== 'Decommissioned');
  const custodianOptions = ticketLookups.custodians ?? [];
  const priorityOptions = ticketLookups.priorities ?? [];
  const selectedVehicle = vehicleOptions.find((v) => String(v.vehicle_id) === String(liveValues.vehicle_id)) ?? null;
  const selectedCustodian = custodianOptions.find((c) => String(c.id) === String(liveValues.assigned_custodian_id)) ?? null;
  // Can't cannibalize a part from the same vehicle the ticket is for.
  const sourceVehicleOptions = vehicleOptions.filter((v) => String(v.vehicle_id) !== String(liveValues.vehicle_id));

  return (
    <ModulePanel description="Create a new maintenance ticket and assign it to a custodian.">
      {prefilledTicketData?.issue_report_id && (
        <div className="info-callout" style={{ marginBottom: '16px', background: 'rgba(59, 130, 246, 0.1)', borderColor: '#3b82f6' }}>
          <span style={{ marginRight: '8px', color: '#3b82f6', display: 'inline-flex' }}><Icon name="link" size={16} /></span>
          <p className="module-description" style={{ color: '#3b82f6', margin: 0 }}>
            Linking this ticket to <strong>Issue Report #{recordNumber(prefilledTicketData, 'issue_report_id')}</strong>.
          </p>
        </div>
      )}
      {/* Layer 2 duplicate-prevention aid — title-matching alone can't tell
          "Brake Problem" and "Brakes Squeaking" are the same real issue, so
          surface every OTHER open ticket on this vehicle and let the Admin
          judge for themselves. Non-blocking — a vehicle can legitimately
          have two different problems open at once. */}
      {openTicketsOnVehicle.length > 0 && (
        <div className="info-callout" style={{ marginBottom: '16px', background: 'rgba(245, 158, 11, 0.1)', borderColor: '#f59e0b' }}>
          <span style={{ marginRight: '8px', color: '#b45309', display: 'inline-flex', flexShrink: 0 }}><Icon name="alert" size={16} /></span>
          <div>
            <p className="module-description" style={{ color: '#b45309', margin: '0 0 6px', fontWeight: 600 }}>
              This vehicle already has {openTicketsOnVehicle.length} open ticket{openTicketsOnVehicle.length !== 1 ? 's' : ''} — check it isn't the same problem before creating a new one:
            </p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {openTicketsOnVehicle.map((t) => (
                <li key={t.ticket_id} style={{ fontSize: '0.85rem', color: '#92400e', display: 'flex', alignItems: 'center', gap: 8, listStyle: 'none', marginLeft: -18 }}>
                  <span>&bull;</span>
                  <span style={{ flex: 1 }}>#{ticketNumber(t)} "{t.ticket_title}" — {t.status}</span>
                  {/* Opens in a new tab — the Admin is mid-way through this
                      Create Ticket form and shouldn't lose it just to check
                      whether this is the same problem. */}
                  <a
                    href={`${basePath}/tickets/${t.ticket_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: '0.8rem', fontWeight: 600, color: '#b45309', textDecoration: 'underline', whiteSpace: 'nowrap' }}
                  >
                    View <Icon name="link" size={11} style={{ verticalAlign: 'middle' }} />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {recurrence && recurrence.count > 0 && (
        <div className="info-callout" style={{ marginBottom: '16px', background: 'rgba(194, 65, 12, 0.1)', borderColor: '#c2410c' }}>
          <span style={{ marginRight: '8px', color: '#c2410c', display: 'inline-flex', flexShrink: 0 }}><Icon name="undo" size={16} /></span>
          <p className="module-description" style={{ color: '#c2410c', margin: 0 }}>
            <strong>This is the {recurrence.count + 1}{['st', 'nd', 'rd'][recurrence.count] ?? 'th'} time</strong> this fault has come up on this vehicle in the last 90 days
            {recurrence.last_occurred && (
              <> — last fixed via {recurrence.last_type === 'record' ? 'Maintenance Record' : 'Ticket'} #{recurrence.last_id} on {formatDate(recurrence.last_occurred)}</>
            )}
            . Worth considering a deeper fix or a decommission review instead of another routine repair.
          </p>
        </div>
      )}

      {/* Hand-built (not the generic field-array SmartForm) so the layout can
          be grouped into clear sections instead of one long vertical list of
          full-width dropdowns — same reasoning as Inspect Ticket's own
          hand-built form. Reuses the .smart-form input/label styling so
          every field still looks consistent with the rest of the app. */}
      <form className="smart-form ticket-create-form" onSubmit={handleSubmit} noValidate>
        <header className="ticket-create-header">
          <div className="ticket-create-breadcrumb">Maintenance Tickets <span aria-hidden="true">›</span> New Proposal</div>
          <h2>Create New Ticket</h2>
          <p>Create a maintenance proposal for Admin review. Choose a repair method, select the vehicle, and describe the work needed.</p>
        </header>
        {validationLines && (
          <div className="form-feedback" onClick={() => setValidationLines(null)}>
            <div className="qa-inline-error" role="alert" onClick={(e) => e.stopPropagation()}>
              <Icon name="alert" size={17} className="toast-notice-icon" />
              <div className="toast-notice-lines">
                {validationLines.map((line, i) => <span key={i}>{line}</span>)}
              </div>
              <button type="button" className="toast-notice-close" onClick={() => setValidationLines(null)} aria-label="Dismiss">
                <Icon name="close" size={13} />
              </button>
            </div>
          </div>
        )}

        {/* Entry mode comes first, not last — it decides what the rest of
            the form even asks for, so it shouldn't be buried at the bottom.
            Repair Type used to only exist on the separate Maintenance Record
            form; it's folded in here now instead of asking for it twice —
            "Pre-Diagnosed" as a generic option is gone, since picking a
            specific repair type already implies the issue is diagnosed. */}
        <section className="veh-card ticket-method-section">
          <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>How Is This Being Reported?</h4></div>
          <div className="ticket-method-body">
            <div className="entry-mode-toggle" role="radiogroup" aria-label="Entry mode">
              {ENTRY_MODE_OPTIONS.map((opt) => {
                const checked = liveValues.entry_mode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    className={`entry-mode-btn entry-mode-btn--${opt.value} ticket-method-tab ${checked ? 'primary-button' : 'ghost-button'}`}
                    onClick={() => selectEntryMode(opt.value)}
                  >
                    <Icon name="wrench" size={18} />
                    <span>{opt.label}</span>
                    {checked && <Icon name="checkCircle" size={18} />}
                  </button>
                );
              })}
            </div>
            <p className="muted ticket-method-hint">
              {liveValues.entry_mode == null
                ? 'Pick whichever matches what you already know about this repair.'
                : preDiagnosed
                  ? 'The problem (and how it will be fixed) is already known — this skips straight to a mechanic, no custodian inspection needed.'
                  : "Nobody has confirmed what's wrong yet — the assigned custodian will inspect the vehicle first."}
            </p>
            {isCannibalized && (
              <label style={{ marginTop: 12, maxWidth: 320 }}>
                <span>Source Vehicle (donor) <span className="required-asterisk">*</span></span>
                <SearchableSelect
                  required
                  value={liveValues.source_vehicle_id ?? ''}
                  onChange={(e) => setField('source_vehicle_id', e.target.value)}
                >
                  <option value="">{' '}</option>
                  {sourceVehicleOptions.map((v) => <option key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_name} ({v.plate_number})</option>)}
                </SearchableSelect>
              </label>
            )}
            {/* Neither field is required here — the vendor may not be
                picked yet, and there's no warranty to record until the
                repair is actually done. Both stay editable later at Log
                Repairs, once that's known for sure. */}
            {isExternal && (
              <div className="ticket-form-grid-2" style={{ padding: 0, marginTop: 12, maxWidth: 500 }}>
                <label>
                  <span>External Shop Name</span>
                  <input
                    type="text"
                    placeholder="e.g. Dela Cruz Auto Repair"
                    value={liveValues.external_vendor ?? ''}
                    onChange={(e) => setField('external_vendor', e.target.value)}
                  />
                </label>
                <label>
                  <span>Warranty Until</span>
                  <DateFilterInput
                    value={liveValues.warranty_until ?? ''}
                    onChange={(v) => setField('warranty_until', v)}
                  />
                </label>
              </div>
            )}
          </div>
        </section>

        <section className="veh-card ticket-vehicle-section">
          <div className="veh-card-head"><Icon name="vehicle" size={16} /><h4>Vehicle & Assignment</h4></div>
          <div className="ticket-form-grid-2 ticket-vehicle-grid">
            <label>
              <span>Vehicle <span className="required-asterisk">*</span></span>
              <SearchableSelect required value={liveValues.vehicle_id ?? ''} onChange={(e) => setField('vehicle_id', e.target.value)}>
                <option value="">{' '}</option>
                {vehicleOptions.map((v) => <option key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_name} ({v.plate_number})</option>)}
              </SearchableSelect>
            </label>
            <label>
              <span>
                Assign to Custodian ({isExternal ? 'checks the vehicle when it returns' : 'verifies the repair later'})
                {' '}<span className="required-asterisk">*</span>
              </span>
              <SearchableSelect required value={liveValues.assigned_custodian_id ?? ''} onChange={(e) => setField('assigned_custodian_id', e.target.value)}>
                <option value="">{' '}</option>
                {custodianOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </SearchableSelect>
            </label>
          </div>
          {(selectedVehicle || selectedCustodian) && (
            <div className="ticket-selection-preview">
              {selectedVehicle && (
                <div className="ticket-preview-card">
                  {selectedVehicle.photo_url ? (
                    <img className="ticket-preview-photo" src={resolvePhotoUrl(selectedVehicle.photo_url)} alt={selectedVehicle.vehicle_name} />
                  ) : (
                    <span className="ticket-preview-photo ticket-preview-photo-empty"><Icon name="vehicle" size={32} /></span>
                  )}
                  <div className="ticket-preview-body">
                    <strong>{selectedVehicle.vehicle_name}</strong>
                    <span>{selectedVehicle.plate_number} &middot; {selectedVehicle.category?.category_name ?? 'Unclassified'}</span>
                    <span className="muted">{[selectedVehicle.brand, selectedVehicle.model].filter(Boolean).join(' ') || '—'} &middot; {selectedVehicle.current_location ?? 'No location on file'}</span>
                  </div>
                </div>
              )}
              {selectedCustodian && (
                <div className="ticket-preview-card">
                  <UserAvatarName user={selectedCustodian} />
                  <div className="ticket-preview-body">
                    <span className="muted">Custodian &middot; {selectedCustodian.email}</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="veh-card veh-card-form ticket-issue-section">
          <div className="veh-card-head"><Icon name="alert" size={16} /><h4>3. Describe the issue</h4></div>
          <div className="ticket-issue-fields">
            <div className="ticket-form-grid-2" style={{ padding: 0 }}>
              <label style={{ gridColumn: '1 / -1' }}>
                <span>Ticket Title <span className="required-asterisk">*</span></span>
                <input required type="text" value={liveValues.ticket_title ?? ''} onChange={(e) => setField('ticket_title', e.target.value)} />
              </label>
            </div>
            <label>
              <span>Details <span className="required-asterisk">*</span></span>
              <textarea required rows={3} value={liveValues.ticket_description ?? ''} onChange={(e) => setField('ticket_description', e.target.value)} />
            </label>
            <label className="ticket-priority-field">
              <span>Priority <span className="required-asterisk">*</span></span>
              <SearchableSelect required value={liveValues.priority ?? ''} onChange={(e) => setField('priority', e.target.value)}>
                <option value="">{' '}</option>
                {priorityOptions.map((p) => <option key={p} value={p}>{p}</option>)}
              </SearchableSelect>
            </label>
          </div>
        </section>

        {preDiagnosed && (
          <section className="veh-card veh-card-form">
            <div className="veh-card-head">
              <Icon name="wrench" size={16} />
              <h4>{isSingleIssueMode ? 'Known Issue' : 'Known Sub-Issues'}</h4>
            </div>
            <div style={{ padding: 18 }}>
              <p className="muted" style={{ marginTop: 0, marginBottom: 14 }}>
                {isCannibalized
                  ? 'Describe the specific problem this cannibalized part fixes — one donor vehicle can only be tied to one problem here.'
                  : isExternal
                    ? 'Describe the problem being sent out. Everything the shop actually finds/fixes gets logged in detail later, once they report back.'
                    : 'List each specific problem already found — a mechanic will be assigned to each one. All sub-issues here share one category.'}
              </p>

              <label style={{ maxWidth: 320 }}>
                <span>Category</span>
                <CreatableSelect
                  value={subIssueCategory}
                  onChange={setSubIssueCategory}
                  options={ticketLookups?.maintenance_types ?? []}
                  placeholder="Select a category or type to add new"
                  newItemLabel="repair type"
                  catalogEndpoint="/maintenance-types"
                />
              </label>

              <div className="sub-issue-rows">
                {subIssueRows.map((title, index) => (
                  <div key={index} className="sub-issue-row">
                    {!isSingleIssueMode && <span className="sub-issue-row-index">{index + 1}</span>}
                    <input
                      type="text"
                      placeholder="e.g. Low coolant level"
                      value={title}
                      onChange={(e) => updateSubIssue(index, e.target.value)}
                    />
                    {!isSingleIssueMode && (
                      <button
                        type="button"
                        className="btn-delete-action icon-btn"
                        onClick={() => removeSubIssueRow(index)}
                        disabled={subIssueRows.length === 1}
                        title="Remove sub-issue"
                        aria-label="Remove sub-issue"
                      >
                        <Icon name="close" size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {!isSingleIssueMode && (
                <button type="button" className="primary-button" onClick={addSubIssueRow}><Icon name="plus" size={14} /> Add another sub-issue</button>
              )}
            </div>
          </section>
        )}

        <div className="form-actions">
          <button className="ghost-button" onClick={() => { clearNewTicketDraft(); onBack(); }} type="button" disabled={submitting}>Cancel</button>
          <button className="primary-button" type="submit" disabled={submitting}>
            {preDiagnosed ? 'Create Ticket & Assign Mechanic' : 'Create Ticket & Assign'}
          </button>
        </div>
      </form>
      {submitting && <SubmitLoadingOverlay label="Creating ticket…" />}
    </ModulePanel>
  );
}

// A Custodian's "propose a ticket" form — their own diagnosis, including who
// they think should do each repair, submitted for an Admin to review before
// it becomes a real, live ticket (POST /tickets/propose). Deliberately a
// separate component from NewTicketPage above rather than a shared branch:
// Admin's flow is more elaborate (entry mode, cannibalized/external context,
// Assign to Custodian, a single shared sub-issue category) and none of that
// applies here — the backend self-assigns the proposing Custodian, and each
// sub-issue carries its own maintenance type + an optional suggested
// mechanic instead. Keeping it fully separate means Admin's existing form is
// untouched by this addition.
function ProposeTicketPage({ onBack, ticketLookups, onProposeTicket, onCreated, onDirty, prefilledTicketData }) {
  // Opened from a flagged Issue Report / Condition Check the form arrives
  // pre-filled and linked; from the chooser's "full repair details" card it
  // starts blank. Separate draft keys so the two never overwrite each other.
  const linkedIssueId = prefilledTicketData?.issue_report_id ?? null;
  const linkedConditionId = prefilledTicketData?.condition_check_id ?? null;
  const fromFlag = Boolean(linkedIssueId || linkedConditionId);
  const draftSuffix = linkedIssueId ? 'issue-' + linkedIssueId : linkedConditionId ? 'condition-' + linkedConditionId : 'blank';
  const draftKeyBase = 'draft:propose-ticket:' + draftSuffix;
  const [liveValues, setLiveValues] = useDraftState(draftKeyBase + ':values', () => (prefilledTicketData ? {
    vehicle_id: prefilledTicketData.vehicle_id ?? '',
    ticket_title: prefilledTicketData.ticket_title ?? '',
    ticket_description: prefilledTicketData.ticket_description ?? '',
    priority: prefilledTicketData.priority ?? '',
    entry_mode: prefilledTicketData.entry_mode ?? null,
  } : {}));
  const [subIssueRows, setSubIssueRows] = useDraftState(draftKeyBase + ':sub-issues', () => {
    const seeded = (prefilledTicketData?.sub_issues_text ?? '').split('\n').map((t) => t.trim()).filter(Boolean);
    return seeded.map((title) => ({ title, maintenance_type: '' }));
  });
  const emptyPartRow = { part_missing: '', part_needed: '', maintenance_type: '' };
  const [partRows, setPartRows] = useDraftState(draftKeyBase + ':part-rows', () => [emptyPartRow]);
  const [submitting, setSubmitting] = useState(false);
  const [validationLines, setValidationLines] = useState(null);
  useEffect(() => {
    if (!validationLines) return;
    const timer = setTimeout(() => setValidationLines(null), 8000);
    return () => clearTimeout(timer);
  }, [validationLines]);

  const clearProposeDraft = () => {
    clearDraftState(`${draftKeyBase}:values`);
    clearDraftState(`${draftKeyBase}:sub-issues`);
    clearDraftState(`${draftKeyBase}:part-rows`);
  };




  const setField = (name, value) => { setLiveValues((v) => ({ ...v, [name]: value })); onDirty?.(); };
  const setSubIssueRowsDirty = (rows) => { setSubIssueRows(rows); onDirty?.(); };

  // A proposal always states the repair: in-house, a part taken from another
  // vehicle, or sent to an outside shop. (There is no "needs inspection" —
  // a Custodian only proposes once they know what is wrong; flagging a
  // concern without a plan is what Report Issue is for.)
  // Two choices: In-House Repair, or Sent to External Shop. A part taken from
  // another vehicle ("cannibalized") is still an in-house repair, so it's a
  // checkbox under In-House — it keeps its own mode behind the scenes, which is
  // what triggers the Admin approval and the donor-vehicle report.
  const modeOptions = ENTRY_MODE_OPTIONS.filter((o) => o.value === 'in_house' || o.value === 'external');
  // Using a part from another vehicle is NOT declared here: the mechanic
  // records the donor part when logging the repair (the Admin then approves
  // it). A proposal is just In-House or External.
  const entryMode = ['in_house', 'external'].includes(liveValues.entry_mode) ? liveValues.entry_mode : 'in_house';
  const pickerValue = entryMode;
  const isInHouse = entryMode === 'in_house';
  const isCannibalized = entryMode === 'cannibalized';
  const isExternal = entryMode === 'external';

  const selectEntryMode = (value) => {
    if (value === pickerValue) return;
    setLiveValues((v) => ({
      ...v,
      entry_mode: value,
      source_vehicle_id: '',
      external_vendor: '', external_reason: '', external_work_scope: '', external_shop_contact: '',
      external_sent_by: '', external_contact_person: '', external_estimated_cost: '', external_maintenance_type: '',
    }));
    setPartRows([emptyPartRow]);
    onDirty?.();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const errors = [];
    if (!liveValues.vehicle_id) errors.push('Vehicle is required.');
    if (!isExternal && !(liveValues.ticket_description ?? '').trim()) errors.push('Details is required.');
    if (!liveValues.priority) errors.push('Priority is required.');
    if (!entryMode) errors.push('Pick how this is being reported, above.');
    const cleanedRows = subIssueRows.filter((row) => (row.title ?? '').trim());
    if (isInHouse && !cleanedRows.length) errors.push('At least one sub-issue is required.');
    // A part row counts once either field is filled; then both are required.
    const filledPartRows = partRows.filter((r) => (r.part_missing ?? '').trim() || (r.part_needed ?? '').trim());
    if (isCannibalized) {
      if (!liveValues.source_vehicle_id) errors.push('Donor Vehicle is required.');
      if (!filledPartRows.length) errors.push('Add at least one part.');
      filledPartRows.forEach((r, i) => {
        if (!(r.part_missing ?? '').trim()) errors.push(`Part ${i + 1}: Missing / Faulty Part is required.`);
        if (!(r.part_needed ?? '').trim()) errors.push(`Part ${i + 1}: Part to Take From Donor is required.`);
      });
    }
    if (isExternal) {
      if (!liveValues.external_reason) errors.push('Reason for Sending Out is required.');
      if (!(liveValues.external_work_scope ?? '').trim()) errors.push('Details is required.');
    }
    if (errors.length) {
      setValidationLines(errors);
      return;
    }

    setSubmitting(true);
    try {
      // No title is sent: the server builds "MT-0010 — Vehicle — Issue".
      const out = {
        vehicle_id: liveValues.vehicle_id,
        ticket_description: isExternal ? liveValues.external_work_scope : liveValues.ticket_description,
        priority: liveValues.priority,
        entry_mode: entryMode,
        issue_report_id: linkedIssueId || liveValues.link_issue_id || undefined,
        condition_check_id: linkedConditionId || undefined,
        sub_issues: [],
      };
      if (isInHouse) {
        out.sub_issues = cleanedRows.map((row) => ({
          title: row.title.trim(),
          maintenance_type: row.maintenance_type || null,
          suggested_mechanic_id: row.suggested_mechanic_id || null,
        }));
      }
      // Cannibalized/External are one repair each — their single work item
      // is described by the dedicated fields below, not a free-form row.
      if (isCannibalized) {
        const donor = sourceVehicleOptions.find((v) => String(v.vehicle_id) === String(liveValues.source_vehicle_id));
        out.source_vehicle_id = liveValues.source_vehicle_id;
        out.sub_issues = filledPartRows.map((r) => ({
          title: `Replace ${r.part_missing.trim()} using ${r.part_needed.trim()} from ${donor?.vehicle_name ?? 'donor vehicle'}`.slice(0, 255),
          maintenance_type: r.maintenance_type || null,
          part_missing: r.part_missing.trim(),
          part_needed: r.part_needed.trim(),
        }));
      }
      if (isExternal) {
        Object.assign(out, {
          external_vendor: liveValues.external_vendor?.trim() || undefined,
          external_reason: liveValues.external_reason,
          external_work_scope: liveValues.external_work_scope.trim(),
          external_shop_contact: liveValues.external_shop_contact?.trim() || undefined,
          external_sent_by: liveValues.external_sent_by?.trim() || undefined,
          external_contact_person: liveValues.external_contact_person?.trim() || undefined,
          external_estimated_cost: liveValues.external_estimated_cost || undefined,
        });
        out.sub_issues = [{
          title: `External shop: ${liveValues.external_work_scope.trim().split('\n')[0]}`.slice(0, 255),
          maintenance_type: liveValues.external_maintenance_type || null,
          suggested_mechanic_id: null,
        }];
      }
      const created = await onProposeTicket(out);
      if (created) { clearProposeDraft(); if (onCreated) onCreated(created); else onBack(); }
    } finally {
      setSubmitting(false);
    }
  };

  const vehicleOptions = (ticketLookups.vehicles ?? []).filter((v) => v.status !== 'Inactive' && v.status !== 'Decommissioned');
  const priorityOptions = ticketLookups.priorities ?? [];
  const selectedVehicle = vehicleOptions.find((v) => String(v.vehicle_id) === String(liveValues.vehicle_id)) ?? null;

  // A proposal started from the generic form isn't tied to any report. If the
  // vehicle has open reports, offer them so the ticket can be linked to the one
  // it's for (that's what makes the report's Ticket column and eye icon work).
  const [openReports, setOpenReports] = useState([]);
  const [reportLookupFailed, setReportLookupFailed] = useState(false);
  const reportVehicleResetKey = JSON.stringify([fromFlag, liveValues.vehicle_id]);
  const [previousReportVehicleResetKey, setPreviousReportVehicleResetKey] = useState(reportVehicleResetKey);
  if (previousReportVehicleResetKey !== reportVehicleResetKey) { setPreviousReportVehicleResetKey(reportVehicleResetKey); setOpenReports([]); }
  useEffect(() => {
    if (fromFlag || !liveValues.vehicle_id) return undefined;
    let cancelled = false;
    api.get(`/vehicles/${liveValues.vehicle_id}/open-issues`)
      .then((response) => {
        if (cancelled) return;
        setReportLookupFailed(false);
        const open = (response.data ?? []).filter((r) => ['Pending', 'Under Review'].includes(r.status));
        setOpenReports(open);
        setLiveValues((v) => (v.link_issue_id && !open.some((r) => String(r.issue_report_id) === String(v.link_issue_id)) ? { ...v, link_issue_id: '' } : v));
      })
      .catch(() => { if (!cancelled) { setOpenReports([]); setReportLookupFailed(true); } });
    return () => { cancelled = true; };
  }, [liveValues.vehicle_id, fromFlag, setLiveValues]);
  const sourceVehicleOptions = vehicleOptions.filter((v) => String(v.vehicle_id) !== String(liveValues.vehicle_id));


  return (
    <ModulePanel description="Propose a maintenance ticket for Admin review. Pick how it's being reported first — it stays Pending Approval until an Admin approves or declines it.">
      {fromFlag && (
        <div className="info-callout" style={{ marginBottom: '16px', background: 'rgba(59, 130, 246, 0.1)', borderColor: '#3b82f6' }}>
          <span style={{ marginRight: '8px', color: '#3b82f6', display: 'inline-flex' }}><Icon name="link" size={16} /></span>
          <p className="module-description" style={{ color: '#3b82f6', margin: 0 }}>
            Linking this proposal to <strong>{linkedIssueId ? 'Issue Report #' + linkedIssueId : 'Condition Check #' + linkedConditionId}</strong>.
          </p>
        </div>
      )}
      <form className="smart-form ticket-create-form" onSubmit={handleSubmit} noValidate>
        <header className="ticket-create-header">
          <div className="ticket-create-breadcrumb">Maintenance Tickets <span aria-hidden="true">›</span> New Proposal</div>
          <h2>Create New Ticket</h2>
          <p>Create a maintenance proposal for Admin review. Choose a repair method, select the vehicle, and describe the work needed.</p>
        </header>
        {validationLines && (
          <div className="form-feedback" onClick={() => setValidationLines(null)}>
            <div className="qa-inline-error" role="alert" onClick={(e) => e.stopPropagation()}>
              <Icon name="alert" size={17} className="toast-notice-icon" />
              <div className="toast-notice-lines">
                {validationLines.map((line, i) => <span key={i}>{line}</span>)}
              </div>
              <button type="button" className="toast-notice-close" onClick={() => setValidationLines(null)} aria-label="Dismiss">
                <Icon name="close" size={13} />
              </button>
            </div>
          </div>
        )}

        <section className="veh-card ticket-method-section">
          <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>1. Choose a repair method</h4></div>
          <div className="ticket-method-body">
            <div className="entry-mode-toggle" role="radiogroup" aria-label="Entry mode">
              {modeOptions.map((opt) => {
                const checked = pickerValue === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    className={`entry-mode-btn entry-mode-btn--${opt.value} ticket-method-tab ${checked ? 'primary-button' : 'ghost-button'}`}
                    onClick={() => selectEntryMode(opt.value)}
                  >
                    <Icon name="wrench" size={18} />
                    <span>{opt.label}</span>
                    {checked && <Icon name="checkCircle" size={18} />}
                  </button>
                );
              })}
            </div>
            <p className="muted ticket-method-hint">
              {entryMode == null
                ? 'Pick how this repair will be done.'
                : isExternal
                  ? 'Admin reviews the proposal before shop dispatch. The Custodian verifies the completed work.'
                  : 'Once an Admin approves and assigns a mechanic, it goes straight to repair.'}
            </p>
          </div>
        </section>

        <section className="veh-card ticket-vehicle-section">
          <div className="veh-card-head"><Icon name="vehicle" size={16} /><h4>2. Select the vehicle</h4></div>
          {/* The picker and the selected vehicle's info now sit side by side
              (one .ticket-form-grid-2 row) instead of the preview stacking
              full-width underneath — picker on the left, info on the right. */}
          <div className="ticket-form-grid-2 ticket-vehicle-grid">
            <label>
              <span>Vehicle <span className="required-asterisk">*</span></span>
              <SearchableSelect required value={liveValues.vehicle_id ?? ''} onChange={(e) => setField('vehicle_id', e.target.value)}>
                <option value="">Select a vehicle</option>
                {vehicleOptions.map((v) => <option key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_name} ({v.plate_number})</option>)}
              </SearchableSelect>
            </label>
            <div className={`ticket-preview-card ticket-preview-card--lg${selectedVehicle ? '' : ' is-empty'}`}>
              {selectedVehicle ? <>
                {selectedVehicle.photo_url ? (
                  <img className="ticket-preview-photo ticket-preview-photo--lg" src={resolvePhotoUrl(selectedVehicle.photo_url)} alt={selectedVehicle.vehicle_name} />
                ) : (
                  <span className="ticket-preview-photo ticket-preview-photo--lg ticket-preview-photo-empty"><Icon name="vehicle" size={44} /></span>
                )}
                <div className="ticket-preview-body ticket-preview-body--lg">
                  <strong>{selectedVehicle.vehicle_name}</strong>
                  <span className="ticket-preview-plate">{selectedVehicle.plate_number || 'No plate / registration number'} <span>·</span> {selectedVehicle.category?.category_name ?? 'Unclassified'}</span>
                  <span className="muted">{[selectedVehicle.brand, selectedVehicle.model].filter(Boolean).join(' ') || 'Make and model not recorded'}</span>
                  <span className="muted">{selectedVehicle.current_location ?? 'No location on file'}</span>
                  <span className="ticket-preview-badges">
                    {selectedVehicle.status && <StatusBadge value={selectedVehicle.status} />}
                    {selectedVehicle.condition && <StatusBadge value={selectedVehicle.condition} />}
                  </span>
                </div>
              </> : <div className="ticket-preview-empty-copy"><Icon name="vehicle" size={24} /><strong>Vehicle summary</strong><span>Select a vehicle to preview its details.</span></div>}
            </div>
          </div>
          {!fromFlag && openReports.length > 0 && (
            <div style={{ margin: '0 18px 18px', padding: '12px 14px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8 }}>
              <div style={{ fontWeight: 700, fontSize: '0.9rem', marginBottom: 2 }}>This vehicle has open reports — is this repair for one of them?</div>
              <div className="muted" style={{ fontSize: '0.8rem', marginBottom: 8 }}>Linking it lets the report show its ticket, and the report is closed out when the ticket is.</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {openReports.map((r) => (
                  <div
                    key={r.issue_report_id}
                    role="radio"
                    aria-checked={String(liveValues.link_issue_id) === String(r.issue_report_id)}
                    tabIndex={0}
                    onClick={() => setField('link_issue_id', r.issue_report_id)}
                    onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setField('link_issue_id', r.issue_report_id); } }}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#fff', border: `1px solid ${String(liveValues.link_issue_id) === String(r.issue_report_id) ? '#2563eb' : '#e2e8f0'}`, borderRadius: 6, cursor: 'pointer', fontSize: '0.86rem' }}
                  >
                    <span aria-hidden="true" style={{ width: 16, height: 16, borderRadius: '50%', flexShrink: 0, border: `2px solid ${String(liveValues.link_issue_id) === String(r.issue_report_id) ? '#2563eb' : '#94a3b8'}`, background: String(liveValues.link_issue_id) === String(r.issue_report_id) ? '#2563eb' : '#fff', boxShadow: String(liveValues.link_issue_id) === String(r.issue_report_id) ? 'inset 0 0 0 3px #fff' : 'none' }} />
                    <span><strong>#{r.issue_report_id} {r.issue_type}</strong> <span className="muted">({r.severity_level} · {r.status}{r.reported_by?.name ? ` · reported by ${r.reported_by.name}` : ''})</span></span>
                  </div>
                ))}
                <div
                  role="radio"
                  aria-checked={!liveValues.link_issue_id}
                  tabIndex={0}
                  onClick={() => setField('link_issue_id', '')}
                  onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setField('link_issue_id', ''); } }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#fff', border: `1px solid ${!liveValues.link_issue_id ? '#2563eb' : '#e2e8f0'}`, borderRadius: 6, cursor: 'pointer', fontSize: '0.86rem' }}
                >
                  <span aria-hidden="true" style={{ width: 16, height: 16, borderRadius: '50%', flexShrink: 0, border: `2px solid ${!liveValues.link_issue_id ? '#2563eb' : '#94a3b8'}`, background: !liveValues.link_issue_id ? '#2563eb' : '#fff', boxShadow: !liveValues.link_issue_id ? 'inset 0 0 0 3px #fff' : 'none' }} />
                  <span>None of these — this is something new</span>
                </div>
              </div>
            </div>
          )}
        </section>

        <div className="ticket-work-column">
        {reportLookupFailed && <p role="alert" className="notice warning">Existing issue reports could not be checked. Your draft is kept; reselect the vehicle to retry before submitting.</p>}
        {isExternal && (
        <section className="veh-card veh-card-form">
          <div className="veh-card-head"><Icon name="wrench" size={16} /><h4>External Shop Details</h4></div>
          <div className="ticket-external-fields">
            <p className="muted ticket-section-help">
              Give the Admin a verifiable reason for sending this out and exactly what the shop is asked to do.
            </p>
            <div className="ticket-form-grid-2 ticket-external-grid">
              <label>
                <span>Reason for Sending Out <span className="required-asterisk">*</span></span>
                <SearchableSelect required value={liveValues.external_reason ?? ''} onChange={(e) => setField('external_reason', e.target.value)}>
                  <option value="">{' '}</option>
                  {(ticketLookups.external_reasons ?? []).map((r) => <option key={r} value={r}>{r}</option>)}
                </SearchableSelect>
              </label>
              <label>
                <span>Repair Type <small>(optional)</small></span>
                <CreatableSelect
                  value={liveValues.external_maintenance_type ?? ''}
                  onChange={(v) => setField('external_maintenance_type', v)}
                  options={ticketLookups?.maintenance_types ?? []}
                  placeholder="Select a category or type to add new"
                  newItemLabel="repair type"
                  catalogEndpoint="/maintenance-types"
                />
              </label>
              <label>
                <span>External Shop Name</span>
                <input type="text" placeholder="e.g. Dela Cruz Auto Repair" value={liveValues.external_vendor ?? ''} onChange={(e) => setField('external_vendor', e.target.value)} />
              </label>
              <label>
                <span>Contact Person (at the shop)</span>
                <input type="text" placeholder="e.g. Mang Jun Dela Cruz" value={liveValues.external_contact_person ?? ''} onChange={(e) => setField('external_contact_person', e.target.value)} />
              </label>
              <label>
                <span>Contact Number</span>
                <input type="text" placeholder="e.g. 0917 123 4567" value={liveValues.external_shop_contact ?? ''} onChange={(e) => setField('external_shop_contact', e.target.value)} />
              </label>
              <label>
                <span>Sent By (who takes the vehicle)</span>
                <CreatableSelect
                  value={liveValues.external_sent_by ?? ''}
                  onChange={(v) => setField('external_sent_by', v)}
                  options={[]}
                  newItemLabel="person"
                  catalogEndpoint="/reported-persons"
                />
              </label>
              <label>
                <span>Estimated Cost (PHP) <small>(optional)</small></span>
                <input type="number" min="0" placeholder="e.g. 5000" value={liveValues.external_estimated_cost ?? ''} onChange={(e) => setField('external_estimated_cost', e.target.value)} />
              </label>
              <label className="ticket-external-priority">
                <span>Priority <span className="required-asterisk">*</span></span>
                <SearchableSelect required value={liveValues.priority ?? ''} onChange={(e) => setField('priority', e.target.value)}>
                  <option value="">Select priority</option>
                  {priorityOptions.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
                </SearchableSelect>
              </label>
            </div>
            <label className="ticket-external-scope">
              <span>Details <span className="required-asterisk">*</span></span>
              <textarea rows={3} placeholder="e.g. Diagnose and recharge A/C system, replace compressor if needed" value={liveValues.external_work_scope ?? ''} onChange={(e) => setField('external_work_scope', e.target.value)} />
            </label>
          </div>
        </section>
        )}

        {isInHouse && (
        <section className="veh-card veh-card-form">
          <div className="veh-card-head"><Icon name="wrench" size={16} /><h4>Sub-Issues</h4></div>
          <div className="ticket-subissue-body">
            <p className="muted ticket-section-help">
              List each specific problem you found, with its own repair type — different problems on the same ticket can need different kinds of repair. The Admin assigns Maintenance Personnel to each sub-issue when approving it.
            </p>

            <TwoColumnSubIssueEditor
              items={subIssueRows}
              onChange={setSubIssueRowsDirty}
              maintenanceTypeOptions={ticketLookups?.maintenance_types ?? []}
              mechanicOptions={ticketLookups?.maintenance_personnel ?? []}
              minItems={0}
            />
          </div>
        </section>
        )}

        {!isExternal && (
        <section className="veh-card veh-card-form ticket-issue-section">
          <div className="veh-card-head"><Icon name="alert" size={16} /><h4>3. Describe the issue</h4></div>
          <div className="ticket-issue-fields">
            {/* No Ticket Title field — it's automatic (vehicle + repair type),
                and the Admin folds the ticket's own # into it on approval. */}
            <label>
              <span>Details <span className="required-asterisk">*</span></span>
              <textarea required rows={3} value={liveValues.ticket_description ?? ''} onChange={(e) => setField('ticket_description', e.target.value)} />
            </label>
            <label className="ticket-priority-field">
              <span>Priority <span className="required-asterisk">*</span></span>
              <SearchableSelect required value={liveValues.priority ?? ''} onChange={(e) => setField('priority', e.target.value)}>
                <option value="">Select an option</option>
                {priorityOptions.map((p) => <option key={p} value={p}>{p}</option>)}
              </SearchableSelect>
            </label>
          </div>
        </section>
        )}


        </div>

        <div className="form-actions ticket-create-actions">
          <button className="ghost-button" onClick={() => { clearProposeDraft(); onBack(); }} type="button" disabled={submitting}>Cancel</button>
          <button className="primary-button" type="submit" disabled={submitting}>Submit</button>
        </div>
      </form>
      {submitting && <SubmitLoadingOverlay label="Submitting proposal…" />}
    </ModulePanel>
  );
}


// =========================================================================
// PHASE 1 + 4T2: ADMIN TICKET MODULE
// =========================================================================

function TicketModule({
  tickets,
  allTickets,
  ticketLookups,
  notifications = [],
  onViewTicket,
  onChangeVisibility,
  onCreateNew,
  onViewArchives,
  searchQuery,
  setSearchQuery,
  categories,
  vehicles,
  filterCategory,
  setFilterCategory,
  filterCapacity,
  setFilterCapacity,
  filterVehicle,
  setFilterVehicle,
  filterMechanic,
  setFilterMechanic,
  filterCustodian,
  setFilterCustodian,
  filterStatus,
  setFilterStatus,
  filterPriority,
  setFilterPriority,
  filterDateStart,
  setFilterDateStart,
  filterDateEnd,
  setFilterDateEnd,
  recentIssues,
}) {
  const [ticketViewMode, setTicketViewMode] = useState('table');
  const [showHidden, setShowHidden] = useState(false);
  const listTickets = tickets.filter((ticket) => Boolean(ticket.hidden_from_list) === showHidden);
  const hiddenCount = (allTickets ?? tickets).filter((ticket) => ticket.hidden_from_list).length;

  const changeTicketViewMode = (mode) => {
    setTicketViewMode(mode);
  };

  // Count alerts — sourced from the unfiltered list so applying a status
  // filter doesn't make them under-report or vanish. A cannibalized repair
  // is the one thing still awaiting an Admin decision at the sub-issue
  // level now — every other old per-sub-issue gate (mechanic assignment,
  // confirmation) was folded into the one-mechanic-per-ticket approval and
  // the Custodian's single verification step.
  const statSourceTickets = allTickets ?? tickets;
  const allSubIssues = statSourceTickets.flatMap((t) => t.sub_issues ?? []);
  const pendingCannibalizationCount = allSubIssues.filter((s) => s.status === 'Pending Approval').length;
  // Unread-updates badge per ticket card — counts this user's unread
  // notifications tied to that ticket (assignment, verification, etc.)
  // so an admin can spot which tickets have activity they haven't seen yet.
  const unreadByTicket = useMemo(() => {
    const counts = {};
    notifications.forEach((n) => {
      if (!n.read_at && n.ticket_id) {
        counts[n.ticket_id] = (counts[n.ticket_id] ?? 0) + 1;
      }
    });
    return counts;
  }, [notifications]);

  // Counts must come from the full ticket list, not the already
  // status-filtered `tickets` prop — otherwise clicking "Open" (say, 0
  // matches) would filter `tickets` down to nothing and every stat card,
  // including Total, would collapse to 0 along with it.
  const ticketStats = useMemo(() => {
    const counts = { total: statSourceTickets.length };
    ['Pending Approval', 'Declined', 'Active', 'For Verification', 'Closed', 'Cancelled'].forEach((s) => {
      counts[s] = statSourceTickets.filter((t) => t.status === s).length;
    });
    return counts;
  }, [statSourceTickets]);
  const ticketPriorityStats = useMemo(() => {
    const counts = { High: 0, Medium: 0, Low: 0 };
    statSourceTickets.forEach((t) => { if (t.priority in counts) counts[t.priority] += 1; });
    return counts;
  }, [statSourceTickets]);

  const ticketColumnDefs = useMemo(() => ticketTableColumns(unreadByTicket, onViewTicket, onChangeVisibility), [unreadByTicket, onViewTicket, onChangeVisibility]);
  const ticketColumnChooser = useColumnChooser('vms_ticket_list_columns_v3', ticketColumnDefs);

  return (
    <div className="module-grid ticket-page">
      <DismissibleHint description="Central Ticket Ledger — review Custodian proposals, approve and assign a mechanic, then let the mechanic's submission and the Custodian's verification carry the ticket through to Closed." />
      <ModuleStatCards
        totalLabel="Total Tickets"
        total={ticketStats.total}
        cards={TICKET_STAT_CARDS}
        counts={ticketStats}
        readOnly
      />
      {/* Same layout as the Issue Reports page: the priority bar and the
          filters stack on the left, Latest Reports spans both on the right.
          The bar counts the same full list as the stat cards above. */}
      <div className={`ticket-summary-grid${recentIssues && recentIssues.length > 0 ? '' : ' no-side'}`}>
        <div className="ticket-summary-chart">
          <StackedBarChart
            title="Maintenance Tickets by Priority"
            showPercentages
            segments={[
              { label: 'High', value: ticketPriorityStats.High, color: '#dc2626' },
              { label: 'Medium', value: ticketPriorityStats.Medium, color: '#f59e0b' },
              { label: 'Low', value: ticketPriorityStats.Low, color: '#0ea5e9' },
            ]}
          />
        </div>
        <section className="panel module-filter-panel ticket-summary-filters">
          <TicketFilterPanel
            categories={categories}
            vehicles={vehicles}
            custodians={ticketLookups.custodians}
            maintenancePersonnelRoster={ticketLookups.maintenance_personnel}
            priorityLevels={ticketLookups.priorities}
            statusOptions={ticketLookups.ticket_statuses}
            filterCategory={filterCategory}
            setFilterCategory={setFilterCategory}
            filterCapacity={filterCapacity}
            setFilterCapacity={setFilterCapacity}
            filterVehicle={filterVehicle}
            setFilterVehicle={setFilterVehicle}
            filterMechanic={filterMechanic}
            setFilterMechanic={setFilterMechanic}
            filterCustodian={filterCustodian}
            setFilterCustodian={setFilterCustodian}
            filterStatus={filterStatus}
            setFilterStatus={setFilterStatus}
            filterPriority={filterPriority}
            setFilterPriority={setFilterPriority}
            filterDateStart={filterDateStart}
            setFilterDateStart={setFilterDateStart}
            filterDateEnd={filterDateEnd}
            setFilterDateEnd={setFilterDateEnd}
          />
        </section>
        {/* Admin no longer has a standalone Issue Reports page — this is
            the one thing worth keeping from it, moved here instead of
            dropped. */}
        {recentIssues && recentIssues.length > 0 && (
          <LatestIssueCard issues={recentIssues} />
        )}
      </div>

      <section className="panel ticket-ledger-panel" style={{ width: '100%' }}>
        {/* Alert banners */}
        {pendingCannibalizationCount > 0 && (
          <div className="ticket-alert-banner formaint">
            <Icon name="alert" size={16} /> <strong>{pendingCannibalizationCount}</strong> cannibalized repair{pendingCannibalizationCount > 1 ? 's' : ''} waiting for your approval.
          </div>
        )}

        <div className="panel-header-bar" style={{ marginBottom: '8px' }}>
          <h3>{showHidden ? 'Hidden Tickets' : 'All Tickets'} <span className="count-badge">{listTickets.length}</span></h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {onViewArchives && (
              <button type="button" className="archive-btn" onClick={onViewArchives} title="Closed and deleted tickets">
                <span className="archive-btn-icon"><Icon name="archive" size={14} /></span>
                <span>Archives</span>
              </button>
            )}
            <ViewModeDropdown value={ticketViewMode} onChange={changeTicketViewMode} />
            <LocalSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search tickets, vehicle, or assignee..."
              onAdd={onCreateNew}
              addLabel="Create Ticket"
              columnChooser={ticketViewMode === 'table' ? ticketColumnChooser : undefined}
            />
          </div>
        </div>

        {listTickets.length === 0
          ? <p className="empty-state">No tickets match this view. Check your filters or switch between the ticket and hidden lists.</p>
          : ticketViewMode === 'table'
            ? <PaginatedTable columns={ticketColumnChooser.visibleColumns} onReorderColumn={ticketColumnChooser.reorderColumn} rows={listTickets} onRowClick={onViewTicket} />
            : (
              <PaginatedCardGrid
                items={listTickets}
                keyOf={(t) => t.ticket_id}
                emptyMessage="No tickets match this view. Check your filters or switch between the ticket and hidden lists."
                renderItem={(t) => (
                  <div><TicketCard ticket={t} unreadCount={unreadByTicket[t.ticket_id] ?? 0} onClick={() => onViewTicket(t)} />{onChangeVisibility && <button type="button" className="ghost-button" onClick={() => onChangeVisibility(t, !t.hidden_from_list)}><Icon name={t.hidden_from_list ? 'undo' : 'archive'} size={14} />{t.hidden_from_list ? 'Restore to my list' : 'Hide from my list'}</button>}</div>
                )}
              />
            )
        }
        {(showHidden || hiddenCount > 0) && (
          <button type="button" className="cell-link" onClick={() => setShowHidden((current) => !current)}>
            {showHidden ? 'Back to tickets' : `Manage tickets removed from my list (${hiddenCount})`}
          </button>
        )}
      </section>
    </div>
  );
}

// =========================================================================
// VEHICLE DETAIL PANEL — shown when a vehicle row is clicked
// =========================================================================

const READINESS_BADGE = {
  ready:          { label: 'Ready to respond', bg: '#ecfdf5', color: '#065f46', border: '#a7f3d0', icon: 'checkCircle' },
  stale:          { label: 'Readiness check', bg: '#fef3c7', color: '#92400e', border: '#fde68a', icon: 'alert' },
  not_ready:      { label: 'NOT ready to respond', bg: '#fee2e2', color: '#b91c1c', border: '#fecaca', icon: 'alert' },
  unchecked:      { label: 'Never checked', bg: '#f1f5f9', color: '#475569', border: '#cbd5e1', icon: 'alert' },
  in_maintenance: { label: 'In maintenance', bg: '#fff7ed', color: '#9a3412', border: '#fed7aa', icon: 'wrench' },
  retired:        { label: 'Out of fleet', bg: '#f1f5f9', color: '#475569', border: '#cbd5e1', icon: 'alert' },
};

// Simplified per product direction: a plain confirmation, not a checklist —
// if something's actually wrong, the Custodian proposes a maintenance
// ticket instead of confirming readiness.
function ReadinessCheckForm({ vehicle, onCancel, onSubmit }) {
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [eligibility, setEligibility] = useState(null);
  useEffect(() => {
    let current = true;
    api.get(`/vehicles/${vehicle.vehicle_id}/readiness`)
      .then(({ data }) => { if (current) setEligibility(data); })
      .catch(() => { if (current) setEligibility({ can_confirm_readiness: false, readiness_block_reason: 'Could not check readiness eligibility. Close this dialog and try again before confirming readiness.' }); });
    return () => { current = false; };
  }, [vehicle.vehicle_id]);
  const blocked = !eligibility || eligibility.can_confirm_readiness !== true;


  const submit = async () => {
    if (blocked || !confirmed || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit({ confirmed: true });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      {!eligibility && <p role="status">Checking readiness eligibility...</p>}
      {eligibility?.can_confirm_readiness === false && <p className="notice warning" role="alert">{eligibility.readiness_block_reason || 'Readiness cannot be confirmed until maintenance is completed and independently verified.'}</p>}
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.88rem', cursor: 'pointer' }}>
        <input type="checkbox" disabled={blocked || submitting} checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ marginTop: 3 }} />
        <span>I confirm I <strong>personally checked and operated</strong> this vehicle and it is ready to respond.</span>
      </label>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
        <button type="button" className="ghost-button" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary-button" onClick={submit} disabled={blocked || !confirmed || submitting}>
          {submitting ? 'Saving…' : 'Confirm Ready'}
        </button>
      </div>
    </div>
  );
}

// File cabinet on a vehicle's profile page — deliberately separate from the
// vehicle's own cover photo (shown in Vehicle Information above), so this
// list is only ever what someone explicitly uploaded here: receipts,
// registration papers, insurance, etc. Fetches its own data so the parent
// profile page doesn't need to know about documents at all.
// Read-only "filing cabinet" for an issue report's files: photos as a
// thumbnail grid, everything else as typed rows. A legacy single photo_url
// (reports from before multi-file) is folded in as the first photo.
function IssueFilesCard({ issue }) {
  const files = [
    ...(issue.photo_url ? [{ key: 'legacy', url: resolvePhotoUrl(issue.photo_url), name: 'Photo', isImage: true, at: issue.created_at, by: issue.reported_by?.name }] : []),
    ...(issue.attachments ?? []).map((att) => {
      const name = att.original_name ?? att.file_url?.split('/').pop() ?? 'Attachment';
      return {
        key: att.attachment_id,
        url: resolvePhotoUrl(att.file_url),
        name,
        ext: (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'file').toUpperCase(),
        isImage: /\.(png|jpe?g|gif|webp)$/i.test(name),
        at: att.created_at,
        by: att.uploaded_by?.name,
      };
    }),
  ];
  const photos = files.filter((f) => f.isImage);
  const docs = files.filter((f) => !f.isImage);

  return (
    <section className="veh-card veh-files issue-files">
      <div className="veh-card-head veh-files-head">
        <div className="veh-files-head-title"><Icon name="clipboard" size={16} /><h4>Files</h4></div>
        {files.length > 0 && <span className="count-badge">{files.length}</span>}
      </div>
      <div className="veh-files-body">
        {files.length === 0 ? (
          <div className="file-card-empty">No files attached</div>
        ) : (
          <>
            {photos.length > 0 && (
              <div className="issue-files-grid">
                {photos.map((f) => (
                  <a key={f.key} href={f.url} target="_blank" rel="noreferrer" className="issue-files-thumb" title={f.name}>
                    <img src={f.url} alt={f.name} />
                  </a>
                ))}
              </div>
            )}
            {docs.length > 0 && (
              <div className="issue-files-list">
                {docs.map((f) => (
                  <a key={f.key} href={f.url} target="_blank" rel="noreferrer" className="issue-files-row">
                    <span className={`issue-files-ext is-${f.ext.toLowerCase()}`}>{f.ext}</span>
                    <span className="issue-files-meta">
                      <strong>{f.name}</strong>
                      <span>{[f.by, f.at && formatDate(f.at)].filter(Boolean).join(' · ')}</span>
                    </span>
                  </a>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// Cross-vehicle "Vehicle Documents" sidebar entry — a vehicle picker beside
// the exact same per-vehicle Files card (VehicleFiles/VehicleFilesModal)
// VehicleProfilePage already uses, so there's no second document store or
// upload path to keep in sync, just another way to reach the existing one.
// Production-readiness audit finding #8 — FleetController::vehicleReliability()
// was fully built (failure counts, days out of service, lifetime spend, a
// chronic flag, a decommission signal) but had no caller anywhere in the
// frontend. Surfaced here, on the existing Vehicle Profile page, rather than
// a new sidebar module for one metric set.


function VehicleFiles({ vehicleId, canManage, onRequestConfirmation }) {
  // canManage (Admin + Custodian, from VehicleProfilePage's
  // canManageDocuments) governs upload only here — VehicleFilesModal reads
  // the logged-in user itself to further narrow Edit to Admin (any) /
  // Custodian (their own upload only) and Delete to Admin only.
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [initialFile, setInitialFile] = useState(null);
  const [modalKey, setModalKey] = useState(0);

  const load = useCallback(() => {
    api.get(`/vehicles/${vehicleId}/documents`)
      .then((r) => setDocuments(r.data))
      .catch(() => setDocuments([]))
      .finally(() => setLoading(false));
  }, [vehicleId]);

  useEffect(() => { load(); }, [load]);

  const openModal = (file = null) => {
    setInitialFile(file);
    setModalKey((k) => k + 1);
    setModalOpen(true);
  };

  const modal = modalOpen && (
    <VehicleFilesModal
      key={modalKey}
      onClose={() => setModalOpen(false)}
      vehicleId={vehicleId}
      documents={documents}
      canManage={canManage}
      onChanged={load}
      initialFile={initialFile}
      onRequestConfirmation={onRequestConfirmation}
    />
  );

  return (
    <section className="veh-card veh-files">
      <div className="veh-card-head veh-files-head">
        <div className="veh-files-head-title"><Icon name="clipboard" size={16} /><h4>Files</h4></div>
        <div className="veh-files-head-actions">
          <button type="button" className="file-card-icon-btn btn-view-action" onClick={() => openModal()} title="Expand" aria-label="Expand">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          </button>
          {canManage && (
            <button type="button" className="file-card-icon-btn btn-confirm-action" onClick={() => openModal()} title="Add file" aria-label="Add file">
              <Icon name="plus" size={13} />
            </button>
          )}
        </div>
      </div>
      <div
        className="veh-files-body"
        onDragOver={(e) => canManage && e.preventDefault()}
        onDrop={(e) => {
          if (!canManage) return;
          e.preventDefault();
          const file = e.dataTransfer.files?.[0];
          if (file) openModal(file);
        }}
      >
        {loading ? (
          <p className="empty-state">Loading files…</p>
        ) : documents.length ? (
          <div className="veh-files-compact-list">
            {documents.slice(0, 4).map((doc) => (
              <a key={doc.document_id} className="veh-files-compact-row" href={resolvePhotoUrl(doc.file_url)} target="_blank" rel="noreferrer">
                <Icon name="clipboard" size={14} />
                <span>{doc.title}</span>
              </a>
            ))}
            {documents.length > 4 && (
              <button type="button" className="veh-files-more" onClick={() => openModal()}>+{documents.length - 4} more</button>
            )}
          </div>
        ) : (
          <div className="file-card-empty"><Icon name="clipboard" size={18} /><span>No files yet. Vehicle documents and repair evidence will appear here.</span></div>
        )}
      </div>
      {modal}
    </section>
  );
}

// Given a fresh `key` every time it's opened (see VehicleFiles.openModal), so
// mounting with the right `initialFile` already pre-filled needs no
// reset-on-open effect — a new mount already starts from the right state.
function VehicleFilesModal({ onClose, vehicleId, documents, canManage, onChanged, initialFile, onRequestConfirmation }) {
  const { user } = useContext(AuthContext);
  useEscapeKey(true, onClose);
  // Phase B4 — document.delete is Admin-only (Custodian lost it); edit stays
  // Admin (any document) + Custodian, but only on the document THEY uploaded
  // (added_by is already in the list payload, so this needs no extra fetch —
  // the backend enforces the same ownership rule and 403s otherwise).
  const canDeleteDocs = hasRole(user, 'Admin');
  const [selectedId, setSelectedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [pendingFile, setPendingFile] = useState(initialFile ?? null);
  const [addTitle, setAddTitle] = useState(initialFile ? initialFile.name.replace(/\.[^.]+$/, '') : '');
  const [addCategory, setAddCategory] = useState('');
  const [uploadPct, setUploadPct] = useState(null);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const selected = documents.find((d) => d.document_id === selectedId);
  const canEditSelected = !!selected && (hasRole(user, 'Admin') || (canDo(user, 'document.edit') && String(selected.added_by?.id) === String(user.id)));

  const handlePick = (file) => {
    setPendingFile(file);
    setAddTitle(file.name.replace(/\.[^.]+$/, ''));
    setError(null);
  };

  const handleUpload = async () => {
    if (!pendingFile || !addTitle.trim()) return;
    setUploadPct(0);
    setError(null);
    const formData = new FormData();
    formData.append('file', pendingFile);
    formData.append('title', addTitle.trim());
    if (addCategory.trim()) formData.append('category', addCategory.trim());
    try {
      await api.post(`/vehicles/${vehicleId}/documents`, formData, {
        onUploadProgress: (e) => setUploadPct(e.total ? Math.round((e.loaded * 100) / e.total) : null),
      });
      setPendingFile(null);
      setAddTitle('');
      setAddCategory('');
      setUploadPct(null);
      onChanged();
    } catch (err) {
      setError(err?.response?.data?.message ?? 'Upload failed.');
      setUploadPct(null);
    }
  };

  const startEdit = (doc) => {
    setEditingId(doc.document_id);
    setEditTitle(doc.title);
    setEditCategory(doc.category ?? '');
  };

  const saveEdit = async () => {
    if (!editTitle.trim()) return;
    try {
      await api.put(`/documents/${editingId}`, { title: editTitle.trim(), category: editCategory.trim() || null });
      setEditingId(null);
      onChanged();
    } catch (err) {
      setError(err?.response?.data?.message ?? 'Could not save changes.');
    }
  };

  const doDelete = async (doc) => {
    try {
      await api.delete(`/documents/${doc.document_id}`);
      if (selectedId === doc.document_id) setSelectedId(null);
      onChanged();
    } catch (err) {
      setError(err?.response?.data?.message ?? 'Could not delete file.');
    }
  };

  const handleDelete = (doc) => {
    onRequestConfirmation?.({
      title: 'Delete File',
      message: `Delete "${doc.title}" from this vehicle's file cabinet? This cannot be undone.`,
      confirmLabel: 'Delete',
      onConfirm: () => doDelete(doc),
    });
  };

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box-wide files-modal" role="dialog" aria-modal="true" aria-label="Files" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Files</h3>
          <div className="files-modal-toolbar">
            {canManage && (
              <>
                <button type="button" className="file-card-icon-btn btn-confirm-action" onClick={() => fileInputRef.current?.click()} title="Add file" aria-label="Add file">
                  <Icon name="plus" size={14} />
                </button>
                <button
                  type="button"
                  className="file-card-icon-btn btn-edit-action"
                  disabled={!canEditSelected}
                  onClick={() => canEditSelected && startEdit(selected)}
                  title={selected && !canEditSelected ? 'You can only edit a file you uploaded yourself' : 'Edit selected'}
                  aria-label="Edit selected"
                >
                  <Icon name="edit" size={14} />
                </button>
                {canDeleteDocs && (
                  <button type="button" className="file-card-icon-btn btn-delete-action" disabled={!selected} onClick={() => selected && handleDelete(selected)} title="Delete selected" aria-label="Delete selected">
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </>
            )}
          </div>
          <button className="modal-close-btn" onClick={onClose} type="button" aria-label="Close"><Icon name="close" size={18} /></button>
        </div>
        <div className="modal-body">
          {error && (
            <div className="notice error" style={{ marginBottom: 12 }}>{error}</div>
          )}
          <div className="files-modal-table-wrap">
            <table className="files-modal-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Title</th>
                  <th>Category</th>
                  <th>Added By</th>
                  <th>Date Added</th>
                </tr>
              </thead>
              <tbody>
                {documents.length === 0 ? (
                  <tr><td colSpan={5} className="files-modal-empty">No data</td></tr>
                ) : documents.map((doc) => (
                  <tr key={doc.document_id} className={selectedId === doc.document_id ? 'is-selected' : ''}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedId === doc.document_id}
                        onChange={() => setSelectedId(selectedId === doc.document_id ? null : doc.document_id)}
                      />
                    </td>
                    {editingId === doc.document_id ? (
                      <>
                        <td><input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} /></td>
                        <td><input value={editCategory} onChange={(e) => setEditCategory(e.target.value)} placeholder="Category" /></td>
                        <td>{doc.added_by?.name ?? '—'}</td>
                        <td>
                          <QuietDate value={doc.created_at} />
                          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                            <button type="button" className="ghost-button" style={{ height: 28, padding: '0 10px', fontSize: '0.76rem' }} onClick={saveEdit}>Save</button>
                            <button type="button" className="ghost-button" style={{ height: 28, padding: '0 10px', fontSize: '0.76rem' }} onClick={() => setEditingId(null)}>Cancel</button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td>
                          <a href={resolvePhotoUrl(doc.file_url)} target="_blank" rel="noreferrer" className="files-modal-title-link">
                            <Icon name="clipboard" size={13} />{doc.title}
                          </a>
                        </td>
                        <td>{doc.category || '—'}</td>
                        <td>{doc.added_by?.name ?? '—'}</td>
                        <td><QuietDate value={doc.created_at} /></td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {canManage && (
            <div
              className="file-card-dropzone files-modal-dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files?.[0];
                if (file) handlePick(file);
              }}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                style={{ display: 'none' }}
                onChange={(e) => { const file = e.target.files?.[0]; if (file) handlePick(file); }}
              />
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 18a4.5 4.5 0 0 1-1-8.9A5.5 5.5 0 0 1 16.7 7 4.5 4.5 0 0 1 18 18" />
                <path d="M12 12v7" />
                <path d="M9.5 14.5 12 12l2.5 2.5" />
              </svg>
              <span>Drag file here</span>
            </div>
          )}

          {pendingFile && (
            <div className="files-modal-pending">
              <div className="files-modal-pending-row">
                <Icon name="clipboard" size={14} />
                <span className="files-modal-pending-name">{uploadPct != null ? 'Uploading… ' : ''}{pendingFile.name}</span>
                {uploadPct != null && <span className="files-modal-pending-pct">{uploadPct}%</span>}
                <button type="button" className="ghost-button" style={{ height: 28, padding: '0 10px', fontSize: '0.76rem' }} onClick={() => { setPendingFile(null); setUploadPct(null); }}>Cancel</button>
              </div>
              {uploadPct != null && (
                <div className="files-modal-progress-track"><div className="files-modal-progress-bar" style={{ width: `${uploadPct}%` }} /></div>
              )}
              {uploadPct == null && (
                <div className="files-modal-pending-fields">
                  <input placeholder="Title" value={addTitle} onChange={(e) => setAddTitle(e.target.value)} />
                  <input placeholder="Category (optional)" value={addCategory} onChange={(e) => setAddCategory(e.target.value)} />
                  <button type="button" className="primary-button" style={{ height: 36, padding: '0 16px', fontSize: '0.85rem' }} onClick={handleUpload} disabled={!addTitle.trim()}>Add File</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function VehicleProfilePage({ vehicleId, lookups, allHubs, basePath, canManage = false, canManageDocuments = false, canViewDocuments = false, canCheckReadiness = false, canRequestInspection = false, setNotice, onSaved, onRequestConfirmation }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(new URLSearchParams(location.search).get('tab') === 'edit');
  const [decommissioning, setDecommissioning] = useState(false);
  const [readiness, setReadiness] = useState(null);
  const [readinessLoaded, setReadinessLoaded] = useState(false);
  const [readinessLoadFailed, setReadinessLoadFailed] = useState(false);
  const [checkingReadiness, setCheckingReadiness] = useState(false);
  // Live-tracks the Edit form's Vehicle Type select so switching a vehicle
  // to a Water category shows Hull Material/Engine Type immediately,
  // instead of only after saving and reloading. Reset whenever a different
  // vehicle's edit form opens (see the effect below).
  const [editCategoryId, setEditCategoryId] = useState(null);

  const vehicle = (lookups.vehicles ?? []).find((v) => String(v.vehicle_id) === String(vehicleId));

  const vehicleEditKey = JSON.stringify([vehicle?.vehicle_id]);
  const [previousVehicleEditKey, setPreviousVehicleEditKey] = useState(vehicleEditKey);
  if (previousVehicleEditKey !== vehicleEditKey) {
    setPreviousVehicleEditKey(vehicleEditKey);
    setEditCategoryId(vehicle?.category_id ?? null);
    // Deliberately keyed off vehicle_id only, not category_id — the latter
    // is exactly what this state tracks live while editing; including it
    // here would reset every live change right back.

  }

  // Gap A — response-readiness state.
  const loadReadiness = useCallback(() => {
    api.get(`/vehicles/${vehicleId}/readiness`).then((r) => setReadiness(r.data)).catch(() => { setReadiness(null); setReadinessLoadFailed(true); }).finally(() => setReadinessLoaded(true));
  }, [vehicleId]);

  useEffect(() => {
    loadReadiness();
  }, [loadReadiness]);

  const handleReadinessCheck = async (payload) => {
    setNotice(null);
    try {
      const response = await api.post(`/vehicles/${vehicleId}/readiness-check`, payload);
      loadReadiness();
      await onSaved();
      setNotice({ type: 'success', text: 'Readiness check recorded.' });
      setCheckingReadiness(false);

      // Only offered when the backend confirms it's safe: every item
      // passed AND the vehicle has no open ticket. A vehicle with an open
      // ticket must go back to Available through that ticket closing, not
      // through a generic checklist that never looked at the actual repair.
      if (response.data.can_mark_available) {
        onRequestConfirmation?.({
          title: 'Mark Vehicle Available',
          message: `Every item passed and ${vehicle.vehicle_name} has no open ticket — mark it Available now?`,
          confirmLabel: 'Mark Available',
          onConfirm: async () => {
            try {
              await api.put(`/vehicles/${vehicleId}/mark-available`);
              await onSaved();
              loadReadiness();
              setNotice({ type: 'success', text: 'Vehicle marked Available.' });
            } catch (error) {
              showError(error, setNotice);
            }
          },
        });
      }
    } catch (error) {
      showError(error, setNotice);
    }
  };

  const handleDecommission = async (reason) => {
    setNotice(null);
    try {
      await api.put(`/vehicles/${vehicleId}/decommission`, { decommission_reason: reason });
      await onSaved();
      setNotice({ type: 'success', text: 'Vehicle decommissioned.' });
      setDecommissioning(false);
    } catch (error) {
      showError(error, setNotice);
    }
  };

  const handleRecommission = async () => {
    setNotice(null);
    try {
      await api.post(`/vehicles/${vehicleId}/restore`);
      await onSaved();
      setNotice({ type: 'success', text: 'Vehicle recommissioned to active service.' });
    } catch (error) {
      showError(error, setNotice);
    }
  };

  if (!vehicle) {
    return (
      <ModulePanel description="This vehicle could not be found — it may have been archived.">
      </ModulePanel>
    );
  }

  // Admin may not report an issue or open a ticket — the way to act on a
  // hunch is to ask the Custodians to go and look.
  const requestInspection = async () => {
    setNotice(null);
    try {
      await api.post(`/vehicles/${vehicle.vehicle_id}/request-inspection`);
      setNotice({ type: 'success', text: 'Custodians notified to inspect this vehicle.' });
    } catch (error) {
      showError(error, setNotice);
    }
  };

  const handleSave = async (payload) => {
    setNotice(null);
    try {
      const request = moduleRequest('vehicles', vehicle, payload);
      // Empty inputs are never sent, so a blanked custom field would silently
      // keep its old value — say "clear it" explicitly instead.
      const outgoing = Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, k.startsWith('cf_') && (v === '' || v == null) ? '__clear__' : v]));
      await sendPayload(request.method, request.path, outgoing);
      await onSaved();
      setNotice({ type: 'success', text: 'Vehicle updated.' });
      setEditing(false);
    } catch (error) {
      showError(error, setNotice);
    }
  };

  // Derived data for the redesigned overview dashboard.
  const hub = (allHubs ?? []).find((h) => h.name === vehicle.current_location);
  const isWater = (vehicle.category?.domain ?? 'Land') === 'Water';
  const criticality = vehicle.criticality ?? defaultCriticalityFor(vehicle, lookups);
  const criticalityClass = criticality === 'Critical' ? 'is-critical' : criticality === 'High' ? 'is-high' : 'is-normal';
  return (
    <ModulePanel description="Full profile, maintenance, and tickets for this vehicle.">
      <div className="vehicle-profile-page">
      <div className="vehicle-profile-header">
        <div className="vehicle-profile-heading">
          <h2>{vehicle.vehicle_name}</h2>
          <div className="vehicle-profile-subtitle">
            <span className="vehicle-profile-plate">{vehicle.category?.domain ?? 'Land'}.{vehicle.plate_number}</span>
            <span>{vehicle.category?.category_name ?? 'Unassigned vehicle type'}</span>
          </div>
        </div>
        <div className="vehicle-profile-actions">
          {canManage && vehicle.status !== 'Decommissioned' && !editing && (
            <button className="btn-sm primary-button" type="button" onClick={() => setEditing(true)}>
              <Icon name="edit" size={13} /> Edit Vehicle
            </button>
          )}
          {canRequestInspection && !['Decommissioned', 'Inactive'].includes(vehicle.status) && !editing && (
            <button className="btn-sm ghost-button" type="button" onClick={requestInspection}>
              <Icon name="search" size={13} /> Request Custodian Inspection
            </button>
          )}
          {canCheckReadiness && !['Decommissioned', 'Inactive'].includes(vehicle.status) && !editing && (
            <button className="btn-sm success-button" type="button" onClick={() => setCheckingReadiness(true)}>
              <Icon name="checkCircle" size={13} /> Readiness Check
            </button>
          )}
          {canManage && vehicle.status !== 'Decommissioned' && !editing && (
            <button className="btn-sm danger-button" type="button" onClick={() => setDecommissioning(true)}>
              <Icon name="alert" size={13} /> Decommission
            </button>
          )}
          {canManage && vehicle.status === 'Decommissioned' && (
            <button className="btn-sm primary-button" type="button" onClick={() => onRequestConfirmation?.({
              title: 'Recommission Vehicle',
              message: `Bring ${vehicle.vehicle_name} back into active service? This reverses the decommission.`,
              confirmLabel: 'Recommission',
              onConfirm: handleRecommission,
            })}>
              <Icon name="undo" size={13} /> Recommission
            </button>
          )}
        </div>
      </div>

      {vehicle.status === 'Decommissioned' && (
        <div style={{ margin: '0 0 16px', padding: '14px 18px', borderRadius: 12, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 700, marginBottom: 4 }}>
            <Icon name="alert" size={18} /> Decommissioned — retired from the fleet
          </div>
          {vehicle.decommission_reason && <p style={{ margin: '4px 0 0' }}>Reason: {vehicle.decommission_reason}</p>}
          {vehicle.decommissioned_at && <p style={{ margin: '4px 0 0', fontSize: '0.82rem', opacity: 0.85 }}>Retired {formatDate(vehicle.decommissioned_at)}. Its history is preserved; it no longer counts toward readiness.</p>}
        </div>
      )}

      <FormModal open={checkingReadiness} title={`Readiness Check — ${vehicle.vehicle_name}`} onClose={() => setCheckingReadiness(false)}>
        <ReadinessCheckForm
          key={`readiness-${vehicle.vehicle_id}`}
          vehicle={vehicle}
          onCancel={() => setCheckingReadiness(false)}
          onSubmit={handleReadinessCheck}
        />
      </FormModal>

      <FormModal open={decommissioning} title={`Decommission ${vehicle.vehicle_name}`} onClose={() => setDecommissioning(false)}>
        <p className="muted" style={{ marginBottom: 12, fontSize: '0.85rem' }}>
          This permanently retires the vehicle (end of life) and removes it from readiness/coverage. Its full history is kept, and an Admin can recommission it later if this was a mistake.
        </p>
        <SmartForm
          fields={[{ label: 'Reason for decommissioning', name: 'decommission_reason', required: true, type: 'textarea', rows: 3 }]}
          key="decommission"
          onCancel={() => setDecommissioning(false)}
          onSubmit={(payload) => handleDecommission(payload.decommission_reason)}
          submitLabel="Decommission Vehicle"
          title=""
        />
      </FormModal>

      {editing ? (
        <section className="veh-card veh-edit-card">
          <div className="veh-card-head"><Icon name="edit" size={16} /><h4>Edit Vehicle Information</h4></div>
          <div className="form-grid-2col veh-edit-body">
            <SmartForm
              fields={vehicleFields(
                lookups,
                allHubs,
                lookups.categories?.find((c) => String(c.category_id) === String(editCategoryId))?.domain
                  ?? vehicle.category?.domain
                  ?? 'Land',
                vehicle.photo_url,
                lookups.categories?.find((c) => String(c.category_id) === String(editCategoryId))
              )}
              initialValues={vehicleWithCustomInitials(vehicle)}
              key={vehicle.vehicle_id}
              onValuesChange={(vals) => setEditCategoryId(vals.category_id)}
              onCancel={() => setEditing(false)}
              onSubmit={handleSave}
              submitLabel="Save Changes"
              title=""
            />
          </div>
        </section>
      ) : (
      <>
      <div className="vehicle-profile-dashboard">
        <div className="vehicle-profile-overview">
          <section className="veh-card veh-info">
            <div className="veh-card-head"><Icon name={vehicleIconName(vehicle.category?.domain)} size={16} /><h4>Vehicle Information</h4></div>
            <div className="veh-info-body">
              {vehicle.photo_url ? (
                <div className="veh-info-photo"><PhotoCell alt={vehicle.vehicle_name} url={vehicle.photo_url} /></div>
              ) : (
                <div className="veh-info-photo veh-info-photo-empty"><Icon name={vehicleIconName(vehicle.category?.domain)} size={42} /><span>No vehicle photo</span></div>
              )}
              <dl className="veh-kv vehicle-profile-specs">
                <div><dt>{plateFieldLabel(vehicle.category?.domain ?? 'Land')}</dt><dd>{vehicle.plate_number ?? '-'}</dd></div>
                <div><dt>Brand / Model</dt><dd>{`${vehicle.brand ?? '-'} ${vehicle.model ?? ''}`.trim() || '-'}</dd></div>
                <div><dt>Year Model</dt><dd>{vehicle.year_model ?? '-'}</dd></div>
                <div><dt>Capacity</dt><dd>{vehicle.capacity ?? '-'}</dd></div>
                <div><dt>Color</dt><dd>{vehicle.vehicle_color ?? '-'}</dd></div>
                {isWater && <><div><dt>Hull Material</dt><dd>{vehicle.hull_material ?? '-'}</dd></div><div><dt>Engine Type</dt><dd>{vehicle.engine_type ?? '-'}</dd></div></>}
                <div><dt>Fuel Type</dt><dd>{vehicle.fuel_type ?? '-'}</dd></div>
                {customValueRows(vehicle, lookups)}
              </dl>
            </div>
            {vehicle.remarks && <div className="veh-remarks"><span className="veh-remarks-label">Remarks</span><p>{vehicle.remarks}</p></div>}
          </section>

          <section className="veh-card veh-keydates vehicle-profile-operational">
            <div className="veh-card-head"><Icon name="clipboard" size={16} /><div><h4>Operational status</h4><span className="vehicle-profile-card-subtitle">Readiness, service, and key dates</span></div></div>
            <div className="vehicle-profile-status-body">
              <div className="vehicle-profile-priority-status">
                <div className="vehicle-profile-status-item"><span>Availability</span><StatusBadge value={vehicle.status} /></div>
                <div className="vehicle-profile-status-item"><span>Condition</span><StatusBadge value={vehicle.condition} /></div>
                <div className="vehicle-profile-status-item"><span>Response readiness</span>{readiness && READINESS_BADGE[readiness.state] ? (
                  <span className="vehicle-readiness-badge" style={{ '--readiness-bg': READINESS_BADGE[readiness.state].bg, '--readiness-color': READINESS_BADGE[readiness.state].color, '--readiness-border': READINESS_BADGE[readiness.state].border }}>
                    <Icon name={READINESS_BADGE[readiness.state].icon} size={13} /> {READINESS_BADGE[readiness.state].label}
                  </span>
                ) : <span className="vehicle-readiness-badge is-loading">{readinessLoaded ? 'Readiness unavailable' : 'Loading readiness…'}</span>}</div>
                <div className="vehicle-profile-status-item"><span>Criticality</span><span className={`vehicle-criticality ${criticalityClass}`} title={vehicle.criticality ? 'Set for this vehicle' : 'Inherited from vehicle type'}>{criticality}</span></div>
              </div>
              <dl className="vehicle-profile-keydates">
                <div><dt>Active maintenance ticket</dt><dd>{readiness?.active_ticket_id ? <button type="button" className="vehicle-profile-ticket-link" onClick={() => navigate(`${basePath}/tickets/${readiness.active_ticket_id}`)}><Icon name="ticket" size={14} /> {readiness.active_ticket_title ?? `Ticket #${readiness.active_ticket_number ?? readiness.active_ticket_id}`} <Icon name="chevronRight" size={13} /></button> : <span className="muted">{!readinessLoaded ? 'Loading ticket status…' : readinessLoadFailed ? 'Status unavailable' : 'No active ticket'}</span>}</dd></div>
                <div><dt>Last readiness check</dt><dd>{readiness?.last_checked ? formatDate(readiness.last_checked) : <span className="muted">{!readinessLoaded ? 'Loading check history…' : readinessLoadFailed ? 'History unavailable' : readiness?.state === 'unchecked' ? 'Never checked' : 'No check recorded'}</span>}</dd></div>
                <div><dt>Current location</dt><dd>{vehicle.current_location ?? <span className="muted">Not set</span>}</dd></div>
                {vehicle.estimated_return_date && <div><dt>Estimated return</dt><dd>{formatForecastDate(vehicle.estimated_return_date)}</dd></div>}
                <div><dt>Date added</dt><dd>{vehicle.created_at ? <QuietDate value={vehicle.created_at} /> : '—'}</dd></div>
                <div><dt>Last updated</dt><dd>{vehicle.updated_at ? <QuietDate value={vehicle.updated_at} /> : '—'}</dd></div>
              </dl>
            </div>
          </section>

          {canViewDocuments && <VehicleFiles vehicleId={vehicle.vehicle_id} canManage={canManageDocuments} onRequestConfirmation={onRequestConfirmation} />}
        </div>

        <section className="veh-card veh-map vehicle-profile-map">
          <div className="veh-card-head"><Icon name="pin" size={16} /><div><h4>Current Location</h4><span className="vehicle-profile-card-subtitle">{vehicle.current_location ?? 'Location not set'}</span></div></div>
          <div className="veh-map-wrap"><VehicleLocationMap lat={hub?.lat} lng={hub?.lng} label={vehicle.current_location} scrollWheelZoom /></div>
        </section>

      </div>
      {/* Print-only — kept off-screen (see .veh-print-report), shown by the
          Reports card's print button via window.print(). Portaled straight
          to <body> so it never inherits the app shell's own responsive
          collapse (that grid narrows unpredictably once Chromium's print
          engine evaluates media queries against the paper width instead of
          the screen viewport) and so normal document flow — not
          position:fixed — is what lands on the page: a fixed element
          gets reprinted on every page, which was duplicating this whole
          report onto page 2. Reuses the report band/grid look so a
          printed page still reads as a formal document: vehicle identity
          on the left, VMS mark on the right, blue bands. */}
      {createPortal(
        <div className="veh-print-report">
          <div className="veh-print-header">
            <div className="veh-print-header-left">
              <h2>{vehicle.vehicle_name}</h2>
              <p>{vehicle.category?.domain ?? 'Land'}.{vehicle.plate_number}</p>
            </div>
            <div className="veh-print-header-right">
              <VMSLogo variant="blue" size={48} className="topbar-gear-icon" />
              <span className="vms-wordmark">vms</span>
            </div>
          </div>
          <div className="veh-print-body">
            <div className="veh-print-media">
              {vehicle.photo_url && (
                <div className="veh-print-photo"><PhotoCell alt={vehicle.vehicle_name} url={vehicle.photo_url} /></div>
              )}
            </div>
            <div className="veh-print-info">
              <div className="veh-report-band">Vehicle Information</div>
              <dl className="veh-report-grid">
                <div><dt>{plateFieldLabel(vehicle.category?.domain)}</dt><dd>{vehicle.plate_number}</dd></div>
                <div><dt>Vehicle Name</dt><dd>{vehicle.vehicle_name}</dd></div>
                <div><dt>Vehicle Type</dt><dd>{vehicle.category?.category_name ?? 'Unassigned'}</dd></div>
                <div><dt>Brand / Model</dt><dd>{`${vehicle.brand ?? '-'} ${vehicle.model ?? ''}`.trim() || '-'}</dd></div>
                <div><dt>Year Model</dt><dd>{vehicle.year_model ?? '-'}</dd></div>
                <div><dt>Capacity</dt><dd>{vehicle.capacity ?? '-'}</dd></div>
                <div><dt>Color</dt><dd>{vehicle.vehicle_color ?? '-'}</dd></div>
                <div><dt>Fuel Type</dt><dd>{vehicle.fuel_type ?? '-'}</dd></div>
                {isWater && (
                  <>
                    <div><dt>Hull Material</dt><dd>{vehicle.hull_material ?? '-'}</dd></div>
                    <div><dt>Engine Type</dt><dd>{vehicle.engine_type ?? '-'}</dd></div>
                  </>
                )}
                <div><dt>Criticality</dt><dd>{vehicleCriticality(vehicle, lookups)}</dd></div>
                {customValueRows(vehicle, lookups)}
                <div><dt>Acquisition Cost</dt><dd>{vehicle.acquisition_cost != null ? `₱${Number(vehicle.acquisition_cost).toLocaleString()}` : '-'}</dd></div>
                <div><dt>Status</dt><dd>{vehicle.status}</dd></div>
                <div><dt>Condition</dt><dd>{vehicle.condition}</dd></div>
                <div><dt>Current Location</dt><dd>{vehicle.current_location ?? '-'}</dd></div>
                <div><dt>Date Added</dt><dd>{vehicle.created_at ? <QuietDate value={vehicle.created_at} /> : '-'}</dd></div>
                <div><dt>Last Updated</dt><dd>{vehicle.updated_at ? <QuietDate value={vehicle.updated_at} /> : '-'}</dd></div>
              </dl>
            </div>
          </div>
          <div className="veh-print-map-wide">
            <div className="veh-report-band">Current Location — {vehicle.current_location ?? 'Unknown'}</div>
            <div className="veh-print-map">
              <VehicleLocationMap lat={hub?.lat} lng={hub?.lng} label={vehicle.current_location} />
            </div>
          </div>
        </div>,
        document.body
      )}
      </>
      )}
      </div>
    </ModulePanel>
  );
}

// =========================================================================
// TICKET CARD
// =========================================================================

// A ticket's broad status (Open/Active/Closed/Cancelled) doesn't say whose
// turn it is right now — "Active" alone looks the same whether a mechanic
// is still mid-repair, or the Custodian/Admin already responded and it's
// sitting untouched waiting for someone. This derives the actual next step
// from the ticket + its sub-issues, so that's visible at a glance instead of
// hiding behind a generic unread-notification counter.
function ticketWorkflowStage(ticket) {
  if (ticket.correction_requested_at) return { label: 'Corrections requested', tone: 'waiting' };
  // 'Open' only ever appears on historical tickets created before the
  // one-mechanic-per-ticket redesign (new tickets go straight from
  // proposal to Pending Approval to Active) — kept so old data still
  // reads sensibly.
  if (ticket.status === 'Open') {
    return { label: 'Awaiting Custodian Inspection', tone: 'waiting' };
  }
  if (ticket.status === 'For Verification') {
    return { label: 'Awaiting Custodian Verification', tone: 'waiting' };
  }
  if (ticket.status !== 'Active') {
    return null; // Pending Approval/Closed/Cancelled — the status badge alone already says enough.
  }
  const subIssues = ticket.sub_issues ?? [];
  if (subIssues.some((s) => s.status === 'Pending Approval')) {
    return { label: 'Cannibalized Repair — Awaiting Approval', tone: 'action' };
  }
  // Every sub-issue has its repair logged (For Inspection) — the mechanic
  // just needs to submit the ticket for the Custodian to verify.
  if (subIssues.length > 0 && subIssues.every((s) => s.status === 'For Inspection')) {
    return { label: 'Ready to Submit for Verification', tone: 'action' };
  }
  return { label: 'In Repair', tone: 'info' };
}

// Deliberately NOT another rounded status-badge capsule — Priority and
// Status already share that exact look (and, in this app's dark/light
// theme CSS, Medium/High priority and Active status even share the same
// amber color), so a third pill in the same shape just reads as more of
// the same noise. A flat-edged strip with a left accent bar reads as its
// own distinct thing: a callout, not another label.
const TICKET_STAGE_STYLE = {
  action:  { bg: 'linear-gradient(90deg,#faf5ff,#ede9fe)', color: '#5b21b6', icon: 'alert' },
  waiting: { bg: 'linear-gradient(90deg,#eff6ff,#dbeafe)', color: '#1d4ed8', icon: 'search' },
  info:    { bg: 'linear-gradient(90deg,#f8fafc,#f1f5f9)', color: '#475569', icon: 'wrench' },
};

function TicketStageBadge({ ticket, variant = 'flag' }) {
  const stage = ticketWorkflowStage(ticket);
  if (!stage) return null;
  const style = TICKET_STAGE_STYLE[stage.tone];
  // "flag" (default) reads as a leading tab flush against a card's left
  // edge — right for TicketCard, but floats oddly with nothing to sit
  // flush against once it's just one badge among others in a header row.
  // "pill" matches the rounded status/priority badges beside it there.
  if (variant === 'pill') {
    return (
      <span className="ticket-stage-badge" style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', fontWeight: 700,
        padding: '5px 12px', borderRadius: 0, background: style.bg,
        border: `1px solid ${style.color}55`, color: style.color,
      }}>
        <Icon name={style.icon} size={12} /> {stage.label}
      </span>
    );
  }
  return (
    <div className="ticket-stage-badge" style={{
      display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', fontWeight: 700,
      padding: '6px 10px', borderRadius: 0, background: style.bg,
      borderLeft: `3px solid ${style.color}`, color: style.color,
    }}>
      <Icon name={style.icon} size={12} /> {stage.label}
    </div>
  );
}

// The people actually assigned to a ticket, Custodian first. The mechanic is
// read from the sub-issues (reassignment happens per work order, so the
// ticket-level mechanic can be stale); a Pending Approval ticket has none yet.
function ticketPersonnel(ticket) {
  const people = [];
  if (ticket?.assigned_custodian?.name) people.push({ ...ticket.assigned_custodian, role: 'Custodian' });
  const subs = ticket?.sub_issues ?? [];
  const open = subs.filter((s) => s.status !== 'Done' && s.status !== 'Cancelled');
  const seen = new Set();
  const fromWorkOrders = (open.length ? open : subs).map((s) => s.assigned_mechanic)
    .filter((m) => m?.name && !seen.has(m.id) && seen.add(m.id));
  // Ticket-level mechanic is only a fallback when no work order names one.
  const mechanics = fromWorkOrders.length ? fromWorkOrders : [ticket?.assigned_mechanic].filter((m) => m?.name);
  mechanics.forEach((m) => people.push({ ...m, role: 'Maintenance Personnel' }));
  return people;
}

function PersonAvatar({ person }) {
  const [failed, setFailed] = useState(false);
  const initials = person.name.split(' ').filter(Boolean).map((n) => n[0]).join('').slice(0, 2).toUpperCase();
  const src = person.photo_url && !failed ? resolvePhotoUrl(person.photo_url) : '';
  return (
    <span className="tpa-avatar" tabIndex={0} role="img" aria-label={`${person.role}: ${person.name}`} data-tip={`${person.name} · ${person.role}`}>
      {src
        ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
        : <span className="tpa-initials" aria-hidden="true">{initials}</span>}
    </span>
  );
}

// Shared by Card View and List View. `showNames` adds the readable role/name
// text (list view, and always available to touch users without tooltips).
function TicketPersonnelAvatars({ ticket, people: given }) {
  const people = given ?? ticketPersonnel(ticket);
  if (!people.length) return <span className="tpa-empty">Not assigned</span>;
  return (
    <span className="tpa-group" onClick={(e) => e.stopPropagation()}>
      {people.map((p) => <PersonAvatar key={`${p.role}-${p.id}`} person={p} />)}
      <span className="tpa-sr">{people.map((p) => `${p.role}: ${p.name}`).join('; ')}</span>
    </span>
  );
}

function TicketCard({ ticket, unreadCount = 0, onClick }) {
  const progress = ticket.progress;
  const stage = ticketWorkflowStage(ticket);

  return (
    <div className={`ticket-card ticket-reference-card ${ticketStatusClass(ticket.status)}`} style={{ position: 'relative' }} onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}>
      {unreadCount > 0 && (
        <span
          title={`${unreadCount} unread update${unreadCount > 1 ? 's' : ''} on this ticket`}
          style={{
            position: 'absolute', top: -8, right: -8, minWidth: 20, height: 20, padding: '0 5px',
            borderRadius: 0, background: '#dc2626', color: '#fff', fontSize: '0.7rem', fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.25)', zIndex: 1,
          }}
        >
          {unreadCount > 9 ? '9+' : unreadCount}
        </span>
      )}
      <div className="ticket-reference-id">Ticket #{ticketNumber(ticket)}</div>
      <div className="ticket-reference-main">
        <div className="ticket-reference-photo">
          {ticket.vehicle?.photo_url
            ? <img src={resolvePhotoUrl(ticket.vehicle.photo_url)} alt={ticket.vehicle.vehicle_name ?? 'Vehicle'} loading="lazy" />
            : <Icon name="truck" size={40} />}
        </div>
        <div className="ticket-reference-info">
          <h4 title={ticket.ticket_title}>{ticket.ticket_title}</h4>
          <p>{ticket.vehicle?.vehicle_name ?? 'No vehicle'}</p>
          <p>{ticket.vehicle?.plate_number ?? '—'}</p>
        </div>
      </div>
      {(ticket.sub_issues ?? []).filter((item) => item.verification_verdict === 'Rejected').map((item) => <p key={item.sub_issue_id} className="lr-alert lr-alert-warning"><strong>Rework: {item.title}</strong> {item.verification_notes || 'Review the failed checks.'}</p>)}
      <div className="ticket-reference-progress">
        {progress?.done ?? 0}/{progress?.total ?? ticket.sub_issues?.length ?? 0} sub-issues done
      </div>
      <div className="ticket-reference-stage">
        {stage && <TicketStageBadge ticket={ticket} />}
      </div>
      <div className="ticket-reference-bottom">
        <div className="ticket-card-badges">
          <TicketStatusBadge value={ticket.status} />
          <TicketStatusBadge value={ticket.priority} />
        </div>
        <DateBadge value={ticket.created_at} />
        <TicketPersonnelAvatars ticket={ticket} />
      </div>
    </div>
  );
}

// =========================================================================
// PHASE 2: CUSTODIAN INSPECTION MODULE
// =========================================================================

function CustodianInspectionModule({
  tickets,
  onOpenInspect,
  categories,
  vehicles,
  filterCategory,
  setFilterCategory,
  filterCapacity,
  setFilterCapacity,
  filterPriority,
  setFilterPriority,
  priorityOptions,
  stats,
  activeFilter,
  onFilterChange,
  tabBar
}) {
  const isPendingView = activeFilter !== 'Inspected';

  const inspectionColumnDefs = useMemo(() => [
    { key: 'ticket_id', label: 'Ticket ID', locked: true, className: 'cell-center', render: (r) => ticketNumber(r) },
    { key: 'vehicle', label: 'Vehicle', locked: true, render: (r) => <VehicleCell vehicle={r.vehicle} /> }, { key: 'plate', label: 'Plate Number', className: 'cell-center', render: (r) => r.vehicle?.plate_number ?? '-' },
    { key: 'title', label: 'Title', render: (r) => r.ticket_title },
    { key: 'priority', label: 'Priority', className: 'cell-center', render: (r) => <TicketStatusBadge value={r.priority} /> },
    { key: 'result', label: 'Result', className: 'cell-center', render: (r) => r.inspection_result ? <TicketStatusBadge value={r.inspection_result} /> : <span className="muted">—</span> },
    { key: 'assigned', label: 'Assigned', className: 'cell-center', render: (r) => <DateBadge value={r.assigned_at} /> },
    { key: 'time', label: 'Time', className: 'cell-center', render: (r) => formatTime(r.assigned_at) },
    {
      key: 'action',
      label: 'Action',
      locked: true,
      className: 'cell-center',
      // "Submitted" implied THIS Custodian already did something —
      // false for a Pre-Diagnosed ticket, or one reassigned to
      // them after the fact. Reusing the same stage logic the
      // Admin's ticket cards use says honestly where the ball
      // actually is instead (e.g. "Diagnosed — Assign a
      // Mechanic" — informational, since assigning one isn't a
      // Custodian action, but at least it's true).
      render: (r) => r.status === 'Open'
        ? <button className="btn-edit-action icon-btn" type="button" onClick={() => onOpenInspect(r)} title="Inspect" aria-label="Inspect"><Icon name="search" size={14} /></button>
        : <TicketStageBadge ticket={r} />
    },
  ], [onOpenInspect]);
  const inspectionColumnDefsWithNote = useMemo(() => withNoteColumn(inspectionColumnDefs, (r) => r.ticket_description, { label: 'Description' }), [inspectionColumnDefs]);
  const inspectionColumnChooser = useColumnChooser('vms_custodian_inspection_columns', inspectionColumnDefsWithNote);

  return (
    <div className="module-grid">
      <DismissibleHint description="Phase 2 — Vehicle Evaluation. Review tickets assigned to you, submit physical inspection findings, and check back here for anything already diagnosed — either by your own inspection, or pre-diagnosed by an Admin (e.g. reassigned to you mid-repair)." />
      <ModuleStatCards
        totalLabel="Total Assigned"
        total={stats.total}
        cards={TICKET_INSPECTION_STAT_CARDS}
        counts={stats}
        activeFilter={activeFilter}
        onFilterChange={onFilterChange}
      />
      {tabBar}
      <section className="panel module-filter-panel">
        <FilterBar
          categories={categories}
          vehicles={vehicles}
          filterCategory={filterCategory}
          setFilterCategory={setFilterCategory}
          filterCapacity={filterCapacity}
          setFilterCapacity={setFilterCapacity}
          filterPriority={filterPriority}
          setFilterPriority={setFilterPriority}
          priorityOptions={priorityOptions}
          priorityLabel="Priority"
        />
      </section>
      <section className="panel">
        <div className="panel-header-bar">
          {/* Not every ticket in this second bucket was actually inspected —
              a Pre-Diagnosed ticket (or one reassigned to this Custodian
              after the fact) skips inspection entirely, so calling it
              "Already Inspected" claimed something that never happened. */}
          <h3>{isPendingView ? 'Pending Inspections' : 'Diagnosed'} <span className="count-badge">{tickets.length}</span></h3>
          <ColumnChooserButton {...inspectionColumnChooser} />
        </div>
        <div style={{ height: '16px' }} />
        {tickets.length === 0
          ? <p className="empty-state">{isPendingView ? 'No inspection assignments pending.' : 'Nothing diagnosed yet.'}</p>
          : (
            <DataTable
              columns={inspectionColumnChooser.visibleColumns}
              onReorderColumn={inspectionColumnChooser.reorderColumn}
              rows={tickets}
            />
          )
        }
      </section>
    </div>
  );
}

function InspectTicketPage({ ticket, onBack, onSubmit, ticketLookups, onDirty }) {
  const [resultValue, setResultValue] = useState(ticket?.inspection_result ?? '');
  const [notes, setNotes] = useState(ticket?.inspection_notes ?? '');
  const [category, setCategory] = useState('');
  const [categoryOtherNote, setCategoryOtherNote] = useState('');
  // Root causes are "added" one at a time (type on the left, Add commits it)
  // rather than every row being a permanently-editable input — the
  // confirmed list on the right is plain text with its own Edit/Delete per
  // row, so it's clear which ones are actually locked in vs. still being
  // typed.
  const [subIssueTitles, setSubIssueTitles] = useState([]);
  const [newRootCause, setNewRootCause] = useState('');
  const [editingIndex, setEditingIndex] = useState(null);
  const [editingDraft, setEditingDraft] = useState('');

  if (!ticket) {
    return (
      <ModulePanel description="This inspection assignment could not be found — it may no longer be assigned to you.">
      </ModulePanel>
    );
  }

  const commitNewRootCause = () => {
    const title = newRootCause.trim();
    if (!title) return;
    setSubIssueTitles((rows) => [...rows, title]);
    setNewRootCause('');
    onDirty?.();
  };
  const startEdit = (index) => { setEditingIndex(index); setEditingDraft(subIssueTitles[index]); };
  const cancelEdit = () => setEditingIndex(null);
  const saveEdit = () => {
    const title = editingDraft.trim();
    if (!title) return;
    setSubIssueTitles((rows) => rows.map((row, i) => (i === editingIndex ? title : row)));
    setEditingIndex(null);
    onDirty?.();
  };
  const removeRow = (index) => {
    setSubIssueTitles((rows) => rows.filter((_, i) => i !== index));
    if (editingIndex === index) setEditingIndex(null);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    // Category is "Other" + a typed note instead of a real catalog value —
    // fold the note into Inspection Notes (the one free-text field this
    // form already sends) rather than inventing a new backend field.
    const otherNote = category === CATALOG_OTHER_VALUE ? categoryOtherNote.trim() : '';
    const finalNotes = otherNote ? `${notes ? `${notes}\n` : ''}Other (specified type): ${otherNote}` : notes;
    const payload = { inspection_result: resultValue, inspection_notes: finalNotes };
    if (resultValue === 'Needs Maintenance') {
      // A root cause still sitting in the "type a new one" box (not yet
      // clicked Add) shouldn't be silently lost just because Submit was
      // pressed instead.
      const pending = newRootCause.trim();
      const allTitles = pending ? [...subIssueTitles, pending] : subIssueTitles;
      payload.sub_issues = allTitles
        .filter((title) => title.trim())
        .map((title) => ({ title: title.trim(), maintenance_type: category || undefined }));
    }
    return onSubmit(ticket, payload);
  };

  return (
    <ModulePanel description="Review the vehicle in person and submit your physical inspection findings.">
      <div className="vehicle-profile-header">
        <h3 className="ticket-detail-title" style={{ margin: 0 }}>Inspect Ticket #{ticketNumber(ticket)}</h3>
        {ticket.priority && <TicketStatusBadge value={ticket.priority} />}
      </div>

      {/* Same rich vehicle-preview card the New Ticket page uses when a
          vehicle is picked — bigger photo (with a proper icon fallback
          instead of just omitting the box), plus type/brand/location, not
          just name and plate — so there's something to actually look at
          here, not just text. */}
      <section className="ticket-section" style={{ marginBottom: 16 }}>
        <h4><Icon name="vehicle" size={14} /> Overview</h4>
        {ticket.ticket_title && <p className="muted" style={{ marginTop: -4, marginBottom: 12 }}>{ticket.ticket_title}</p>}
        <div className="ticket-preview-card" style={{ marginBottom: 12 }}>
          {ticket.vehicle?.photo_url ? (
            <img className="ticket-preview-photo" style={{ width: 140, height: 140 }} src={resolvePhotoUrl(ticket.vehicle.photo_url)} alt={ticket.vehicle.vehicle_name} />
          ) : (
            <span className="ticket-preview-photo ticket-preview-photo-empty" style={{ width: 140, height: 140 }}><Icon name="vehicle" size={48} /></span>
          )}
          <div className="ticket-preview-body">
            <strong>{ticket.vehicle?.vehicle_name}</strong>
            <span>{ticket.vehicle?.plate_number} &middot; {ticket.vehicle?.category?.category_name ?? 'Unclassified'}</span>
            <span className="muted">{[ticket.vehicle?.brand, ticket.vehicle?.model].filter(Boolean).join(' ') || '—'} &middot; {ticket.vehicle?.current_location ?? 'No location on file'}</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              <StatusBadge value={ticket.vehicle?.status} />
              <StatusBadge value={ticket.vehicle?.condition} />
            </div>
          </div>
        </div>
      </section>

      {/* One continuous form — Cancel/Submit sit at the very end, after every
          field (including Category/Root Causes), never in the middle. */}
      <form className="smart-form" onSubmit={handleSubmit} noValidate>
        <div className={resultValue === 'Needs Maintenance' ? 'inspect-form-grid' : undefined}>
        <div className="inspect-form-left">
        <label>
          <span>Inspection Result</span>
          <SearchableSelect required value={resultValue} onChange={(e) => { setResultValue(e.target.value); onDirty?.(); }}>
            <option value="">{' '}</option>
            <option value="Needs Maintenance">Needs Maintenance</option>
            <option value="No Issues">No Issues</option>
          </SearchableSelect>
        </label>
        <label>
          <span>Inspection Notes</span>
          <textarea required rows={3} value={notes} onChange={(e) => { setNotes(e.target.value); onDirty?.(); }} />
        </label>
        </div>

        {resultValue === 'Needs Maintenance' && (
          <div className="repair-summary-card" style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 16 }}>
            <h4 style={{ margin: '0 0 4px 0', display: 'flex', alignItems: 'center', gap: 7, color: '#0f172a' }}><Icon name="wrench" size={16} /> Root Causes Found</h4>
            <p className="muted" style={{ marginTop: 0, marginBottom: 14 }}>All root causes here belong to the same ticket, so they share one category.</p>

            <label style={{ marginBottom: 16 }}>
              <span>Category</span>
              <CatalogOrOtherField
                value={category}
                onChange={(v) => { setCategory(v); onDirty?.(); }}
                note={categoryOtherNote}
                onNoteChange={(v) => { setCategoryOtherNote(v); onDirty?.(); }}
                options={ticketLookups?.maintenance_types ?? []}
                placeholder="Select a category"
                otherNoteLabel="Describe the issue/type"
              />
            </label>

            <span style={{ display: 'block', fontSize: '0.72rem', fontWeight: 600, color: '#64748b', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.02em' }}>Root Causes</span>
            <div className="root-cause-builder">
              <div className="root-cause-input-col">
                <input
                  type="text"
                  placeholder="Describe a root cause (e.g. low coolant level)"
                  value={newRootCause}
                  onChange={(e) => setNewRootCause(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitNewRootCause(); } }}
                />
                <button type="button" className="primary-button" onClick={commitNewRootCause} disabled={!newRootCause.trim()}>
                  <Icon name="plus" size={14} /> Add
                </button>
              </div>

              <div className="root-cause-list-col">
                {subIssueTitles.length === 0 ? (
                  <p className="muted" style={{ margin: 0, fontSize: '0.82rem' }}>No root causes added yet.</p>
                ) : subIssueTitles.map((title, index) => (
                  <div key={index} className="root-cause-list-item">
                    {editingIndex === index ? (
                      <>
                        <input
                          type="text"
                          value={editingDraft}
                          onChange={(e) => setEditingDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveEdit(); } if (e.key === 'Escape') cancelEdit(); }}
                          style={{ flex: 1 }}
                          autoFocus
                        />
                        <button type="button" className="btn-confirm-action icon-btn" onClick={saveEdit} disabled={!editingDraft.trim()} title="Save" aria-label="Save"><Icon name="checkCircle" size={14} /></button>
                        <button type="button" className="btn-delete-action icon-btn" onClick={cancelEdit} title="Cancel edit" aria-label="Cancel edit"><Icon name="close" size={14} /></button>
                      </>
                    ) : (
                      <>
                        <span className="muted" style={{ flex: '0 0 20px', textAlign: 'right' }}>{index + 1}.</span>
                        <span style={{ flex: 1 }}>{title}</span>
                        <button type="button" className="btn-edit-action icon-btn" onClick={() => startEdit(index)} title="Edit root cause" aria-label="Edit root cause"><Icon name="edit" size={14} /></button>
                        <button type="button" className="btn-delete-action icon-btn" onClick={() => removeRow(index)} title="Remove root cause" aria-label="Remove root cause"><Icon name="trash" size={14} /></button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        </div>

        <div className="form-actions">
          <button className="ghost-button" onClick={onBack} type="button">Cancel</button>
          <button className="primary-button" type="submit">Submit Inspection</button>
        </div>
      </form>
    </ModulePanel>
  );
}

// =========================================================================
// PHASE 4 TIER 1: CUSTODIAN REPAIR VERIFICATION
// =========================================================================

function CustodianVerificationModule({
  user,
  tickets,
  readyToCloseTickets = [],
  editTarget,
  setEditTarget,
  onVerify,
  onCancelEdit,
  categories,
  vehicles,
  filterCategory,
  setFilterCategory,
  filterCapacity,
  setFilterCapacity,
  filterPriority,
  setFilterPriority,
  mechanicOptions,
  filterVerdict,
  setFilterVerdict,
  onViewVehicle,
  onViewTicket,
  stats,
  searchQuery,
  setSearchQuery,
  activeFilter,
  onFilterChange,
  tabBar
}) {
  const [ticketViewMode, setTicketViewMode] = useState('table');
  const viewTicket = useCallback((ticket) => {
    if (onViewTicket) onViewTicket(ticket);
    else if (ticket.vehicle) onViewVehicle?.(ticket.vehicle);
  }, [onViewTicket, onViewVehicle]);
  const ticketColumns = useMemo(() => ticketTableColumns({}, viewTicket), [viewTicket]);
  const ticketColumnChooser = useColumnChooser('vms_my_ticket_list_columns', ticketColumns);
  const panelTitle = activeFilter.length !== 1 ? 'My Tickets' : activeFilter.includes('Active')
    ? 'Active Tickets'
    : activeFilter.includes('Verified')
      ? 'Verified Repairs'
      : activeFilter.includes('Pending')
        ? 'Pending Verifications'
        : 'My Tickets';
  const emptyStateText = activeFilter.length !== 1 ? 'No tickets match the selected statuses.' : activeFilter.includes('Active')
    ? 'No tickets currently active.'
    : activeFilter.includes('Verified')
      ? 'No repairs verified yet.'
      : activeFilter.includes('Pending')
        ? 'No repairs pending your verification.'
        : 'No tickets yet — once the Admin approves a proposal, it will show up here.';


  return (
    <div className="module-grid">
      <DismissibleHint description="Review a mechanic's completed work and give the one verification attestation that closes the ticket — check back here to see what you've already verified." />
      {/* Stat cards swapped above the My Tickets/History tab bar — they read
          as the page's headline now, with the tabs as a secondary switch
          underneath instead of sitting above everything. */}
      <ModuleStatCards
        totalLabel="Total Assigned"
        total={stats.total}
        cards={TICKET_VERIFICATION_STAT_CARDS}
        counts={stats}
        activeFilter={activeFilter}
        onFilterChange={onFilterChange}
      />
      <section className="panel module-filter-panel">
        <FilterBar
          statusControls={<WorkflowStatusControls options={TICKET_VERIFICATION_STAT_CARDS.map(({key,label})=>({value:key,label}))} selected={activeFilter} onChange={onFilterChange} defaults={['Active','Pending']} />}
          categories={categories}
          vehicles={vehicles}
          filterCategory={filterCategory}
          setFilterCategory={setFilterCategory}
          filterCapacity={filterCapacity}
          setFilterCapacity={setFilterCapacity}
          filterPriority={filterPriority}
          setFilterPriority={setFilterPriority}
          priorityOptions={mechanicOptions}
          priorityLabel="Mechanic"
          extraFilters={[{
            key: 'verdict',
            label: 'Verdicts',
            options: ['Approved', 'Rejected'],
            selected: filterVerdict,
            setSelected: setFilterVerdict,
          }]}
        />
      </section>
      {tabBar}
      <TicketsReadyToClosePanel tickets={readyToCloseTickets} onViewTicket={onViewTicket} onCloseTicket={canDo(user, 'ticket.verify') ? setEditTarget : undefined} />
      <section className="panel ticket-ledger-panel">
        <div className="panel-header-bar">
          <h3>{panelTitle} <span className="count-badge">{tickets.length}</span></h3>
          <div className="my-ticket-panel-tools">
            <ViewModeDropdown value={ticketViewMode} onChange={setTicketViewMode} />
            <LocalSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search tickets, vehicle, or assignee..."
              columnChooser={ticketViewMode === 'table' ? ticketColumnChooser : undefined}
            />
          </div>
        </div>
        {ticketViewMode === 'table' ? (
          <PaginatedTable
            columns={ticketColumnChooser.visibleColumns}
            onReorderColumn={ticketColumnChooser.reorderColumn}
            rows={tickets}
            onRowClick={viewTicket}
            emptyMessage={emptyStateText}
          />
        ) : (
          <PaginatedCardGrid
            items={tickets}
            keyOf={(t) => t.ticket_id}
            emptyMessage={emptyStateText}
            renderItem={(t) => <TicketCard ticket={t} onClick={() => viewTicket(t)} />}
          />
        )}
      </section>
      {/* The Custodian's one plain attestation for the whole ticket — no
          checklist, no notes, no reject path (see verifyTicket()). Reuses
          the same TicketVerificationForm the ticket detail page's own
          "Verify Repair" section uses. */}
      <FormModal open={!!editTarget} title={`Verify Repair — ${editTarget?.ticket_title ?? `Ticket #${ticketNumber(editTarget)}`}`} onClose={onCancelEdit}>
        <TicketVerificationForm
          ticket={editTarget}
          key={editTarget?.ticket_id}
          onCancel={onCancelEdit}
          onSubmit={(payload) => onVerify(editTarget, payload)}
        />
      </FormModal>

    </div>
  );
}

// =========================================================================
// PHASE 3: MECHANIC WORK ORDER MODULE
// =========================================================================

function MechanicWorkOrderModule({
  tickets,
  // Full, unfiltered list of every ticket assigned to this mechanic (same
  // GET /tickets payload `tickets` above was flattened/filtered down from) —
  // needed so the Archive toggle (the former standalone Work Tracker page)
  // can compute its own 30-day history scope independent of the active-work
  // Pending/Submitted filter, and so both views can hand TicketCard the real
  // ticket object (status/priority/progress/created_at) rather than the
  // slimmed-down grouping shape.
  allTickets = [],
  onViewTicket,
  categories,
  vehicles,
  filterCategory,
  setFilterCategory,
  filterCapacity,
  setFilterCapacity,
  filterPriority,
  setFilterPriority,
  maintTypeOptions,
  searchQuery,
  setSearchQuery,
  stats,
  activeFilter,
  onFilterChange,
  currentUser,
}) {
  const view = activeFilter?.length === 1 ? activeFilter[0] : 'All';
  const viewCopy = {
    Pending: { title: 'Pending Work Orders', note: 'Open a work order and record the repair — it goes to the Custodian once every repair is logged.', empty: 'No active work orders assigned to you.', icon: 'wrench' },
    Submitted: { title: 'Submitted Work Orders', note: 'Repairs you logged, waiting on the Custodian to verify them.', empty: 'Nothing is waiting on a Custodian right now.', icon: 'search' },
    Completed: { title: 'Completed Work Orders', note: 'Repairs the Custodian verified — these tickets are closed.', empty: 'No verified repairs yet.', icon: 'checkCircle' },
    All: { title: 'Work Orders', note: 'All assigned work, including completed work. Use the status filter to narrow the list.', empty: 'No work orders match the current filters.', icon: 'wrench' },
  }[view];
  // Merge 2 — "Work Tracker" is no longer its own sidebar entry; it's this
  // Archive toggle over the same page, mirroring Admin's Maintenance Tickets
  // "Archives" button (see TicketModule's onViewArchives). Admin's version
  // swaps `activeModule` to a distinct key with its own fetch; this role's
  // GET /tickets already returns every ticket ever assigned to them (not
  // just the active ones — see loadModule), so a plain local boolean over
  // data already on hand is enough.
  const [showArchive, setShowArchive] = useState(false);
  const [workOrderViewMode, setWorkOrderViewMode] = useState('table');
  const workOrderColumns = useMemo(() => ticketTableColumns({}, onViewTicket), [onViewTicket]);
  const workOrderColumnChooser = useColumnChooser('vms_work_order_list_columns', workOrderColumns);

  // Resolve the real ticket object for a ticket_id — both grouping helpers
  // below return a synthesized summary row, not what TicketCard needs.
  const ticketById = useMemo(() => {
    const map = new Map();
    (allTickets ?? []).forEach((t) => map.set(t.ticket_id, t));
    return map;
  }, [allTickets]);

  // ---- Assigned work (all statuses by default, via `tickets`
  // which the parent already flattened/filtered to this mechanic's own
  // sub-issue rows) — one card per ticket/vehicle, same as before.
  const groupedTickets = useMemo(() => groupMechanicRowsByTicket(tickets), [tickets]);
  const activeTicketCards = useMemo(
    () => groupedTickets.map((g) => ticketById.get(g.ticket_id)).filter(Boolean),
    [groupedTickets, ticketById]
  );

  // ---- Archive — the history view the old standalone Work Tracker page
  // showed this role: everything still in progress, plus anything
  // completed/deferred within the last 30 days, mirroring WorkTrackerModule's
  // own scope exactly (just narrowed to this mechanic's own lines, since this
  // page never shows a Custodian's verification work).
  const [nowTs] = useState(() => Date.now());
  const [archiveSearch, setArchiveSearch] = useState('');
  const [archiveBucketFilter, setArchiveBucketFilter] = useState('');

  const archiveAllRows = useMemo(() => {
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    return flattenWorkTrackerRows(allTickets, currentUser)
      .filter((row) => row.isMechanic)
      .filter((row) => {
        const isCompleted = row.status === 'Done' || row.status === 'Deferred';
        if (!isCompleted) return true; // always show active/in-progress work
        const ref = row.confirmed_at || row.deferred_at || row.lastActivityIso;
        return ref ? (nowTs - new Date(ref).getTime()) <= THIRTY_DAYS : false;
      })
      .sort((a, b) => {
        const an = workTrackerNeedsAction(a) ? 1 : 0;
        const bn = workTrackerNeedsAction(b) ? 1 : 0;
        if (an !== bn) return bn - an;
        return b.lastActivityTs - a.lastActivityTs;
      });
  }, [allTickets, currentUser, nowTs]);

  const archiveCounts = useMemo(() => {
    const c = { attention: 0, progress: 0, completed: 0 };
    archiveAllRows.forEach((row) => { c[workTrackerBucket(row)] += 1; });
    return c;
  }, [archiveAllRows]);

  const archiveVisibleRows = useMemo(() => {
    let result = archiveAllRows;
    if (archiveBucketFilter) result = result.filter((row) => workTrackerBucket(row) === archiveBucketFilter);
    const q = archiveSearch.trim().toLowerCase();
    if (q) {
      result = result.filter((row) => (
        (row.vehicle?.vehicle_name ?? '').toLowerCase().includes(q)
        || (row.vehicle?.plate_number ?? '').toLowerCase().includes(q)
        || (row.ticket_title ?? '').toLowerCase().includes(q)
        || (row.title ?? '').toLowerCase().includes(q)
      ));
    }
    return result;
  }, [archiveAllRows, archiveBucketFilter, archiveSearch]);

  const archiveGroupedTickets = useMemo(() => groupWorkTrackerByTicket(archiveVisibleRows), [archiveVisibleRows]);
  const archiveTicketCards = useMemo(
    () => archiveGroupedTickets.map((g) => ticketById.get(g.ticket_id)).filter(Boolean),
    [archiveGroupedTickets, ticketById]
  );

  return (
    <div className="module-grid mechanic-work-orders">
      <DismissibleHint description="Work Orders assigned to you. Execute vehicle repairs, log them, then submit the ticket for Custodian verification once every sub-issue is logged — check the Archive for your full history." />

      {!showArchive ? (
        <>
          <ModuleStatCards
            totalLabel="Total Assigned"
            total={stats.total}
            cards={TICKET_WORK_ORDER_STAT_CARDS}
            counts={stats}
            activeFilter={activeFilter}
            onFilterChange={onFilterChange}
          />
          <section className="panel module-filter-panel">
            <FilterBar
          statusControls={<WorkflowStatusControls showShortcuts={false} options={TICKET_WORK_ORDER_STAT_CARDS.map(({key,label})=>({value:key,label}))} selected={activeFilter} onChange={onFilterChange} />}
              categories={categories}
              vehicles={vehicles}
              filterCategory={filterCategory}
              setFilterCategory={setFilterCategory}
              filterCapacity={filterCapacity}
              setFilterCapacity={setFilterCapacity}
              filterPriority={filterPriority}
              setFilterPriority={setFilterPriority}
              priorityOptions={maintTypeOptions}
              priorityLabel="Repair Type"
            />
          </section>
          <section className="panel operations-board work-order-board work-order-queue-board">
            <div className="operations-board-head">
              <div>
                <span className="operations-kicker">Mechanic queue</span>
                <h3>{viewCopy.title} <span className="count-badge">{activeTicketCards.length}</span></h3>
                <p>{viewCopy.note}</p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <button type="button" className="archive-btn" onClick={() => setShowArchive(true)} title="Completed and deferred work from the last 30 days">
                  <span className="archive-btn-icon"><Icon name="archive" size={14} /></span>
                  <span>Archive</span>
                </button>
                <ViewModeDropdown value={workOrderViewMode} onChange={setWorkOrderViewMode} />
                <LocalSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search work orders..." columnChooser={workOrderViewMode === 'table' ? workOrderColumnChooser : undefined} />
              </div>
            </div>
            {workOrderViewMode === 'table' ? (
              <PaginatedTable columns={workOrderColumnChooser.visibleColumns} onReorderColumn={workOrderColumnChooser.reorderColumn} rows={activeTicketCards} onRowClick={onViewTicket} emptyMessage={viewCopy.empty} />
            ) : (
            <PaginatedCardGrid
              items={activeTicketCards}
              keyOf={(t) => t.ticket_id}
              emptyMessage={viewCopy.empty}
              renderItem={(t) => <TicketCard ticket={t} onClick={() => onViewTicket(t)} />}
            />
            )}
          </section>
        </>
      ) : (
        <section className="panel operations-board work-order-board">
          <div className="operations-board-head">
            <div>
              <span className="operations-kicker">Service activity</span>
              <h3>Work Order Archive <span className="count-badge">{archiveVisibleRows.length}</span></h3>
              <p>Every vehicle you've repaired and where it stands now — completed and deferred work stays here for 30 days.</p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <button type="button" className="archive-btn" onClick={() => setShowArchive(false)}>
                <span className="archive-btn-icon"><Icon name="wrench" size={14} /></span>
                <span>Back to Work Orders</span>
              </button>
              <ViewModeDropdown value={workOrderViewMode} onChange={setWorkOrderViewMode} />
                <LocalSearchInput value={archiveSearch} onChange={setArchiveSearch} placeholder="Search vehicle, plate, or ticket..." columnChooser={workOrderViewMode === 'table' ? workOrderColumnChooser : undefined} />
            </div>
          </div>
          <ModuleStatCards
            totalLabel="Total"
            total={archiveAllRows.length}
            cards={WORK_TRACKER_STAT_CARDS}
            counts={archiveCounts}
            activeFilter={archiveBucketFilter}
            onFilterChange={setArchiveBucketFilter}
          />
          <div className="operations-board-note"><Icon name="alert" size={14} /> Items requiring your action are shown first.</div>
          {workOrderViewMode === 'table' ? (
            <PaginatedTable columns={workOrderColumnChooser.visibleColumns} onReorderColumn={workOrderColumnChooser.reorderColumn} rows={archiveTicketCards} onRowClick={onViewTicket} emptyMessage="Nothing here yet — vehicles you repair will show up here with their current status." />
          ) : (
          <PaginatedCardGrid
            items={archiveTicketCards}
            keyOf={(t) => t.ticket_id}
            emptyMessage="Nothing here yet — vehicles you repair will show up here with their current status."
            renderItem={(t) => <TicketCard ticket={t} onClick={() => onViewTicket(t)} />}
          />
          )}
        </section>
      )}

      {/* The old "My Assigned Maintenance Schedules" card section that used
          to live here (a duplicate of the real Maintenance Schedule sidebar
          page) was removed — that page is back in this role's sidebar, and
          GET /maintenance-schedules already scopes to assigned_to = me for
          a pure Maintenance Personnel account, so this was showing the same
          data twice. */}
    </div>
  );
}

// =========================================================================
// CANNIBALIZATION MANAGEMENT (inside Record Repair Work)
// The donor vehicle plus any number of donor parts, each persisted on its own
// through /tickets/{t}/sub-issues/{s}/donor-parts. Editable only while the
// work order is still Under Repair; once the repair is logged the parts are
// history. Nothing happens to the donor vehicle until the repair is submitted.
// =========================================================================

const DONOR_PART_CONDITIONS = ['Good', 'Fair', 'Worn', 'Damaged'];
const emptyDonorPart = () => ({ part_name: '', quantity: 1, part_condition: '', installed_at: '', reason: '', notes: '' });

function DonorPartModal({ mode, part, base, onClose, onSaved, notify }) {
  const readOnly = mode === 'view';
  const [v, setV] = useState(() => ({ ...emptyDonorPart(), ...(part ? {
    part_name: part.part_name ?? '', quantity: part.quantity ?? 1, part_condition: part.part_condition ?? '',
    installed_at: (part.installed_at ?? '').slice(0, 10), reason: part.reason ?? '', notes: part.notes ?? '',
  } : {}) }));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const set = (k, val) => { setV((s) => ({ ...s, [k]: val })); setErrors((e) => ({ ...e, [k]: undefined })); };

  const submit = async (e) => {
    e.preventDefault();
    // This modal renders in a portal, but React still bubbles its submit to the
    // Record Repair Work form around it — which would submit the whole repair.
    e.stopPropagation();
    if (saving || readOnly) return;
    const local = {};
    if (!v.part_name.trim()) local.part_name = 'Enter the part name.';
    if (!Number.isInteger(Number(v.quantity)) || Number(v.quantity) < 1) local.quantity = 'Quantity must be a whole number of 1 or more.';
    setErrors(local);
    if (Object.keys(local).length) return;
    setSaving(true);
    try {
      const body = { ...v, quantity: Number(v.quantity) };
      Object.keys(body).forEach((k) => { if (body[k] === '') body[k] = null; });
      if (mode === 'edit') await api.put(`${base}/donor-parts/${part.part_id}`, body);
      else await api.post(`${base}/donor-parts`, body);
      notify?.({ type: 'success', text: mode === 'edit' ? 'Donor part updated.' : 'Donor part added.' });
      await onSaved();
      onClose();
    } catch (err) {
      const serverErrors = err.response?.data?.errors;
      if (serverErrors) setErrors(Object.fromEntries(Object.entries(serverErrors).map(([k, m]) => [k, m[0]])));
      else setErrors({ _form: err.response?.data?.message || 'Could not save this part.' });
    } finally {
      setSaving(false);
    }
  };

  const field = (name, label, control, required) => (
    <label className={`dp-field${errors[name] ? ' has-error' : ''}`}>
      <span>{label}{required && <b className="req"> *</b>}</span>
      {control}
      {errors[name] && <small className="dp-error" role="alert">{errors[name]}</small>}
    </label>
  );

  return (
    <form className="dp-form" onSubmit={submit} noValidate>
      {errors._form && <div className="notice danger" role="alert">{errors._form}</div>}
      <div className="dp-grid">
        {field('part_name', 'Part name', <input type="text" value={v.part_name} disabled={readOnly} onChange={(e) => set('part_name', e.target.value)} />, true)}
        {field('quantity', 'Quantity', <input type="number" min="1" step="1" value={v.quantity} disabled={readOnly} onChange={(e) => set('quantity', e.target.value)} />, true)}
        {field('part_condition', 'Part condition',
          <SearchableSelect value={v.part_condition} disabled={readOnly} onChange={(e) => set('part_condition', e.target.value)}>
            <option value="">Not stated</option>{DONOR_PART_CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
          </SearchableSelect>)}
        {field('installed_at', 'Date installed', <input type="date" max={calendarDate()} value={v.installed_at} disabled={readOnly} onChange={(e) => set('installed_at', e.target.value)} />)}
        <div className="dp-wide">{field('reason', 'Why a donor part instead of buying one', <textarea rows={2} value={v.reason} disabled={readOnly} onChange={(e) => set('reason', e.target.value)} />)}</div>
        <div className="dp-wide">{field('notes', 'Remarks', <textarea rows={2} value={v.notes} disabled={readOnly} onChange={(e) => set('notes', e.target.value)} />)}</div>
      </div>
      <div className="can-actions">
        <button type="button" className="ghost-button" onClick={onClose} disabled={saving}>{readOnly ? 'Close' : 'Cancel'}</button>
        {!readOnly && <button type="submit" className="primary-button" disabled={saving}>{saving ? 'Saving…' : (mode === 'edit' ? 'Save changes' : 'Add part')}</button>}
      </div>
    </form>
  );
}

function CannibalizationManagement({ ticket, vehicleOptions, onChanged, notify }) {
  const base = `/tickets/${ticket.ticket_id}/sub-issues/${ticket.sub_issue_id}`;
  const parts = ticket.donor_parts ?? [];
  const editable = ticket.status === 'Under Repair' && ticket.ticket_status === 'Active';
  const donor = (vehicleOptions ?? []).find((x) => String(x.vehicle_id) === String(ticket.source_vehicle_id));
  const donorFallback = ticket.source_vehicle;
  const [modal, setModal] = useState(null);       // { mode, part }
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);
  const totalQty = parts.reduce((n, p) => n + (p.quantity || 0), 0);

  const remove = async () => {
    if (busy || !deleting) return;
    setBusy(true);
    try {
      await api.delete(`${base}/donor-parts/${deleting.part_id}`);
      notify?.({ type: 'success', text: 'Donor part removed.' });
      await onChanged();
      setDeleting(null);
    } catch (err) {
      notify?.({ type: 'error', text: err.response?.data?.message || 'Could not remove this part.' });
    } finally {
      setBusy(false);
    }
  };

  const switchToInHouse = async () => {
    try { await api.put(`${base}/donor`, { source_vehicle_id: null }); await onChanged(); } catch (err) { notify?.({ type: 'error', text: err.response?.data?.message || 'Could not switch the repair method.' }); }
  };

  return (
    <section className="lr-group cm-section" aria-label="Cannibalization management">
      <div className="cm-head">
        <h4 className="lr-section-label" style={{ margin: 0 }}>Cannibalization Management</h4>
      </div>
      <p className="cm-desc">This repair uses parts recovered from a donor vehicle. Parts and materials you buy are listed separately, and donor parts never add to the repair cost.</p>

      <div className="cm-donor">
        <div><dt>Donor vehicle</dt><dd>{donor?.vehicle_name ?? donorFallback?.vehicle_name ?? '—'}</dd></div>
        <div><dt>Plate</dt><dd>{donor?.plate_number ?? donorFallback?.plate_number ?? '—'}</dd></div>
        <div><dt>Type</dt><dd>{donor?.category?.category_name ?? '—'}</dd></div>
        <div><dt>Status</dt><dd>{donor ? <StatusBadge value={donor.status} /> : '—'}</dd></div>
      </div>
      <p className="cm-note"><Icon name="info" size={13} /> Adding or editing parts changes nothing on the donor. When you submit this repair, one issue report listing these parts is filed on the donor vehicle and it is flagged for inspection.</p>

      <div className="cm-toolbar">
        <strong>{parts.length} part{parts.length === 1 ? '' : 's'}{parts.length ? ` · ${totalQty} unit${totalQty === 1 ? '' : 's'} in total` : ''}</strong>
        {editable && <button type="button" className="btn-sm primary-button" onClick={() => setModal({ mode: 'add' })}><Icon name="plus" size={13} /> Add Part</button>}
      </div>

      {parts.length === 0 ? (
        <div className="cm-empty">
          <p>No donor parts recorded yet.</p>
        </div>
      ) : (
        <div className="cm-table-wrap">
          <table className="cm-table">
            <thead><tr><th>Part</th><th>Qty</th><th>Condition</th><th>Date installed</th><th>Reason / remarks</th><th>Actions</th></tr></thead>
            <tbody>
              {parts.map((p) => (
                <tr key={p.part_id}>
                  <td data-label="Part"><strong>{p.part_name}</strong></td>
                  <td data-label="Qty">{p.quantity}</td>
                  <td data-label="Condition">{p.part_condition || '—'}</td>
                  <td data-label="Installed">{p.installed_at ? formatDate(p.installed_at) : '—'}</td>
                  <td data-label="Reason">{[p.reason, p.notes].filter(Boolean).join(' · ') || '—'}</td>
                  <td data-label="Actions">
                    <div className="row-actions">
                      <button type="button" className="btn-view-action icon-btn" title="View" aria-label={`View ${p.part_name}`} onClick={() => setModal({ mode: 'view', part: p })}><Icon name="eye" size={14} /></button>
                      {editable && <button type="button" className="btn-edit-action icon-btn" title="Edit" aria-label={`Edit ${p.part_name}`} onClick={() => setModal({ mode: 'edit', part: p })}><Icon name="edit" size={14} /></button>}
                      {editable && <button type="button" className="btn-delete-action icon-btn" title="Delete" aria-label={`Delete ${p.part_name}`} onClick={() => setDeleting(p)}><Icon name="trash" size={14} /></button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!editable && parts.length > 0 && <p className="cm-note">These parts are locked because the repair has been submitted.</p>}
      {editable && parts.length === 0 && (
        <button type="button" className="link-button cm-switch" onClick={switchToInHouse}>Not using a donor part? Switch back to in-house</button>
      )}

      <FormModal open={!!modal} title={modal?.mode === 'edit' ? 'Edit donor part' : modal?.mode === 'view' ? 'Donor part' : 'Add donor part'} onClose={() => setModal(null)}>
        {modal && <DonorPartModal key={`${modal.mode}-${modal.part?.part_id ?? 'new'}`} mode={modal.mode} part={modal.part} base={base} onClose={() => setModal(null)} onSaved={onChanged} notify={notify} />}
      </FormModal>
      <FormModal open={!!deleting} title="Delete donor part?" onClose={() => setDeleting(null)}>
        {deleting && (
          <div className="dp-form">
            <p>Remove <strong>{deleting.quantity} × {deleting.part_name}</strong> from this repair? This cannot be undone.</p>
            <div className="can-actions">
              <button type="button" className="ghost-button" onClick={() => setDeleting(null)} disabled={busy}>Cancel</button>
              <button type="button" className="danger-button" onClick={remove} disabled={busy}>{busy ? 'Deleting…' : 'Delete part'}</button>
            </div>
          </div>
        )}
      </FormModal>
    </section>
  );
}

// Pick a donor vehicle for an in-house repair. Saved immediately, so the
// repair method shown on this page is always the persisted one.
function DonorVehiclePicker({ ticket, vehicleOptions, onChanged, notify }) {
  const [open, setOpen] = useState(false);
  const [donorId, setDonorId] = useState('');
  const [busy, setBusy] = useState(false);
  const options = (vehicleOptions ?? []).filter((x) => String(x.vehicle_id) !== String(ticket.vehicle?.vehicle_id) && !['Inactive', 'Decommissioned'].includes(x.status));
  const save = async () => {
    if (!donorId || busy) return;
    setBusy(true);
    try {
      await api.put(`/tickets/${ticket.ticket_id}/sub-issues/${ticket.sub_issue_id}/donor`, { source_vehicle_id: donorId });
      await onChanged();
    } catch (err) {
      notify?.({ type: 'error', text: err.response?.data?.errors?.source_vehicle_id?.[0] || err.response?.data?.message || 'Could not set the donor vehicle.' });
    } finally {
      setBusy(false);
    }
  };
  if (!open) return <button type="button" className="btn-sm ghost-button" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>Use parts from another vehicle</button>;
  return (
    <div className="cm-picker">
      <label className="lr-label" htmlFor="cm-donor">Donor vehicle</label>
      <SearchableSelect id="cm-donor" value={donorId} onChange={(e) => setDonorId(e.target.value)}>
        <option value="">Select donor vehicle</option>
        {options.map((x) => <option key={x.vehicle_id} value={x.vehicle_id}>{x.vehicle_name} ({x.plate_number})</option>)}
      </SearchableSelect>
      <button type="button" className="btn-sm primary-button" disabled={!donorId || busy} onClick={save}>{busy ? 'Saving…' : 'Use this donor'}</button>
      <button type="button" className="btn-sm ghost-button" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}

function LogRepairsPage({ ticket, vehicleOptions = [], onBack, onSubmit, onDirty, onExternalSend, onExternalReturn, onDonorChanged, notify }) {
  const [repairLogs, setRepairLogs] = useState('');
  const [submittingRepair, setSubmittingRepair] = useState(false);
  const [shopBusy, setShopBusy] = useState(false);
  const [parts, setParts] = useState([]);
  const [serviceCost, setServiceCost] = useState('');
  const [attachments, setAttachments] = useState([]);
  // Pre-filled from whatever was chosen at ticket creation (if this was a
  // pre-diagnosed sub-issue) — still editable here, since the actual repair
  // sometimes ends up differing from the original plan. Sub-issues created
  // via "Needs Inspection" arrive with this blank, since nobody could know
  // it yet — this is the first point it's actually knowable.
  // The repair method is the saved one (ticket.repair_type) — never local state
  // and never inferred from whether donor fields happen to hold values.
  const repairType = ticket?.repair_type ?? '';
  // External shop stages: send out, then mark returned, then submit.
  const [sendForm, setSendForm] = useState({ external_vendor: ticket?.external_vendor ?? '', external_reason: ticket?.external_reason ?? '', external_work_scope: ticket?.external_work_scope ?? '', external_shop_contact: ticket?.external_shop_contact ?? '', external_shop_address: ticket?.external_shop_address ?? '', external_expected_return: '', external_estimated_cost: ticket?.external_estimated_cost ?? '' });
  const [returnForm, setReturnForm] = useState({ external_return_notes: '', external_actual_cost: '', warranty_until: '' });

  if (!ticket) {
    return (
      <ModulePanel description="This work order could not be found — it may no longer be assigned to you.">
      </ModulePanel>
    );
  }

  const updatePart = (index, field, value) => { setParts((rows) => rows.map((row, i) => (i === index ? { ...row, [field]: value } : row))); onDirty?.(); };
  const addPart = () => { setParts((rows) => [...rows, { name: '', cost: '' }]); onDirty?.(); };
  const removePart = (index) => { setParts((rows) => rows.filter((_, i) => i !== index)); onDirty?.(); };

  // Live-running total instead of a manual "Generate" click — a click-based
  // total would go stale the moment another row is added or edited after
  // pressing it. This always reflects exactly what's in the rows right now.
  const totalCost = parts.reduce((sum, p) => sum + (parseFloat(p.cost) || 0), 0) + (parseFloat(serviceCost) || 0);
  // Confirmed via code audit: while a repair is sent out and waiting on the
  // shop, Parts/Attachment/Schedule don't apply yet — the mechanic has
  // nothing to log here until it comes back. De-emphasized, not removed or
  // disabled, since a mechanic may still want to note something early.
  const needsShopCycle = repairType === 'external' && (!ticket.external_sent_at || !ticket.external_returned_at || ticket.verification_verdict === 'Rejected');
  const awaitingShopReturn = repairType === 'external' && !!ticket.external_sent_at && !ticket.external_returned_at;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submittingRepair || needsShopCycle) return;
    if (repairType === 'cannibalized' && !(ticket.donor_parts ?? []).length) {
      notify?.({ type: 'error', text: 'Add at least one donor part before submitting a cannibalized repair.' });
      return;
    }
    const namedParts = parts.filter((p) => p.name.trim());
    setSubmittingRepair(true);
    try { await onSubmit(ticket, {
      repair_logs: repairLogs,
      parts_used: namedParts.map((p) => p.name.trim()).join(', ') || undefined,
      photos: attachments.length ? attachments : undefined,
      maintenance_cost: parts.some((part) => part.cost !== '') || serviceCost !== '' ? totalCost : undefined,
      repair_type: repairType || undefined,
      source_vehicle_id: repairType === 'cannibalized' ? ticket.source_vehicle_id : undefined,
    }); } finally { setSubmittingRepair(false); }
  };

  // Display-only helpers for the workspace below — none of them feed into
  // handleSubmit, which still sends exactly the same payload as before.
  const REPAIR_TYPE_LABEL = { in_house: 'In-House Repair', cannibalized: 'Cannibalized Repair', external: 'Sent to External Shop' };
  const idBase = `lr-${ticket.sub_issue_id ?? ticket.ticket_id}`;
  const workDescription = ticket.work_order_notes ?? ticket.ticket_description;
  const namedPartCount = parts.filter((p) => p.name.trim()).length;
  const dimWhileAtShop = { opacity: awaitingShopReturn ? 0.5 : 1 };

  // One workspace instead of a stack of cards: a compact header (vehicle /
  // ticket / status said once), then a two-column body — the repair task
  // itself on the left, the supporting record (parts, dates, total) plus
  // the submit action on the right, which stays in view while scrolling.
  return (
    <ModulePanel>
      <header className="lr-header">
        <div className="lr-header-main">
          <h3 className="lr-vehicle">{ticket.vehicle?.vehicle_name ?? 'Vehicle'}</h3>
          <p className="lr-header-meta">
            {[ticket.vehicle?.plate_number, ticket.maintenance_type, `Ticket #${ticketNumber(ticket)}`].filter(Boolean).join(' · ')}
          </p>
        </div>
        <TicketStatusPill status={ticket.status} />
      </header>

      {ticket.confirmation_verdict === 'Reopened' && (
        <div className="lr-alert lr-alert-danger" role="alert">
          <Icon name="alert" size={16} />
          <div>
            <strong>Reopened by Admin ({ticket.confirmed_by?.name ?? 'Admin'})</strong>
            <p>{ticket.confirmation_notes ?? 'No feedback notes provided.'}</p>
          </div>
        </div>
      )}
      {ticket.verification_verdict === 'Rejected' && (
        <div className="lr-alert lr-alert-warning" role="alert">
          <Icon name="alert" size={16} />
          <div>
            <strong>Rejected by Custodian ({ticket.verified_by?.name ?? 'Custodian'})</strong>
            <p>{ticket.verification_notes ?? 'No feedback notes provided.'}</p>
          </div>
        </div>
      )}

      <form className="smart-form lr-workspace" onSubmit={handleSubmit} noValidate>
        <div className="lr-main">
          {/* Work order — only as tall as its content. Vehicle, ticket #,
              type and status already live in the header above, so this
              only carries what the header doesn't: what to fix and why. */}
          <section className="lr-group lr-workorder" aria-labelledby={`${idBase}-wo`}>
            <h4 className="lr-section-label" id={`${idBase}-wo`}>Work Order Overview</h4>
            <dl className="lr-kv">
              <div><dt>Repair Item</dt><dd>{ticket.title}</dd></div>
              <div><dt>Main Issue</dt><dd>{ticket.ticket_title}</dd></div>
              {workDescription && <div className="lr-kv-wide"><dt>Description</dt><dd>{workDescription}</dd></div>}
            </dl>
            {ticket.repair_logs && (
              <div className="lr-history">
                <span className="lr-mini-label">Previous repair</span>
                <RepairLogEntries text={ticket.repair_logs} compact limit={2} />
              </div>
            )}
          </section>

          {/* The primary task — visually the heaviest group on the page. */}
          <section className="lr-group lr-primary" aria-labelledby={`${idBase}-rw`}>
            <h4 className="lr-section-label" id={`${idBase}-rw`}>Repair Details</h4>
            <div className="lr-field">
              <span className="lr-label" id={`${idBase}-type`}>Repair Method</span>
              {/* Read-only on purpose: decided when the ticket was proposed
                  and never changed here — shown as a value, not a disabled
                  dropdown that looks clickable. */}
              <p className="lr-readonly" aria-labelledby={`${idBase}-type`}>
                {repairType === 'cannibalized' ? <span className="cm-badge">{REPAIR_TYPE_LABEL.cannibalized}</span> : (REPAIR_TYPE_LABEL[repairType] ?? REPAIR_TYPE_LABEL.in_house)}
                {repairType === 'external' && <span className="lr-hint"> · set when the ticket was proposed</span>}
              </p>
            </div>
            {repairType !== 'external' && repairType !== 'cannibalized' && ticket.status === 'Under Repair' && ticket.ticket_status === 'Active' && (
              <DonorVehiclePicker ticket={ticket} vehicleOptions={vehicleOptions} onChanged={onDonorChanged} notify={notify} />
            )}

            <div className="lr-field">
              <label className="lr-label" htmlFor={`${idBase}-work`}>Work Performed {repairType !== 'cannibalized' && <abbr className="required-asterisk" title="required">*</abbr>}</label>
              <textarea
                id={`${idBase}-work`}
                className="lr-textarea"
                required={repairType !== 'cannibalized'}
                rows={4}
                placeholder={repairType === 'cannibalized' ? 'Optional — add repair details if you also repaired something (a part-only job can leave this blank).' : 'Describe what you repaired, what you found, what you replaced, adjustments made, and testing performed.'}
                value={repairLogs}
                onChange={(e) => { setRepairLogs(e.target.value); onDirty?.(); }}
              />
            </div>
          </section>

          {repairType === 'cannibalized' && (
            <CannibalizationManagement ticket={ticket} vehicleOptions={vehicleOptions} onChanged={onDonorChanged} notify={notify} />
          )}

          {repairType === 'external' && onExternalSend && (
            <section className="lr-group" aria-labelledby={`${idBase}-shop`}>
              <h4 className="lr-section-label" id={`${idBase}-shop`}>External Shop</h4>
              {(!ticket.external_sent_at || ticket.verification_verdict === 'Rejected') ? (
                <>
                  <div className="lr-two-col">
                    <div className="lr-field">
                      <label className="lr-label" htmlFor={`${idBase}-sv`}>Shop Name <abbr className="required-asterisk" title="required">*</abbr></label>
                      <input id={`${idBase}-sv`} type="text" value={sendForm.external_vendor} onChange={(e) => setSendForm({ ...sendForm, external_vendor: e.target.value })} />
                    </div>
                    <div className="lr-field">
                      <label className="lr-label" htmlFor={`${idBase}-sr`}>Why Outside? <abbr className="required-asterisk" title="required">*</abbr></label>
                      <input id={`${idBase}-sr`} type="text" value={sendForm.external_reason} onChange={(e) => setSendForm({ ...sendForm, external_reason: e.target.value })} />
                    </div>
                    <div className="lr-field">
                      <label className="lr-label" htmlFor={`${idBase}-sc`}>Shop Contact</label>
                      <input id={`${idBase}-sc`} type="text" value={sendForm.external_shop_contact} onChange={(e) => setSendForm({ ...sendForm, external_shop_contact: e.target.value })} />
                    </div>
                    <div className="lr-field">
                      <label className="lr-label" htmlFor={`${idBase}-sa`}>Shop Address</label>
                      <input id={`${idBase}-sa`} type="text" value={sendForm.external_shop_address} onChange={(e) => setSendForm({ ...sendForm, external_shop_address: e.target.value })} />
                    </div>
                    <div className="lr-field">
                      <label className="lr-label" htmlFor={`${idBase}-sx`}>Expected Return</label>
                      <DateFilterInput id={`${idBase}-sx`} value={sendForm.external_expected_return} onChange={(v) => setSendForm({ ...sendForm, external_expected_return: v })} />
                    </div>
                    <div className="lr-field">
                      <label className="lr-label" htmlFor={`${idBase}-se`}>Estimated Cost (₱)</label>
                      <input id={`${idBase}-se`} type="number" min="0" value={sendForm.external_estimated_cost} onChange={(e) => setSendForm({ ...sendForm, external_estimated_cost: e.target.value })} />
                    </div>
                  </div>
                  <div className="lr-field">
                    <label className="lr-label" htmlFor={`${idBase}-sw`}>Details <abbr className="required-asterisk" title="required">*</abbr></label>
                    <textarea id={`${idBase}-sw`} className="lr-textarea" rows={2} value={sendForm.external_work_scope} onChange={(e) => setSendForm({ ...sendForm, external_work_scope: e.target.value })} />
                  </div>
                  <button
                    type="button"
                    className="primary-button"
                    style={{ alignSelf: 'flex-start' }}
                    disabled={shopBusy || !sendForm.external_vendor.trim() || !sendForm.external_reason.trim() || !sendForm.external_work_scope.trim()}
                    onClick={async () => { if (shopBusy) return; setShopBusy(true); try { const ok = await onExternalSend(ticket, Object.fromEntries(Object.entries(sendForm).filter(([, v]) => String(v).trim() !== ''))); if (ok !== false) setReturnForm({ external_return_notes: '', external_actual_cost: '', warranty_until: '' }); } finally { setShopBusy(false); } }}
                  >
                    Mark as Sent to Shop
                  </button>
                </>
              ) : !ticket.external_returned_at ? (
                <>
                  <p className="lr-note">Sent to <strong>{ticket.external_vendor}</strong> on {formatDate(ticket.external_sent_at)} — waiting for it to come back.</p>
                  <div className="lr-field">
                    <label className="lr-label" htmlFor={`${idBase}-rn`}>Result / Condition on Return <abbr className="required-asterisk" title="required">*</abbr></label>
                    <textarea id={`${idBase}-rn`} className="lr-textarea" rows={2} value={returnForm.external_return_notes} onChange={(e) => setReturnForm({ ...returnForm, external_return_notes: e.target.value })} />
                  </div>
                  <div className="lr-two-col">
                    <div className="lr-field">
                      <label className="lr-label" htmlFor={`${idBase}-ra`}>Actual Cost (₱)</label>
                      <input id={`${idBase}-ra`} type="number" min="0" value={returnForm.external_actual_cost} onChange={(e) => setReturnForm({ ...returnForm, external_actual_cost: e.target.value })} />
                    </div>
                    <div className="lr-field">
                      <label className="lr-label" htmlFor={`${idBase}-rw2`}>Warranty Until</label>
                      <DateFilterInput id={`${idBase}-rw2`} value={returnForm.warranty_until} onChange={(v) => setReturnForm({ ...returnForm, warranty_until: v })} />
                    </div>
                  </div>
                  <button
                    type="button"
                    className="primary-button"
                    style={{ alignSelf: 'flex-start' }}
                    disabled={shopBusy || !returnForm.external_return_notes.trim()}
                    onClick={async () => { if (shopBusy) return; setShopBusy(true); try { await onExternalReturn(ticket, Object.fromEntries(Object.entries(returnForm).filter(([, v]) => String(v).trim() !== ''))); } finally { setShopBusy(false); } }}
                  >
                    Mark as Returned
                  </button>
                </>
              ) : (
                <p className="lr-note">Returned from <strong>{ticket.external_vendor}</strong> on {formatDate(ticket.external_returned_at)}. {ticket.external_return_notes}</p>
              )}
            </section>
          )}

          {awaitingShopReturn && (
            <p className="lr-note">Evidence, parts and dates apply once the vehicle is back from the shop — mark it Returned above when it comes in.</p>
          )}


        </div>

        <aside className="lr-side-column" aria-label="Repair record and submission">
          <div className="lr-side">
          {/* Part name takes the row, cost is a fixed narrow column — no
              more fields pinned to opposite edges of the page. Same
              Part Name + Cost model the backend stores (a joined string +
              one total), so no quantity/unit-cost fields are invented. */}
           {repairType !== 'external' ? <section className="lr-side-group" style={dimWhileAtShop} aria-labelledby={`${idBase}-parts`}>
            <h4 className="lr-section-label" id={`${idBase}-parts`}>Parts &amp; Materials <span className="lr-hint">(optional)</span></h4>
            {!parts.length && <p className="lr-hint">No parts or costs to record? Leave this section empty.</p>}
            {!!parts.length && <div className="lr-parts" role="table" aria-labelledby={`${idBase}-parts`}>
              <div className="lr-parts-head" role="row">
                <span role="columnheader">Part / Material</span>
                <span role="columnheader">Cost (₱)</span>
                <span aria-hidden="true" />
              </div>
              {parts.map((part, index) => (
                <div className="lr-parts-row" role="row" key={index}>
                  <input type="text" aria-label={`Part ${index + 1} name`} placeholder="e.g. A/C compressor" value={part.name} onChange={(e) => updatePart(index, 'name', e.target.value)} />
                  <input type="number" aria-label={`Part ${index + 1} cost`} placeholder="0.00" min="0" step="0.01" value={part.cost} onChange={(e) => updatePart(index, 'cost', e.target.value)} />
                  <button
                    type="button"
                    className="lr-icon-btn btn-delete-action"
                    onClick={() => removePart(index)}
                    title="Remove part"
                    aria-label={`Remove part ${index + 1}`}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}
            </div>}
            <button type="button" className="lr-link-btn" onClick={addPart}><Icon name="plus" size={13} /> Add Part</button>
            <div className="lr-field"><label className="lr-label" htmlFor={`${idBase}-service`}>Labor / Service Cost (optional)</label><input id={`${idBase}-service`} type="number" min="0" step="0.01" value={serviceCost} onChange={(e) => { setServiceCost(e.target.value); onDirty?.(); }} /></div>
            <div className="lr-total">
              <span>Total Repair Cost</span>
              <strong>₱{totalCost.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong>
            </div>
          </section> : <section className="lr-side-group"><h4>Shop cost across visits</h4><p>{ticket.maintenance_cost == null ? 'Cost not yet recorded for every shop visit' : `₱${Number(ticket.maintenance_cost).toLocaleString('en-US', { minimumFractionDigits: 2 })}`}</p><p>Record each visit's invoice amount when marking it returned.</p></section>}


          <div className="lr-side-actions">
            <p className="lr-hint">
              Recorded under Ticket #{ticketNumber(ticket)} · {namedPartCount} part{namedPartCount === 1 ? '' : 's'} · {attachments.length ? `${attachments.length} file${attachments.length === 1 ? '' : 's'} attached` : 'no evidence attached'}
            </p>
            {needsShopCycle && <p className="lr-note">{ticket.verification_verdict === 'Rejected' ? 'Record a new shop visit and return for this rejected repair.' : 'Send to the shop and mark returned before submitting.'}</p>}
            <button className="primary-button lr-submit" type="submit" disabled={needsShopCycle || submittingRepair || shopBusy}>{submittingRepair ? 'Submitting...' : 'Submit Repair Log'}</button>
            <button className="ghost-button lr-cancel" onClick={onBack} type="button">Cancel</button>
          </div>
          </div>
          <RepairFileCabinet files={attachments} savedFiles={[...(ticket.attachment_files ?? []).map((file) => ({ ...file, url: resolvePhotoUrl(file.url) })), ...(ticket.attachment_url ? [{ url: resolvePhotoUrl(ticket.attachment_url), name: 'Previous repair attachment' }] : [])]} onChange={(files) => { setAttachments(files); onDirty?.(); }} onError={(text) => notify?.({ type: 'error', text })} />
        </aside>
      </form>
    </ModulePanel>
  );
}

// =========================================================================
// TICKET TABLE VIEW COLUMNS (alternative to the ticket card grid)
// =========================================================================

// Collapsible highlight strip above the main ticket table — surfaces
// tickets whose sub-issues are all done but haven't been closed yet, so
// an Admin/Custodian can spot and act on them without hunting through the
// full list below. Always visible (even at a count of 0) so it reads as a
// permanent fixture of the page, not something that randomly appears.
function readyToCloseColumns(onCloseTicket) {
  return [
    { key: 'ticket_id', label: 'Ticket ID', className: 'cell-center', render: (r) => <span className="row-title-text">#{ticketNumber(r)}</span> },
    { key: 'vehicle', label: 'Vehicle', render: (r) => <VehicleCell vehicle={r.vehicle} isRowTitle={false} /> },
    { key: 'title', label: 'Title', render: (r) => r.ticket_title },
    { key: 'priority', label: 'Priority', className: 'cell-center', render: (r) => <TicketStatusBadge value={r.priority} /> },
    { key: 'progress', label: 'Sub-Issues', className: 'cell-center', render: (r) => `${r.progress?.done ?? 0}/${r.progress?.total ?? 0} done` },
    { key: 'created', label: 'Created', className: 'cell-center', render: (r) => <DateBadge value={r.created_at} /> },
    ...(onCloseTicket ? [{ key: 'action', label: 'Action', className: 'cell-center', render: (r) => (
      <button type="button" className="ready-to-close-action" aria-label={`Close ticket #${ticketNumber(r)}`} title="Verify the repair before closing this ticket" onClick={(event) => { event.stopPropagation(); onCloseTicket(r); }} onKeyDown={(event) => event.stopPropagation()}>
        <Icon name="checkCircle" size={15} /> Close Ticket
      </button>
    ) }] : []),
  ];
}

function TicketsReadyToClosePanel({ tickets, onViewTicket, onCloseTicket }) {
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const columns = useMemo(() => readyToCloseColumns(onCloseTicket), [onCloseTicket]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tickets;
    return tickets.filter((t) => (
      String(ticketNumber(t)).includes(q)
      || t.ticket_title?.toLowerCase().includes(q)
      || t.vehicle?.vehicle_name?.toLowerCase().includes(q)
      || t.vehicle?.plate_number?.toLowerCase().includes(q)
    ));
  }, [tickets, search]);

  return (
    <div className="ready-to-close-panel">
      <div className="ready-to-close-header">
        <span className="count-badge">{tickets.length}</span>
        <h3>Tickets Ready to Close</h3>
        <div className="ready-to-close-search">
          <LocalSearchInput value={search} onChange={setSearch} placeholder="Search ready tickets..." />
        </div>
        <button
          type="button"
          className="ready-to-close-toggle"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? 'Collapse' : 'Expand'}
          aria-expanded={expanded}
        >
          <Icon name="chevronDown" size={16} className={expanded ? 'is-expanded' : ''} />
        </button>
      </div>
      {expanded && (
        <div className="ready-to-close-body">
          <DataTable
            compact
            columns={columns}
            rows={filtered}
            onRowClick={onViewTicket}
            emptyMessage={tickets.length ? 'No tickets match your search.' : 'No tickets are ready to close right now.'}
          />
        </div>
      )}
    </div>
  );
}

function ticketTableColumns(unreadByTicket = {}, onViewTicket, onChangeVisibility) {
  const columns = [
    { key: 'ticket_id', label: 'Ticket ID', locked: true, className: 'cell-center', render: (r) => <div className={`ticket-list-identity ${ticketStatusClass(r.status)}`}><strong>{ticketNumber(r)}</strong><small className="muted">{(r.updated_at ?? r.created_at) ? new Date(r.updated_at ?? r.created_at).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) : '-'}</small></div> },
    { key: 'created', label: 'Created', className: 'cell-center', render: (r) => <DateBadge value={r.created_at} /> },
    { key: 'next_step', label: 'Next Step', className: 'cell-center', render: (r) => {
      const stage = ticketWorkflowStage(r);
      return stage ? <span className="ticket-next-step-badge" style={{ color: TICKET_STAGE_STYLE[stage.tone].color, background: TICKET_STAGE_STYLE[stage.tone].bg }}>{stage.label}</span> : '—';
    } },
    { key: 'priority', label: 'Priority', className: 'cell-center', render: (r) => <TicketStatusBadge value={r.priority} /> },
    {
      key: 'title',
      label: 'Title',
      render: (r) => {
        const unread = unreadByTicket[r.ticket_id] ?? 0;
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {unread > 0 && (
              <span
                title={`${unread} unread update${unread > 1 ? 's' : ''} on this ticket`}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  minWidth: 18, height: 18, padding: '0 4px', borderRadius: 0,
                  background: '#dc2626', color: '#fff', fontSize: '0.65rem', fontWeight: 700,
                }}
              >
                {unread > 9 ? '9+' : unread}
              </span>
            )}
            <span className="ticket-list-title"><strong className="row-title-text">{r.ticket_title}</strong><small className="muted">{[r.vehicle?.vehicle_name, r.vehicle?.plate_number].filter(Boolean).join(' — ') || 'No vehicle'}</small></span>
          </span>
        );
      },
    },
    { key: 'vehicle_image', label: 'Vehicle Image', className: 'cell-center', render: (r) => <PhotoCell alt={r.vehicle?.vehicle_name ?? 'Vehicle'} url={r.vehicle?.photo_url} /> },
    { key: 'status', label: 'Status', className: 'cell-center', render: (r) => <span><TicketStatusPill status={r.status} />{r.correction_requested_at && <small className="muted"> Corrections requested</small>}</span> },
    { key: 'personnel', label: 'Assigned To', render: (r) => <TicketPersonnelAvatars ticket={r} /> },
    { key: 'actions', label: 'Actions', className: 'cell-center', render: (r) => <span className="ticket-list-actions"><button type="button" className="icon-btn btn-view-action" title="View ticket" aria-label={`View ticket ${ticketNumber(r)}`} onClick={(e) => { e.stopPropagation(); onViewTicket(r); }}><Icon name="eye" size={16} /></button>{onChangeVisibility && <button type="button" className={`icon-btn ${r.hidden_from_list ? 'btn-reopen-action' : 'btn-archive-action'}`} title={r.hidden_from_list ? 'Restore to my list' : 'Hide from my list; repair tracking continues'} aria-label={`${r.hidden_from_list ? 'Restore' : 'Hide'} ticket ${ticketNumber(r)} ${r.hidden_from_list ? 'to' : 'from'} my list`} onClick={(e) => { e.stopPropagation(); onChangeVisibility(r, !r.hidden_from_list); }}><Icon name={r.hidden_from_list ? 'undo' : 'archive'} size={16} /></button>}</span> },
  ];
  const order = ['ticket_id', 'created', 'vehicle_image', 'title', 'priority', 'status', 'personnel', 'next_step', 'actions'];
  return order.map((key) => columns.find((column) => column.key === key));
}

// =========================================================================
// PHASE 5: TICKET ARCHIVE COLUMNS
// =========================================================================

const ticketArchiveColumns = [
  { key: 'archive_id', label: 'Archive ID', locked: true, className: 'cell-center', render: (r) => recordNumber(r, 'archive_id') },
  { key: 'ticket_id', label: 'Ticket ID', className: 'cell-center', render: (r) => ticketNumber(r) },
  { key: 'title', label: 'Title', render: (r) => r.ticket_title },
  { key: 'vehicle', label: 'Vehicle', render: (r) => <VehicleCell vehicle={r.vehicle ?? { vehicle_name: r.vehicle_name, plate_number: r.plate_number }} /> },
  { key: 'plate', label: 'Plate Number', className: 'cell-center', render: (r) => (r.vehicle?.plate_number ?? r.plate_number) ?? '-' },
  { key: 'expenses', label: 'Expenses', className: 'cell-center', render: (r) => r.maintenance_cost != null ? `₱${Number(r.maintenance_cost).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : 'Not recorded' },
  { key: 'final_status', label: 'Final Status', className: 'cell-center', render: (r) => <TicketStatusPill status={r.final_status} /> },
  { key: 'archived_by', label: 'Archived By', className: 'cell-center', render: (r) => <UserAvatarName user={r.archived_by} fallback="—" /> },
  { key: 'archived_at', label: 'Archived At', className: 'cell-center', render: (r) => <DateBadge value={r.archived_at} /> },
  { key: 'time', label: 'Time', className: 'cell-center', render: (r) => formatTime(r.archived_at) },
];

// =========================================================================
// TICKET PHASE HELPERS
// =========================================================================

// A ticket now only moves through 3 stages at the ticket level — the real
// work happens per sub-issue (see TicketDetailPanel's sub-issue checklist,
// which uses this same TicketStatusBadge for each line's own status).
// 'Open' no longer appears here — only historical tickets created before
// the one-mechanic-per-ticket redesign can have that status, and for those
// the stepper below just shows no step highlighted (same graceful fallback
// already used for 'Cancelled'/'Pending Approval' tickets whose status
// isn't in this list).
const phaseOrder = ['Pending Approval', 'Active', 'For Verification', 'Closed'];

const PHASE_STEP_ICONS = {
  'Pending Approval': 'clipboard',
  'Active': 'wrench',
  'For Verification': 'search',
  'Closed': 'checkCircle',
};

const PHASE_STEP_COLORS = {
  'Pending Approval': '#a16207',
  'Active': '#2563eb',
  'For Verification': '#7c3aed',
  'Closed': '#16a34a',
};

// Order-insensitive comparison for the array-valued filter state used by
// FilterBar's multi-select dropdowns.
const sameSelection = (a = [], b = []) => a.length === b.length && a.every((v) => b.includes(v));

// Naive but good-enough English pluralization for filter placeholders
// ("Priority" -> "Priorities", "Status" -> "Statuses", "Mechanic" -> "Mechanics").
const pluralizeLabel = (label) => {
  if (label.endsWith('y')) return `${label.slice(0, -1)}ies`;
  if (label.endsWith('s')) return `${label}es`;
  return `${label}s`;
};

function isoDateToDisplay(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return '';
  return `${m}/${d}/${y}`;
}

function displayDateToIso(display) {
  const match = display.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, m, d, y] = match;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// A native <input type="date">'s displayed text always follows the
// visitor's own OS region setting (day-first, month-first, whatever it is)
// — nothing on the page, not even the `lang` attribute, can override just
// that display. This wraps a hidden native date input (kept only for its
// calendar picker, launched via showPicker()) behind a visible text field
// that is always typed and displayed as MM/DD/YYYY, so the format is
// guaranteed regardless of the browser/OS locale.
// `id` lets a standalone <label htmlFor> point at the visible text input;
// both are optional and unused by every existing caller.
function DateFilterInput({ value, onChange, placeholder = 'mm/dd/yyyy', id, ariaLabel = 'Date (mm/dd/yyyy)' }) {
  const hiddenRef = useRef(null);
  const [text, setText] = useState(() => isoDateToDisplay(value));

  const dateValueKey = JSON.stringify([value]);
  const [previousDateValueKey, setPreviousDateValueKey] = useState(dateValueKey);
  if (previousDateValueKey !== dateValueKey) {
    setPreviousDateValueKey(dateValueKey);
    setText(isoDateToDisplay(value));

  }

  const openPicker = () => {
    try { hiddenRef.current?.showPicker?.(); } catch { /* unsupported browser — text entry still works */ }
  };

  const commit = (raw) => {
    if (!raw.trim()) { onChange(''); return; }
    const iso = displayDateToIso(raw);
    if (iso) onChange(iso);
    else setText(isoDateToDisplay(value));
  };

  return (
    <div className="date-filter-input">
      <input
        type="text"
        id={id}
        aria-label={ariaLabel}
        className="date-filter-input-text"
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
      <button type="button" className="date-filter-input-icon" onClick={openPicker} aria-label="Open calendar">
        <Icon name="calendar" size={14} />
      </button>
      <input
        ref={hiddenRef}
        type="date"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className="date-filter-input-hidden"
        tabIndex={-1}
        aria-hidden="true"
      />
    </div>
  );
}

// Checkbox multi-select dropdown — lets a filter row pick zero, one, or many
// values instead of forcing a single native <SearchableSelect> choice.
function MultiSelectDropdown({ placeholder = 'All', options = [], selected = [], onChange }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  const normalizedOptions = useMemo(
    () => options.map((opt) => (opt && typeof opt === 'object' ? opt : { value: opt, label: String(opt) })),
    [options]
  );
  const query = search.trim().toLowerCase();
  const filteredOptions = query
    ? normalizedOptions.filter((opt) => opt.label.toLowerCase().includes(query))
    : normalizedOptions;

  const toggleAll = () => onChange([]);
  const toggleOption = (value) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  const summaryLabel = selected.length === 0
    ? placeholder
    : selected.length === 1
      ? (normalizedOptions.find((o) => String(o.value) === String(selected[0]))?.label ?? String(selected[0]))
      : `${selected.length} selected`;

  return (
    <div className="multi-select-dropdown" ref={containerRef}>
      <button
        type="button"
        className={`filter-select multi-select-trigger${selected.length ? ' has-selection' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>{summaryLabel}</span>
        <Icon name="chevronDown" size={14} className={`multi-select-chevron${open ? ' is-open' : ''}`} />
      </button>
      {open && (
        <div className="multi-select-panel">
          <input
            type="text"
            className="multi-select-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            autoFocus
          />
          <label className="multi-select-option multi-select-all-option">
            <input type="checkbox" checked={selected.length === 0} onChange={toggleAll} />
            <span>- All -</span>
          </label>
          <div className="multi-select-option-list">
            {filteredOptions.map((opt) => (
              <label key={opt.value} className="multi-select-option">
                <input
                  type="checkbox"
                  checked={selected.includes(opt.value)}
                  onChange={() => toggleOption(opt.value)}
                />
                <span>{opt.label}</span>
              </label>
            ))}
            {filteredOptions.length === 0 && <div className="multi-select-empty">No matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// A text input that suggests existing options as you type, and — when
// nothing matches — offers to add whatever was typed as a brand new one.
// The catalog it's editing (fault categories, maintenance types) is meant
// to grow with real use instead of being a fixed, admin-curated list; the
// backend persists new values the same way, so anyone who adds one here
// finds it waiting in the dropdown next time, everywhere it's offered.
function CreatableSelect({
  value, onChange, options = [], placeholder = 'Select or type to add new', newItemLabel = 'option',
  required = false, catalogEndpoint = null, optionDomain = null,
  // For a catalog whose API doesn't use plain {id, name} — e.g. vehicle
  // categories use {category_id, category_name} — read/write under these
  // keys instead, normalizing to {id, name} internally either way.
  idField = 'id', nameField = 'name',
  // True when the field this drives (e.g. category_id) stores the
  // catalog row's id, not its name — value/onChange deal in ids, and the
  // displayed text is resolved by looking the id up in the catalog.
  valueIsId = false,
  // Extra required fields the create-endpoint needs beyond a bare name
  // (e.g. vehicle categories also require a Domain) — rendered as simple
  // selects in the add-new modal, merged into the POST body.
  extraFields = [],
}) {
  const { user: currentUser } = useContext(AuthContext);
  const abilityPrefix = ({ '/categories': 'vehicle_type', '/hubs': 'hub' })[catalogEndpoint] ?? 'catalog';
  const canEditCatalogItems = canDo(currentUser, abilityPrefix + '.edit');
  const canDeleteCatalogItems = canDo(currentUser, abilityPrefix + '.delete');
  const createAbility = ({
    '/categories': 'vehicle_type.create',
    '/hubs': 'hub.create',
    '/reported-persons': 'issue.create',
  })[catalogEndpoint] ?? 'catalog.create';
  const canCreateCatalogItems = !catalogEndpoint || canDo(currentUser, createAbility);
  // Accepts either a plain name string (the simple catalogs) or a raw API
  // row keyed by idField/nameField (e.g. vehicle categories) — either way,
  // normalized to one {id, name} shape everything below works with.
  const normalizeItem = useCallback((raw) => (
    typeof raw === 'string' ? { id: null, name: raw } : { ...raw, id: raw[idField] ?? null, name: raw[nameField] }
  ), [idField, nameField]);
  const [open, setOpen] = useState(false);
  // Only holds what's being typed while the panel is open — closed, the
  // input just displays `value` directly, so there's nothing to keep in
  // sync via an effect when the value changes from outside.
  const [draftText, setDraftText] = useState('');
  // {id, name} pairs — seeded from the plain-string `options` prop (ids
  // unknown yet) so the list isn't empty on first render, then replaced
  // with the authoritative version once catalogEndpoint responds. Ids are
  // what make per-row delete possible; a bare string list (no catalog
  // backing) just never shows a delete button.
  const [catalogItems, setCatalogItems] = useState(() => options.map(normalizeItem));
  // Non-null while the "complete new item" modal is open — holds its own
  // editable Name field, seeded from what was typed but not locked to it,
  // same as the reference add-new-Company flow (a real little form, not
  // just a yes/no confirmation of the raw typed text).
  const [addModalName, setAddModalName] = useState(null);
  // Non-null while the modal above is in EDIT mode instead of ADD mode —
  // holds the raw {id, name} item being renamed. Shares the same
  // addModalName/addModalExtra/addModalError/addSaving state as add, since
  // it's the same little form either way; only the submit target differs.
  const [editTarget, setEditTarget] = useState(null);
  // Values for `extraFields` (e.g. Domain), keyed by field name.
  const [addModalExtra, setAddModalExtra] = useState({});
  const [addModalError, setAddModalError] = useState(null);
  const [addSaving, setAddSaving] = useState(false);
  const [addedMessage, setAddedMessage] = useState(null);
  // The item pending the delete confirmation modal — a real, permanent
  // removal (it disappears from this list for everyone), so it gets the
  // same "are you sure" step as any other destructive action in the app.
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  useEscapeKey(Boolean(deleteTarget) && !deleteBusy, useCallback(() => setDeleteTarget(null), []));
  // True right after opening (via focus), before the user has actually
  // typed anything — the input still shows the current value, but the
  // option list is NOT filtered by it, so reopening an already-picked
  // field shows the full catalog instead of just the one exact match
  // (which used to look like every other option had vanished).
  const [justOpened, setJustOpened] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!catalogEndpoint) return;
    let cancelled = false;
    api.get(catalogEndpoint).then((res) => {
      if (!cancelled) setCatalogItems(res.data.map(normalizeItem));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [catalogEndpoint, normalizeItem]);

  // Refresh sibling dropdowns after catalog changes.
  useEffect(() => {
    if (!catalogEndpoint) return;
    const refresh = ({ detail }) => {
      if (detail.endpoint !== catalogEndpoint) return;
      setCatalogItems((items) => {
        const remaining = items.filter((item) => item.id !== detail.item.id && item.name !== detail.previous?.name && item.name !== detail.item.name);
        return (detail.deleted ? remaining : [...remaining, detail.item]).sort((a, b) => a.name.localeCompare(b.name));
      });
      const selected = valueIsId ? String(value) === String(detail.item.id) : value === (detail.previous?.name ?? detail.item.name);
      if (selected && detail.deleted) onChange(valueIsId ? null : '');
      else if (selected && detail.previous && !valueIsId) onChange(detail.item.name);
    };
    window.addEventListener('vms:catalog-change', refresh);
    return () => window.removeEventListener('vms:catalog-change', refresh);
  }, [catalogEndpoint, value, valueIsId, onChange]);

  const announceChange = (item, previous = null, deleted = false) => {
    window.dispatchEvent(new CustomEvent('vms:catalog-change', { detail: { endpoint: catalogEndpoint, item, previous, deleted } }));
  };

  useEffect(() => {
    if (!addedMessage) return;
    const timer = setTimeout(() => setAddedMessage(null), 2600);
    return () => clearTimeout(timer);
  }, [addedMessage]);

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  // When the driven field stores an id (valueIsId), resolve it to a name
  // for display — `value` itself is never text in that mode.
  const selectedItem = valueIsId ? catalogItems.find((o) => String(o.id) === String(value)) : null;
  const displayText = valueIsId ? (selectedItem?.name ?? '') : (value ?? '');
  const text = open ? draftText : displayText;
  const query = justOpened ? '' : text.trim().toLowerCase();
  const domainItems = optionDomain == null ? catalogItems : catalogItems.filter((item) => item.domain === optionDomain);
  const filtered = query ? domainItems.filter((o) => o.name.toLowerCase().includes(query)) : domainItems;
  const hasExactMatch = catalogItems.some((o) => o.name.toLowerCase() === query);
  const canAddNew = canCreateCatalogItems && query.length > 0 && !hasExactMatch;

  const openPanel = () => {
    setDraftText(displayText);
    setJustOpened(true);
    setOpen(true);
  };
  const pick = (item) => {
    onChange(valueIsId ? item.id : item.name);
    setOpen(false);
  };
  const openAddModal = (name) => {
    setEditTarget(null);
    setAddModalName(name);
    // Extra fields can carry a sensible default from context (e.g. Domain
    // pre-filled to match the vehicle already being filled out) — still
    // shown and changeable, just not blank by default.
    setAddModalExtra(Object.fromEntries(extraFields.map((f) => [f.name, f.default ?? ''])));
    setAddModalError(null);
    setOpen(false);
  };
  // Preserve additional fields when renaming a catalog entry.
  const openEditModal = (item) => {
    setEditTarget(item);
    setAddModalName(item.name);
    setAddModalExtra(Object.fromEntries(extraFields.map((f) => [f.name, item[f.name] ?? f.default ?? ''])));
    setAddModalError(null);
    setOpen(false);
  };
  const newItemTitle = newItemLabel.replace(/\b\w/g, (c) => c.toUpperCase());
  const saveAddModal = async (e) => {
    e.preventDefault();
    // React portals bubble synthetic events through the component tree, not
    // the DOM tree — without this, submitting this modal's form (portaled
    // to document.body) also fires the outer page's own <form onSubmit>,
    // since CreatableSelect is nested inside it there.
    e.stopPropagation();
    const val = addModalName.trim();
    if (!val) {
      setAddModalError('Name is required.');
      return;
    }
    const missingExtra = extraFields.find((f) => f.required && (addModalExtra[f.name] ?? '') === '');
    if (missingExtra) {
      setAddModalError(`${missingExtra.label} is required.`);
      return;
    }

    if (editTarget) {
      setAddSaving(true);
      try {
        const res = await api.put(`${catalogEndpoint}/${editTarget.id}`, { [nameField]: val, ...addModalExtra });
        const updated = normalizeItem(res.data);
        announceChange(updated, editTarget);
        setCatalogItems((items) => items
          .map((i) => (i.id === editTarget.id ? updated : i))
          .sort((a, b) => a.name.localeCompare(b.name)));
        // Renamed item was the one already selected — plain-string mode
        // (valueIsId false) stores the name itself, so it has to follow the
        // rename or the field would keep showing text that's no longer a
        // real option. valueIsId mode needs nothing here; the id didn't change.
        if (!valueIsId && value === editTarget.name) {
          onChange(updated.name);
        }
        setEditTarget(null);
        setAddModalName(null);
        setAddModalError(null);
        setAddedMessage(`"${editTarget.name}" renamed to "${updated.name}".`);
      } catch (err) {
        setAddModalError(err?.response?.data?.message || 'Something went wrong — please try again.');
      } finally {
        setAddSaving(false);
      }
      return;
    }

    if (!catalogEndpoint) {
      pick({ id: null, name: val });
      setAddModalName(null);
      setAddModalError(null);
      setAddedMessage(`"${val}" added as a new ${newItemLabel}.`);
      return;
    }
    setAddSaving(true);
    try {
      const res = await api.post(catalogEndpoint, { [nameField]: val, ...addModalExtra });
      const created = normalizeItem(res.data);
      announceChange(created);
      setCatalogItems((items) => {
        const withoutDupe = items.filter((i) => i.name.toLowerCase() !== created.name.toLowerCase());
        return [...withoutDupe, created].sort((a, b) => a.name.localeCompare(b.name));
      });
      pick(created);
      setAddModalName(null);
      setAddModalError(null);
      setAddedMessage(`"${created.name}" added as a new ${newItemLabel}.`);
    } catch (err) {
      setAddModalError(err?.response?.data?.message || 'Something went wrong — please try again.');
    } finally {
      setAddSaving(false);
    }
  };
  const closeAddModal = () => {
    setAddModalName(null);
    setAddModalError(null);
    setEditTarget(null);
  };
  const confirmDelete = async () => {
    setDeleteBusy(true);
    try {
      await api.delete(`${catalogEndpoint}/${deleteTarget.id}`);
      announceChange(deleteTarget, null, true);
      setCatalogItems((items) => items.filter((i) => i.id !== deleteTarget.id));
      const wasSelected = valueIsId ? String(value) === String(deleteTarget.id) : value === deleteTarget.name;
      if (wasSelected) onChange(valueIsId ? null : '');
      setDeleteTarget(null);
      setDeleteError(null);
    } catch (err) {
      setDeleteError(err?.response?.data?.message || 'Something went wrong — please try again.');
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="creatable-select" ref={containerRef}>
      <input
        type="text"
        value={text}
        placeholder={placeholder}
        required={required}
        onFocus={openPanel}
        onChange={(e) => { setDraftText(e.target.value); setJustOpened(false); if (!open) setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || !open) return;
          // Enter inside the list means "choose what I typed" — never "submit the form".
          e.preventDefault();
          const exact = domainItems.find((o) => o.name.toLowerCase() === query);
          if (exact) pick(exact);
          else if (filtered.length === 1) pick(filtered[0]);
          else if (canAddNew) openAddModal(text.trim());
        }}
      />
      {open && (
        <div className="creatable-select-panel">
          {canCreateCatalogItems && !canAddNew && (
            <button type="button" className="creatable-select-option creatable-select-add creatable-select-add-pinned" onClick={() => openAddModal('')}>
              <Icon name="plus" size={13} /> Add New {newItemTitle}
            </button>
          )}
          <div className="creatable-select-option-list">
            {filtered.map((o) => (
              <div key={o.id ?? o.name} className="creatable-select-option-row">
                <button type="button" className="creatable-select-option" onClick={() => pick(o)}>
                  {o.name}
                </button>
                {catalogEndpoint && (canEditCatalogItems || canDeleteCatalogItems) && o.id != null && (
                  <>
                    {canEditCatalogItems && (
                      <button
                        type="button"
                        className="creatable-select-option-edit"
                        onClick={(e) => { e.stopPropagation(); openEditModal(o); }}
                        title={`Rename ${o.name}`}
                        aria-label={`Rename ${o.name}`}
                      >
                        <Icon name="edit" size={12} />
                      </button>
                    )}
                    {canDeleteCatalogItems && <button
                      type="button"
                      className="creatable-select-option-delete"
                      onClick={(e) => { e.stopPropagation(); setDeleteTarget(o); setDeleteError(null); }}
                      title={`Remove ${o.name}`}
                      aria-label={`Remove ${o.name}`}
                    >
                      <Icon name="trash" size={12} />
                    </button>}
                  </>
                )}
              </div>
            ))}
            {filtered.length === 0 && !canAddNew && <div className="multi-select-empty">No matches</div>}
          </div>
          {canAddNew && (
            <button type="button" className="creatable-select-option creatable-select-add" onClick={() => openAddModal(text.trim())}>
              <Icon name="plus" size={13} /> Add "{text.trim()}" as a new {newItemLabel}
            </button>
          )}
        </div>
      )}
      <FormModal open={addModalName !== null} title={editTarget ? `Rename ${newItemTitle}` : `Add New ${newItemTitle}`} onClose={closeAddModal}>
        <form className="smart-form" onSubmit={saveAddModal} noValidate>
          {addModalError && (
            <div className="form-feedback" onClick={() => setAddModalError(null)}>
              <div className="qa-inline-error" role="alert" onClick={(e) => e.stopPropagation()}>
                <Icon name="alert" size={17} className="toast-notice-icon" />
                <div className="toast-notice-lines"><span>{addModalError}</span></div>
                <button type="button" className="toast-notice-close" onClick={() => setAddModalError(null)} aria-label="Dismiss">
                  <Icon name="close" size={13} />
                </button>
              </div>
            </div>
          )}
          <label>
            <span>Name <span className="required-asterisk">*</span></span>
            <input type="text" required autoFocus value={addModalName ?? ''} onChange={(e) => setAddModalName(e.target.value)} />
          </label>
          {extraFields.map((f) => (
            <label key={f.name}>
              <span>{f.label} {f.required && <span className="required-asterisk">*</span>}</span>
              {f.type === 'number' ? (
                <input
                  type="number"
                  step="any"
                  required={f.required}
                  placeholder={f.placeholder}
                  value={addModalExtra[f.name] ?? ''}
                  onChange={(e) => setAddModalExtra((cur) => ({ ...cur, [f.name]: e.target.value }))}
                />
              ) : (
                <SearchableSelect
                  required={f.required}
                  value={addModalExtra[f.name] ?? ''}
                  onChange={(e) => setAddModalExtra((cur) => ({ ...cur, [f.name]: e.target.value }))}
                >
                  <option value="" disabled>{' '}</option>
                  {f.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </SearchableSelect>
              )}
            </label>
          ))}
          <div className="form-actions">
            <button className="ghost-button" type="button" onClick={closeAddModal} disabled={addSaving}>Cancel</button>
            <button className="primary-button" type="submit" disabled={addSaving}>{addSaving ? 'Saving…' : (editTarget ? 'Save Changes' : 'Save')}</button>
          </div>
        </form>
      </FormModal>
      {deleteTarget && createPortal(
        <div className="confirm-overlay" onClick={() => !deleteBusy && setDeleteTarget(null)}>
          <section className="confirm-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-icon" aria-hidden="true">
              <Icon name="alert" size={20} />
            </div>
            <div className="confirm-dialog-copy">
              <p className="eyebrow">Confirmation</p>
              <h3>Remove {newItemTitle}</h3>
              <p>Remove "{deleteTarget.name}" from this list? It disappears for everyone — options used by saved records cannot be removed.</p>
              {deleteError && <p style={{ color: '#b91c1c', fontWeight: 600, marginTop: 8 }}>{deleteError}</p>}
            </div>
            <div className="confirm-dialog-actions">
              <button className="ghost-button" disabled={deleteBusy} onClick={() => setDeleteTarget(null)} type="button">Cancel</button>
              <button className="danger-button" disabled={deleteBusy} onClick={confirmDelete} type="button">
                {deleteBusy ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </section>
        </div>,
        document.body
      )}
      {addedMessage && createPortal(
        <div className="toast-notice success" role="alert">
          <div className="toast-notice-body">
            <Icon name="checkCircle" size={16} />
            <span>{addedMessage}</span>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// Popup-modal version of the "+ Add New Issue…" field on the Maintenance
// Record form. Opens immediately (lazy initial state, not an effect — no
// extra click on an inline trigger first) and only asks for Issue Type;
// Description/Severity aren't asked twice — submitFormPage fills those in
// from the outer form's own Problem/Reason field and a default severity.
// Writes new_issue_type plus a truthy sentinel on its own field name (so
// SmartForm's generic required-field check has something to check) via one
// onChange patch — nothing downstream needs to know it came from a modal.
function NewIssueModalField({ value, onChange, issueTypeOptions = [] }) {
  const hasValue = !!value?.new_issue_type;
  const [open, setOpen] = useState(() => !hasValue);
  const [draft, setDraft] = useState(() => value?.new_issue_type ?? '');
  const [error, setError] = useState(null);

  const openModal = () => {
    setDraft(value?.new_issue_type ?? '');
    setError(null);
    setOpen(true);
  };

  // Cancelling out of a first-time add (nothing saved yet) reverts the
  // Related Issue Report dropdown back to blank instead of leaving the
  // field group stranded with no value and no visible way back in.
  const cancel = () => {
    if (!hasValue) onChange({ issue_report_id: '' });
    setOpen(false);
  };

  const save = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draft.trim()) {
      setError('Issue Type is required.');
      return;
    }
    onChange({ new_issue_type: draft.trim(), __new_issue_group__: 1 });
    setOpen(false);
  };

  return (
    <>
      {hasValue && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 12px', border: '1px solid var(--border-subtle, #e2e8f0)', borderRadius: 8 }}>
          <strong>{value.new_issue_type}</strong>
          <button type="button" className="ghost-button" onClick={openModal} style={{ flexShrink: 0 }}>Edit</button>
        </div>
      )}
      <FormModal open={open} title="Add New Issue" onClose={cancel}>
        <form className="smart-form new-issue-form" onSubmit={save} noValidate>
          {error && (
            <div className="form-feedback" onClick={() => setError(null)}>
              <div className="qa-inline-error" role="alert" onClick={(e) => e.stopPropagation()}>
                <Icon name="alert" size={17} className="toast-notice-icon" />
                <div className="toast-notice-lines"><span>{error}</span></div>
                <button type="button" className="toast-notice-close" onClick={() => setError(null)} aria-label="Dismiss">
                  <Icon name="close" size={13} />
                </button>
              </div>
            </div>
          )}
          <label>
            <span>Issue Type <span className="required-asterisk">*</span></span>
            <CreatableSelect
              value={draft}
              onChange={setDraft}
              options={issueTypeOptions}
              newItemLabel="issue type"
              catalogEndpoint="/fault-categories"
              required
            />
          </label>
          <div className="form-actions">
            <button className="ghost-button" type="button" onClick={cancel}>Cancel</button>
            <button className="primary-button" type="submit">Save</button>
          </div>
        </form>
      </FormModal>
    </>
  );
}

function FilterBar({
  categories = [],
  vehicles = [],
  filterCategory,
  setFilterCategory,
  filterCapacity,
  setFilterCapacity,
  filterStatus,
  setFilterStatus,
  filterPriority,
  setFilterPriority,
  statusOptions = [],
  priorityOptions = [],
  priorityLabel = "Priority",
  statusLabel = "Status",
  trailing,
  statusControls,
  filterLocation,
  setFilterLocation,
  filterDomain,
  setFilterDomain,
  // Extra module-specific dropdowns beyond the standard six — each applies
  // immediately (no "Filter" click needed), unlike the staged fields above.
  // Shape: [{ key, label, options, selected, setSelected }].
  extraFilters = [],
  // Optional date-range pair (also applies immediately as typed).
  dateRange = null,
}) {
  // Extract unique capacities dynamically
  const capacities = useMemo(() => {
    const caps = new Set();
    vehicles.forEach((v) => {
      if (v.capacity) {
        caps.add(v.capacity.trim());
      }
    });
    return Array.from(caps).sort();
  }, [vehicles]);

  const locations = useMemo(() => {
    const locs = new Set();
    vehicles.forEach((v) => {
      if (v.current_location) locs.add(v.current_location.trim());
    });
    return Array.from(locs).sort();
  }, [vehicles]);

  const domains = useMemo(() => {
    const doms = new Set();
    categories.forEach((c) => { if (c.domain) doms.add(c.domain); });
    return Array.from(doms).sort();
  }, [categories]);

  // Draft selections — only applied to the table when "Filter" is clicked.
  // Each field is an array now, so a dropdown can hold zero, one, or many values.
  const [draft, setDraft] = useState({
    category: filterCategory ?? [],
    capacity: filterCapacity ?? [],
    status: filterStatus ?? [],
    priority: filterPriority ?? [],
    location: filterLocation ?? [],
    domain: filterDomain ?? [],
  });

  // Keep the draft in sync when applied filters are reset externally
  // (e.g. switching modules clears all filters).
  const fleetFilterKey = JSON.stringify([filterCategory, filterCapacity, filterStatus, filterPriority, filterLocation, filterDomain]);
  const [previousFleetFilterKey, setPreviousFleetFilterKey] = useState(fleetFilterKey);
  if (previousFleetFilterKey !== fleetFilterKey) {
    setPreviousFleetFilterKey(fleetFilterKey);
    setDraft({
      category: filterCategory ?? [],
      capacity: filterCapacity ?? [],
      status: filterStatus ?? [],
      priority: filterPriority ?? [],
      location: filterLocation ?? [],
      domain: filterDomain ?? [],
    });

  }

  const isDirty = !sameSelection(draft.category, filterCategory ?? [])
    || !sameSelection(draft.capacity, filterCapacity ?? [])
    || !sameSelection(draft.status, filterStatus ?? [])
    || !sameSelection(draft.priority, filterPriority ?? [])
    || !sameSelection(draft.location, filterLocation ?? [])
    || !sameSelection(draft.domain, filterDomain ?? []);

  const applyFilters = () => {
    setFilterCategory(draft.category);
    setFilterCapacity(draft.capacity);
    setFilterStatus(draft.status);
    if (setFilterPriority) setFilterPriority(draft.priority);
    if (setFilterLocation) setFilterLocation(draft.location);
    if (setFilterDomain) setFilterDomain(draft.domain);
  };

  const extraFiltersJsx = extraFilters.map((f) => (
    <div className="filter-date-group" key={f.key}>
      <span>{f.label}</span>
      <MultiSelectDropdown
        placeholder={`All ${f.label}`}
        options={f.options}
        selected={f.selected}
        onChange={f.setSelected}
      />
    </div>
  ));

  const dateRangeJsx = dateRange && (
    <>
      <div className="filter-date-group">
        <span>From Date</span>
        <DateFilterInput value={dateRange.start || '2026-01-01'} onChange={dateRange.setStart} />
      </div>
      <div className="filter-date-group">
        <span>To Date</span>
        <DateFilterInput value={dateRange.end || '2026-12-31'} onChange={dateRange.setEnd} />
      </div>
    </>
  );

  return (
    <div className="filter-bar-container">
      <div className="filter-label">
        <span>Filters:</span>
      </div>

      {/* Category Dropdown */}
      <div className="filter-date-group">
        <span>Category</span>
        <MultiSelectDropdown
          placeholder="All Categories"
          options={categories.map((cat) => ({ value: String(cat.category_id), label: cat.category_name }))}
          selected={draft.category}
          onChange={(vals) => setDraft((d) => ({ ...d, category: vals }))}
        />
      </div>

      {/* Capacity Dropdown */}
      <div className="filter-date-group">
        <span>Capacity</span>
        <MultiSelectDropdown
          placeholder="All Capacities"
          options={capacities}
          selected={draft.capacity}
          onChange={(vals) => setDraft((d) => ({ ...d, capacity: vals }))}
        />
      </div>

      {/* Status Dropdown */}
      {statusOptions && statusOptions.length > 0 && (
        <div className="filter-date-group">
          <span>{statusLabel}</span>
          <MultiSelectDropdown
            placeholder={`All ${pluralizeLabel(statusLabel)}`}
            options={statusOptions}
            selected={draft.status}
            onChange={(vals) => setDraft((d) => ({ ...d, status: vals }))}
          />
        </div>
      )}

      {/* Priority / Severity / Condition Dropdown */}
      {priorityOptions && priorityOptions.length > 0 && (
        <div className="filter-date-group">
          <span>{priorityLabel}</span>
          <MultiSelectDropdown
            placeholder={`All ${pluralizeLabel(priorityLabel)}`}
            options={priorityOptions}
            selected={draft.priority}
            onChange={(vals) => setDraft((d) => ({ ...d, priority: vals }))}
          />
        </div>
      )}

      {/* Location/Domain — only Vehicle Management passes their setters. */}
      {setFilterLocation && (
        <div className="filter-date-group">
          <span>Location</span>
          <MultiSelectDropdown
            placeholder="All Locations"
            options={locations}
            selected={draft.location}
            onChange={(vals) => setDraft((d) => ({ ...d, location: vals }))}
          />
        </div>
      )}
      {setFilterDomain && (
        <div className="filter-date-group">
          <span>Domain</span>
          <MultiSelectDropdown
            placeholder="All Domains (Land/Water)"
            options={domains}
            selected={draft.domain}
            onChange={(vals) => setDraft((d) => ({ ...d, domain: vals }))}
          />
        </div>
      )}

      {/* Extra module-specific dropdowns and the date range apply
          immediately, not staged. */}
      {extraFiltersJsx}
      {dateRangeJsx}

      {statusControls}

      {/* Apply Filter button */}
      <button
        type="button"
        className="filter-apply-btn"
        onClick={applyFilters}
        disabled={!isDirty}
      >
        Filter
      </button>

      {trailing && <div className="filter-bar-trailing">{trailing}</div>}
    </div>
  );
}

function LocalSearchInput({ value, onChange, placeholder = "Search...", onExport, onAdd, addLabel = "Add", columnChooser }) {
  return (
    <div className="local-search-bar">
      <div className="local-search-container">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="local-search-icon">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="local-search-input"
          aria-label={placeholder.replace(/\.+$/, '')}
        />
        {value && (
          <button className="local-search-clear" onClick={() => onChange('')} type="button" title="Clear search" aria-label="Clear search">
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
      {columnChooser && <ColumnChooserButton {...columnChooser} />}
      {onAdd && (
        <button className="icon-add-btn has-label" onClick={onAdd} type="button" title={addLabel} aria-label={addLabel}>
          <Icon name="plus" size={18} />
          <span className="icon-add-btn-label">{addLabel}</span>
        </button>
      )}
      {onExport && (
        <button className="export-btn" onClick={onExport} type="button" title="Export to CSV" aria-label="Export to CSV">
          <Icon name="download" size={15} />
        </button>
      )}
    </div>
  );
}

// Persists which columns a table shows and in what order, per browser (one
// localStorage entry per `storageKey`, so e.g. Vehicle Management's choices
// don't bleed into a different table reusing this same hook later).
// `allColumns` must be a stable array of {key, label, locked?, ...} — `key`
// is the identity persisted to storage, `locked` (e.g. ID/Action) hides the
// checkbox instead of letting a table lose its own row identifier or
// actions. Returns the already order-applied, hidden-filtered array to pass
// straight into DataTable/PaginatedTable's `columns` prop.
function useColumnChooser(storageKey, allColumns) {
  const columnKeys = allColumns.map((c) => c.key);
  // Real deps for the effect below — a plain array literal would be a new
  // reference (and re-run the effect) every render even when unchanged.
  const columnKeysSignature = columnKeys.join('|');

  const [order, setOrder] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`${storageKey}_order`) ?? 'null');
      if (Array.isArray(saved) && saved.length) {
        const stillValid = saved.filter((k) => columnKeys.includes(k));
        const newOnes = columnKeys.filter((k) => !stillValid.includes(k));
        return [...stillValid, ...newOnes];
      }
    } catch { /* fall through to default order */ }
    return columnKeys;
  });
  const [hidden, setHidden] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`${storageKey}_hidden`) ?? '[]');
      return new Set(Array.isArray(saved) ? saved.filter((k) => columnKeys.includes(k)) : []);
    } catch {
      return new Set();
    }
  });

  // Keeps a saved preference from a previous session in sync if the column
  // set itself changes shape later (e.g. the role-gated Action column
  // appearing/disappearing) — drops keys that no longer exist, appends any
  // new ones at the end rather than silently hiding them.
  const columnStateKey = JSON.stringify([columnKeysSignature]);
  const [previousColumnStateKey, setPreviousColumnStateKey] = useState(columnStateKey);
  if (previousColumnStateKey !== columnStateKey) {
    setPreviousColumnStateKey(columnStateKey);
    setOrder((prev) => {
      const stillValid = prev.filter((k) => columnKeys.includes(k));
      const newOnes = columnKeys.filter((k) => !stillValid.includes(k));
      return newOnes.length || stillValid.length !== prev.length ? [...stillValid, ...newOnes] : prev;
    });
    setHidden((prev) => {
      const next = new Set([...prev].filter((k) => columnKeys.includes(k)));
      return next.size === prev.size ? prev : next;
    });

  }

  useEffect(() => {
    try { localStorage.setItem(`${storageKey}_order`, JSON.stringify(order)); } catch { /* storage unavailable */ }
  }, [storageKey, order]);
  useEffect(() => {
    try { localStorage.setItem(`${storageKey}_hidden`, JSON.stringify([...hidden])); } catch { /* storage unavailable */ }
  }, [storageKey, hidden]);

  const toggleColumn = (key) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  // `side` ('before' | 'after') lets the table header's own drag handler
  // place a column on whichever side of the drop target the cursor was
  // actually over (matching the drop-line indicator DataTable draws there)
  // — the popover's simpler row list never passes it, so it keeps its
  // original "insert at the target's position" behavior.
  const reorderColumn = (dragKey, dropKey, side = 'before') => {
    if (dragKey === dropKey) return;
    setOrder((prev) => {
      const next = [...prev];
      const from = next.indexOf(dragKey);
      if (from === -1) return prev;
      next.splice(from, 1);
      let to = next.indexOf(dropKey);
      if (to === -1) return prev;
      if (side === 'after') to += 1;
      next.splice(to, 0, dragKey);
      return next;
    });
  };
  const resetColumns = () => {
    setOrder(columnKeys);
    setHidden(new Set());
  };

  const byKey = new Map(allColumns.map((c) => [c.key, c]));
  // The Action column always sits at the far end — a saved column order from
  // before a new column existed (it gets appended) must not leave Action in
  // the middle of the row.
  const isActionKey = (k) => k === 'action' || k === 'actions';
  const orderedKeys = [...order.filter((k) => !isActionKey(k)), ...order.filter(isActionKey)];
  const visibleColumns = orderedKeys.map((k) => byKey.get(k)).filter((c) => c && !hidden.has(c.key));

  return { allColumns, order: orderedKeys, hidden, toggleColumn, reorderColumn, resetColumns, visibleColumns };
}

// Toolbar trigger + popover for picking which columns a table shows and
// reordering them by drag — spread straight from useColumnChooser's return
// value as <ColumnChooserButton {...chooser} />.
function ColumnChooserButton({ allColumns, order, hidden, toggleColumn, reorderColumn, resetColumns }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const dragKeyRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleOutsideClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  const byKey = new Map(allColumns.map((c) => [c.key, c]));
  const orderedColumns = order.map((k) => byKey.get(k)).filter(Boolean);
  const query = search.trim().toLowerCase();
  const filtered = query ? orderedColumns.filter((c) => c.label.toLowerCase().includes(query)) : orderedColumns;
  // Dragging to reorder only makes sense against the full, unfiltered list —
  // disabled while a search is narrowing the rows shown, same reasoning
  // CreatableSelect's own filtered list uses.
  const dragEnabled = !query;

  return (
    <div className="column-chooser" ref={containerRef}>
      <button
        type="button"
        className={`export-btn${open ? ' is-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Choose columns"
        aria-label="Choose columns"
      >
        <Icon name="columns" size={16} />
      </button>
      {open && (
        <div className="column-chooser-panel" role="dialog" aria-label="Choose columns">
          <div className="column-chooser-head">
            <h4>Choose Columns</h4>
            <button type="button" className="toast-notice-close" onClick={() => setOpen(false)} aria-label="Close">
              <Icon name="close" size={13} />
            </button>
          </div>
          <div className="column-chooser-search">
            <Icon name="search" size={13} />
            <input type="text" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="column-chooser-list">
            {filtered.map((col) => (
              <div
                key={col.key}
                className="column-chooser-row"
                draggable={dragEnabled}
                onDragStart={() => { dragKeyRef.current = col.key; }}
                onDragOver={(e) => { if (dragEnabled) e.preventDefault(); }}
                onDrop={() => {
                  if (dragEnabled && dragKeyRef.current) reorderColumn(dragKeyRef.current, col.key);
                  dragKeyRef.current = null;
                }}
              >
                <span className={`column-chooser-grip${dragEnabled ? '' : ' is-disabled'}`} aria-hidden="true">
                  <Icon name="gripVertical" size={14} />
                </span>
                <label className="column-chooser-checkbox">
                  <input
                    type="checkbox"
                    checked={!hidden.has(col.key)}
                    disabled={col.locked}
                    onChange={() => toggleColumn(col.key)}
                  />
                  <span>{col.label}</span>
                </label>
              </div>
            ))}
            {filtered.length === 0 && <p className="column-chooser-empty">No columns match &quot;{search}&quot;.</p>}
          </div>
          <div className="column-chooser-foot">
            <button type="button" className="link-button" onClick={resetColumns}>Reset to default</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default Workspace;
