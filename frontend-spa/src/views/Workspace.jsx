import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, createContext, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import api from '../api/axios';
import LocationDensityMap from '../components/LocationDensityMap';
import VehicleLocationMap from '../components/VehicleLocationMap';
import AddLocationMap from '../components/AddLocationMap';
import Icon from '../components/Icon';
import TextType from '../components/TextType';
import WorkspaceFooter from '../components/WorkspaceFooter';
import ConfirmDialog from '../components/ConfirmDialog';
import { DonutChart, SolidPieChart, HorizontalBarChart, ColumnChart, StackedBarChart } from '../components/charts';
import { AuthContext } from '../context/AuthContextObject';
import { groupLocationRowsByHub, PAKNAAN_POLYGON } from '../data/paknaanLocationDensity';
import { geoJsonToRings, isPointWithinBoundaryRings } from '../utils/boundary';
import { geocodeAddress, reverseGeocode } from '../utils/geocode';

const FormNoticeContext = createContext(null);
// Lets shared table cells (VehicleCell, UserAvatarName) open the right detail
// view for what was actually clicked — a vehicle cell opens the vehicle, a user
// cell opens that user — instead of the whole row always going to the vehicle.
const RowActionsContext = createContext(null);

// Every value the backend actually stamps onto a Notification.type (see
// notifyAdmins/notifyCustodians/notifyUser call sites in TicketController.php
// and FleetController.php) mapped to the bell dropdown's visual category.
// Driven off this reliable field instead of guessing from the title text.
// Several keys below (inspection_*, work_order_assigned/reassigned,
// repairs_approved, sub_issue_confirmed, ticket_ready_to_close,
// work_order_reopened, sub_issue_deferred) are no longer sent by any live
// code path — their features (inspection, per-sub-issue verify/confirm/
// reassign/defer) were replaced by the one-mechanic-per-ticket workflow.
// Kept here anyway, not pruned: a user's existing notification history may
// still contain rows of these types, and removing the mapping would just
// make old notifications fall back to a plain 'info' style instead of their
// original color.
const NOTIFICATION_STYLE_BY_TYPE = {
  // success — a positive/resolved outcome
  sub_issue_confirmed: 'success',
  repairs_approved: 'success',
  ticket_ready_to_close: 'success',
  ticket_closed: 'success',
  ticket_verified: 'success',
  ticket_approved: 'success',
  cannibalization_approved: 'success',
  schedule_restored: 'success',

  // warning — a rejection, rework, deferral, or reopened/recurring problem
  repairs_rejected: 'warning',
  work_order_reopened: 'warning',
  sub_issue_deferred: 'warning',
  ticket_reopened: 'warning',
  ticket_declined: 'warning',
  cannibalization_rejected: 'warning',
  repair_reopened_for_verification: 'warning',
  recurring_fault: 'warning',

  // info — a neutral assignment/submission with no verdict yet
  ticket_prediagnosed: 'info',
  ticket_proposed: 'info',
  inspection_assigned: 'info',
  inspection_submitted: 'info',
  work_order_assigned: 'info',
  work_order_reassigned: 'info',
  ticket_assigned: 'info',
  ticket_reassigned: 'info',
  repairs_completed: 'info',
  cannibalization_pending: 'info',
  maintenance_recorded: 'info',
  maintenance_verification_withdrawn: 'info',
  schedule_assigned: 'info',
  maintenance_verification_needed: 'info',
};

// Backward-compat only: a notification row created before `type` existed (or
// with a type this map hasn't caught up to yet) has no reliable field to key
// off, so fall back to the old title-sniffing guess rather than mislabeling it.
function legacyNotificationStyleFromTitle(title) {
  if (/confirmed|approved|completed|verified|done/i.test(title)) return 'success';
  if (/reopened|deferred|rejected|sent back/i.test(title)) return 'warning';
  if (/required|assigned|logged|repairs completed/i.test(title)) return 'info';
  if (/failed|error/i.test(title)) return 'error';
  return 'info';
}

function getNotificationStyle(notification) {
  return NOTIFICATION_STYLE_BY_TYPE[notification.type] ?? legacyNotificationStyleFromTitle(notification.title);
}

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
      ['vehicles', 'Vehicle Management'],
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
      ['histories', 'Vehicle History'],
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
      ['conditions', 'Condition Monitoring'],
    ] },
    { section: 'Maintenance', icon: 'calendar', items: [
      ['schedules', 'Maintenance Schedule'],
      // Same single ledger Admin sees now — the separate "Needs
      // Verification" tab/page was removed; a Custodian's Verify action is
      // now a row-level button in this same table (see maintenanceColumns'
      // record.verify branch), matching Admin's "no tabs" reference design.
      ['maintenance', 'Maintenance Records'],
    ] },
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

function Workspace() {
  const navigate = useNavigate();
  const location = useLocation();
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
    || isNewCategoryPage || editCategoryId || isNewSchedulePage || editScheduleId
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
  const moduleGroups = useMemo(() => resolveModuleGroups(user), [user.role, user.roles]);
  const modules = useMemo(() => moduleGroups.flatMap((g) => g.items), [moduleGroups]);
  // A fresh mount (hard refresh, a bookmarked/shared link, opening a new tab)
  // always used to default this to the first sidebar module — losing which
  // ticket/record the URL actually pointed at, since these special sub-pages
  // read their record out of `records[activeModule]`, which is only fetched
  // once loadModule(activeModule) runs. Seeding activeModule from the URL
  // itself (instead of always modules[0]) means that fetch fires for the
  // right module on the very first render, so the page renders instead of
  // sitting blank until the user happens to click the matching sidebar item.
  const [activeModule, setActiveModule] = useState(() => {
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
    if (isNewSchedulePage || editScheduleId) return 'schedules';
    if (isNewIssuePage || editIssueId || viewIssueId) return 'issues';
    if (isNewConditionPage || editConditionId) return 'conditions';
    if (isNewUserPage || editUserId || viewUserId) return 'users';
    if (isNewLocationPage || editLocationVehicleId) return 'locations';
    if (logRepairsTicketId) return 'ticketWorkOrders';
    if (inspectTicketId) return 'ticketInspections';
    return modules[0]?.[0] ?? 'dashboard';
  });
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
  }, []);
  // Same thin-wrapper pattern as My Tasks above, merging Custodian's
  // "Maintenance Status" (records awaiting their verification) and
  // "Maintenance Records" (the full ledger) — same underlying data
  // (GET /maintenance-records), just a different filter, so this is a pure
  // navigation/presentation merge with zero change to either module.
  const [maintenanceLedgerLastTab, setMaintenanceLedgerLastTab] = useState('maintenanceStatus');
  const setMaintenanceLedgerTab = useCallback((key) => {
    setMaintenanceLedgerLastTab(key);
    setActiveModule(key);
  }, []);
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
    : isNewSchedulePage || editScheduleId ? 'schedules'
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
  const [lookups, setLookups] = useState(emptyLookups);
  const [ticketLookups, setTicketLookups] = useState(emptyTicketLookups);
  const [records, setRecords] = useState({});
  const [prefilledScheduleData, setPrefilledScheduleData] = useState(null);
  // Memoized so the object reference stays stable across unrelated re-renders
  // — SmartForm resets its values whenever this reference changes, which
  // would otherwise wipe out whatever the user has already typed.
  const scheduleInitialValues = useMemo(() => (
    editScheduleId
      ? (records.schedules ?? []).find((s) => String(s.schedule_id) === String(editScheduleId))
      // Default to tomorrow — a schedule is always plotted ahead, so this
      // saves a click for the common case; still fully editable.
      : { scheduled_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10), ...(prefilledScheduleData ?? {}) }
  ), [editScheduleId, records.schedules, prefilledScheduleData]);
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
    // The field renders as a single-item checkboxes group (see userFields());
    // that type always stores/reads an array, converted back to a plain
    // boolean on submit (see submitFormPage's 'users' branch).
    return { ...u, can_register_vehicles: u.can_register_vehicles ? ['Allow vehicle registration'] : [] };
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
  // Card/List toggle for Maintenance Records, remembered per browser the same
  // way the Tickets module does it (separate key so the two don't clobber
  // each other). Defaults to the table — these rows carry more columns worth
  // scanning than a ticket does.
  const [maintenanceViewMode, setMaintenanceViewMode] = useState(
    () => localStorage.getItem('vms_maintenance_view') || 'table'
  );
  const changeMaintenanceViewMode = (mode) => {
    setMaintenanceViewMode(mode);
    localStorage.setItem('vms_maintenance_view', mode);
  };
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
  const [historyViewMode, setHistoryViewMode] = useState(
    () => localStorage.getItem('vms_history_view') || 'table'
  );
  const changeHistoryViewMode = (mode) => {
    setHistoryViewMode(mode);
    localStorage.setItem('vms_history_view', mode);
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
    setCompleteScheduleTarget(row);
  };
  const [report, setReport] = useState(null);
  const [notice, setNotice] = useState(null);
  const [vehicleImportOpen, setVehicleImportOpen] = useState(false);
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
  useEffect(() => {
    setHasUnsavedChanges(false);
  }, [location.pathname]);
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
  const [showNotifications, setShowNotifications] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState([]);
  const [filterCapacity, setFilterCapacity] = useState([]);
  const [filterStatus, setFilterStatus] = useState([]);
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

  // Condition Monitoring Filters
  const [condFilterStartDate, setCondFilterStartDate] = useState('');
  const [condFilterEndDate, setCondFilterEndDate] = useState('');
  // Draft for the condition filter bar — applied only on "Filter" click.
  const [condDraft, setCondDraft] = useState({ category: [], status: [], capacity: [], checkedBy: [], start: '', end: '' });
  const [prefilledTicketData, setPrefilledTicketData] = useState(null);
  // A form page that finishes by switching module wants its success notice to
  // survive the module-change reset below.
  const keepNoticeRef = useRef(false);
  // Pre-filled proposal data (from a flagged issue / condition check) only
  // lives while the ticket form is open — leaving it by ANY route (sidebar,
  // back button, submit) drops it so the next form never re-links stale data.
  useEffect(() => {
    if (!isNewTicketPage) setPrefilledTicketData(null);
  }, [isNewTicketPage]);
  const [allHubs, setAllHubs] = useState([]);
  const [locationsTab, setLocationsTab] = useState('map');
  const [selectedMapVehicleId, setSelectedMapVehicleId] = useState(null);
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('theme') || 'light'; } catch { return 'light'; }
  });
  const notificationsRef = useRef(null);
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

  const markNotificationAsRead = async (id) => {
    try {
      await api.put(`/notifications/${id}/read`);
      await loadNotifications();
    } catch (error) {
      console.error('Failed to mark notification as read:', error);
    }
  };

  const markAllNotificationsAsRead = async () => {
    try {
      await api.put('/notifications/read-all');
      await loadNotifications();
    } catch (error) {
      console.error('Failed to mark all as read:', error);
    }
  };

  const deleteNotification = async (id) => {
    try {
      await api.delete(`/notifications/${id}`);
      await loadNotifications();
    } catch (error) {
      console.error('Failed to delete notification:', error);
    }
  };

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

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    loadLookups().catch((error) => showError(error, setNotice));
    loadTicketLookups().catch(() => {});
    loadHubs().catch(() => {});
  }, [loadLookups, loadTicketLookups, loadHubs]);

  useEffect(() => {
    loadNotifications().catch(() => {});
    const interval = setInterval(() => {
      loadNotifications().catch(() => {});
    }, 10000); // Poll every 10 seconds
    return () => clearInterval(interval);
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
      if (notificationsRef.current && !notificationsRef.current.contains(event.target)) {
        setShowNotifications(false);
      }
      if (profileMenuRef.current && !profileMenuRef.current.contains(event.target)) {
        setShowProfileMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    setActiveModule(modules[0]?.[0] ?? 'dashboard');
  }, [modules]);

  useEffect(() => {
     setEditTarget(null);
     setReport(null);
     if (keepNoticeRef.current) keepNoticeRef.current = false; else setNotice(null);
     setSearchQuery('');
     setFilterCategory([]);
     setFilterCapacity([]);
     setFilterStatus([]);
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
     loadModule(activeModule)
       .catch((error) => showError(error, setNotice))
       .finally(() => setLoading(false));
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
        setReport(response.data);
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
      await api.post('/tickets/propose', cleanPayload(payload));
      setNotice({ type: 'success', text: 'Ticket proposal submitted — an Admin will review it.' });
      await refreshCurrent();
      return true;
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
      ticket_title: `[Issue #${issue.issue_report_id}] ${issue.issue_type}`,
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
      await api.delete(`/tickets/${ticket.ticket_id}`);
      setNotice({ type: 'success', text: 'Ticket deleted successfully.' });
      await refreshCurrent();
    } catch (error) {
      showError(error, setNotice);
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

  // Clears a ticket's "unread updates" badge (Maintenance Tickets card/table
  // view) the moment it's opened directly from that list — without this,
  // the badge only ever clears via the notification bell, so opening the
  // ticket itself wouldn't acknowledge the updates you just saw on it.
  // Best-effort: a failed mark-as-read just leaves the badge until the next
  // notifications poll picks it up, not worth surfacing as an error.
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

  const rowActions = useMemo(
    () => ({
      viewVehicle: openVehicleProfile,
      viewTicket: openTicketProfile,
      viewUser: (u) => {
        if (u?.id) navigate(`${roleRoutes[user.role]}/users/${u.id}`, { state: { user: u } });
      },
    }),
    [openVehicleProfile, openTicketProfile, navigate, user.role]
  );

  // Regular sidebar modules never get their own URL — switching between them
  // only flips `activeModule` in local state, so browser history never has a
  // real entry for e.g. "/vehicles". That makes navigate(-1) unreliable after
  // an Add/Edit page: it pops back to whatever real URL happened to precede
  // it (usually just the bare dashboard route), not "the module the user was
  // on". This is the deterministic replacement — go to the base route AND
  // explicitly set the module, instead of trusting history.
  const returnToModule = useCallback((moduleKey, filter) => {
    if (filter !== undefined) setFilterStatus(filter);
    navigate(roleRoutes[user.role]);
    setActiveModule(moduleKey);
  }, [navigate, user.role]);

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
  const approveSchedule = async (target) => {
    setNotice(null);
    try {
      await api.put(`/maintenance-schedules/${target.schedule_id}/approve`);
      await refreshCurrent();
      setNotice({ type: 'success', text: 'Schedule approved.' });
    } catch (error) {
      showError(error, setNotice);
    }
  };
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
      // userFields() renders vehicle-registration delegation as a one-item
      // checkboxes group (array in, array out) purely so it can reuse the
      // generic field renderer — the API wants a plain boolean.
      if (moduleKey === 'users' && Array.isArray(payload.can_register_vehicles)) {
        finalPayload = { ...payload, can_register_vehicles: payload.can_register_vehicles.includes('Allow vehicle registration') };
      }

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
  const rawRows = activeModule === 'ticketWorkOrders'
    ? flattenSubIssueRows(records[activeModule], user.id)
    : activeModule === 'ticketVerifications'
      ? (records[activeModule] ?? []).filter((t) => (
          String(t.assigned_custodian_id) === String(user.id)
          && ['Active', 'For Verification', 'Closed'].includes(t.status)
        ))
      : records[activeModule] ?? [];
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

    if (activeModule === 'schedules' && !filterStatus.length) {
      // Recurring schedules auto-regenerate every time one is completed
      // (Workflow 15), so Completed rows pile up indefinitely otherwise —
      // default view stays to just what's actually upcoming/actionable.
      // Pending Approval is included so a newly-submitted schedule is
      // visible immediately, not just after clicking its stat card — it
      // needs timely action the same way Scheduled rows do. Click the
      // Declined/Completed/Cancelled stat card to see the rest.
      result = result.filter((row) => row.status === 'Scheduled' || row.status === 'Pending Approval');
    }

    if (activeModule === 'schedules' && filterStatus.includes('MyAssigned')) {
      result = result.filter((row) => row.status === 'Scheduled' && String(row.assigned_to) === String(user.id));
    } else if (activeModule === 'schedules' && filterStatus.includes('AwaitingVerification')) {
      result = result.filter((row) => (
        row.status === 'Completed' && row.resulting_maintenance && row.resulting_maintenance.progress_status !== 'Completed'
      ));
    } else if (activeModule === 'schedules' && filterStatus.some((s) => SCHEDULE_URGENCY_KEYS.includes(s))) {
      result = result.filter((row) => filterStatus.includes(scheduleUrgencyBucket(row)));
    } else if (activeModule === 'ticketInspections') {
      result = result.filter((row) => (
        filterStatus.includes('Inspected') ? row.status !== 'Open' : row.status === 'Open'
      ));
    } else if (activeModule === 'ticketWorkOrders') {
      result = result.filter((row) => (
        filterStatus.includes('Submitted') ? row.status !== 'Under Repair' : row.status === 'Under Repair'
      ));
    } else if (activeModule === 'ticketVerifications') {
      // Rows are now tickets, not sub-issues — Active means still being
      // repaired, Pending means waiting at For Verification, Verified means
      // already Closed. No filter selected (Total) shows every one.
      if (filterStatus.includes('Active')) {
        result = result.filter((row) => row.status === 'Active');
      } else if (filterStatus.includes('Verified')) {
        result = result.filter((row) => row.status === 'Closed');
      } else if (filterStatus.includes('Pending')) {
        result = result.filter((row) => row.status === 'For Verification');
      }
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
    } else if (filterStatus.length) {
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
        result = result.filter((row) => filterSource.includes(row.source));
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
      const dateField = activeModule === 'maintenance' ? 'date_started'
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
          return filterStatus.includes(row.condition_result);
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
  }, [rawRows, searchQuery, filterCategory, filterCapacity, filterLocation, filterDomain, filterStatus, filterPriority, filterReadiness, filterIssueType, filterMaintType, filterSource, filterActive, filterAssignedTo, filterVerdict, filterCheckedBy, filterActivityType, filterVehicle, filterMechanic, filterCustodian, filterDateStart, filterDateEnd, activeModule, condFilterStartDate, condFilterEndDate, archiveStart, archiveEnd, archiveStatusFilter]);

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
    const base = countByValues(records.schedules ?? [], (r) => r.status, ['Pending Approval', 'Declined', 'Scheduled', 'Completed', 'Cancelled']);
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
    // How soon each still-scheduled row is due — same buckets the top-row
    // urgency cards show and filter by (see scheduleUrgencyBucket).
    const urgency = { Overdue: 0, Due1to3: 0, Due4to7: 0, Due8plus: 0 };
    (records.schedules ?? []).forEach((r) => {
      const bucket = scheduleUrgencyBucket(r);
      if (bucket) urgency[bucket] += 1;
    });
    return { ...base, ...urgency, AwaitingVerification: awaitingVerification, MyAssigned: myAssigned };
  }, [records.schedules, user.id]);

  // A vehicle with no check on file yet is its own bucket ("Not Checked"),
  // not just an absence from the list — so the stat cards (and the list
  // below) reflect the whole fleet's coverage, not only vehicles someone
  // has gotten around to inspecting.
  const conditionRowsForStats = useMemo(() => {
    const vehiclesWithRecord = new Set((records.conditions ?? []).map((r) => r.vehicle_id));
    const uncheckedRows = (lookups.vehicles ?? [])
      .filter((vehicle) => !vehiclesWithRecord.has(vehicle.vehicle_id))
      .map(() => ({ condition_result: 'Not Checked' }));
    return [...(records.conditions ?? []), ...uncheckedRows];
  }, [records.conditions, lookups.vehicles]);

  const conditionStats = useMemo(
    () => countByValues(conditionRowsForStats, (r) => r.condition_result, ['Good', 'Needs Inspection', 'Needs Repair', 'Not Checked']),
    [conditionRowsForStats]
  );

  const maintenanceRecordStats = useMemo(
    () => countByValues(records.maintenance ?? [], (r) => r.progress_status, ['Assigned', 'Under Repair', 'For Verification', 'Completed']),
    [records.maintenance]
  );

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
    const rows = flattenSubIssueRows(records.ticketWorkOrders, user.id);
    const pending = rows.filter((r) => r.status === 'Under Repair').length;
    return { total: rows.length, Pending: pending, Submitted: rows.length - pending };
  }, [records.ticketWorkOrders, user.id]);

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
  const vehicleColumnDefs = useMemo(
    () => vehicleColumns(user, (row) => openVehicleProfile(row, 'edit'), deleteRecord, restoreRecord, filterStatus, openTicketProfile, (row) => setReadinessPromptTarget(row)),
    [user, openVehicleProfile, deleteRecord, restoreRecord, filterStatus, openTicketProfile],
  );
  const vehicleColumnChooser = useColumnChooser('vms_vehicle_columns', vehicleColumnDefs);

  // Every other module's table gets the same Choose Columns / drag-to-reorder
  // treatment as Vehicle Management above — one useColumnChooser call per
  // table, hoisted up here (not inside renderModule's per-module branches)
  // because hooks can't run conditionally; renderModule only executes the
  // branch matching the current activeModule.
  const categoryColumnDefs = useMemo(
    () => categoryColumns((row) => navigate(`${roleRoutes[user.role]}/categories/${row.category_id}/edit`), deleteRecord),
    [navigate, user.role, deleteRecord],
  );
  const categoryColumnChooser = useColumnChooser('vms_category_columns', categoryColumnDefs);

  const userColumnDefs = useMemo(
    () => userColumns((row) => navigate(`${roleRoutes[user.role]}/users/${row.id}/edit`), toggleUserActive, user.id),
    [navigate, user.role, toggleUserActive, user.id],
  );
  const userColumnChooser = useColumnChooser('vms_user_columns', userColumnDefs);

  const locationColumnChooser = useColumnChooser('vms_location_columns', locationTableColumns);

  const conditionColumnDefs = useMemo(
    () => conditionColumns(
      user,
      (row) => navigate(`${roleRoutes[user.role]}/conditions/${row.condition_check_id}/edit`),
      deleteRecord,
      handleCreateTicketFromCondition,
      handleSuggestScheduleFromCondition,
      canDo(user, 'condition.create') ? (row) => {
        setPrefilledConditionVehicleId(row.vehicle_id);
        navigate(`${roleRoutes[user.role]}/conditions/new`);
      } : undefined,
    ),
    [user, navigate, deleteRecord, handleCreateTicketFromCondition, handleSuggestScheduleFromCondition],
  );
  const conditionColumnChooser = useColumnChooser('vms_condition_columns', conditionColumnDefs);

  const issueColumnDefs = useMemo(
    () => issueColumns(user.role, (row) => navigate(`${roleRoutes[user.role]}/issues/${row.issue_report_id}/edit`), handleCreateTicketFromIssue, setUserInfoTarget, (row) => navigate(`${roleRoutes[user.role]}/issues/${row.issue_report_id}`), deleteRecord, user, openTicketProfile, setDismissIssueTarget),
    [user, navigate, handleCreateTicketFromIssue, deleteRecord, openTicketProfile],
  );
  const issueColumnChooser = useColumnChooser('vms_issue_columns', issueColumnDefs);

  const maintenanceColumnDefs = useMemo(
    () => maintenanceColumns(user.role, (row) => navigate(`${roleRoutes[user.role]}/maintenance/${row.maintenance_id}/edit`), updateRecord, (row) => navigate(`${roleRoutes[user.role]}/maintenance/${row.maintenance_id}`), user),
    [user, navigate, updateRecord],
  );
  const maintenanceColumnChooser = useColumnChooser('vms_maintenance_columns', maintenanceColumnDefs);

  const maintenanceStatusColumnDefs = useMemo(
    () => maintenanceStatusColumns(setEditTarget, user.id),
    [user.id],
  );
  const maintenanceStatusColumnChooser = useColumnChooser('vms_maintenance_status_columns', maintenanceStatusColumnDefs);

  const scheduleColumnDefs = useMemo(
    () => scheduleColumns((row) => navigate(`${roleRoutes[user.role]}/schedules/${row.schedule_id}/edit`), deleteRecord, openCompleteSchedule, user, (row) => navigate(`${roleRoutes[user.role]}/maintenance/${row.resulting_maintenance_id}`), restoreRecord, setReassignScheduleTarget, openTicketProfile, approveSchedule, setDeclineScheduleTarget),
    [navigate, user, deleteRecord, restoreRecord],
  );
  const scheduleColumnChooser = useColumnChooser('vms_schedule_columns', scheduleColumnDefs);

  const vehicleHistoryColumnChooser = useColumnChooser('vms_vehicle_history_columns', historyColumns);

  const logColumnDefs = useMemo(
    () => logColumns(lookups.vehicles, openVehicleProfile, openTicketProfile),
    [lookups.vehicles, openVehicleProfile, openTicketProfile],
  );
  const logColumnChooser = useColumnChooser('vms_activity_log_columns', logColumnDefs);

  const archiveColumnDefs = useMemo(() => [
    ...ticketArchiveColumns,
    {
      key: 'actions',
      label: 'Actions',
      locked: true,
      className: 'cell-center',
      render: (row) => {
        if (row.final_status === 'Deleted') {
          return (
            <div className="row-actions">
              <button
                className="btn-reopen-action icon-btn"
                type="button"
                title="Reopen Ticket"
                aria-label="Reopen Ticket"
                onClick={() => {
                  setConfirmDialog({
                    title: 'Reopen Deleted Ticket',
                    message: `Are you sure you want to reopen Ticket #${row.ticket_id} for ${row.vehicle_name}? It will be restored with all its sub-issues to how they were before it was deleted.`,
                    confirmLabel: 'Reopen Ticket',
                    variant: 'primary',
                    onConfirm: () => ticketAction(`/ticket-archives/${row.archive_id}/reopen`, {}, 'Ticket successfully reopened.'),
                  });
                }}
              >
                <Icon name="undo" size={14} />
              </button>
            </div>
          );
        }
        // A Closed ticket is permanently locked (no Reopen), but its
        // record still exists — the Admin can still open it read-only
        // to see the full history of what was done.
        if (row.final_status === 'Closed') {
          return (
            <div className="row-actions">
              <button
                className="btn-view-action icon-btn"
                type="button"
                title="View Ticket"
                aria-label="View Ticket"
                onClick={() => openTicketProfile({ ticket_id: row.ticket_id })}
              >
                <Icon name="eye" size={14} />
              </button>
            </div>
          );
        }
        return <span className="muted">—</span>;
      },
    },
  ], [setConfirmDialog, openTicketProfile]);
  const archiveColumnChooser = useColumnChooser('vms_ticket_archive_columns', archiveColumnDefs);

  const unreadCount = notifications.filter((n) => !n.read_at).length;

  const toggleSidebar = () => {
    setIsSidebarCollapsed((prev) => !prev);
  };

  // DEV-ONLY impersonation — a fast way to switch accounts while testing,
  // without logging out and back in. import.meta.env.DEV is compile-time, so
  // this entire block (and its UI below) is stripped from a production build;
  // the backend also 404s the endpoint outside local/testing.
  //
  // Deliberately reuses the map boundary selector's own Province/Barangay
  // dropdowns below (mapProvinceId/mapBarangayId) instead of adding its own
  // — one barangay picker driving two things is simpler than two pickers
  // sitting side by side doing almost the same job.
  const [impersonateCandidates, setImpersonateCandidates] = useState([]);
  const [impersonateId, setImpersonateId] = useState(user?.id ?? '');
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    api.get('/impersonate/candidates').then((r) => setImpersonateCandidates(r.data)).catch(() => {});
    // Re-fetch whenever the Users list itself refreshes (add/edit/delete a
    // user) — otherwise a newly-created account never appears here until a
    // full page reload, since this effect would otherwise only ever run once
    // on mount.
  }, [records.users]);
  // {key, label, users[]} per barangay — key matches mapBarangayId's value
  // so the same dropdown selection resolves which staff list to show here.
  const impersonateGroups = useMemo(() => {
    const groups = {};
    impersonateCandidates.forEach((u) => {
      const key = String(u.barangay_id ?? '');
      const label = u.province_name && u.barangay_name ? `${u.province_name} — ${u.barangay_name}` : 'Unassigned';
      (groups[key] ??= { label, users: [] }).users.push(u);
    });
    return Object.entries(groups).map(([key, g]) => ({ key, ...g }));
  }, [impersonateCandidates]);
  const doImpersonate = async () => {
    if (!impersonateId) return;
    try {
      // Phase A5 — a reason is now required on every impersonation, even
      // this dev-only shortcut; a fixed one keeps the "quick account
      // switch while testing" flow frictionless instead of adding another
      // field to a tool that's already stripped out of production.
      const res = await api.post(`/impersonate/${impersonateId}`, { reason: 'Dev testing (local impersonate control)' });
      // Stash the acting account's own token before it's overwritten below —
      // otherwise there was no way back into it short of logging out and back
      // in. Keyed off role so "Return to..." can route straight to the right
      // dashboard without an extra round-trip to figure out who they were.
      const ownToken = localStorage.getItem('token');
      if (ownToken) {
        localStorage.setItem('impersonator_token', ownToken);
        localStorage.setItem('impersonator_name', user.name);
        localStorage.setItem('impersonator_role', user.role);
      }
      localStorage.setItem('token', res.data.access_token);
      sessionStorage.removeItem('token');
      // Full reload → axios picks up the new token and AuthContext reloads the
      // impersonated user cleanly (no stale state from the previous account).
      window.location.assign(roleRoutes[res.data.user?.role] ?? '/admin');
    } catch {
      setNotice({ type: 'error', text: 'Could not impersonate that account.' });
    }
  };
  // Vehicle Location map boundary selector — lets an Admin swap which
  // barangay outline the map draws. Scoped to Province + Barangay only
  // (no City/Municipality step) since Mandaue City is the only city with
  // real per-barangay boundary data today — defaults to Cebu so the
  // Barangay dropdown is immediately usable. This is purely cosmetic:
  // hubs/vehicles aren't scoped by barangay, so switching only changes the
  // drawn outline + camera framing, not which hubs/vehicles show.
  const [mapProvinces, setMapProvinces] = useState([]);
  const [mapProvinceId, setMapProvinceId] = useState('');
  const [mapBarangays, setMapBarangays] = useState([]);
  const [mapBarangayId, setMapBarangayId] = useState('');
  const [mapBoundaryOverride, setMapBoundaryOverride] = useState(null);
  // Same "what counts as inside the service area" boundary the map draws,
  // recomputed here so the Add Location form can reject a geocoded address
  // that falls outside it — mirrors LocationDensityMap's own fallback (the
  // hardcoded Paknaan outline when no barangay override is selected, or the
  // override has no boundary geometry on file).
  const locationBoundaryRings = useMemo(() => {
    const overrideRings = geoJsonToRings(mapBoundaryOverride?.geometry);
    return overrideRings.length ? overrideRings : [PAKNAAN_POLYGON];
  }, [mapBoundaryOverride]);
  const locationBoundaryLabel = mapBoundaryOverride?.label ?? 'Paknaan';
  // Guards the one-time "default to Paknaan" seed below from re-firing on a
  // second effect invocation (React's dev-only StrictMode double-invokes
  // effects on mount) — without this, a second run would call
  // loadBarangaysForProvince(cebu.id, 'Paknaan') again.
  const mapDefaultAppliedRef = useRef(false);
  // The bigger race: that seed is 2 sequential API calls deep (province ->
  // barangay list -> boundary fetch), slow enough on the local dev server
  // that an admin can pick a real barangay from the dropdown WHILE it's
  // still in flight. When it finally resolves, it must not overwrite a
  // selection made in the meantime — this ref is the source of truth for
  // "has the admin touched this dropdown themselves".
  const userPickedBarangayRef = useRef(false);

  // DEV-only: the same two dropdowns also drive Impersonate below, so a
  // barangay with registered staff but no boundary polygon (anything other
  // than Paknaan today) still needs to show up here, not just barangays
  // the map can actually draw. Merged in, never replacing the boundary-
  // sourced list — production keeps working with zero impersonation data.
  const provinceOptions = useMemo(() => {
    const byId = new Map(mapProvinces.map((p) => [String(p.id), p]));
    impersonateCandidates.forEach((u) => {
      if (u.province_id && !byId.has(String(u.province_id))) {
        byId.set(String(u.province_id), { id: u.province_id, name: u.province_name });
      }
    });
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [mapProvinces, impersonateCandidates]);
  const barangayOptions = useMemo(() => {
    const byId = new Map(mapBarangays.map((b) => [String(b.id), b]));
    impersonateCandidates.forEach((u) => {
      if (u.barangay_id && String(u.province_id) === String(mapProvinceId) && !byId.has(String(u.barangay_id))) {
        byId.set(String(u.barangay_id), { id: u.barangay_id, name: u.barangay_name });
      }
    });
    // Guarantee the currently-selected barangay always has an entry — in
    // production, impersonateCandidates above is always empty (that merge
    // is dev-only), so a barangay outside Mandaue City (the only city with
    // a real /barangays/registered list) would otherwise vanish from its
    // own dropdown the moment it's selected, e.g. every non-Paknaan admin
    // landing on their own barangay by default.
    if (mapBarangayId && !byId.has(String(mapBarangayId)) && mapBoundaryOverride?.label) {
      byId.set(String(mapBarangayId), { id: mapBarangayId, name: mapBoundaryOverride.label });
    }
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [mapBarangays, impersonateCandidates, mapProvinceId, mapBarangayId, mapBoundaryOverride]);
  // Keeps the Impersonate staff dropdown valid for whichever barangay is
  // currently selected above — re-runs whenever the barangay changes or the
  // candidate list itself first loads.
  const impersonateGroupUsers = impersonateGroups.find((g) => g.key === String(mapBarangayId))?.users ?? [];
  useEffect(() => {
    const stillValid = impersonateGroupUsers.some((u) => String(u.id) === String(impersonateId));
    if (!stillValid) {
      // The barangay/candidate chain resolves over several async calls, so
      // this can fire once against a still-loading (wrong) group before
      // landing on the real one. Falling back to "whoever's first" there
      // would silently pick a coworker instead of yourself — prefer your
      // own account if it's in this group at all, only falling further
      // back to "first" when you genuinely aren't a candidate here.
      const self = impersonateGroupUsers.find((u) => String(u.id) === String(user.id));
      setImpersonateId(self?.id ?? impersonateGroupUsers[0]?.id ?? '');
    }
    // impersonateGroupUsers is a derived array (new reference every render);
    // keying off mapBarangayId/impersonateCandidates instead avoids re-running
    // this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapBarangayId, impersonateCandidates]);

  // Fetches one barangay's boundary and sets it as the map override.
  const selectBarangayBoundary = useCallback(async (barangayId) => {
    if (!barangayId) { setMapBoundaryOverride(null); return; }
    try {
      const res = await api.get(`/barangays/${barangayId}`);
      // Always carry the picked barangay's own name, even when it has no
      // boundary polygon on file (only Mandaue City barangays do today) —
      // otherwise the map silently falls back to Paknaan's shape AND label,
      // which reads as "the dropdown did nothing" instead of "no data yet".
      // Qualified with the city name whenever we have one — several
      // barangay names repeat across neighboring cities (e.g. "Banilad"
      // exists in both Mandaue City and Cebu City), so a bare name on the
      // map reads as ambiguous, or worse, as the wrong city's barangay.
      const label = res.data.city_name ? `${res.data.name}, ${res.data.city_name}` : res.data.name;
      setMapBoundaryOverride({ geometry: res.data.boundary ?? null, label });
    } catch {
      setMapBoundaryOverride(null);
    }
  }, []);

  // Loads the barangays that actually have a registered user (plus Paknaan,
  // always included — the system's built-in home barangay) for the one
  // city within a province that has a registered barangay list. Which city
  // that is comes straight from `/provinces/with-barangays`'
  // `city_with_barangays_id` (see ProvinceController::withBarangays) rather
  // than being re-derived here — this used to search the province's city
  // list for one literally named "Mandaue City", which only worked because
  // that was the sole seeded example; a second city with real barangay data
  // in any province would have silently produced an empty dropdown. A
  // province with no such city (falsy `cityId`) simply ends up with an
  // empty Barangay dropdown. `defaultBarangayName` pre-selects a barangay
  // once the list loads — used to land on Paknaan on first load.
  const loadBarangaysForProvince = useCallback(async (cityId, defaultBarangayName) => {
    if (!cityId) {
      setMapBarangays([]);
      return;
    }
    try {
      const barangaysRes = await api.get('/barangays/registered', { params: { city_id: cityId } });
      setMapBarangays(barangaysRes.data);

      // Skip applying the default if the admin has already picked a real
      // barangay themselves while this chain was still in flight — this
      // check happens as late as possible (right before acting on it) so
      // it catches a pick made at any point during the 3-call chain above.
      const defaultBarangay = defaultBarangayName && !userPickedBarangayRef.current
        ? barangaysRes.data.find((b) => b.name === defaultBarangayName)
        : null;
      if (defaultBarangay) {
        setMapBarangayId(String(defaultBarangay.id));
        selectBarangayBoundary(defaultBarangay.id);
      }
    } catch {
      setMapBarangays([]);
    }
  }, [selectBarangayBoundary]);

  useEffect(() => {
    // Narrower than the registration form's /provinces — only provinces
    // that actually have registered barangay/boundary data, so the
    // dropdown doesn't list 80+ provinces with nothing behind them.
    api.get('/provinces/with-barangays').then((response) => {
      setMapProvinces(response.data);
      const cebu = response.data.find((p) => p.name === 'Cebu');
      if (cebu) {
        setMapProvinceId(String(cebu.id));
        if (!mapDefaultAppliedRef.current) {
          mapDefaultAppliedRef.current = true;
          // Land every admin on THEIR OWN barangay by default, not always
          // Paknaan — that hardcoded default only ever made sense back when
          // Paknaan was the only barangay in the system. Falls back to
          // Paknaan only for an account with no barangay of its own (there
          // isn't one today, but this keeps old behavior as the fallback).
          if (user.barangay_id && !userPickedBarangayRef.current) {
            setMapBarangayId(String(user.barangay_id));
            selectBarangayBoundary(user.barangay_id);
            loadBarangaysForProvince(cebu.city_with_barangays_id, null);
          } else {
            loadBarangaysForProvince(cebu.city_with_barangays_id, 'Paknaan');
          }
        } else {
          // Still populate the barangay list for this province — just
          // don't re-seed the default selection over a real one.
          loadBarangaysForProvince(cebu.city_with_barangays_id, null);
        }
      }
    }).catch(() => {});
  }, [loadBarangaysForProvince, selectBarangayBoundary, user.barangay_id]);

  const handleMapProvinceChange = (e) => {
    userPickedBarangayRef.current = true;
    const provinceId = e.target.value;
    setMapProvinceId(provinceId);
    setMapBarangayId('');
    setMapBoundaryOverride(null);
    setMapBarangays([]);
    if (provinceId) {
      const province = mapProvinces.find((p) => String(p.id) === String(provinceId));
      loadBarangaysForProvince(province?.city_with_barangays_id ?? null);
    }
  };

  const handleMapBarangayChange = (e) => {
    userPickedBarangayRef.current = true;
    const barangayId = e.target.value;
    setMapBarangayId(barangayId);
    selectBarangayBoundary(barangayId);
  };

  // Sidebar badge for a given module key — 'myTasks' has no badge_counts
  // entry of its own (it's not a real module), so it's the sum of the two
  // real queues it groups. Shared by each row's own badge and by a
  // collapsed group header's summed badge below.
  const badgeCountFor = (key) => (
    key === 'myTasks'
      ? (dashboard?.badge_counts?.ticketVerifications ?? 0)
      : (dashboard?.badge_counts?.[key] ?? 0)
  );

  return (
    <FormNoticeContext.Provider value={notice}>
    <RowActionsContext.Provider value={rowActions}>
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
            <Icon name="gear" size={28} className="topbar-gear-icon" filled />
            <span className="vms-wordmark vms-wordmark-sm">vms</span>
          </div>
          <div className="map-boundary-selector" title="Choose which registered barangay outline the Vehicle Location map draws.">
            <select
              aria-label="Map boundary province"
              onChange={handleMapProvinceChange}
              value={mapProvinceId}
            >
              {provinceOptions.map((province) => (
                <option key={province.id} value={province.id}>{province.name}</option>
              ))}
            </select>
            <select
              aria-label="Map boundary barangay"
              disabled={barangayOptions.length === 0}
              onChange={handleMapBarangayChange}
              value={mapBarangayId}
            >
              {barangayOptions.length > 0 ? (
                barangayOptions.map((barangay) => (
                  <option key={barangay.id} value={barangay.id}>{barangay.name}</option>
                ))
              ) : (
                <option value="">No registered barangay</option>
              )}
            </select>
          </div>
          {import.meta.env.DEV && impersonateGroupUsers.length > 0 && (
            <div className="dev-impersonate" title="Dev only — switch account without logging out. Not present in production. Staff list follows the barangay picked above.">
              <select value={impersonateId} onChange={(e) => setImpersonateId(e.target.value)} aria-label="Impersonate account">
                {impersonateGroupUsers.map((u) => (
                  <option key={u.id} value={u.id} disabled={!u.is_active}>
                    {u.name} · {u.role}{u.is_active ? '' : ' (inactive)'}
                  </option>
                ))}
              </select>
              <button type="button" onClick={doImpersonate}>Impersonate</button>
            </div>
          )}
        </div>

        <div className="topbar-right">
          {/* The Return control now lives in the persistent banner below the
              topbar (Phase A5) — a single, more visible home for it instead
              of duplicating the button here too. */}
          {/* No bell in the top bar — the list opens from the profile
              menu's "Notifications" item. */}
          <div className="notifications-dropdown-container" ref={notificationsRef}>
            {showNotifications && (
              <div className="notifications-dropdown">
                <div className="notifications-header">
                  <h4>Notifications</h4>
                  {unreadCount > 0 && (
                    <button type="button" onClick={markAllNotificationsAsRead}>Mark all as read</button>
                  )}
                </div>
                <div className="notifications-list">
                  {notifications.length === 0 ? (
                    <div className="notifications-empty">
                      <span style={{ display: 'inline-flex', opacity: 0.6 }}><Icon name="bell" size={26} /></span>
                      <span>No notifications yet.</span>
                    </div>
                  ) : (
                    notifications.map((n) => {
                      const notificationType = getNotificationStyle(n);
                      return (
                      <div
                        key={n.notification_id}
                        className={`notification-item notification-${notificationType} ${!n.read_at ? 'unread' : ''}`}
                        onClick={async () => {
                          await markNotificationAsRead(n.notification_id);
                          // Production-readiness audit finding #10 — open the
                          // exact record this notification is about, not just
                          // mark it read and leave the user where they were.
                          if (n.ticket_id) {
                            openTicketProfile({ ticket_id: n.ticket_id });
                          } else if (n.issue_report_id) {
                            navigate(`${roleRoutes[user.role]}/issues/${n.issue_report_id}`);
                          } else if (n.vehicle_id) {
                            navigate(`${roleRoutes[user.role]}/vehicles/${n.vehicle_id}`);
                          } else if (n.schedule_id) {
                            // Not every role that can receive this (e.g. a
                            // Maintenance Personnel assignee) holds
                            // schedule.edit — land on the shared list instead
                            // of a specific /edit page that could redirect
                            // them away.
                            returnToModule('schedules');
                          }
                          setShowNotifications(false);
                        }}
                      >
                        <div className="notification-content">
                          <span className="notification-title">{n.title}</span>
                          <span className="notification-msg">{n.message}</span>
                          <span className="notification-time">{formatDate(n.created_at)}</span>
                      </div>
                      <div className="notification-actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          className="notification-close-btn"
                          type="button"
                          title="Delete notification"
                          onClick={() => deleteNotification(n.notification_id)}
                        >
                          <Icon name="close" size={14} />
                        </button>
                      </div>
                    </div>
                    );
                    })
                )}
              </div>
            </div>
          )}
        </div>

        <button
          className="icon-btn theme-toggle-btn"
          type="button"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label="Toggle light and dark mode"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        >
          {theme === 'dark' ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>

        <div className="profile-menu-container" ref={profileMenuRef}>
          <ProfileMenu
            user={user}
            open={showProfileMenu}
            setOpen={setShowProfileMenu}
            onLogout={handleLogout}
            onOpenNotifications={() => setShowNotifications(true)}
            onOpenSettings={() => navigate(`${roleRoutes[user.role]}/profile`)}
          />
        </div>
      </div>
      </header>

      <main className={`workspace${isSidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
        <aside className={`sidebar${isSidebarCollapsed ? ' collapsed' : ''}`}>
          <nav className="module-nav" aria-label="Workspace modules">
            {moduleGroups.map(({ section, items }) => {
              const renderItem = ([key, label]) => {
                const badgeCount = badgeCountFor(key);
                // Admin's "Maintenance Tickets" badge (badge_counts.tickets)
                // already counts every non-Closed/Cancelled ticket, Pending
                // Approval proposals included — adding ticketProposals on top
                // would double-count them. Shown as its own small pill
                // instead, so "N open tickets" and "M awaiting your review"
                // stay two distinct, addable-up-in-your-head signals.
                // 'ticketPropose' isn't a real module (no list view/endpoint
                // of its own) — it's a direct link straight to the Propose
                // Ticket form, same URL Admin's own Create Ticket flow uses.
                // Every other item here just flips `activeModule` in place.
                const isDirectRouteLink = key === 'ticketPropose';
                // 'myTasks' also isn't a real module — clicking it jumps
                // straight to whichever of its three tabs was last open
                // (see setMyTasksTab / myTasksLastTab above).
                const isMyTasksContainer = key === 'myTasks';
                // 'maintenanceLedger' is the same kind of thin wrapper —
                // jumps to whichever of its two tabs was last open (see
                // setMaintenanceLedgerTab / maintenanceLedgerLastTab above).
                const isMaintenanceLedgerContainer = key === 'maintenanceLedger';
                return (
                  <button
                    className={key === breadcrumbModule ? 'active' : ''}
                    key={key}
                    onClick={() => guardedNavigate(() => {
                      if (isDirectRouteLink) {
                        navigate(`${roleRoutes[user.role]}/tickets/new`);
                        return;
                      }
                      if (isMyTasksContainer) {
                        setMyTasksTab(myTasksLastTab);
                      } else if (isMaintenanceLedgerContainer) {
                        setMaintenanceLedgerTab(maintenanceLedgerLastTab);
                      } else {
                        // 'workTracker' used to also be a plain sidebar row
                        // (Maintenance Personnel's standalone "Work Tracker"
                        // entry) reached via this generic click path — that
                        // row is gone now (folded into 'ticketWorkOrders'
                        // own Archive toggle), so no sidebar button sets
                        // activeModule to 'workTracker' through here anymore.
                        // This branch is kept, harmlessly unreachable, rather
                        // than special-cased away — My Tasks' own "History"
                        // tab still sets 'workTracker' exclusively through
                        // setMyTasksTab (see the tab bar below), which always
                        // keeps workTrackerViaMyTasks true.
                        if (key === 'workTracker') setWorkTrackerViaMyTasks(false);
                        // 'reportOrPropose' is a relabeled alias for the
                        // Issue Reports list — its "Report Vehicle Issue" and
                        // "Propose Ticket" actions both live inline there.
                        setActiveModule(key === 'reportOrPropose' ? 'issues' : key);
                      }
                      if (isOnSpecialPage) {
                        navigate(roleRoutes[user.role]);
                      }
                    })}
                    title={isSidebarCollapsed ? label : undefined}
                    type="button"
                  >
                    {moduleIcons[key]}
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

        <section className="content-area">
          {/* Dashboard has its own greeting banner right below (name, role,
              date) — this generic icon+title bar would just repeat "Dashboard"
              redundantly above it, so it's skipped for that one page only. */}
          {(activeModule !== 'dashboard' || isOnSpecialPage) && (
            <div className="page-heading-row">
              <span className="page-heading-icon">{moduleIcons[breadcrumbModule]}</span>
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
          <div className="toast-notice-overlay" onClick={() => setNotice(null)}>
            <div className="toast-notice toast-notice-validation error" role="alert" onClick={(e) => e.stopPropagation()}>
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
                    Ticket #{t.ticket_id}{t.ticket_title ? ` — ${t.ticket_title}` : ''}
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
              boundaryRings={locationBoundaryRings}
              boundaryLabel={locationBoundaryLabel}
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
              boundaryRings={locationBoundaryRings}
              boundaryLabel={locationBoundaryLabel}
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
                  keepNoticeRef.current = true;
                  returnToModule(hasReportOrProposeNav ? 'issues' : 'workTracker');
                }}
                ticketLookups={ticketLookups}
                prefilledTicketData={prefilledTicketData}
                onProposeTicket={proposeTicket}
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
            <VehicleProfilePage
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
              canViewUsage={canDo(user, 'usage.view')}
              canLogUsage={canDo(user, 'usage.log')}
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
            <TicketProfilePage
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
            <MaintenanceRecordProfilePage
              maintenanceId={maintenanceProfileId}
              canManage={hasRole(user, 'Admin')}
              onConfirm={(r) => updateRecord(`/maintenance-records/${r.maintenance_id}/confirm`, { confirmed: true }, 'Maintenance confirmed.')}
              onReopen={(r) => updateRecord(`/maintenance-records/${r.maintenance_id}/confirm`, { confirmed: false }, 'Maintenance reopened.')}
              onDecisionClose={(r, payload) => updateRecord(`/maintenance-records/${r.maintenance_id}/decision-close`, payload, 'Record closed without verification.')}
            />
          ) : (isNewCategoryPage || editCategoryId) ? (
            <>
            <FormPage
              description="Maintain standard vehicle type choices used across dropdowns."
              onBack={() => returnToModule('categories')}
              fields={categoryFields}
              initialValues={editCategoryId ? (records.categories ?? []).find((c) => String(c.category_id) === String(editCategoryId)) : EMPTY_OBJ}
              onSubmit={(payload) => submitFormPage('categories', editCategoryId ? { category_id: editCategoryId } : null, payload)}
              submitLabel={editCategoryId ? 'Update Type' : 'Add Type'}
              wrapperClassName="category-form-grid"
              categoryVehicleCount={editCategoryId ? (records.categories ?? []).find((c) => String(c.category_id) === String(editCategoryId))?.vehicles_count : null}
              onDirty={() => setHasUnsavedChanges(true)}
              showDomainPreview
            />
            {editCategoryId && canDo(user, 'vehicle_type.edit') && (
              <CategoryFieldsManager categoryId={editCategoryId} onChanged={loadLookups} />
            )}
            </>
          ) : (isNewSchedulePage || editScheduleId) ? (
            <FormPage
              description="Plan preventative maintenance and track schedule status."
              onBack={() => { setPrefilledScheduleData(null); returnToModule('schedules'); }}
              fields={scheduleFields(lookups, allHubs, Boolean(editScheduleId), !editScheduleId && !canDo(user, 'schedule.create'))}
              initialValues={scheduleInitialValues}
              onSubmit={(payload) => submitFormPage('schedules', editScheduleId ? { schedule_id: editScheduleId } : null, payload)}
              submitLabel={editScheduleId ? 'Update Schedule' : (canDo(user, 'schedule.create') ? 'Add Schedule' : 'Send Suggestion')}
              contextVehicles={lookups.vehicles}
              hubs={allHubs}
              onDirty={() => setHasUnsavedChanges(true)}
            />
          ) : viewIssueId ? (
            <>
              <IssueViewPage
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
              fields={conditionFields(lookups)}
              initialValues={conditionInitialValues}
              onSubmit={(payload) => submitFormPage('conditions', editConditionId ? { condition_check_id: editConditionId } : null, payload)}
              submitLabel={editConditionId ? 'Update Condition' : 'Record Condition'}
              contextVehicles={lookups.vehicles}
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
            <FormPage
              description="Create and manage user accounts — Admin, Custodian, and Maintenance Personnel."
              onBack={() => returnToModule('users')}
              fields={(vals) => userFields(Boolean(editUserId), vals)}
              initialValues={editUserInitialValues}
              onSubmit={(payload) => submitFormPage('users', editUserId ? { id: editUserId } : null, payload)}
              submitLabel={editUserId ? 'Update User' : 'Add User'}
              wrapperClassName="user-form-grid"
              onDirty={() => setHasUnsavedChanges(true)}
            />
          ) : logRepairsTicketId ? (
            <LogRepairsPage
              key={flattenSubIssueRows(records.ticketWorkOrders).some((r) => String(r.ticket_id) === String(logRepairsTicketId) && String(r.sub_issue_id) === String(logRepairsSubIssueId)) ? 'ready' : 'loading'}
              ticket={flattenSubIssueRows(records.ticketWorkOrders).find((r) => String(r.ticket_id) === String(logRepairsTicketId) && String(r.sub_issue_id) === String(logRepairsSubIssueId))}
              vehicleOptions={lookups.vehicles ?? []}
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
                { label: 'Date Completed', name: 'date_completed', type: 'date' },
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
                  accept: 'image/*,.pdf',
                  // Final senior system review (2026-10-05, §2) — only the
                  // assigned Maintenance Personnel can even open this modal
                  // now, and a receipt/photo is evidence only; it never skips
                  // the Custodian check, for anyone.
                  hint: 'Attach a receipt or a photo of the completed repair so the Custodian verifying this has proof.',
                },
                { label: 'Notes (what was done)', name: 'notes', type: 'textarea', rows: 2 },
              ]}
              key={`complete-${completeScheduleTarget.schedule_id}`}
              initialValues={{ date_completed: new Date().toISOString().slice(0, 10) }}
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
            <span className="count-badge">{dashboard.badge_counts.ticketVerifications}</span>
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
          description={((hasRole(user, 'Custodian') && !hasRole(user, 'Admin')) ? 'View-only fleet information.' : 'Register, edit, and archive vehicle records.') + ' Status = availability (can it be dispatched right now?). Condition = physical state (does it need repair or inspection?). Click a row to see full vehicle details.'}
          statCards={
            <ModuleStatCards
              totalLabel="Total Vehicles"
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
              onImport={canDo(user, 'vehicle.import') && canRegisterVehicles(user) ? () => setVehicleImportOpen(true) : undefined}
              onExport={() => exportRowsToCsv('vehicles.csv', VEHICLE_EXPORT_COLUMNS, visibleRows)}
            />
          </div>
          <PaginatedTable columns={vehicleColumnChooser.visibleColumns} rows={visibleRows} onRowClick={openVehicleProfile} onReorderColumn={vehicleColumnChooser.reorderColumn} emptyMessage="No vehicles here yet — click the + button to register one." />
          <VehicleImportModal open={vehicleImportOpen} onClose={() => setVehicleImportOpen(false)} onImported={refreshCurrent} />
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
      return (
        <ModulePanel
          description="Maintain standard vehicle type choices used across dropdowns."
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 14px', marginBottom: 14, border: '1px solid var(--border-subtle, #e2e8f0)', borderRadius: 8 }}>
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
          <ModulePanel description="Record current vehicle stationing and keep a location history.">
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
                    onRowClick={(row) => row.vehicle && openVehicleProfile(row.vehicle)}
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
            <ModuleStatCards
              totalLabel="Total Records"
              total={conditionStats.total}
              cards={CONDITION_STAT_CARDS}
              counts={conditionStats}
              activeFilter={filterStatus}
              onFilterChange={setFilterStatus}
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
                  options={['Good', 'Needs Inspection', 'Needs Repair', 'Not Checked']}
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
              onRowClick={(row) => row.vehicle && openVehicleProfile(row.vehicle)}
              renderSubRow={(row) => row.observations}
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
              <LatestIssueCard issues={records.issues ?? []} onRowClick={(row) => row.vehicle && openVehicleProfile(row.vehicle)} />
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
            emptyMessage="No issues reported — the fleet has no open problems right now."
            rows={visibleRows}
            onRowClick={(row) => row.vehicle && openVehicleProfile(row.vehicle)}
          />
        </ModulePanel>
      );
    }

    if (activeModule === 'maintenance') {
      return (
        <>
        <ModulePanel
          tabBar={maintenanceLedgerTabBar}
          description="Directly log external, historical, or third-party vehicle maintenance records and expenses without running the full ticket workflow."
          statCards={
            <ModuleStatCards
              totalLabel="Total Records"
              total={maintenanceRecordStats.total}
              cards={MAINTENANCE_RECORD_STAT_CARDS}
              counts={maintenanceRecordStats}
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
              statusOptions={lookups.maintenance_statuses}
              statusLabel="Progress"
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
                  options: ['Scheduled Maintenance', 'External Shop', 'From Issue Report', 'Field Repair'],
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
              <ViewModeDropdown value={maintenanceViewMode} onChange={changeMaintenanceViewMode} />
              {/* No general "+ Add" entry point here anymore — repair data
                  is now entered through Tickets; Maintenance Schedule
                  completions create records through their own path. */}
              <LocalSearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Search maintenance..."
                columnChooser={maintenanceViewMode === 'card' ? undefined : maintenanceColumnChooser}
              />
            </div>
          </div>
          {maintenanceViewMode === 'card' ? (
            <PaginatedCardGrid
              items={visibleRows}
              keyOf={(row) => row.maintenance_id}
              emptyMessage="No maintenance records yet — click the + button to log one."
              renderItem={(row) => (
                <MaintenanceRecordCard
                  record={row}
                  onClick={() => navigate(`${roleRoutes[user.role]}/maintenance/${row.maintenance_id}`)}
                />
              )}
            />
          ) : (
            <PaginatedTable
              columns={maintenanceColumnChooser.visibleColumns}
              onReorderColumn={maintenanceColumnChooser.reorderColumn}
              emptyMessage="No maintenance records yet — click the + button to log one."
              rows={visibleRows}
              compact
              onRowClick={(row) => row.vehicle && openVehicleProfile(row.vehicle)}
              renderSubRow={(row) => row.problem_reason}
            />
          )}
        </ModulePanel>
        <FormModal open={!!editTarget?.__verify} title={`Verify Maintenance #${editTarget?.maintenance_id}`} onClose={() => setEditTarget(null)}>
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
              onRowClick={(row) => row.vehicle && openVehicleProfile(row.vehicle)}
              renderSubRow={(row) => subRowFields([['Problem / Reason', row.problem_reason], ['Action Taken', row.action_taken]])}
            />
          </ModulePanel>
          <FormModal open={!!editTarget} title={`Verify Maintenance #${editTarget?.maintenance_id}`} onClose={() => setEditTarget(null)}>
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
      // A mechanic's own assignments surface first — the shared list still
      // shows everyone's schedules for context, but their own work isn't
      // buried in it. Computed once so the table and card views can't drift
      // into showing different orderings.
      const scheduleRows = (!hasRole(user, 'Admin') && hasRole(user, 'Maintenance Personnel'))
        ? [...visibleRows].sort((a, b) => {
            const aMine = String(a.assigned_to) === String(user.id) ? 0 : 1;
            const bMine = String(b.assigned_to) === String(user.id) ? 0 : 1;
            return aMine - bMine;
          })
        : visibleRows;

      return (
        <ModulePanel
          description="Plan preventative maintenance and track schedule status."
          statCards={
            <ModuleStatCards
              totalLabel="Total Schedules"
              total={scheduleStats.total}
              cards={(hasRole(user, 'Maintenance Personnel') && !hasRole(user, 'Admin')) ? [...SCHEDULE_STAT_CARDS, MY_ASSIGNED_SCHEDULE_CARD] : SCHEDULE_STAT_CARDS}
              counts={scheduleStats}
              activeFilter={filterStatus}
              onFilterChange={setFilterStatus}
              gridClassName="schedule-stat-grid"
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
          <div className="panel-header-bar">
            <h3>Maintenance Schedules <span className="count-badge">{visibleRows.length}</span></h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
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
              emptyMessage="No maintenance scheduled — click the + button to plan one."
              renderItem={(row) => (
                <MaintenanceScheduleCard
                  row={row}
                  currentUser={user}
                  onComplete={openCompleteSchedule}
                  onEdit={(r) => navigate(`${roleRoutes[user.role]}/schedules/${r.schedule_id}/edit`)}
                  onDelete={(r) => deleteRecord(`/maintenance-schedules/${r.schedule_id}`, 'Schedule cancelled.', `Cancel the ${r.maintenance_type} schedule for ${r.vehicle?.vehicle_name ?? 'this vehicle'}? It can be restored later if needed.`)}
                  onRestore={(r) => restoreRecord(`/maintenance-schedules/${r.schedule_id}/restore`, 'Schedule restored.', 'Restore this cancelled schedule back to Scheduled?')}
                  onViewRecord={(r) => navigate(`${roleRoutes[user.role]}/maintenance/${r.resulting_maintenance_id}`)}
                  onReassign={setReassignScheduleTarget}
                  onViewTicket={openTicketProfile}
                  onViewVehicle={openVehicleProfile}
                  onApprove={approveSchedule}
                  onDecline={setDeclineScheduleTarget}
                />
              )}
            />
          ) : (
            <PaginatedTable
              columns={scheduleColumnChooser.visibleColumns}
              onReorderColumn={scheduleColumnChooser.reorderColumn}
              emptyMessage="No maintenance scheduled — click the + button to plan one."
              rows={scheduleRows}
              onRowClick={(row) => row.vehicle && openVehicleProfile(row.vehicle)}
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
              <ViewModeDropdown value={historyViewMode} onChange={changeHistoryViewMode} />
              <LocalSearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Search history..."
                onExport={() => exportRowsToCsv('vehicle-history.csv', VEHICLE_HISTORY_EXPORT_COLUMNS, visibleRows)}
                columnChooser={historyViewMode === 'card' ? undefined : vehicleHistoryColumnChooser}
              />
              <button className="ghost-button" onClick={() => window.print()} type="button">Print</button>
            </div>
          </div>
          {historyViewMode === 'card' ? (
            <PaginatedCardGrid
              items={visibleRows}
              keyOf={(row) => row.history_id}
              emptyMessage="No vehicle activity recorded yet."
              renderItem={(row) => (
                <HistoryCard row={row} onClick={() => row.vehicle && openVehicleProfile(row.vehicle)} />
              )}
            />
          ) : (
            <PaginatedTable
              columns={vehicleHistoryColumnChooser.visibleColumns}
              onReorderColumn={vehicleHistoryColumnChooser.reorderColumn}
              emptyMessage="No vehicle activity recorded yet."
              rows={visibleRows}
              onRowClick={(row) => row.vehicle && openVehicleProfile(row.vehicle)}
              pageSizeOptions={[10, 20, 40, 50]}
              initialPageSize={10}
              renderSubRow={(row) => row.description}
            />
          )}

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
                  <Icon name="gear" size={48} className="topbar-gear-icon" filled />
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
              <GenerateReportButton rows={visibleRows} />
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
          description="Immutable audit trail of all completed and closed maintenance tickets."
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
                <select
                  className="filter-select"
                  value={archiveDraft.quick}
                  onChange={(e) => applyQuickFilter(e.target.value)}
                >
                  <option value="">Quick Filter</option>
                  <option value="this_year">This Year</option>
                  <option value="last_year">Last Year</option>
                  <option value="over_1yr">Older than 1 Year</option>
                  <option value="over_3yr">Older than 3 Years</option>
                </select>
              </div>

              <div style={{ width: 1, height: 22, background: 'var(--border, #334155)', flexShrink: 0 }} />

              {/* Year dropdown — only years that actually have archived tickets */}
              <div className="filter-date-group">
                <span>Year</span>
                <select
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
                </select>
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
                  <select
                    className="filter-select"
                    value={archiveDraft.status}
                    onChange={(e) => setArchiveDraft((d) => ({ ...d, status: e.target.value }))}
                  >
                    <option value="">All Statuses</option>
                    {archiveFinalStatuses.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
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
              Archived Tickets <span className="count-badge">{visibleRows.length}</span>
              {visibleRows.length !== allArchiveRows.length && (
                <span style={{ fontWeight: 400, fontSize: '0.8rem', marginLeft: 6 }}>of {allArchiveRows.length} total</span>
              )}
            </h3>
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
            emptyMessage="No archived tickets yet — completed tickets are stored here automatically."
            rows={visibleRows}
            onRowClick={(row) => row.vehicle && openVehicleProfile(row.vehicle)}
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
const ACTION_QUEUE_META = {
  issue_pending:           { icon: 'alert',       color: '#b45309', route: (basePath, id) => `${basePath}/issues/${id}` },
  subissue_needs_mechanic: { icon: 'wrench',      color: '#7c3aed', route: (basePath, id) => `${basePath}/tickets/${id}` },
  ticket_confirm:          { icon: 'checkCircle', color: '#9d174d', route: (basePath, id) => `${basePath}/tickets/${id}` },
  ticket_close:            { icon: 'checkCircle', color: '#16a34a', route: (basePath, id) => `${basePath}/tickets/${id}` },
  recurring_fault_review:  { icon: 'undo',        color: '#c2410c', route: (basePath, id) => `${basePath}/tickets/${id}` },
  readiness_check:         { icon: 'search',      color: '#0369a1', route: (basePath, id) => `${basePath}/vehicles/${id}` },
  schedule_overdue:        { icon: 'wrench',      color: '#b91c1c', route: null },
};

function ActionQueueRow({ item, basePath, onNavigate, onGoToSchedules }) {
  const meta = ACTION_QUEUE_META[item.type] ?? ACTION_QUEUE_META.issue_pending;
  const goTo = () => (meta.route ? onNavigate(meta.route(basePath, item.id)) : onGoToSchedules());
  return (
    <button
      type="button"
      onClick={goTo}
      className="action-queue-row"
      style={{ '--aq-color': meta.color }}
    >
      <span className="action-queue-row-icon"><Icon name={meta.icon} size={15} /></span>
      <span className="action-queue-row-body">
        <span className="action-queue-row-label">{item.label}</span>
        {item.vehicle_name && <span className="action-queue-row-vehicle">{item.vehicle_name}</span>}
      </span>
      {item.severity && <span className="action-queue-row-severity">{item.severity}</span>}
      <Icon name="chevronRight" size={14} className="action-queue-row-chevron" />
    </button>
  );
}

// A mechanic's personal task list — the counterpart to the Admin's Action
// Queue, but scoped to "what's assigned to ME" instead of "what needs an
// Admin decision". Same visual language (reuses .action-queue-* styles) so
// it reads as part of the same "here's what to do" pattern on the dashboard.
function MyScheduledWorkRow({ item, onClick }) {
  const overdue = isScheduleOverdue(item);
  return (
    <button
      type="button"
      onClick={onClick}
      className="action-queue-row"
      style={{ '--aq-color': overdue ? '#b91c1c' : '#0369a1' }}
    >
      <span className="action-queue-row-icon"><Icon name="wrench" size={15} /></span>
      <span className="action-queue-row-body">
        <span className="action-queue-row-label">{item.maintenance_type}</span>
        {item.vehicle && <span className="action-queue-row-vehicle">{item.vehicle.vehicle_name}</span>}
      </span>
      <span className="action-queue-row-severity">{overdue ? 'OVERDUE' : item.scheduled_date}</span>
      <Icon name="chevronRight" size={14} className="action-queue-row-chevron" />
    </button>
  );
}

// A compact "tap to see everything" tile — Action Queue, Emergency
// Readiness, and Risk & Readiness Watch used to each be a full list
// permanently on the dashboard; now they're one glance-able number that
// opens the full list in a popup instead of claiming that much vertical
// space all the time.
function DashboardQuickCard({ icon, title, stat, tone, preview, onClick }) {
  return (
    <button type="button" className="dashboard-quick-card" onClick={onClick}>
      <div className="dashboard-quick-card-head">
        <span className="dashboard-quick-card-icon"><Icon name={icon} size={16} /></span>
        <span className="dashboard-quick-card-title">{title}</span>
        <Icon name="chevronRight" size={14} className="dashboard-quick-card-chevron" />
      </div>
      <strong className={`dashboard-quick-card-stat${tone ? ` is-${tone}` : ''}`}>{stat}</strong>
      {preview && <span className="dashboard-quick-card-preview">{preview}</span>}
    </button>
  );
}

// Lightweight read-only popup — no form/notice machinery like FormModal,
// just the same modal-overlay/modal-box chrome so it looks consistent with
// every other modal in the app.
function DashboardListModal({ title, tag, onClose, children }) {
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="modal-close-btn" onClick={onClose} type="button" aria-label="Close"><Icon name="close" size={18} /></button>
        </div>
        {tag && <div className="dashboard-list-modal-tag">{tag}</div>}
        <div className="modal-body dashboard-list-modal-body">{children}</div>
      </div>
    </div>,
    document.body
  );
}

// Shared row for both the Emergency Readiness modal and the compact
// "Readiness by Vehicle Type" dashboard panel — a status dot + fill bar so
// which categories are covered is readable at a glance, not just from text.
function ReadinessRow({ r }) {
  const verifiedReady = typeof r.verified_ready === 'number' ? r.verified_ready : r.ready;
  const unverified = r.ready - verifiedReady;
  const state = verifiedReady > 0 ? 'ready' : r.ready > 0 ? 'unverified' : 'none';
  const pct = r.total > 0 ? Math.max(4, Math.round((verifiedReady / r.total) * 100)) : 0;

  return (
    <div className={`emergency-readiness-row is-${state}`}>
      <span className={`emergency-readiness-row-dot is-${state}`} />
      <div className="emergency-readiness-row-main">
        <span className="emergency-readiness-row-name">{r.category}</span>
        <span className="emergency-readiness-row-detail">
          {r.ready} available
          {unverified > 0 && <> · <span className="emergency-readiness-row-unverified">{unverified} unverified</span></>}
        </span>
      </div>
      <div className="emergency-readiness-row-stat">
        <span className={`emergency-readiness-row-tag${verifiedReady > 0 ? ' is-ready' : ''}`}>
          {verifiedReady}/{r.total} READY
        </span>
        <span className="emergency-readiness-row-bar">
          <span className={`emergency-readiness-row-bar-fill is-${state}`} style={{ width: `${pct}%` }} />
        </span>
      </div>
    </div>
  );
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function DashboardMicroMetric({ icon, label, value, tone = 'neutral', onClick }) {
  const content = (
    <>
      <span><Icon name={icon} size={15} /></span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={`dashboard-micro-metric is-${tone} is-clickable`} onClick={onClick}>
        {content}
      </button>
    );
  }

  return <div className={`dashboard-micro-metric is-${tone}`}>{content}</div>;
}

function DashboardSignalCard({ icon, label, value, detail, tone = 'neutral', meter = 0, onClick }) {
  const content = (
    <>
      <div className="dashboard-signal-card-head">
        <span className="dashboard-signal-card-icon"><Icon name={icon} size={16} /></span>
        <span>{label}</span>
        {onClick && <Icon name="chevronRight" size={14} className="dashboard-signal-card-chevron" />}
      </div>
      <strong>{value}</strong>
      <p>{detail}</p>
      <span className="dashboard-signal-meter" aria-hidden="true">
        <span style={{ width: `${clampPercent(meter)}%` }} />
      </span>
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={`dashboard-signal-card is-${tone}`} onClick={onClick}>
        {content}
      </button>
    );
  }

  return <article className={`dashboard-signal-card is-${tone}`}>{content}</article>;
}

function DashboardStatusStrip({ rows }) {
  return (
    <div className="dashboard-status-strip">
      {rows.map((row) => (
        <div key={row.label} style={{ '--strip-color': row.color }}>
          <span>{row.label}</span>
          <strong>{row.value}</strong>
        </div>
      ))}
    </div>
  );
}

function Dashboard({ data, hubs = null, user, basePath, onNavigate, onGoToSchedules, onGoToModule }) {
  const [weather, setWeather] = useState(null);
  const [greeting, setGreeting] = useState(() => buildLocalGreeting(user?.name));
  const [greetingRole, setGreetingRole] = useState(() => dashboardRoleLabel(user?.role));
  const [now, setNow] = useState(() => new Date());
  // Dashboard = summary, not the complete list — Action Queue, Emergency
  // Readiness, and Risk & Readiness Watch each collapse to one glance-able
  // card; tapping one opens its full list in a popup instead of the list
  // living permanently on the page. null = no modal open.
  const [openDashboardModal, setOpenDashboardModal] = useState(null);

  useEffect(() => {
    // Displayed time is minute-precision (no seconds), so a 1s tick would
    // just be wasted re-renders — once a minute is enough to stay current.
    const interval = setInterval(() => setNow(new Date()), 60000);

    // Fetch Mandaue City, Cebu, Philippines (10.3446, 123.9392) weather
    fetch('https://api.open-meteo.com/v1/forecast?latitude=10.3446&longitude=123.9392&current=temperature_2m,relative_humidity_2m,weather_code')
      .then((res) => res.json())
      .then((resData) => {
        if (resData && resData.current) {
          const temp = Math.round(resData.current.temperature_2m);
          const code = resData.current.weather_code;
          const humidity = resData.current.relative_humidity_2m;
          
          let desc = 'Sunny';
          let icon = '☀️';
          
          if (code === 0) { desc = 'Clear Sky'; icon = '☀️'; }
          else if ([1, 2, 3].includes(code)) { desc = 'Partly Cloudy'; icon = '⛅'; }
          else if ([45, 48].includes(code)) { desc = 'Foggy'; icon = '🌫️'; }
          else if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) { desc = 'Rainy'; icon = '🌧️'; }
          else if ([95, 96, 99].includes(code)) { desc = 'Thunderstorm'; icon = '⛈️'; }
          
          setWeather({ temp, desc, icon, humidity });
        }
      })
      .catch(() => {
        setWeather({ temp: 33, desc: 'Partly Cloudy', icon: '⛅', humidity: 68 });
      });

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadGreeting = async () => {
      try {
        const response = await api.get('/greeting');
        if (!cancelled) {
          setGreeting(response.data.greeting ?? buildLocalGreeting(user?.name));
          setGreetingRole(response.data.role_label ?? dashboardRoleLabel(user?.role));
        }
      } catch {
        if (!cancelled) {
          setGreeting(buildLocalGreeting(user?.name));
          setGreetingRole(dashboardRoleLabel(user?.role));
        }
      }
    };

    loadGreeting();
    const interval = setInterval(loadGreeting, 60000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user?.name, user?.role]);

  if (!data) {
    return <p className="empty-state">No dashboard data available yet.</p>;
  }

  const metricValue = (label) => dashboardMetricValue(data.metrics, label);
  const totalVehicles = metricValue('Total Vehicles');
  const availableVehicles = metricValue('Available Vehicles');
  const underMaintenanceVehicles = metricValue('Vehicles Under Maintenance');
  const inactiveVehicles = metricValue('Inactive Vehicles');
  const reportedIssues = metricValue('Reported Issues');
  const upcomingMaintenance = metricValue('Upcoming Maintenance');
  const overdueMaintenanceCount = metricValue('Overdue Maintenance');
  const maintenanceExpenses = data.metrics.find((metric) => metric.label === 'Total Maintenance Expenses')?.value ?? '0';

  // Re-group raw location rows into the same hubs the map shows, so the
  // "Vehicles by Location" chart always matches the map's pins.
  const locationsByHub = groupLocationRowsByHub(data.vehicles_by_location ?? [], hubs);

  // Availability Forecast — vehicles currently out and when they're due back.
  const forecast = data.availability_forecast ?? { available_now: availableVehicles, under_maintenance: [] };
  const forecastOut = forecast.under_maintenance ?? [];
  const overdueSchedules = data.overdue_schedules ?? [];

  // Gap 1 — readiness/coverage by vehicle type; Gap 2 — preventive watch.
  const readiness = data.readiness ?? [];
  const noCoverage = readiness.filter((r) => r.no_coverage);
  const fleetSummary = data.fleet_readiness_summary ?? null;
  const preventiveWatch = data.preventive_watch ?? [];
  // Gap A — readiness watch; Gap B — fragility; Gap C — failure patterns.
  const readinessWatch = data.readiness_watch ?? [];
  const criticalityWatch = data.criticality_watch ?? [];
  // Final feature pass — Fleet Capability & Readiness Impact: the same
  // signals above, rolled up to "which emergency capability is at risk?".
  const capabilityImpact = data.capability_impact ?? [];
  const fragility = data.fragility ?? [];
  const failurePatterns = data.failure_patterns ?? [];
  const showBreakingMost = hasRole(user, 'Admin') && failurePatterns.length > 0;

  // Action Queue — everything currently waiting on an Admin decision,
  // ranked and pulled from across the whole system, so the dashboard
  // answers "what do I do right now" instead of just "what's currently
  // true". Admin-only (the backend already returns [] for other roles).
  const actionQueue = data.action_queue ?? [];
  const criticalActionCount = actionQueue.filter((item) => item.severity === 'Critical').length;

  // My Scheduled Work — a mechanic's own assigned schedules, surfaced right
  // on their dashboard instead of only living in the shared schedule table.
  const myScheduledWork = data.my_scheduled_work ?? [];

  // Fleet health (Good/Needs Inspection/Needs Repair) — a different
  // signal than Available/Under Maintenance/Inactive, which already have
  // their own KPI tiles just below this card, so this donut wouldn't just
  // be re-drawing the same three numbers. Colors match the same condition
  // badges used everywhere else (Condition Monitoring's stat cards, etc).
  const vehicleCondition = (data.vehicles_by_condition ?? []).map((row) => ({
    label: row.label,
    value: row.value,
    color: CONDITION_STAT_CARDS.find((c) => c.key === row.label)?.color ?? '#94a3b8',
  }));
  const goodConditionCount = vehicleCondition.find((c) => c.label === 'Good')?.value ?? 0;
  const goodConditionRate = totalVehicles ? Math.round((goodConditionCount / totalVehicles) * 100) : 0;

  const operationalTotal = fleetSummary?.operational_total ?? totalVehicles;
  const verifiedReady = fleetSummary?.verified_ready ?? Math.max(0, availableVehicles - readinessWatch.length);
  const readinessRate = operationalTotal ? clampPercent((verifiedReady / operationalTotal) * 100) : 0;
  const atRiskCount = noCoverage.length + readinessWatch.length + fragility.length + forecastOut.length + preventiveWatch.length + overdueMaintenanceCount;
  const notReadyVehicles = Math.max(0, totalVehicles - availableVehicles);
  const opsTone = notReadyVehicles === 0 ? 'ok' : availableVehicles === 0 ? 'alert' : 'warn';
  const maintenanceLoad = underMaintenanceVehicles + upcomingMaintenance + overdueMaintenanceCount;
  const statusSegments = [
    { label: 'Available', value: availableVehicles, color: '#16a34a' },
    { label: 'In shop', value: underMaintenanceVehicles, color: '#d97706' },
    { label: 'Inactive', value: inactiveVehicles, color: '#64748b' },
  ];
  const operationsQueue = [
    { label: 'Issues', value: reportedIssues, color: '#ef4444' },
    { label: 'Upcoming', value: upcomingMaintenance, color: '#f59e0b' },
    { label: 'Overdue', value: overdueMaintenanceCount, color: '#dc2626' },
    { label: 'Ready', value: availableVehicles, color: '#22c55e' },
  ];
  const topFailurePattern = failurePatterns[0];
  const visibleReadiness = readiness.slice(0, 5);
  const visibleLocationRows = locationsByHub.slice(0, 4);
  const visibleTypeRows = (data.vehicles_by_type ?? []).slice(0, 5);
  const isAdminDashboard = hasRole(user, 'Admin');
  const isMaintenanceDashboard = hasRole(user, 'Maintenance Personnel') && !isAdminDashboard;
  // Phase A4 — one departure away from an orphaned barangay (nobody left
  // who can manage users, vehicles, or approvals). GuardsLastAdmin blocks
  // that departure from happening through deactivate/role-change, but not
  // e.g. this Admin simply leaving with no successor ever promoted — this
  // is the "before it happens" half of that protection.
  const primaryActionCount = isAdminDashboard
    ? actionQueue.length
    : isMaintenanceDashboard
      ? myScheduledWork.length
      : reportedIssues;
  const primaryActionLabel = isAdminDashboard
    ? (actionQueue[0]?.label ?? 'No urgent action')
    : isMaintenanceDashboard
      ? (myScheduledWork[0]?.maintenance_type ?? 'Nothing assigned')
      : (reportedIssues > 0 ? 'Open reports need follow-up' : 'No open reported issues');
  const primaryActionTitle = isAdminDashboard ? 'Action Queue' : isMaintenanceDashboard ? 'My Work' : 'My Reports';
  const primaryActionIcon = isMaintenanceDashboard ? 'wrench' : reportedIssues > 0 ? 'alert' : 'checkCircle';
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  // Custodian / Maintenance Personnel get their own, leaner dashboard: their
  // own queues first, then only the fleet context their job actually uses.
  // The fleet-wide analytics (expenses, risk watch, sites/types, maintenance
  // load) are Admin's — the backend doesn't even send those numbers to these
  // roles, so they used to render as misleading zeroes.
  if (!isAdminDashboard) {
    const badges = data.badge_counts ?? {};
    const isCustodianView = hasRole(user, 'Custodian');
    const needsCheck = readinessWatch.slice(0, 5);
    const toneFor = (n, hot = 'warn') => (n > 0 ? hot : 'ok');
    const quick = [];
    if (isCustodianView) {
      quick.push(
        { icon: 'checkCircle', label: 'To Verify', value: badges.ticketVerifications ?? 0, go: () => onGoToModule('ticketVerifications', []) },
        { icon: 'alert', label: 'My Open Reports', value: badges.issues ?? 0, go: () => onGoToModule('issues', []) },
      );
    }
    if (isMaintenanceDashboard) {
      quick.push(
        { icon: 'wrench', label: 'Work Orders', value: badges.ticketWorkOrders ?? 0, go: () => onGoToModule('ticketWorkOrders', []) },
        { icon: 'calendar', label: 'My Schedule', value: myScheduledWork.length, go: onGoToSchedules },
        { icon: 'alert', label: 'Needs Attention', value: metricValue('Vehicles Needing Attention'), go: () => onGoToModule('vehicles', []) },
      );
    }

    return (
      <div className="dashboard-grid dashboard-grid-smart">
        <section className={`dashboard-command-center full-span is-${opsTone}`}>
          <div className="dashboard-command-copy">
            <span className="dashboard-command-role">{greetingRole}</span>
            <TextType
              key={greeting}
              as="h2"
              text={[greeting]}
              typingSpeed={150}
              pauseDuration={1500}
              loop={false}
              showCursor={true}
              cursorCharacter="|"
            />
            <p>{dateStr || 'Today'}</p>
          </div>

          <div className="dashboard-ready-split">
            <div className="dashboard-ready-stat" style={{ '--ready-pct': `${totalVehicles ? (availableVehicles / totalVehicles) * 100 : 0}%` }}>
              <span className="dashboard-hologram-scan" />
              <div className="dashboard-ready-stat-inner">
                <div className="dashboard-ready-row is-ready">
                  <strong>{availableVehicles}</strong>
                  <span>Ready</span>
                </div>
                <div className="dashboard-ready-row is-not-ready">
                  <strong>{notReadyVehicles}</strong>
                  <span>Not Ready</span>
                </div>
              </div>
            </div>
          </div>

          <div className="dashboard-command-side">
            <div className="dashboard-live-chips">
              <div>
                <span>Local time</span>
                <strong>{timeStr}</strong>
              </div>
              {weather && (
                <div>
                  <span>Mandaue City, Cebu</span>
                  <strong><span className="dashboard-weather-mark">{weather.icon}</span>{weather.temp}C</strong>
                  <small>{weather.desc} / {weather.humidity}% humidity</small>
                </div>
              )}
            </div>
            <div className="dashboard-command-mini-grid">
              {quick.slice(0, 4).map((q) => (
                <DashboardMicroMetric key={q.label} icon={q.icon} label={q.label} value={q.value} tone={toneFor(q.value)} onClick={q.go} />
              ))}
            </div>
          </div>
        </section>

        {isMaintenanceDashboard && (
          <section className="panel col-span-7 action-queue-panel dashboard-lean-panel">
            <div className="panel-header-bar">
              <h3><Icon name="wrench" size={16} /> My Scheduled Work</h3>
              {myScheduledWork.length > 0 && <span className="area-chart-tag">{myScheduledWork.length} assigned to you</span>}
            </div>
            {myScheduledWork.length === 0 ? (
              <p className="action-queue-clear"><Icon name="checkCircle" size={16} /> Nothing scheduled for you right now.</p>
            ) : (
              <div className="action-queue-list action-queue-list-compact">
                {myScheduledWork.map((item) => (
                  <MyScheduledWorkRow key={item.schedule_id} item={item} onClick={onGoToSchedules} />
                ))}
              </div>
            )}
          </section>
        )}

        {isCustodianView && (
          <section className="panel col-span-7 dashboard-lean-panel">
            <div className="panel-header-bar">
              <h3><Icon name="checkCircle" size={16} /> Needs a Readiness Check</h3>
              {readinessWatch.length > 0 && <span className="area-chart-tag">{readinessWatch.length} vehicle{readinessWatch.length === 1 ? '' : 's'}</span>}
            </div>
            {needsCheck.length === 0 ? (
              <p className="action-queue-clear"><Icon name="checkCircle" size={16} /> Every available vehicle has a current readiness check.</p>
            ) : (
              <div className="risk-watch-col">
                {needsCheck.map((r) => (
                  <button
                    key={r.vehicle_id}
                    type="button"
                    className={`risk-watch-item risk-watch-item-clickable${r.state === 'not_ready' ? ' is-critical' : ''}`}
                    onClick={() => onNavigate(`${basePath}/vehicles/${r.vehicle_id}`)}
                  >
                    <span className={`risk-watch-item-dot${r.state === 'not_ready' ? ' is-critical' : ''}`} />
                    <div className="risk-watch-item-body">
                      <span className="risk-watch-item-top">
                        <span className="risk-watch-item-title">{r.vehicle_name}</span>
                        <span className={`risk-watch-tag${r.state === 'not_ready' ? ' is-critical' : ''}`}>
                          {(READINESS_BADGE[r.state]?.label ?? r.state).toUpperCase()}
                        </span>
                      </span>
                      <span className="risk-watch-item-sub">{r.category ?? '—'}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {readinessWatch.length > needsCheck.length && (
              <p className="muted" style={{ margin: '8px 0 0', fontSize: '0.78rem' }}>+ {readinessWatch.length - needsCheck.length} more — open Vehicles to see them all.</p>
            )}
          </section>
        )}

        <CriticalityWatchCard items={criticalityWatch} onNavigate={onNavigate} basePath={basePath} />
        <CapabilityImpactCard items={capabilityImpact} onNavigate={onNavigate} basePath={basePath} />

        <section className="panel col-span-5 dashboard-lean-panel">
          <div className="panel-header-bar">
            <h3>Fleet Condition</h3>
            <span className="area-chart-tag">{goodConditionRate}% in good condition</span>
          </div>
          <div className="fleet-status-compact">
            <div className="donut-chart-small">
              <DonutChart centerLabel={totalVehicles} centerSubLabel="Vehicles" segments={vehicleCondition} />
            </div>
            <div className="fleet-status-legend-col">
              <ChartLegend rows={vehicleCondition} />
            </div>
          </div>
        </section>

        {/* Same vehicle-condition data as the donut above, as a bar graph —
            the donut reads the share (percent in good condition), this
            reads the actual counts per bucket at a glance. */}
        <section className="panel col-span-7 dashboard-lean-panel">
          <div className="panel-header-bar">
            <h3>Fleet Condition by Count</h3>
          </div>
          <ColumnChart rows={vehicleCondition} />
        </section>
      </div>
    );
  }

  return (
    <div className="dashboard-grid dashboard-grid-smart">
      <section className={`dashboard-command-center full-span is-${opsTone}`}>
        <div className="dashboard-command-copy">
          <span className="dashboard-command-role">{greetingRole}</span>
          <TextType
            key={greeting}
            as="h2"
            text={[greeting]}
            typingSpeed={150}
            pauseDuration={1500}
            loop={false}
            showCursor={true}
            cursorCharacter="|"
          />
          <p>{dateStr || 'Today'}</p>
          <div className="dashboard-command-pills">
            <button type="button" onClick={() => onGoToModule('vehicles', [])}>{totalVehicles} fleet units</button>
            <button type="button" onClick={() => onGoToModule('locations', [])}>{locationsByHub.length} active sites</button>
            <button type="button" onClick={() => onGoToModule('categories', [])}>{data.vehicles_by_type?.length ?? 0} vehicle types</button>
          </div>
        </div>

        <div className="dashboard-ready-split">
          <div className="dashboard-ready-stat" style={{ '--ready-pct': `${totalVehicles ? (availableVehicles / totalVehicles) * 100 : 0}%` }}>
            <span className="dashboard-hologram-scan" />
            <div className="dashboard-ready-stat-inner">
              <div className="dashboard-ready-row is-ready">
                <strong>{availableVehicles}</strong>
                <span>Ready</span>
              </div>
              <div className="dashboard-ready-row is-not-ready">
                <strong>{notReadyVehicles}</strong>
                <span>Not Ready</span>
              </div>
            </div>
          </div>
        </div>

        <div className="dashboard-command-side">
          <div className="dashboard-live-chips">
            <div>
              <span>Local time</span>
              <strong>{timeStr}</strong>
            </div>
            {weather && (
              <div>
                <span>Mandaue City, Cebu</span>
                <strong><span className="dashboard-weather-mark">{weather.icon}</span>{weather.temp}C</strong>
                <small>{weather.desc} / {weather.humidity}% humidity</small>
              </div>
            )}
          </div>
          <div className="dashboard-command-mini-grid">
            <DashboardMicroMetric icon="vehicle" label="Available" value={availableVehicles} tone="ok" onClick={() => onGoToModule('vehicles', ['Available'])} />
            <DashboardMicroMetric icon="wrench" label="In Shop" value={underMaintenanceVehicles} tone="warn" onClick={() => onGoToModule('vehicles', ['Under Maintenance'])} />
            <DashboardMicroMetric icon="alert" label="Issues" value={reportedIssues} tone={reportedIssues > 0 ? 'alert' : 'ok'} onClick={() => onGoToModule('issues', [])} />
            <DashboardMicroMetric icon="calendar" label="Overdue" value={overdueMaintenanceCount} tone={overdueMaintenanceCount > 0 ? 'alert' : 'neutral'} onClick={onGoToSchedules} />
          </div>
        </div>
      </section>

      <section className="dashboard-signal-grid full-span" aria-label="Dashboard signals">
        <DashboardSignalCard
          icon={primaryActionIcon}
          label={primaryActionTitle}
          value={primaryActionCount === 0 ? 'Clear' : primaryActionCount}
          detail={primaryActionLabel}
          tone={criticalActionCount > 0 ? 'alert' : primaryActionCount > 0 ? 'warn' : 'ok'}
          meter={primaryActionCount > 0 ? Math.min(100, primaryActionCount * 18) : 100}
          onClick={isAdminDashboard ? () => setOpenDashboardModal('actionQueue') : undefined}
        />
        <DashboardSignalCard
          icon="checkCircle"
          label="Emergency Coverage"
          value={operationalTotal ? `${verifiedReady}/${operationalTotal}` : '0/0'}
          detail={noCoverage.length > 0 ? `No coverage: ${noCoverage.map((r) => r.category).join(', ')}` : `${readinessRate}% verified ready`}
          tone={noCoverage.length > 0 ? 'alert' : readinessRate >= 75 ? 'ok' : 'warn'}
          meter={readinessRate}
          onClick={readiness.length > 0 ? () => setOpenDashboardModal('emergencyReadiness') : undefined}
        />
        <DashboardSignalCard
          icon="flag"
          label="Risk Watch"
          value={atRiskCount === 0 ? 'Stable' : atRiskCount}
          detail={fragility.length > 0 ? `${fragility.length} no-backup categories` : `${readinessWatch.length} available but unverified`}
          tone={atRiskCount > 0 ? 'alert' : 'ok'}
          meter={atRiskCount > 0 ? Math.min(100, atRiskCount * 12) : 100}
          onClick={atRiskCount > 0 ? () => setOpenDashboardModal('riskWatch') : undefined}
        />
        <DashboardSignalCard
          icon="calendar"
          label="Maintenance Load"
          value={maintenanceLoad}
          detail={`${underMaintenanceVehicles} in shop / ${upcomingMaintenance} upcoming / ${overdueMaintenanceCount} overdue`}
          tone={overdueMaintenanceCount > 0 ? 'alert' : maintenanceLoad > 0 ? 'warn' : 'ok'}
          meter={totalVehicles ? Math.min(100, (maintenanceLoad / Math.max(totalVehicles, 1)) * 100) : 0}
          onClick={onGoToSchedules}
        />
      </section>

      <section className="dashboard-intelligence-grid full-span">
        <article className="dashboard-smart-panel dashboard-readiness-matrix">
          <div className="dashboard-smart-panel-head">
            <div>
              <span>Response Matrix</span>
              <h3>Readiness by Vehicle Type</h3>
            </div>
            <strong>{readinessRate}%</strong>
          </div>
          {readiness.length === 0 ? (
            <p className="empty-state">No vehicle types to show yet.</p>
          ) : (
            <div className="dashboard-readiness-compact-list">
              {visibleReadiness.map((r) => <ReadinessRow key={r.category} r={r} />)}
            </div>
          )}
          {readiness.length > visibleReadiness.length && (
            <button type="button" className="dashboard-inline-action" onClick={() => setOpenDashboardModal('emergencyReadiness')}>
              View all {readiness.length} types
            </button>
          )}
        </article>

        <article className="dashboard-smart-panel dashboard-condition-matrix">
          <div className="dashboard-smart-panel-head">
            <div>
              <span>Fleet Health</span>
              <h3>Condition and Status</h3>
            </div>
            <strong>{goodConditionRate}%</strong>
          </div>
          <div className="dashboard-condition-core">
            <div className="dashboard-condition-donut">
              <DonutChart centerLabel={totalVehicles} centerSubLabel="Vehicles" segments={vehicleCondition} />
            </div>
            <ChartLegend rows={vehicleCondition} />
          </div>
          <DashboardStatusStrip rows={statusSegments} />
        </article>

        <article className="dashboard-smart-panel dashboard-operations-matrix">
          <div className="dashboard-smart-panel-head">
            <div>
              <span>Operations Pulse</span>
              <h3>Workload Pressure</h3>
            </div>
            <strong>{maintenanceExpenses}</strong>
          </div>
          <ColumnChart rows={operationsQueue} />
          <p className="dashboard-panel-note">
            {topFailurePattern
              ? `${topFailurePattern.type} leads the last 12 months with ${topFailurePattern.count} case${topFailurePattern.count === 1 ? '' : 's'}.`
              : 'No recurring failure pattern logged yet.'}
          </p>
        </article>

        <article className="dashboard-smart-panel dashboard-distribution-matrix">
          <div className="dashboard-smart-panel-head">
            <div>
              <span>Fleet Distribution</span>
              <h3>Sites and Types</h3>
            </div>
            <strong>{totalVehicles}</strong>
          </div>
          <div className="dashboard-dual-bars">
            <div>
              <h4>Sites</h4>
              <HorizontalBarChart rows={visibleLocationRows} />
            </div>
            <div>
              <h4>Types</h4>
              <HorizontalBarChart rows={visibleTypeRows} />
            </div>
          </div>
        </article>
      </section>
      {/* SECTION 1: Welcome Header — compressed, and paired with Fleet
          Status instead of stretching full-width alone at the top. */}
      <div className="dashboard-banner dashboard-banner-compact col-span-7">
        <div className="dashboard-banner-welcome">
          <span className="dashboard-greeting-role">{greetingRole}</span>
          <TextType
            key={greeting}
            as="h2"
            text={[greeting]}
            typingSpeed={150}
            pauseDuration={1500}
            loop={false}
            showCursor={true}
            cursorCharacter="|"
          />
          <p>{dateStr || 'Today'}</p>
        </div>
        <div className="dashboard-banner-widgets">
          <div className="dashboard-banner-time">
            <span className="time-label">Local time</span>
            <strong>{timeStr}</strong>
          </div>
          {weather && (
            <div className="dashboard-banner-weather">
              <span className="weather-icon">{weather.icon}</span>
              <div className="weather-details">
                <span className="weather-city">Mandaue City, Cebu</span>
                <span className="weather-desc">{weather.desc}</span>
                <span className="weather-extra">Humidity: {weather.humidity}%</span>
              </div>
              <p className="weather-temp">{weather.temp}°C</p>
            </div>
          )}
        </div>
      </div>

      <section className="panel col-span-5 dashboard-fleet-status-panel">
        <div className="panel-header-bar">
          <h3>Fleet Condition</h3>
          <span className="area-chart-tag">{goodConditionRate}% in good condition</span>
        </div>
        <div className="fleet-status-compact">
          <div className="donut-chart-small">
            <DonutChart centerLabel={totalVehicles} centerSubLabel="Vehicles" segments={vehicleCondition} />
          </div>
          <div className="fleet-status-legend-col">
            {/* Verified-ready deliberately lives only in the Action Center's
                Emergency Readiness card below — it was previously repeated
                here, in an alert tile, in a quick card, and twice more in the
                Readiness section, so the same 0/7 read five times on one page. */}
            <ChartLegend rows={vehicleCondition} />
          </div>
        </div>
      </section>

      {/* SECTION 2 — Action Center: what needs a decision right now, placed
          directly under the banner instead of below eight KPI tiles, since
          "what do I do" outranks "what is currently true". This absorbs the
          old Critical Action / Emergency Ready alert strip, which showed
          these same two numbers one row higher in a different card style. */}
      {hasRole(user, 'Admin') && (
        <div className="dashboard-quick-cards full-span">
          <DashboardQuickCard
            icon="alert"
            title="Action Queue"
            stat={actionQueue.length === 0 ? 'All clear' : `${actionQueue.length} need${actionQueue.length === 1 ? 's' : ''} you`}
            tone={criticalActionCount > 0 ? 'alert' : actionQueue.length > 0 ? 'warn' : 'ok'}
            preview={criticalActionCount > 0
              ? `${criticalActionCount} critical · ${actionQueue[0]?.label ?? ''}`
              : actionQueue[0]?.label}
            onClick={() => setOpenDashboardModal('actionQueue')}
          />
          {readiness.length > 0 && (
            <DashboardQuickCard
              icon="checkCircle"
              title="Emergency Readiness"
              stat={fleetSummary ? `${fleetSummary.verified_ready}/${fleetSummary.operational_total} ready` : '—'}
              tone={fleetSummary?.coverage_alert ? 'alert' : fleetSummary && fleetSummary.verified_ready < fleetSummary.operational_total ? 'warn' : 'ok'}
              preview={noCoverage.length > 0
                ? `No coverage: ${noCoverage.map((r) => r.category).join(', ')}`
                : `Across ${readiness.length} vehicle type${readiness.length === 1 ? '' : 's'}`}
              onClick={() => setOpenDashboardModal('emergencyReadiness')}
            />
          )}
          {(fragility.length > 0 || readinessWatch.length > 0 || forecastOut.length > 0 || preventiveWatch.length > 0 || overdueSchedules.length > 0) && (
            <DashboardQuickCard
              icon="alert"
              title="Risk & Readiness Watch"
              stat={fragility.length > 0 ? `${fragility.length} single point${fragility.length === 1 ? '' : 's'} of failure` : `${readinessWatch.length} unverified`}
              tone={fragility.length > 0 ? 'alert' : 'warn'}
              preview={forecastOut.length > 0 ? `${forecastOut.length} vehicle${forecastOut.length === 1 ? '' : 's'} in the shop` : undefined}
              onClick={() => setOpenDashboardModal('riskWatch')}
            />
          )}
        </div>
      )}

      {/* SECTION 3 — Fleet KPIs. Every headline number in one consistent tile
          style, including the three "watch" counts (issues / upcoming /
          overdue) that used to sit right below in a third, slimmer card style
          for no reason other than to de-emphasise them. */}
      <section className="metric-grid stat-one-line dashboard-headline-grid full-span" style={{ '--stat-cols': data.metrics.length }}>
        {data.metrics.map((metric) => {
          const style = DASHBOARD_METRIC_STYLES[metric.label] ?? DASHBOARD_METRIC_STYLE_DEFAULT;

          return (
            <article
              className="metric-card metric-card-iconic dashboard-metric-card"
              key={metric.label}
            >
              <span className="metric-card-icon" style={{ background: style.bg, color: style.color }}>
                <Icon name={style.icon} size={16} />
              </span>
              <div className="metric-card-body">
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
              </div>
            </article>
          );
        })}
      </section>

      {hasRole(user, 'Maintenance Personnel') && (
        <section className="panel col-span-7 action-queue-panel">
          <div className="panel-header-bar">
            <h3><Icon name="wrench" size={16} /> My Scheduled Work</h3>
            {myScheduledWork.length > 0 && <span className="area-chart-tag">{myScheduledWork.length} assigned to you</span>}
          </div>
          {myScheduledWork.length === 0 ? (
            <p className="action-queue-clear"><Icon name="checkCircle" size={16} /> Nothing scheduled for you right now.</p>
          ) : (
            <div className="action-queue-list action-queue-list-compact">
              {myScheduledWork.map((item) => (
                <MyScheduledWorkRow
                  key={item.schedule_id}
                  item={item}
                  onClick={onGoToSchedules}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {openDashboardModal === 'actionQueue' && (
        <DashboardListModal
          title="Action Queue"
          tag={actionQueue.length > 0 ? `${actionQueue.length} need${actionQueue.length === 1 ? 's' : ''} you` : undefined}
          onClose={() => setOpenDashboardModal(null)}
        >
          {actionQueue.length === 0 ? (
            <p className="action-queue-clear"><Icon name="checkCircle" size={16} /> All clear — nothing needs your attention right now.</p>
          ) : (
            <div className="action-queue-list">
              {actionQueue.map((item) => (
                <ActionQueueRow
                  key={`${item.type}-${item.id}`}
                  item={item}
                  basePath={basePath}
                  onNavigate={(path) => { setOpenDashboardModal(null); onNavigate(path); }}
                  onGoToSchedules={() => { setOpenDashboardModal(null); onGoToSchedules(); }}
                />
              ))}
            </div>
          )}
        </DashboardListModal>
      )}

      {openDashboardModal === 'emergencyReadiness' && (
        <DashboardListModal
          title="Emergency Readiness"
          tag={fleetSummary ? `${fleetSummary.verified_ready} of ${fleetSummary.operational_total} verified ready` : undefined}
          onClose={() => setOpenDashboardModal(null)}
        >
          <div className="emergency-readiness-rows">
            {readiness.map((r) => <ReadinessRow key={r.category} r={r} />)}
          </div>
          {fragility.length > 0 && fragility.length === readiness.length && (
            <p className="emergency-readiness-note">
              <Icon name="alert" size={13} /> Every emergency type has exactly one vehicle — no backup if any of the {readiness.length} goes down. Verify all {readiness.length} to clear this panel.
            </p>
          )}
          {noCoverage.length > 0 && (
            <p className="emergency-readiness-alert"><Icon name="alert" size={13} /> No coverage: {noCoverage.map((r) => r.category).join(', ')}</p>
          )}
        </DashboardListModal>
      )}

      {openDashboardModal === 'riskWatch' && (
        <DashboardListModal
          title="Risk & Readiness Watch"
          tag={fragility.length > 0 ? `${fragility.length} single point${fragility.length === 1 ? '' : 's'} of failure` : undefined}
          onClose={() => setOpenDashboardModal(null)}
        >
          <div className="risk-watch-columns">
            {criticalityWatch.some((r) => r.criticality !== 'Normal') && (
              <div className="risk-watch-col">
                <h4>Critical &amp; high-priority vehicles not ready</h4>
                {criticalityWatch.filter((r) => r.criticality !== 'Normal').map((r) => (
                  <div key={r.vehicle_id} className={`risk-watch-item${r.criticality === 'Critical' ? ' is-critical' : ''}`}>
                    <span className={`risk-watch-item-dot${r.criticality === 'Critical' ? ' is-critical' : ''}`} />
                    <div className="risk-watch-item-body">
                      <span className="risk-watch-item-top">
                        <span className="risk-watch-item-title">{r.vehicle_name}</span>
                        <span className={`risk-watch-tag${r.criticality === 'Critical' ? ' is-critical' : ''}`}>{r.criticality.toUpperCase()}</span>
                      </span>
                      <span className="risk-watch-item-sub">{r.category ?? '—'} · {r.reason}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {fragility.length > 0 && (
              <div className="risk-watch-col">
                <h4>No backup if it goes down</h4>
                {fragility.map((f) => (
                  <div key={f.category} className={`risk-watch-item${f.critical ? ' is-critical' : ''}`}>
                    <span className={`risk-watch-item-dot${f.critical ? ' is-critical' : ''}`} />
                    Only 1 {f.category}
                  </div>
                ))}
              </div>
            )}
            {capabilityImpact.length > 0 && (
              <div className="risk-watch-col">
                <h4>Capability impact by type</h4>
                {capabilityImpact.map((row) => (
                  <button
                    key={row.category}
                    type="button"
                    className={`risk-watch-item risk-watch-item-clickable${row.criticality === 'Critical' ? ' is-critical' : ''}`}
                    onClick={() => { setOpenDashboardModal(null); onNavigate(`${basePath}/vehicles`); }}
                  >
                    <span className={`risk-watch-item-dot${row.criticality === 'Critical' ? ' is-critical' : ''}`} />
                    <div className="risk-watch-item-body">
                      <span className="risk-watch-item-top">
                        <span className="risk-watch-item-title">{row.category}</span>
                        <span className={`risk-watch-tag${row.coverage_state === 'NO_COVERAGE' ? ' is-critical' : ''}`}>
                          {CAPABILITY_STATE_LABEL[row.coverage_state] ?? row.coverage_state}
                        </span>
                      </span>
                      <span className="risk-watch-item-sub">{row.ready}/{row.total} ready · {row.primary_reason ?? 'Based on current records.'}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {readinessWatch.length > 0 && (
              <div className="risk-watch-col">
                <h4>Available, not verified</h4>
                {readinessWatch.map((r) => (
                  <button
                    key={r.vehicle_id}
                    type="button"
                    className={`risk-watch-item risk-watch-item-clickable${r.state === 'not_ready' ? ' is-critical' : ''}`}
                    onClick={() => { setOpenDashboardModal(null); onNavigate(`${basePath}/vehicles/${r.vehicle_id}`); }}
                  >
                    <span className={`risk-watch-item-dot${r.state === 'not_ready' ? ' is-critical' : ''}`} />
                    <div className="risk-watch-item-body">
                      <span className="risk-watch-item-top">
                        <span className="risk-watch-item-title">{r.vehicle_name}</span>
                        <span className={`risk-watch-tag${r.state === 'not_ready' ? ' is-critical' : ''}`}>
                          {(READINESS_BADGE[r.state]?.label ?? r.state).toUpperCase()}
                        </span>
                      </span>
                      <span className="risk-watch-item-sub">{r.category ?? '—'}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          {forecastOut.length === 0 && preventiveWatch.length === 0 && overdueSchedules.length === 0 ? (
            <p className="risk-watch-footer-ok">
              <Icon name="checkCircle" size={13} /> All vehicles available — nothing out for maintenance.
              <span className="area-chart-tag">{forecast.available_now} ready</span>
            </p>
          ) : (
            <div className="risk-watch-footer-list">
              {forecastOut.map((v) => (
                <div key={v.vehicle_id} className="risk-watch-footer-row">
                  <span>{v.vehicle_name}</span>
                  <span>{v.estimated_return_date ? `Ready by ${formatForecastDate(v.estimated_return_date)}` : 'No estimate yet'}</span>
                </div>
              ))}
              {(preventiveWatch.length > 0 ? preventiveWatch : overdueSchedules).map((s) => (
                <div key={s.schedule_id} className="risk-watch-footer-row">
                  <span>{s.vehicle_name ?? s.vehicle?.vehicle_name ?? '—'} · {s.maintenance_type}</span>
                  <span className={(s.state ? s.state === 'overdue' : true) ? 'is-overdue' : ''}>
                    {(s.state ? s.state === 'overdue' : true) ? 'OVERDUE' : 'DUE SOON'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </DashboardListModal>
      )}

      {/* SECTION 4 — Can we respond, and why do vehicles keep going down?
          Readiness used to be a full-width band with a half-empty right
          side; pairing it with the failure-cause chart fills the row and
          puts the cause right next to the consequence. */}
      <section className="panel col-span-7">
        <div className="panel-header-bar">
          <h3><Icon name="checkCircle" size={16} /> Readiness by Vehicle Type</h3>
          {fleetSummary && (
            <span className="area-chart-tag">
              {fleetSummary.verified_ready} of {fleetSummary.operational_total} verified ready
            </span>
          )}
        </div>
        {readiness.length === 0 ? (
          <p className="empty-state">No vehicle types to show yet.</p>
        ) : (
          <div className="emergency-readiness-rows">
            {readiness.map((r) => <ReadinessRow key={r.category} r={r} />)}
          </div>
        )}
        {noCoverage.length > 0 && (
          <p className="emergency-readiness-alert">
            <Icon name="alert" size={13} /> No coverage: {noCoverage.map((r) => r.category).join(', ')}
          </p>
        )}
      </section>

      {showBreakingMost ? (
        <section className="panel col-span-5">
          <div className="panel-header-bar">
            <h3><Icon name="wrench" size={16} /> What's Breaking Most</h3>
            <span className="area-chart-tag">Last 12 months</span>
          </div>
          <div className="dashboard-panel-chart-body">
            <HorizontalBarChart rows={failurePatterns.map((p) => ({ label: p.type, value: p.count }))} />
            <p className="muted" style={{ marginTop: 8, fontSize: '0.78rem' }}>{failurePatterns[0]?.type ?? 'This'} affects {failurePatterns[0]?.count ?? 0} vehicles — a common cause worth fixing at the root.</p>
          </div>
        </section>
      ) : (
        <section className="panel col-span-5">
          <div className="panel-header-bar">
            <h3>Operations Queue</h3>
            <span className="area-chart-tag">{maintenanceExpenses}</span>
          </div>
          <div className="dashboard-panel-chart-body">
            <ColumnChart rows={operationsQueue} />
            <div className="graph-footnote">
              <span>Total maintenance expenses</span>
              <strong>{maintenanceExpenses}</strong>
            </div>
          </div>
        </section>
      )}

      {/* SECTION 5 — Fleet composition: where the vehicles are, and what
          kinds exist. Two halves of one question, so they share a row
          instead of stacking as two more full-width bands. */}
      <section className="panel col-span-6">
        <div className="panel-header-bar">
          <h3><Icon name="pin" size={16} /> Vehicles by Location</h3>
          <span className="area-chart-tag">{locationsByHub.length} sites</span>
        </div>
        <div className="dashboard-panel-chart-body">
          <HorizontalBarChart rows={locationsByHub} />
        </div>
      </section>

      <section className="panel col-span-6">
        <div className="panel-header-bar">
          <h3><Icon name="vehicle" size={16} /> Vehicles by Type</h3>
          <span className="area-chart-tag">{data.vehicles_by_type?.length ?? 0} types</span>
        </div>
        <div className="dashboard-panel-chart-body">
          <HorizontalBarChart rows={data.vehicles_by_type} />
        </div>
      </section>
    </div>
  );
}

// Formats a plain YYYY-MM-DD date for the Availability Forecast (e.g. "Jul 14, 2026").
function formatForecastDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function buildLocalGreeting(name = 'User', date = new Date()) {
  const displayName = firstName(name);
  const hour = date.getHours();

  if (hour >= 5 && hour < 12) {
    return randomGreeting([
      `Rise and shine, ${displayName}!`,
      `A bright morning to you, ${displayName}!`,
      `Fresh start, ${displayName}! Let's keep the fleet moving.`,
      `Morning momentum is here, ${displayName}!`,
    ]);
  }

  if (hour === 12) {
    return randomGreeting([
      `Happy noon, ${displayName}!`,
      `Midday check-in, ${displayName}! The fleet is ready.`,
      `It's noon, ${displayName}! Keep the day rolling.`,
      `A steady noon to you, ${displayName}!`,
    ]);
  }

  if (hour >= 13 && hour < 15) {
    return randomGreeting([
      `A pleasant afternoon, ${displayName}!`,
      `Good energy this afternoon, ${displayName}!`,
      `Afternoon focus is on, ${displayName}!`,
      `Keep the dashboard sharp this afternoon, ${displayName}!`,
    ]);
  }

  if (hour >= 15 && hour < 18) {
    return randomGreeting([
      `It's late afternoon, ${displayName}!`,
      `Late afternoon focus, ${displayName}!`,
      `A strong late afternoon to you, ${displayName}!`,
      `The day is still moving, ${displayName}!`,
    ]);
  }

  if (hour >= 18 && hour < 22) {
    return randomGreeting([
      `A calm evening to you, ${displayName}!`,
      `Evening check-in, ${displayName}! The fleet is in view.`,
      `Good evening, ${displayName}! Keep things steady.`,
      `The evening shift is looking sharp, ${displayName}!`,
    ]);
  }

  return randomGreeting([
    `Working late, ${displayName}? The dashboard is ready.`,
    `Quiet night watch, ${displayName}!`,
    `Late-night focus, ${displayName}!`,
    `The fleet rests easier with you here, ${displayName}!`,
  ]);
}

function randomGreeting(messages) {
  return messages[Math.floor(Math.random() * messages.length)];
}

function firstName(name = 'User') {
  return (String(name || 'User').trim().split(/\s+/)[0] || 'User').toUpperCase();
}

function dashboardRoleLabel(role = 'User') {
  const labels = {
    Admin: 'Administrator',
    Custodian: 'Custodian',
    'Maintenance Personnel': 'Maintenance',
  };

  return labels[role] ?? role;
}

function dashboardMetricValue(metrics, label) {
  const rawValue = metrics.find((metric) => metric.label === label)?.value ?? 0;
  if (typeof rawValue === 'number') {
    return rawValue;
  }
  const parsed = Number.parseFloat(String(rawValue).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
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
          // Stacked on top of the max thumb once they meet at the same stop
          // (e.g. narrowing the filter down to "Medium" only) — otherwise,
          // since it's first in the DOM, the max thumb always paints over it
          // and permanently swallows the drag, leaving the min thumb stuck
          // and the range impossible to widen back out.
          style={{ zIndex: minIndex >= maxIndex ? 2 : 1 }}
          onChange={(e) => onChange(Math.min(Number(e.target.value), maxIndex), maxIndex)}
        />
        <input
          type="range"
          className="dual-range-input"
          min={0}
          max={lastIndex}
          step={1}
          value={maxIndex}
          style={{ zIndex: minIndex >= maxIndex ? 1 : 2 }}
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

function SolidPieLegend({ segments, total }) {
  const shown = segments.filter((s) => s.value > 0);
  if (!shown.length) return null;
  return (
    <div className="solid-pie-legend">
      {shown.map((s) => (
        <div className="solid-pie-legend-item" key={s.label}>
          <span className="solid-pie-legend-dot" style={{ background: s.color }} />
          <div>
            <p className="solid-pie-legend-label" style={{ color: s.color }}>{s.label}</p>
            <p className="solid-pie-legend-pct">{total ? Math.round((s.value / total) * 100) : 0}%</p>
            <p className="solid-pie-legend-count">{s.value} issue{s.value === 1 ? '' : 's'}</p>
          </div>
        </div>
      ))}
    </div>
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
function FormModal({ open, title, onClose, children, wide = false }) {
  const notice = useContext(FormNoticeContext);

  if (!open) return null;

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className={`modal-box${wide ? ' modal-box-wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="modal-close-btn" onClick={onClose} type="button" aria-label="Close"><Icon name="close" size={18} /></button>
        </div>
        {notice && notice.type === 'error' && (
          <div className="notice error" style={{ margin: '12px 28px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', textAlign: 'center', flexDirection: 'column' }}>
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
  const initials = user.name
    ? user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()
    : 'U';

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
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

const ISSUE_STATUS_COLORS = {
  'Pending': '#f59e0b',
  'Under Review': '#a855f7',
  'In Maintenance': '#2563eb',
  'Resolved': '#22c55e',
};

// Full-page issue detail — mirrors the vehicle/ticket profile pages so every
// "View" action opens its own page rather than a modal, consistently for all roles.
// Fetches by ID rather than looking the issue up in an already-loaded list —
// a pure Custodian's own list is filtered to "mine", but a "View" link from
// the duplicate-issue warning is specifically for a report FILED BY SOMEONE
// ELSE on the same vehicle, which that filtered list would never contain.
function IssueViewPage({ issueId, allIssues = [], allHubs = [], user, onCreateTicketFromIssue, onDismissIssue, onRecommendTicket }) {
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
    setLoading(true);
    api.get(`/issues/${issueId}`)
      .then((response) => { setIssue(response.data); setNotFound(false); })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [issueId]);

  useEffect(() => {
    if (!issue?.vehicle_id) { setRecurrence(null); return; }
    let cancelled = false;
    api.get(`/vehicles/${issue.vehicle_id}/recurrence`, { params: { issue_type: issue.issue_type, title: issue.issue_type } })
      .then((r) => { if (!cancelled) setRecurrence(r.data); })
      .catch(() => { if (!cancelled) setRecurrence(null); });
    return () => { cancelled = true; };
  }, [issue?.vehicle_id, issue?.issue_type]);

  const hub = allHubs.find((h) => h.name === issue?.vehicle?.current_location);

  // This vehicle's full issue-report history, broken down by status — reuses
  // the already-loaded issues list, no extra API call.
  const historySegments = useMemo(() => {
    if (!issue?.vehicle_id) return [];
    const forThisVehicle = allIssues.filter((i) => i.vehicle_id === issue.vehicle_id);
    return Object.entries(ISSUE_STATUS_COLORS).map(([label, color]) => ({
      label,
      color,
      value: forThisVehicle.filter((i) => i.status === label).length,
    }));
  }, [allIssues, issue?.vehicle_id]);
  const historyTotal = historySegments.reduce((sum, s) => sum + s.value, 0);

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
          <span className="ticket-detail-id">Issue #{issue.issue_report_id}</span>
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
                        Ticket #{issue.maintenance_ticket.ticket_id}
                      </button>
                    ) : <>Ticket #{issue.maintenance_ticket.ticket_id}</>}
                    {' '}<TicketStatusBadge value={issue.maintenance_ticket.status} />
                  </p>
                )}
              </div>
            </div>
          </section>

          <section className="veh-card issue-view-desc">
            <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>Description &amp; Remarks</h4></div>
            <div className="issue-view-text">
              <p>{issue.issue_description || '-'}</p>
              {issue.remarks && (
                <div className="issue-view-remarks">
                  <span className="issue-view-remarks-label"><Icon name="clipboard" size={12} /> Remarks</span>
                  <p>{issue.remarks}</p>
                </div>
              )}
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

          {historyTotal > 0 && (
            <section className="veh-card">
              <div className="veh-card-head"><Icon name="grid" size={16} /><h4>Issue History</h4></div>
              <p className="solid-pie-subtitle">{issue.vehicle?.vehicle_name ?? 'This vehicle'} — {historyTotal} report{historyTotal === 1 ? '' : 's'} total</p>
              <SolidPieLegend segments={historySegments} total={historyTotal} />
              <SolidPieChart segments={historySegments} />
            </section>
          )}
        </div>
      </div>
    </ModulePanel>
  );
}

function ProfileMenu({ user, open, setOpen, onLogout, onOpenNotifications, onOpenSettings }) {
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
          <button className="profile-menu-item" type="button" onClick={() => { onOpenNotifications(); setOpen(false); }}>
            <Icon name="bell" size={15} /> Notifications
          </button>

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

function profileFields(existingPhotoUrl) {
  return [
    { label: 'Full Name', name: 'name', required: true, type: 'text' },
    { label: 'Email', name: 'email', required: true, type: 'text', placeholder: 'name@barangay.gov' },
    { label: 'Phone', name: 'phone', type: 'tel', pattern: '[0-9]{10}', placeholder: '09XXXXXXXXX', title: 'Phone must be exactly 10 digits' },
    { label: 'Address', name: 'address', type: 'text' },
    { label: 'Profile Photo', name: 'photo', accept: 'image/*', type: 'file', existingUrl: existingPhotoUrl },
  ];
}

/** Self-service profile page (all roles) — editable details (same fields/layout
 * an Admin uses on Update User) plus a separate password-change section, since
 * that one stays gated behind old-password verification. */
function ProfilePage({ user, onBack, setNotice, refreshUser, onDirty }) {
  const initials = user.name ? user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() : 'U';
  const roles = (Array.isArray(user.roles) && user.roles.length) ? user.roles : [user.role].filter(Boolean);

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
      <div className="vehicle-profile-header">
        <div className="vehicle-profile-identity">
          <span className="ticket-detail-id">My Profile</span>
          <h3 className="ticket-detail-title">{user.name}</h3>
        </div>
      </div>

      <div className="profile-page">
        <div className="profile-hero">
          <div className="profile-hero-avatar">
            {user.photo_url
              ? <img src={resolvePhotoUrl(user.photo_url)} alt={user.name} />
              : <span>{initials}</span>}
          </div>
          <div className="profile-hero-info">
            <h2>{user.name}</h2>
            <p className="muted">{user.email}</p>
            <div className="profile-hero-roles">{roles.map((r) => <StatusBadge key={r} value={r} />)}</div>
          </div>
        </div>

        <div className="profile-section">
          <h4 className="profile-section-title"><Icon name="edit" size={15} /> Edit Details</h4>
          <p className="muted profile-section-hint">Keep your contact information up to date.</p>
          <div className="form-grid-2col user-form-grid">
            <SmartForm
              fields={profileFields(user.photo_url)}
              initialValues={user}
              key="profile-details"
              onCancel={onBack}
              onSubmit={updateDetails}
              onValuesChange={() => onDirty?.()}
              submitLabel="Save Changes"
              title=""
            />
          </div>
        </div>

        <div className="profile-section">
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
        </div>
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
      <select
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
      </select>
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

// Phase B4 — catalog.create (fault categories / maintenance types) is
// Admin-only now. Everywhere a Custodian or Maintenance Personnel used to
// get CreatableSelect's "+ Add New" affordance on one of these two
// catalogs, this replaces it: a plain select with "Other" pinned as the
// last option. Picking it reveals a free-text note below — `value` stays a
// real catalog name, or the literal CATALOG_OTHER_VALUE sentinel; `note` is
// kept separate, meant to be folded into whichever description/notes field
// the parent form already sends to the backend (rather than trying to mint
// a new catalog value, which only Admin can still do). Admin keeps the
// original CreatableSelect wherever this replaces it — this component is
// never shown to Admin.
const CATALOG_OTHER_VALUE = 'Other';

function CatalogOrOtherField({ value, onChange, note, onNoteChange, options = [], required = false, placeholder = 'Select an option', otherNoteLabel = 'Describe the issue/type' }) {
  const isOther = value === CATALOG_OTHER_VALUE;
  return (
    <>
      <select
        required={required}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{placeholder}</option>
        {options.map((option, i) => (
          <option key={option?.value != null ? option.value : `opt-${i}`} value={option?.value ?? option ?? ''}>
            {option?.label ?? option}
          </option>
        ))}
        <option value={CATALOG_OTHER_VALUE}>Other</option>
      </select>
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
function collectValidationErrors(fields, values) {
  const lines = [];
  fields.forEach((field) => {
    const value = values[field.name];

    if (field.type === 'checkboxes') {
      if (field.required && !(Array.isArray(value) && value.length > 0)) {
        lines.push(`${field.label}: select at least one.`);
      }
      return;
    }

    if (field.type === 'list') {
      const rows = Array.isArray(value) ? value : [];
      if (field.required && !rows.some((row) => row.trim())) {
        lines.push(`${field.label} is required.`);
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
          lines.push(`${field.label} is required.`);
        }
      }
      return;
    }

    if (field.confirmOf) {
      if (field.required && isValueMissing(value)) {
        lines.push(`${field.label} is required.`);
      } else if (value && value !== values[field.confirmOf]) {
        lines.push(`${field.label} does not match.`);
      }
      return;
    }

    if (field.required && isValueMissing(value)) {
      lines.push(`${field.label} is required.`);
      return;
    }

    if (field.type === 'number' && value !== '' && value != null) {
      const num = Number(value);
      if (field.min != null && num < Number(field.min)) {
        lines.push(`${field.label} must be at least ${field.min}.`);
      }
      if (field.max != null && num > Number(field.max)) {
        lines.push(`${field.label} must be at most ${field.max}.`);
      }
    }

    if (field.pattern && value && !new RegExp(`^(?:${field.pattern})$`).test(value)) {
      lines.push(field.title || `${field.label} is invalid.`);
    }
  });
  return lines;
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

function SmartForm({ fields, initialValues = EMPTY_OBJ, onCancel, cancelLabel = 'Cancel', onSubmit, submitLabel, title, onValuesChange }) {
  const [values, setValues] = useState(() => valuesFromFields(fields, initialValues));
  const [submitting, setSubmitting] = useState(false);
  // Per-field show/hide toggle for password inputs — keyed by field name so
  // e.g. Old/New/Confirm Password on the same form toggle independently.
  const [visiblePasswords, setVisiblePasswords] = useState({});
  const [validationLines, setValidationLines] = useState(null);

  useEffect(() => {
    setValues(valuesFromFields(fields, initialValues));
  }, [initialValues]);

  const handleChange = (event) => {
    const { name, type, files, value } = event.target;
    const field = fields.find((f) => f.name === name);
    let nextValue = field?.uppercase ? value.toUpperCase() : value;
    if (field?.type === 'tel' && name === 'phone') {
      nextValue = value.replace(/[^0-9]/g, '').slice(0, 10);
    }
    // 'multi-file' fields render their own dropzone/input with a dedicated
    // onChange (see the field renderer below) — this generic handler only
    // ever sees single-file and non-file fields.
    const finalValue = type === 'file' ? files[0] : nextValue;
    const next = { ...values, [name]: finalValue };
    setValues(next);
    onValuesChange?.(next);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    const lines = collectValidationErrors(fields, values);
    if (lines.length) {
      setValidationLines(lines);
      return;
    }

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
      // Phase B4 — a 'catalog-or-other' field's typed note never has a
      // backend column of its own (Custodian/Maintenance Personnel can no
      // longer mint a new catalog value, so "Other" + a note stands in for
      // it). Runs as its own pass, after the 'list' join above, so folding
      // the note into another field this same form owns (e.g. a textarea
      // that started as an array) appends to the already-joined string, not
      // the raw array.
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
    <form className="smart-form" onSubmit={handleSubmit} noValidate autoComplete="off">
      {validationLines && (
        <div className="toast-notice-overlay" onClick={() => setValidationLines(null)}>
          <div className="toast-notice toast-notice-validation error" role="alert" onClick={(e) => e.stopPropagation()}>
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
      {submitting && createPortal(
        <div className="loading-overlay">
          <div className="loading-overlay-card">
            <Icon name="gear" size={34} className="loading-overlay-gear" filled />
            <span>Loading…</span>
          </div>
        </div>,
        document.body
      )}
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
        return (
        <Fragment key={field.name}>
        <label
          className={[field.compactFile ? 'file-inline' : null, fieldHasValue ? 'has-value' : null].filter(Boolean).join(' ') || undefined}
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
                min="0"
                onChange={(e) => setValues((current) => ({
                  ...current,
                  [field.name]: `${e.target.value} ${quantity.unit}`.trim(),
                }))}
                placeholder={field.placeholder}
                required={field.required}
                step="any"
                type="number"
                value={quantity.amount}
              />
              <select
                onChange={(e) => setValues((current) => ({
                  ...current,
                  [field.name]: `${quantity.amount} ${e.target.value}`.trim(),
                }))}
                value={quantity.unit}
              >
                {field.units.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
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
            <select
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
                  style={option?.value === NEW_ISSUE_OPTION.value ? { color: '#2563eb', fontWeight: 700 } : undefined}
                >
                  {option?.label ?? option}
                </option>
              ))}
            </select>
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
              maxLength={field.maxLength}
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
          {field.type === 'file' ? (
            <div className={`photo-box${isFile(values[field.name]) || field.existingUrl ? ' has-file' : ''}`}>
              <input
                accept={field.accept}
                className="photo-box-input"
                id={`photo-box-input-${field.name}`}
                name={field.name}
                onChange={handleChange}
                required={field.required}
                type="file"
              />
              <label className="photo-box-add-btn" htmlFor={`photo-box-input-${field.name}`}>
                <Icon name="plus" size={10} />
                {isFile(values[field.name]) || field.existingUrl ? 'Change Image' : 'Add Image'}
              </label>
              {isFile(values[field.name]) ? (
                <button
                  type="button"
                  className="photo-box-remove"
                  onClick={() => {
                    const next = { ...values, [field.name]: null };
                    setValues(next);
                    onValuesChange?.(next);
                  }}
                  title="Remove image"
                  aria-label="Remove image"
                >
                  <Icon name="trash" size={13} />
                </button>
              ) : null}
              {isFile(values[field.name]) ? (
                values[field.name].type.startsWith('image/') ? (
                  <img alt={field.label} className="photo-box-fill" src={URL.createObjectURL(values[field.name])} />
                ) : (
                  <div className="photo-box-file">
                    <Icon name="clipboard" size={28} />
                    <span>{values[field.name].name}</span>
                  </div>
                )
              ) : field.existingUrl ? (
                // Not a freshly-picked File — the vehicle's already-saved photo,
                // shown so editing doesn't look like it wiped out the photo that
                // was there all along. No remove button here: the backend only
                // ever replaces photo_url when a new file is uploaded, it has no
                // "clear the photo" path, so offering removal would be a lie.
                <img alt={field.label} className="photo-box-fill" src={resolvePhotoUrl(field.existingUrl)} />
              ) : (
                <div className="photo-box-empty">
                  <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="15" rx="2" />
                    <circle cx="9" cy="10" r="1.8" />
                    <path d="M4.5 17.5 9 13l3 3 4-4.5 3.5 4" />
                  </svg>
                  <span>No image available</span>
                </div>
              )}
            </div>
          ) : null}
          {field.type === 'multi-file' ? (() => {
            const existingFiles = Array.isArray(field.existingAttachments) ? field.existingAttachments : [];
            const pendingFiles = Array.isArray(values[field.name]) ? values[field.name] : [];
            const addFiles = (incoming) => {
              const list = Array.from(incoming ?? []).filter(Boolean);
              if (!list.length) return;
              const next = { ...values, [field.name]: [...pendingFiles, ...list] };
              setValues(next);
              onValuesChange?.(next);
            };
            const inputId = `multi-file-input-${field.name}`;
            return (
              <div className="multi-file-field file-card-like">
                <div className="multi-file-body">
                  {existingFiles.length || pendingFiles.length ? (
                    <div className="multi-file-list">
                      {existingFiles.map((att) => (
                        <div key={`existing-${att.attachment_id}`} className="multi-file-item is-existing">
                          <Icon name="clipboard" size={14} />
                          <a className="multi-file-name" href={resolvePhotoUrl(att.file_url)} target="_blank" rel="noreferrer">
                            {att.original_name || 'File'}
                          </a>
                          {field.onRemoveExisting && (
                            <button type="button" className="multi-file-remove" onClick={() => field.onRemoveExisting(att)} title="Remove file" aria-label="Remove file">
                              <Icon name="close" size={12} />
                            </button>
                          )}
                        </div>
                      ))}
                      {pendingFiles.map((file, i) => (
                        <div key={`pending-${file.name}-${i}`} className="multi-file-item">
                          <Icon name="clipboard" size={14} />
                          <span className="multi-file-name">{file.name}</span>
                          <button
                            type="button"
                            className="multi-file-remove"
                            onClick={() => {
                              const next = { ...values, [field.name]: pendingFiles.filter((_, fi) => fi !== i) };
                              setValues(next);
                              onValuesChange?.(next);
                            }}
                            title="Remove file"
                            aria-label="Remove file"
                          >
                            <Icon name="close" size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="file-card-empty">No data</div>
                  )}
                  <label
                    className="file-card-dropzone multi-file-dropzone"
                    htmlFor={inputId}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
                  >
                    <input
                      accept={field.accept}
                      className="multi-file-input"
                      id={inputId}
                      multiple
                      name={field.name}
                      onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
                      type="file"
                    />
                    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M7 18a4.5 4.5 0 0 1-1-8.9A5.5 5.5 0 0 1 16.7 7 4.5 4.5 0 0 1 18 18" />
                      <path d="M12 12v7" />
                      <path d="M9.5 14.5 12 12l2.5 2.5" />
                    </svg>
                    <span>Drag file here</span>
                  </label>
                </div>
              </div>
            );
          })() : null}
          {field.inlineExtra ? (
            <div className="field-extra field-extra-inline">
              {typeof field.inlineExtra === 'function' ? field.inlineExtra(values) : field.inlineExtra}
            </div>
          ) : null}
          {field.hint ? <small className="field-hint">{field.hint}</small> : null}
        </label>
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
  boundaryRings,
  boundaryLabel,
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
        if (!isPointWithinBoundaryRings(match, boundaryRings)) {
          setError(`That address is outside the ${boundaryLabel} boundary — only locations within ${boundaryLabel} can be added.`);
        }
      } catch (err) {
        setError(err.message || 'Address lookup failed.');
      } finally {
        setLookingUp(false);
      }
    }, 700);

    return () => clearTimeout(timer);
  }, [address, boundaryRings, boundaryLabel]);

  const handleMapPick = useCallback(async (latLng) => {
    setMarker(latLng);
    setError(null);

    if (!isPointWithinBoundaryRings(latLng, boundaryRings)) {
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
  }, [boundaryRings, boundaryLabel]);

  const isPinValid = marker && isPointWithinBoundaryRings(marker, boundaryRings);
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
            <div className="toast-notice toast-notice-validation error" role="alert">
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
              {lookingUp ? 'Looking up…' : `Must be within the ${boundaryLabel} boundary — you can also click the map to pinpoint it.`}
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
          <AddLocationMap marker={marker} boundaryRings={boundaryRings} onPick={handleMapPick} />
        </div>
      </form>
    </ModulePanel>
  );
}

function NewLocationPage({ onBack, boundaryRings, boundaryLabel, onSubmit }) {
  return (
    <LocationAddressMapForm
      mode="add"
      boundaryRings={boundaryRings}
      boundaryLabel={boundaryLabel}
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
function EditLocationPage({ row, allHubs, boundaryRings, boundaryLabel, onBack, onSubmit }) {
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
      boundaryRings={boundaryRings}
      boundaryLabel={boundaryLabel}
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
                >
                  {columns.map((column) => (
                    <td key={column.label} className={column.className}>{column.render ? column.render(row) : row[column.key]}</td>
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
function SubmitLoadingOverlay({ label = 'Saving…' }) {
  return createPortal(
    <div className="modal-overlay submit-loading-overlay" role="status" aria-live="polite">
      <div className="submit-loading-card">
        <Icon name="gear" size={48} className="submit-loading-gear" filled />
        <p className="submit-loading-label">{label}</p>
      </div>
    </div>,
    document.body
  );
}

function ModuleLoader({ label = 'Loading module data' }) {
  return (
    <div className="module-loader" role="status" aria-live="polite">
      <div className="module-loader-card">
        <span className="module-loader-spinner" aria-hidden="true">
          <svg viewBox="0 0 50 50" width="44" height="44">
            <circle className="module-loader-track" cx="25" cy="25" r="20" fill="none" strokeWidth="5" />
            <circle className="module-loader-arc" cx="25" cy="25" r="20" fill="none" strokeWidth="5" strokeLinecap="round" />
          </svg>
        </span>
        <span className="module-loader-label">{label}<span className="module-loader-dots" /></span>
      </div>

      <div className="skeleton-table" aria-hidden="true">
        <div className="skeleton-row skeleton-head">
          {Array.from({ length: 5 }).map((_, i) => <span className="skeleton-cell" key={i} />)}
        </div>
        {Array.from({ length: 5 }).map((_, r) => (
          <div className="skeleton-row" key={r} style={{ animationDelay: `${r * 0.08}s` }}>
            {Array.from({ length: 5 }).map((_, c) => <span className="skeleton-cell" key={c} />)}
          </div>
        ))}
      </div>
    </div>
  );
}

function ReportPreview({ report }) {
  if (!report) {
    return <p className="empty-state">Choose a report type and filters to generate a preview.</p>;
  }

  const rows = report.rows ?? [];
  const columns = reportColumns(rows);

  return (
    <section>
      <div className="report-heading">
        <div>
          <h3>{report.report_type}</h3>
          <p>Generated by {report.generated_by} on {formatDate(report.generated_at)}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
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
      <DataTable columns={columns} rows={rows} />

      {/* Print-only — kept off-screen (see .report-print-view), shown by the
          Print button above. Portaled to <body>, same reasoning as the
          vehicle profile's .veh-print-report: the app's @media print rule
          hides #root entirely, so the printable content has to live outside
          it or Print produces a blank page. */}
      {createPortal(
        <div className="report-print-view">
          <div className="veh-print-header">
            <div className="veh-print-header-left">
              <h2>{report.report_type}</h2>
              <p>Generated by {report.generated_by} on {formatDate(report.generated_at)}</p>
            </div>
            <div className="veh-print-header-right">
              <Icon name="gear" size={48} className="topbar-gear-icon" filled />
              <span className="vms-wordmark">vms</span>
            </div>
          </div>
          <table className="report-print-table">
            <thead>
              <tr>{columns.map((col) => <th key={col.label}>{col.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.length ? rows.map((row, i) => (
                <tr key={row.id ?? i}>{columns.map((col) => <td key={col.label}>{col.render(row)}</td>)}</tr>
              )) : (
                <tr><td colSpan={columns.length || 1}>No records</td></tr>
              )}
            </tbody>
          </table>
        </div>,
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

const categoryFields = [
  { label: 'Vehicle Type Name', name: 'category_name', required: true, type: 'text', placeholder: 'e.g. Fire Truck, Rescue Boat' },
  {
    label: 'Domain', name: 'domain', options: ['Land', 'Water'], required: true, type: 'select',
    hint: 'Water changes what a vehicle of this type asks for elsewhere — hull material and engine type instead of the usual land specs.',
  },
  {
    label: 'Default Criticality', name: 'default_criticality', options: CRITICALITY_LEVELS, type: 'select',
    hint: 'How much a vehicle of this type matters operationally. Critical vehicles surface first on the readiness watch. Admin can override it per vehicle.',
  },
  { label: 'Description', name: 'description', type: 'textarea', placeholder: 'Optional notes about when to use this type' },
];

// `liveValues` lets Confirm Password become required only once a new
// password has actually been typed — editing an Admin resets someone
// else's password, so unlike the self-service My Profile flow there's
// deliberately no Current Password field: the whole point of an admin
// reset is that they don't (and shouldn't need to) know the old one.
function userFields(isEditing, liveValues = EMPTY_OBJ) {
  return [
    { label: 'Full Name', name: 'name', required: true, type: 'text' },
    { label: 'Email', name: 'email', required: true, type: 'text', placeholder: 'name@barangay.gov' },
    { label: 'Phone', name: 'phone', type: 'tel', pattern: '[0-9]{10}', placeholder: '09XXXXXXXXX', title: 'Phone must be exactly 10 digits' },
    { label: 'Address', name: 'address', type: 'text' },
    // Deliberately paired side by side, in this order, both NOT full-width:
    // the grid's dense auto-flow (App.css .form-grid-2col .smart-form)
    // only backfills gaps when one exists — keeping every field here a
    // plain single-column item, in strict declared order, means each row
    // fills left-then-right with no gaps for later fields to jump into
    // (which is what previously stranded Confirm Password alone).
    { label: 'Roles (a person can hold more than one — the first is their primary)', name: 'roles', options: ['Admin', 'Custodian', 'Maintenance Personnel'], required: true, type: 'checkboxes' },
    // Production-readiness audit finding #6 — vehicle registration is a
    // per-account delegation an Admin grants a specific Custodian, not a
    // blanket role grant. Only shown once Custodian is actually selected
    // above; Admin already always registers regardless of this flag.
    ...(Array.isArray(liveValues.roles) && liveValues.roles.includes('Custodian')
      ? [{
          label: 'Vehicle Registration',
          name: 'can_register_vehicles',
          options: ['Allow vehicle registration'],
          type: 'checkboxes',
        }]
      : []),
    { label: 'Profile Photo', name: 'photo', accept: 'image/*', type: 'file' },
    {
      label: isEditing ? 'New Password (leave blank to keep current)' : 'Password',
      name: 'password',
      required: !isEditing,
      type: 'password',
    },
    {
      label: isEditing ? 'Confirm New Password' : 'Confirm Password',
      name: 'password_confirmation',
      required: isEditing ? Boolean(liveValues.password) : true,
      type: 'password',
      confirmOf: 'password',
    },
  ];
}

const verificationFields = [
  { label: 'Verification Result', name: 'verification_result', options: ['Passed', 'Failed'], required: true, type: 'select' },
  { label: 'Verification Notes', name: 'verification_notes', type: 'textarea' },
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
            title: 'Enter a valid plate number, e.g. ABC 1234 or ABC-1234', uppercase: true, maxLength: 10,
          },
      {
        label: 'Vehicle Type',
        name: 'category_id',
        options: lookups.categories.filter((c) => c.domain === domainFilter),
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
    setDomainFilter(wizardData.vehicle_domain ?? '');
    setStep(n);
  };

  const handleStepSubmit = async (values) => {
    const merged = { ...wizardData, ...values };
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
          onValuesChange={(vals) => { setDomainFilter(vals.vehicle_domain ?? ''); onDirty?.(); }}
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
              : `#${r.ticket_id} ${r.ticket_title} — ${r.status}`;
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
function FormPage({ description, onBack, fields, initialValues, onSubmit, submitLabel, contextVehicles, hubs, warnEndpoint, warnRender, reviewStep = false, wrapperClassName, formTitle = '', onDirty, showDomainPreview = false, categoryVehicleCount = null }) {
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
  const skippedFirstReset = useRef(false);
  useEffect(() => {
    if (!skippedFirstReset.current) { skippedFirstReset.current = true; return; }
    setLiveValues(initialValues ?? EMPTY_OBJ);
    setSmartFormSeed(initialValues ?? EMPTY_OBJ);
    setStep(1);
  }, [initialValues]);

  const hasContext = Boolean(contextVehicles?.length);
  const vehicle = hasContext
    ? contextVehicles.find((v) => String(v.vehicle_id) === String(liveValues?.vehicle_id))
    : null;
  const hub = vehicle ? (hubs ?? []).find((h) => h.name === vehicle.current_location) : null;

  // #7 — when a warn endpoint is provided (e.g. open issues on this vehicle),
  // fetch it as the vehicle is picked so the form can show a duplicate warning.
  const warnVehicleId = liveValues?.vehicle_id ?? null;
  useEffect(() => {
    if (!warnEndpoint || !warnVehicleId) { setWarnRows([]); return; }
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
  const useSideLayout = (hasContext || showDomainPreview) && !reviewStep;

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
        <div className="form-context-layout">
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
                <Icon name="vehicle" size={30} />
                <p>Select a vehicle in the form and its photo, details, and location will show here.</p>
              </section>
            )}

            {vehicle && !showDomainPreview && (
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

          </div>
          <div className="form-context-form-col">
            <div className={`form-grid-2col form-context-form${wrapperClassName ? ` ${wrapperClassName}` : ''}`}>{form}</div>
            {/* Stacked below the form fields, inside the same column, so it
                fills the free space the form's shorter height leaves behind
                instead of floating full-width beneath both columns. */}
            {vehicle && !showDomainPreview && (
              <section className="veh-card form-context-map-inline">
                <div className="veh-card-head"><Icon name="pin" size={16} /><h4>{vehicle.current_location ?? 'Location unknown'}</h4></div>
                <div className="veh-map-wrap form-context-map-expanded">
                  <VehicleLocationMap lat={hub?.lat} lng={hub?.lng} label={vehicle.current_location} />
                </div>
              </section>
            )}
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

function conditionFields(lookups) {
  return [
    { label: 'Vehicle', name: 'vehicle_id', options: vehicleOptions(lookups), required: true, type: 'select' },
    { label: 'Condition Result', name: 'condition_result', options: lookups.condition_results, required: true, type: 'select' },
    { label: 'Observations', name: 'observations', type: 'textarea' },
  ];
}

function issueFields(lookups, editTarget, role, onAddVehicle) {
  if (editTarget?.issue_report_id && role === 'Custodian') {
    return [
      // Phase B4 — catalog.create (fault categories) is Admin-only now, so
      // a Custodian no longer gets the "+ Add New" affordance here — "Other"
      // + a note (folded into Remarks on submit, see SmartForm's handleSubmit)
      // stands in for it instead. Remarks itself isn't its own visible field
      // any more (it duplicated Issues Found) — otherNoteField still targets
      // it so an "Other" note has somewhere to land.
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
      // delegated Custodian) — anyone else would just hit a permissions wall.
      action: onAddVehicle ? { label: '+ Add Vehicle', onClick: onAddVehicle } : undefined,
    },
    // Phase B4 — Admin keeps the original "+ Add New" catalog affordance;
    // anyone else (a Custodian filing a fresh report) gets "Other" + a note
    // folded into Remarks instead, same as the edit-own path above.
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
      accept: 'image/*,.pdf',
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

function scheduleFields(lookups, allHubs = [], isEdit = false, suggestOnly = false) {
  const hubOptions = allHubs.map((hub) => ({ value: hub.name, label: hub.name }));

  // A Custodian's suggestion only needs what Admin must see: which vehicle,
  // what, roughly when, and why.
  const keep = suggestOnly ? ['vehicle_id', 'maintenance_type', 'scheduled_date', 'notes'] : null;
  const all = [
    { label: 'Vehicle', name: 'vehicle_id', options: vehicleOptions(lookups), required: true, type: 'select' },
    { label: 'Maintenance Type', name: 'maintenance_type', options: lookups.maintenance_types, required: true, type: 'creatable-select', newItemLabel: 'maintenance type', catalogEndpoint: '/maintenance-types' },
    { label: 'Scheduled Date', name: 'scheduled_date', required: true, type: 'date' },
    { label: 'Scheduled Time', name: 'scheduled_time', type: 'time' },
    // Recurring PM: completing this schedule auto-creates the next at the chosen
    // interval. Left blank = one-time (the default "Select" option).
    {
      label: 'Repeat Every (optional)',
      name: 'recurrence_months',
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
    { label: 'Service Location', name: 'service_location', type: 'select-or-other', options: hubOptions, otherLabel: 'Other / External Shop', otherPlaceholder: 'e.g. Toyota Service Center' },
    // Full-width only on create: with Status hidden there, it's the trailing
    // odd-one-out in the 2-column grid — spanning the full row reads as
    // intentional instead of leaving an empty cell beside it. On edit, Status
    // sits next to it instead, making the pair even again.
    { label: 'Assigned To', name: 'assigned_to', options: options(lookups.maintenance_personnel, 'id', 'name'), type: 'select', fullWidth: !isEdit },
    // Completed is deliberately never offered here — marking a schedule done
    // goes through the dedicated "Mark Done" action (creates the proof-of-work
    // record and, if recurring, the next occurrence); this field only ever
    // needs to cancel an existing one. Not shown at all when creating new.
    ...(isEdit ? [{ label: 'Status', name: 'status', options: ['Scheduled', 'Cancelled'], type: 'select' }] : []),
    { label: 'Notes', name: 'notes', type: 'textarea' },
  ];
  return keep ? all.filter((f) => keep.includes(f.name)) : all;
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
const DASHBOARD_METRIC_STYLES = {
  'Total Vehicles': { icon: 'grid', bg: '#dbeafe', color: '#2563eb' },
  'Available Vehicles': { icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
  'Vehicles Under Maintenance': { icon: 'wrench', bg: '#fef3c7', color: '#d97706' },
  'Inactive Vehicles': { icon: 'archive', bg: '#fee2e2', color: '#dc2626' },
  'Reported Issues': { icon: 'alert', bg: '#fee2e2', color: '#dc2626' },
  'Reported Vehicle Issues': { icon: 'alert', bg: '#fee2e2', color: '#dc2626' },
  'My Reported Issues': { icon: 'alert', bg: '#fee2e2', color: '#dc2626' },
  'Upcoming Maintenance': { icon: 'calendar', bg: '#ede9fe', color: '#7c3aed' },
  'Overdue Maintenance': { icon: 'alert', bg: '#fef3c7', color: '#d97706' },
  'Total Maintenance Expenses': { icon: 'clipboard', bg: '#e0f2fe', color: '#0284c7' },
  'Maintenance Records': { icon: 'clipboard', bg: '#e0f2fe', color: '#0284c7' },
  'Recently Completed Maintenance': { icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
  'Vehicles Needing Attention': { icon: 'wrench', bg: '#fef3c7', color: '#d97706' },
};
const DASHBOARD_METRIC_STYLE_DEFAULT = { icon: 'grid', bg: '#dbeafe', color: '#2563eb' };

// NOTE: no "In Use" card — the status exists in the DB enum but this system
// tracks availability only (no dispatch flow ever sets a vehicle to In Use).
const VEHICLE_STAT_CARDS = [
  { key: 'Available', label: 'Available', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
  { key: 'Under Maintenance', label: 'Under Maintenance', icon: 'wrench', bg: '#fef3c7', color: '#d97706' },
  { key: 'Inactive', label: 'Inactive', icon: 'archive', bg: '#fee2e2', color: '#dc2626' },
  // Distinct from "Available" — a vehicle can be Available yet never (or no
  // longer) proven ready by an actual readiness check. See responseReadinessState().
  { key: 'ReadyToRespond', label: 'Ready to Respond', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
  { key: 'NotReady', label: 'Not Ready to Respond', icon: 'alert', bg: '#fee2e2', color: '#dc2626' },
];

const ISSUE_STAT_CARDS = [
  { key: 'Pending', label: 'Pending', icon: 'alert', bg: '#fef3c7', color: '#d97706' },
  { key: 'Under Review', label: 'Under Review', icon: 'search', bg: '#e0f2fe', color: '#0284c7' },
  { key: 'In Maintenance', label: 'In Maintenance', icon: 'wrench', bg: '#fee2e2', color: '#dc2626' },
  { key: 'Resolved', label: 'Resolved', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
];

// Severity filter chips — same colors as the Issue Reports bar chart's own
// High/Medium/Low segments (see the StackedBarChart segments above).
const ISSUE_SEVERITY_CHIP_BG = { High: '#fee2e2', Medium: '#fef3c7', Low: '#e0f2fe' };
const ISSUE_SEVERITY_CHIP_COLOR = { High: '#dc2626', Medium: '#f59e0b', Low: '#0ea5e9' };

// Simplified per product direction: the urgency breakdown (Overdue/1-3
// Days/4-7 Days) was its own set of cards here — removed in favor of a
// plain upcoming list elsewhere on the dashboard. Row-level "Overdue"
// badges (isScheduleOverdue) still show urgency per-row; this stat row now
// only tracks status.
const SCHEDULE_STAT_CARDS = [
  { key: 'Pending Approval', label: 'Pending Approval', icon: 'alert', bg: '#fef3c7', color: '#d97706' },
  { key: 'Declined', label: 'Declined', icon: 'close', bg: '#fee2e2', color: '#dc2626' },
  { key: 'Completed', label: 'Completed', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
  // A schedule marked "Completed" only means the calendar task is done —
  // its record might still be sitting unverified. Its own filter so those
  // rows are findable instead of scrolling through fully-verified ones.
  { key: 'AwaitingVerification', label: 'Awaiting Verification', icon: 'search', bg: '#fef9c3', color: '#854d0e' },
  { key: 'Cancelled', label: 'Cancelled', icon: 'close', bg: '#f1f5f9', color: '#64748b' },
];

// Only shown to a Maintenance-Personnel-only viewer — "how many vehicles do
// I still need to do", not the fleet-wide count everyone else also sees.
const MY_ASSIGNED_SCHEDULE_CARD = { key: 'MyAssigned', label: 'Assigned to You', icon: 'wrench', bg: '#eff6ff', color: '#1d4ed8' };

const CONDITION_STAT_CARDS = [
  { key: 'Good', label: 'Good', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
  { key: 'Needs Inspection', label: 'Needs Inspection', icon: 'search', bg: '#e0f2fe', color: '#0284c7' },
  { key: 'Needs Repair', label: 'Needs Repair', icon: 'wrench', bg: '#fef3c7', color: '#d97706' },
  { key: 'Not Checked', label: 'Not Checked', icon: 'eyeOff', bg: '#f1f5f9', color: '#64748b' },
];

const MAINTENANCE_RECORD_STAT_CARDS = [
  { key: 'Assigned', label: 'Assigned', icon: 'clipboard', bg: '#e0f2fe', color: '#0284c7' },
  { key: 'Under Repair', label: 'Under Repair', icon: 'wrench', bg: '#fef3c7', color: '#d97706' },
  { key: 'For Verification', label: 'For Verification', icon: 'search', bg: '#ede9fe', color: '#7c3aed' },
  { key: 'Completed', label: 'Completed', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
];

// 'Open' removed — no new ticket ever reaches that status (propose goes
// straight to Pending Approval); it only ever existed on tickets created
// before the one-mechanic-per-ticket redesign.
const TICKET_STAT_CARDS = [
  { key: 'Pending Approval', label: 'Proposals', icon: 'clipboard', bg: '#fef9c3', color: '#a16207' },
  // "For Verification" was here, but that's a Custodian action, not
  // something Admin does anything with — Declined is the one Admin needs a
  // quick count of, since those proposals are waiting on a reconsider.
  { key: 'Declined', label: 'Declined', icon: 'close', bg: '#fee2e2', color: '#dc2626' },
  { key: 'Active', label: 'Active', icon: 'wrench', bg: '#fef3c7', color: '#d97706' },
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

const TICKET_WORK_ORDER_STAT_CARDS = [
  { key: 'Pending', label: 'Pending', icon: 'wrench', bg: '#fef3c7', color: '#d97706' },
  { key: 'Submitted', label: 'Submitted', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
];

// 'Pending' relabeled 'To Verify' — this is the Custodian's verification
// queue (For Verification tickets), same term the Dashboard's own stat uses
// for it; the old label read as just another ticket-status bucket instead
// of the one that needs this Custodian's action.
const TICKET_VERIFICATION_STAT_CARDS = [
  { key: 'Active', label: 'Active', icon: 'wrench', bg: '#fef9c3', color: '#a16207' },
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
function ModuleStatCards({ totalLabel = 'Total', total, cards, counts, activeFilter, onFilterChange, gridClassName = '' }) {
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
    { key: 'id', label: 'ID', locked: true, className: 'cell-center', render: (row) => row.vehicle_id },
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
    { key: 'type', label: 'Type', render: (row) => row.category?.category_name ?? 'Unassigned' },
    { key: 'brand_model', label: 'Brand / Model', render: (row) => `${row.brand} ${row.model}` },
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
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.74rem', fontWeight: 700, padding: '3px 9px', borderRadius: 999, background: badge.bg, color: badge.color, border: `1px solid ${badge.border}`, whiteSpace: 'nowrap' }}
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
            <button className="btn-view-action icon-btn" onClick={() => onViewTicket({ ticket_id: row.open_ticket_id })} type="button" title={`View Ticket #${row.open_ticket_id}`} aria-label={`View Ticket #${row.open_ticket_id}`}><Icon name="ticket" size={14} /></button>
          ) : (
            <span className="icon-btn-spacer" aria-hidden="true" />
          )}
          {canCheckReadiness && (
            (row.status === 'Inactive' || row.status === 'Decommissioned') ? (
              <span className="icon-btn-spacer" aria-hidden="true" />
            ) : (
              <button className="btn-confirm-action icon-btn" onClick={() => onReadinessCheck(row)} type="button" title="Record Readiness Check" aria-label="Record Readiness Check"><Icon name="checkCircle" size={14} /></button>
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
    { key: 'id', label: 'ID', locked: true, className: 'cell-center', render: (row) => row.id },
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
  { key: 'id', label: 'ID', locked: true, className: 'cell-center', render: (row) => row.location_record_id ?? 'Current' },
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

function conditionColumns(user, onEdit, deleteRecord, onCreateTicketFromCondition, onSuggestScheduleFromCondition, onAddCondition) {
  const columns = [
    { key: 'id', label: 'ID', locked: true, className: 'cell-center', render: (row) => row.condition_check_id ?? '-' },
    { key: 'vehicle', label: 'Vehicle', locked: true, render: (row) => <VehicleCell vehicle={row.vehicle} /> }, { key: 'plate', label: 'Plate Number', className: 'cell-center', render: (row) => row.vehicle?.plate_number ?? '-' },
    { key: 'result', label: 'Result', className: 'cell-center', render: (row) => <StatusBadge value={row.condition_result} /> },
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
          <div className="row-actions">
            {onAddCondition && (
              <button className="btn-confirm-action icon-btn" onClick={() => onAddCondition(row)} type="button" title="Record Condition" aria-label="Record Condition"><Icon name="plus" size={14} /></button>
            )}
          </div>
        ) : (
        <div className="row-actions">
          {/* #2 — Admin can turn a problem-finding condition check (Needs
              Repair OR Needs Inspection — anything short of Good) into a
              pre-diagnosed ticket in one click, instead of someone having to
              redescribe the same problem in a separate Issue Report just to
              get it in front of Admin. Reserved as its own slot (hidden, not
              removed) even when this row doesn't qualify — otherwise
              Edit/Delete shift left on every row that lacks it, and the
              column stops lining up. */}
          {(canDo(user, 'ticket.create') || canDo(user, 'ticket.propose')) && onCreateTicketFromCondition && (
            row.condition_result !== 'Good' ? (
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
function LatestIssueCard({ issues = [], onRowClick }) {
  const sorted = useMemo(
    () => [...issues].sort((a, b) => (b.issue_report_id ?? 0) - (a.issue_report_id ?? 0)),
    [issues]
  );

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
          sorted.map((row) => (
            <button
              key={row.issue_report_id}
              type="button"
              className="latest-issue-timeline-item"
              onClick={() => onRowClick?.(row)}
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
            </button>
          ))
        )}
      </div>
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
  statusOptions = [],
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

  const statusKeys = useMemo(
    () => ISSUE_STAT_CARDS.filter((c) => statusOptions.includes(c.key)).map((c) => c.key),
    [statusOptions],
  );

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

  useEffect(() => {
    setDraft({
      category: filterCategory ?? [],
      capacity: filterCapacity ?? [],
      issueType: filterIssueType ?? [],
      status: filterStatus ?? [],
      severity: filterPriority ?? [],
      dateStart: filterDateStart || '2026-01-01',
      dateEnd: filterDateEnd || '2026-12-31',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterCategory, filterCapacity, filterIssueType, filterStatus, filterPriority, filterDateStart, filterDateEnd]);

  // An empty draft.status means "no filter" — every chip should read as
  // checked, the same "everything's included" state the Total/All stat
  // card represents. Unchecking one FROM that implicit-all state has to
  // expand it into an explicit "every status except this one" list first —
  // otherwise toggling off a single chip would (wrongly) read as toggling
  // it on, since d.status.includes(key) is false for all of them.
  const toggleDraftStatus = (key) => {
    setDraft((d) => {
      const current = d.status.length === 0 ? statusKeys : d.status;
      const next = current.includes(key) ? current.filter((s) => s !== key) : [...current, key];
      return { ...d, status: next.length === statusKeys.length ? [] : next };
    });
  };

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

  const statusKeys = useMemo(
    () => TICKET_STAT_CARDS.filter((c) => statusOptions.includes(c.key)).map((c) => c.key),
    [statusOptions],
  );

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
    priorityRange: severityRangeFromSelection(filterPriority, priorityLevels),
    dateStart: filterDateStart || '2026-01-01',
    dateEnd: filterDateEnd || '2026-12-31',
  });

  useEffect(() => {
    setDraft({
      category: filterCategory ?? [],
      capacity: filterCapacity ?? [],
      vehicle: filterVehicle ?? [],
      mechanic: filterMechanic ?? [],
      custodian: filterCustodian ?? [],
      status: filterStatus ?? [],
      priorityRange: severityRangeFromSelection(filterPriority, priorityLevels),
      dateStart: filterDateStart || '2026-01-01',
      dateEnd: filterDateEnd || '2026-12-31',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterCategory, filterCapacity, filterVehicle, filterMechanic, filterCustodian, filterStatus, filterPriority, filterDateStart, filterDateEnd]);

  // An empty draft.status means "no filter" — every chip should read as
  // checked, the same "everything's included" state the Total/All stat
  // card represents. Unchecking one FROM that implicit-all state has to
  // expand it into an explicit "every status except this one" list first —
  // otherwise toggling off a single chip would (wrongly) read as toggling
  // it on, since d.status.includes(key) is false for all of them.
  const toggleDraftStatus = (key) => {
    setDraft((d) => {
      const current = d.status.length === 0 ? statusKeys : d.status;
      const next = current.includes(key) ? current.filter((s) => s !== key) : [...current, key];
      return { ...d, status: next.length === statusKeys.length ? [] : next };
    });
  };

  const applyFilters = () => {
    setFilterCategory(draft.category);
    setFilterCapacity(draft.capacity);
    setFilterVehicle(draft.vehicle);
    setFilterMechanic(draft.mechanic);
    setFilterCustodian(draft.custodian);
    setFilterStatus(draft.status);
    setFilterPriority(priorityLevels.slice(draft.priorityRange[0], draft.priorityRange[1] + 1));
    setFilterDateStart(draft.dateStart);
    setFilterDateEnd(draft.dateEnd);
  };

  const isFullPriorityRange = draft.priorityRange[0] === 0 && draft.priorityRange[1] === priorityLevels.length - 1;
  const isDirty = !sameSelection(draft.category, filterCategory ?? [])
    || !sameSelection(draft.capacity, filterCapacity ?? [])
    || !sameSelection(draft.vehicle, filterVehicle ?? [])
    || !sameSelection(draft.mechanic, filterMechanic ?? [])
    || !sameSelection(draft.custodian, filterCustodian ?? [])
    || !sameSelection(draft.status, filterStatus ?? [])
    || !isFullPriorityRange && !sameSelection(priorityLevels.slice(draft.priorityRange[0], draft.priorityRange[1] + 1), filterPriority ?? [])
    || draft.dateStart !== (filterDateStart || '2026-01-01')
    || draft.dateEnd !== (filterDateEnd || '2026-12-31');

  return (
    <div className="issue-filter-panel">
      <div className="issue-filter-row">
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
          <span>Maintenance Personnel</span>
          <MultiSelectDropdown
            placeholder="All Maintenance Personnel"
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
      </div>
      <div className="issue-filter-dates">
        <div className="filter-date-group issue-filter-date-input">
          <span>From Date</span>
          <DateFilterInput value={draft.dateStart} onChange={(val) => setDraft((d) => ({ ...d, dateStart: val }))} />
        </div>
        <div className="filter-date-group issue-filter-date-input">
          <span>To Date</span>
          <DateFilterInput value={draft.dateEnd} onChange={(val) => setDraft((d) => ({ ...d, dateEnd: val }))} />
        </div>
      </div>

      <div className="issue-filter-severity-card">
        <span className="issue-filter-severity-label">Priority</span>
        <DualRangeSlider
          labels={priorityLevels}
          minIndex={draft.priorityRange[0]}
          maxIndex={draft.priorityRange[1]}
          onChange={(min, max) => setDraft((d) => ({ ...d, priorityRange: [min, max] }))}
        />
      </div>
      <div className="issue-filter-right-cluster">
        <div className="issue-filter-status-grid">
          {TICKET_STAT_CARDS.filter((c) => statusOptions.includes(c.key)).map((c) => (
            <label key={c.key} className="issue-filter-status-chip" style={{ background: c.bg }}>
              <input type="checkbox" checked={draft.status.length === 0 || draft.status.includes(c.key)} onChange={() => toggleDraftStatus(c.key)} />
              <span style={{ color: c.color }}>{c.label}</span>
            </label>
          ))}
        </div>
        <div className="issue-filter-actions">
          <button type="button" className="filter-apply-btn issue-filter-apply-btn" onClick={applyFilters} disabled={!isDirty}>Filter</button>
        </div>
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

// Collapses a row's action icons behind a single "…" button; clicking it
// opens a small popover with the icons (rendered in a portal so table
// overflow never clips it). Keeps narrow Action columns tidy.
function RowActionsMenu({ children }) {
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
    { key: 'id', label: 'ID', width: '4%', locked: true, className: 'cell-center', render: (row) => row.issue_report_id },
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
    { key: 'vehicle', label: 'Vehicle', width: '19%', render: (row) => <VehicleCell vehicle={row.vehicle} /> },
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
            Ticket #{row.maintenance_ticket.ticket_id}
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
        <RowActionsMenu>
          {row.maintenance_ticket && onViewTicket ? (
            <button className="btn-view-action icon-btn" onClick={() => onViewTicket({ ticket_id: row.maintenance_ticket.ticket_id })} type="button" title={`View Ticket #${row.maintenance_ticket.ticket_id}`} aria-label={`View Ticket #${row.maintenance_ticket.ticket_id}`}><Icon name="eye" size={14} /></button>
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
        <RowActionsMenu>
          {row.maintenance_ticket && onViewTicket ? (
            <button className="btn-view-action icon-btn" onClick={() => onViewTicket({ ticket_id: row.maintenance_ticket.ticket_id })} type="button" title={`View Ticket #${row.maintenance_ticket.ticket_id}`} aria-label={`View Ticket #${row.maintenance_ticket.ticket_id}`}><Icon name="eye" size={14} /></button>
          ) : (
            <button className="btn-view-action icon-btn" onClick={() => onView(row)} type="button" title="View" aria-label="View"><Icon name="eye" size={14} /></button>
          )}
          {/* A Custodian turns a flagged concern into a ticket proposal right
              from the row — only while the issue can still take one. */}
          {canDo(user, 'ticket.propose') && onCreateTicketFromIssue && ['Pending', 'Under Review'].includes(row.status) && !row.maintenance_ticket && (
            <button className="btn-confirm-action icon-btn" onClick={() => onCreateTicketFromIssue(row)} type="button" title="Propose Ticket" aria-label="Propose Ticket"><Icon name="ticket" size={14} /></button>
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

function maintenanceColumns(role, setEditTarget, updateRecord, onViewRecord, user) {
  const columns = [
    { key: 'id', label: 'ID', width: '4%', locked: true, className: 'cell-center', render: (row) => row.maintenance_id },
    { key: 'vehicle', label: 'Vehicle', width: '15%', locked: true, render: (row) => <VehicleCell vehicle={row.vehicle} /> },
    { key: 'plate', label: 'Plate Number', width: '8%', className: 'cell-center', render: (row) => row.vehicle?.plate_number ?? '-' },
    {
      key: 'type',
      label: 'Type',
      width: '9%',
      render: (row) => (
        <div>
          <div>{row.maintenance_type}</div>
          {row.is_external && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
              <span className="badge" style={{ fontSize: '0.68rem', background: '#f0f9ff', color: '#0369a1', border: '1px solid #bae6fd' }} title={row.external_vendor || 'External shop'}>External</span>
              {row.receipt_url && (
                <a href={resolvePhotoUrl(row.receipt_url)} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.72rem', fontWeight: 600, color: '#0369a1', textDecoration: 'underline' }}>
                  Receipt
                </a>
              )}
            </div>
          )}
          {row.source_vehicle && (
            <div style={{ marginTop: 2 }}>
              <span className="badge" style={{ fontSize: '0.68rem', background: '#fff7ed', color: '#9a3412', border: '1px solid #fed7aa' }} title={`${row.part_name ? `${row.part_name} c` : 'C'}annibalized from ${row.source_vehicle.vehicle_name}`}>
                ⚙ {row.part_name ? `${row.part_name} ` : ''}from {row.source_vehicle.vehicle_name}
              </span>
            </div>
          )}
        </div>
      ),
    },
    { key: 'source', label: 'Source', width: '9%', className: 'cell-center', render: (row) => <StatusBadge value={row.source} /> },
    { key: 'personnel', label: 'Personnel', width: '10%', className: 'cell-center', render: (row) => <UserAvatarName user={row.maintenance_personnel} fallback={row.performed_by_other ?? '-'} /> },
    { key: 'progress', label: 'Progress', width: '8%', className: 'cell-center', render: (row) => <StatusBadge value={row.progress_status} /> },
    { key: 'verification', label: 'Verification', width: '8%', className: 'cell-center', render: (row) => row.verification_result ? <StatusBadge value={row.verification_result} /> : '-' },
    { key: 'date_started', label: 'Date Started', width: '5%', className: 'cell-center', render: (row) => <DateBadge value={row.date_started} /> },
    { key: 'date_completed', label: 'Date Completed', width: '5%', className: 'cell-center', render: (row) => <DateBadge value={row.date_completed} /> },
    {
      key: 'action',
      label: 'Action',
      width: '8%',
      locked: true,
      className: 'cell-center',
      render: (row) => (
        <div className="row-actions" style={{ flexWrap: 'wrap' }}>
          {onViewRecord && (
            <button className="btn-view-action icon-btn" onClick={() => onViewRecord(row)} type="button" title="View" aria-label="View"><Icon name="eye" size={14} /></button>
          )}
          {/* Phase B4 — record.edit narrowed to Admin only (Custodian is
              read-only here now; Maintenance Personnel never reaches this
              module at all — see modulesByRole). */}
          {canDo(user, 'record.edit') && (
            <button className="btn-edit-action icon-btn" onClick={() => setEditTarget(row)} type="button" title="Edit" aria-label="Edit"><Icon name="edit" size={14} /></button>
          )}
          {canDo(user, 'record.confirm') && row.verification_result === 'Passed' && row.progress_status !== 'Completed' ? (
            <>
              <button className="btn-confirm-action icon-btn" onClick={() => updateRecord(`/maintenance-records/${row.maintenance_id}/confirm`, { confirmed: true }, 'Maintenance confirmed.')} type="button" title="Confirm" aria-label="Confirm"><Icon name="checkCircle" size={14} /></button>
              <button className="btn-reopen-action icon-btn" onClick={() => updateRecord(`/maintenance-records/${row.maintenance_id}/confirm`, { confirmed: false }, 'Maintenance reopened.')} type="button" title="Reopen" aria-label="Reopen"><Icon name="undo" size={14} /></button>
            </>
          ) : null}
          {/* Unified into the one ledger every role sees — no more separate
              "Needs Verification" tab/page. Same self-verification guard the
              old maintenanceStatusColumns had: a Custodian who performed this
              repair themselves can't be the one who verifies it. */}
          {canDo(user, 'record.verify') && row.progress_status === 'For Verification' && (
            String(row.maintenance_personnel_id) === String(user?.id) ? (
              <span className="muted" title="You performed this repair — another Custodian needs to verify it.">Awaiting another Custodian</span>
            ) : (
              <button className="btn-edit-action icon-btn" onClick={() => setEditTarget({ ...row, __verify: true })} type="button" title="Verify" aria-label="Verify"><Icon name="checkCircle" size={14} /></button>
            )
          )}
        </div>
      ),
    },
  ];

  return columns;
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
function MaintenanceRecordCard({ record, onClick }) {
  const stageIndex = maintenanceStageIndex(record);
  const isDone = record.progress_status === 'Completed';
  const unverified = isClosedUnverified(record);
  const stagesDone = stageIndex + 1;

  return (
    <div className="ticket-card" onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <div className="ticket-card-content-wrapper">
        <div className="ticket-card-info">
          <div className="ticket-card-top">
            <span className="ticket-card-id">#{record.maintenance_id}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <StatusBadge value={record.source} />
              <StatusBadge value={record.progress_status} />
            </div>
          </div>
          <p className="ticket-card-title">{record.maintenance_type}</p>
          <p className="ticket-card-vehicle">
            {record.vehicle?.vehicle_name}{record.vehicle?.plate_number ? ` · ${record.vehicle.plate_number}` : ''}
          </p>
        </div>
        {record.vehicle?.photo_url && (
          <div className="ticket-card-photo">
            <img src={resolvePhotoUrl(record.vehicle.photo_url)} alt={record.vehicle.vehicle_name} />
          </div>
        )}
      </div>

      {/* Same four stages as the detail page, compressed to a single bar —
          green only once it's genuinely finished. */}
      <div style={{ margin: '8px 0 2px' }}>
        <div style={{ height: 6, borderRadius: 999, background: '#e2e8f0', overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            width: `${(stagesDone / MAINTENANCE_PROGRESS_STAGES.length) * 100}%`,
            background: isDone ? '#16a34a' : '#d97706',
            borderRadius: 999,
          }} />
        </div>
        <span className="muted" style={{ fontSize: '0.72rem' }}>
          {MAINTENANCE_PROGRESS_STAGES[stageIndex] ?? record.progress_status} · stage {stagesDone} of {MAINTENANCE_PROGRESS_STAGES.length}
        </span>
      </div>

      {(unverified || record.is_external || record.source_vehicle) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, margin: '6px 0 2px' }}>
          {unverified && (
            <span style={{ fontSize: '0.66rem', fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }} title="Closed by Admin without Custodian verification.">
              UNVERIFIED CLOSE
            </span>
          )}
          {record.is_external && (
            <span style={{ fontSize: '0.66rem', fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: '#f0f9ff', color: '#0369a1', border: '1px solid #bae6fd' }} title={record.external_vendor || 'External shop'}>
              EXTERNAL
            </span>
          )}
          {record.source_vehicle && (
            <span style={{ fontSize: '0.66rem', fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: '#fff7ed', color: '#9a3412', border: '1px solid #fed7aa' }} title={`${record.part_name ? `${record.part_name} c` : 'C'}annibalized from ${record.source_vehicle.vehicle_name}`}>
              ⚙ {record.part_name ? `${record.part_name} — ` : ''}{record.source_vehicle.vehicle_name}
            </span>
          )}
        </div>
      )}

      <div className="ticket-card-bottom">
        {record.verification_result
          ? <StatusBadge value={record.verification_result} />
          : <span className="muted" style={{ fontSize: '0.72rem' }}>{record.maintenance_personnel?.name ?? record.performed_by_other ?? '—'}</span>}
        <span className="ticket-card-date">{formatDate(record.date_completed ?? record.date_started)}</span>
      </div>
    </div>
  );
}

// Read-rich detail PAGE for a single Maintenance Record — same spirit as the
// Ticket detail page (a visual progress trail instead of a flat status
// word), but for the linear Assigned -> ... -> Completed chain a Record
// follows instead of a ticket's per-sub-issue breakdown. Reachable both from
// the Maintenance Records table and from a completed Schedule row, so
// there's one consistent "view what actually happened" experience instead
// of only ever landing in the plain edit form.
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
    <ModulePanel description={`Maintenance #${record.maintenance_id}`}>
      <div className="maintenance-record-detail">
        <div className="maintenance-record-hero">
          <VehicleCell vehicle={record.vehicle} />
          <span className="muted">{record.maintenance_type}</span>
          <StatusBadge value={record.source} />
          {onHold && (
            <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>ON HOLD — AWAITING PARTS</span>
          )}
          {record.is_external && (
            <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#f0f9ff', color: '#0369a1', border: '1px solid #bae6fd' }}>External{record.external_vendor ? ` — ${record.external_vendor}` : ''}</span>
          )}
          {record.source_vehicle && (
            <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#fff7ed', color: '#9a3412', border: '1px solid #fed7aa' }}>⚙ Part from {record.source_vehicle.vehicle_name}</span>
          )}
          {closedUnverified && (
            <span
              style={{ fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}
              title="Admin closed this without waiting for Custodian verification — nobody independently checked the work."
            >
              <Icon name="alert" size={11} /> CLOSED WITHOUT VERIFICATION
            </span>
          )}
        </div>

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

        {/* Proof shown inline — the whole point of this view over the plain
            edit form is not having to click away just to see it. */}
        {record.receipt_url && (
          <div>
            <span className="muted" style={{ fontSize: '0.74rem', display: 'block', marginBottom: 6 }}>Proof of Completion</span>
            <a href={resolvePhotoUrl(record.receipt_url)} target="_blank" rel="noopener noreferrer">
              <img src={resolvePhotoUrl(record.receipt_url)} alt="Proof of completion" style={{ maxWidth: 360, maxHeight: 280, borderRadius: 8, border: '1px solid #e2e8f0', display: 'block' }} />
            </a>
          </div>
        )}

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
      </div>
    </ModulePanel>
  );
}

// Fetch-by-id wrapper — same pattern as TicketProfilePage: load once by the
// URL's :id, show a loader/not-found state, then hand the fetched record to
// the read-rich detail view above. Re-fetches after Confirm/Reopen so the
// progress trail reflects the new state without a manual refresh.
function MaintenanceRecordProfilePage({ maintenanceId, onConfirm, onReopen, onDecisionClose, canManage }) {
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const loadRecord = useCallback(() => {
    setLoading(true);
    api.get(`/maintenance-records/${maintenanceId}`)
      .then((response) => { setRecord(response.data); setNotFound(false); })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [maintenanceId]);

  useEffect(() => { loadRecord(); }, [loadRecord]);

  if (loading) return <ModuleLoader label="Loading maintenance record" />;

  if (notFound || !record) {
    return <ModulePanel description="This maintenance record could not be found — it may have been deleted." />;
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
    { key: 'id', label: 'ID', locked: true, className: 'cell-center', render: (row) => row.maintenance_id },
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
    { key: 'id', label: 'ID', locked: true, className: 'cell-center', render: (row) => row.schedule_id },
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
            {name}
            {isMe && <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>YOU</span>}
          </span>
        );
      },
    },
    { key: 'date', label: 'Date', className: 'cell-center', render: (row) => <DateBadge value={row.scheduled_date} /> },
    { key: 'time', label: 'Time', className: 'cell-center', render: (row) => row.scheduled_time ?? '-' },
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
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {/* TicketStatusBadge, not the plain StatusBadge — its colorMap
              already covers Pending Approval/Declined (shared with tickets);
              Scheduled/Completed/Cancelled fall back to the same plain
              style StatusBadge gave them, so this is a strict addition. */}
          <TicketStatusBadge value={row.status} />
          {/* #11 — a scheduled PM whose date has passed is overdue: flag it
              loudly instead of leaving it to sit silently on the calendar. */}
          {isScheduleOverdue(row) && (
            <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>OVERDUE</span>
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
                style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0' }}
                title={`Verification: ${row.resulting_maintenance.verification_result ?? 'Pending'}`}
              >
                Done {formatDate(row.resulting_maintenance.date_completed)}
              </span>
            ) : (
              <span
                style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#fef9c3', color: '#854d0e', border: '1px solid #fde68a' }}
                title="The calendar task is done, but the record it created still needs Custodian verification before it's fully closed."
              >
                Record: {row.resulting_maintenance.progress_status}
              </span>
            )
          )}
          {row.status === 'Declined' && row.decline_reason && (
            <span
              style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca', cursor: 'help' }}
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
      className: 'cell-center',
      render: (row) => (
        <div className="row-actions" style={{ flexWrap: 'wrap' }}>
          {row.status === 'Scheduled' && row.resulting_ticket_id && onViewTicket && (
            <button className="btn-view-action icon-btn" onClick={() => onViewTicket({ ticket_id: row.resulting_ticket_id })} type="button" title={`This schedule became Ticket #${row.resulting_ticket_id} — open it`} aria-label={`Open Ticket #${row.resulting_ticket_id}`}><Icon name="ticket" size={14} /></button>
          )}
          {row.status === 'Scheduled' && !row.resulting_ticket_id && onComplete && (currentUserId != null && String(row.assigned_to) === String(currentUserId)) && (
            <button className="btn-confirm-action icon-btn" onClick={() => onComplete(row)} type="button" title="Mark as Done" aria-label="Mark as Done"><Icon name="checkCircle" size={14} /></button>
          )}
          {row.status === 'Completed' && row.resulting_maintenance_id && onViewRecord && (
            <button className="btn-view-action icon-btn" onClick={() => onViewRecord(row)} type="button" title="View Maintenance Record" aria-label="View Maintenance Record"><Icon name="wrench" size={14} /></button>
          )}
          {/* Admin reviews a Custodian's booked schedule before it goes live
              — same propose/approve/decline shape as a ticket proposal. A
              Declined row can still be approved directly (no undecline
              needed first), same as tickets. */}
          {canDo(currentUser, 'schedule.approve') && ['Pending Approval', 'Declined'].includes(row.status) && onApprove && (
            <button className="btn-confirm-action icon-btn" onClick={() => onApprove(row)} type="button" title="Approve" aria-label="Approve"><Icon name="checkCircle" size={14} /></button>
          )}
          {canDo(currentUser, 'schedule.decline') && row.status === 'Pending Approval' && onDecline && (
            <button className="btn-delete-action icon-btn" onClick={() => onDecline(row)} type="button" title="Decline" aria-label="Decline"><Icon name="close" size={14} /></button>
          )}
          {/* Edit/Delete/Restore are Custodian-only abilities (config/
              permissions.php: schedule.edit/.delete/.restore => ['Custodian']
              — Admin doesn't hold them), gated by canDo rather than role so
              this actually matches what the backend will accept. Any
              Custodian may edit or cancel any schedule in their barangay,
              not only the ones they booked. A Maintenance Personnel assigned to it only
              ever gets to act on it via Mark as Done above. */}
          {canDo(currentUser, 'schedule.edit') && (
            <button className="btn-edit-action icon-btn" onClick={() => onEdit(row)} type="button" title="Edit" aria-label="Edit"><Icon name="edit" size={14} /></button>
          )}
          {/* schedule.reassign (Admin only, config/permissions.php) — Admin's
              one remaining lever over an already-booked schedule: hand a
              still-open Scheduled row to a different Maintenance Personnel
              without cancelling and re-booking it (see the ability's own
              comment there for why this stayed with Admin). */}
          {canDo(currentUser, 'schedule.reassign') && row.status === 'Scheduled' && onReassign && (
            <button className="btn-view-action icon-btn" onClick={() => onReassign(row)} type="button" title="Reassign" aria-label="Reassign"><Icon name="undo" size={14} /></button>
          )}
          {/* Cancelling a schedule is a soft cancel — the row survives — so a
              cancelled one gets Restore instead of a Delete that would do
              nothing. Same swap vehicleColumns makes for archived vehicles. */}
          {row.status === 'Cancelled'
            ? canDo(currentUser, 'schedule.restore') && restoreRecord && (
              <button className="btn-confirm-action icon-btn" onClick={() => restoreRecord(`/maintenance-schedules/${row.schedule_id}/restore`, 'Schedule restored.', 'Restore this cancelled schedule back to Scheduled?')} type="button" title="Restore" aria-label="Restore"><Icon name="undo" size={14} /></button>
            )
            : canDo(currentUser, 'schedule.delete') && (
              <button className="btn-delete-action icon-btn" onClick={() => deleteRecord(`/maintenance-schedules/${row.schedule_id}`, 'Schedule cancelled.', `Cancel the ${row.maintenance_type} schedule for ${row.vehicle?.vehicle_name ?? 'this vehicle'}? It can be restored later if needed.`)} type="button" title="Cancel Schedule" aria-label="Cancel Schedule"><Icon name="trash" size={14} /></button>
            )}
        </div>
      ),
    },
  ];
}

const RECURRENCE_LABEL = { 1: 'Monthly', 3: 'Quarterly', 6: 'Every 6 mo', 12: 'Yearly' };

// #11 — a schedule is overdue when it's still 'Scheduled' but its date has
// already passed (compared date-only, so "today" is never overdue).
function isScheduleOverdue(row) {
  if (row.status !== 'Scheduled' || !row.scheduled_date) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(row.scheduled_date); due.setHours(0, 0, 0, 0);
  return due < today;
}

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
function MaintenanceScheduleCard({ row, currentUser, onComplete, onEdit, onDelete, onViewRecord, onRestore, onReassign, onViewTicket, onViewVehicle, onApprove, onDecline }) {
  const currentUserId = currentUser?.id;
  const isMine = currentUserId != null && String(row.assigned_to) === String(currentUserId);
  const overdue = isScheduleOverdue(row);
  const resulting = row.resulting_maintenance;
  // Once a due schedule has become a ticket, the ticket is where the work is
  // done — completing the schedule directly would be refused. Final senior
  // system review (2026-10-05, §2) — Admin no longer completes a schedule
  // directly (that's physically performing the work); only the assigned
  // Maintenance Personnel can.
  const canComplete = row.status === 'Scheduled' && !row.resulting_ticket_id && onComplete && isMine;
  const becameTicket = row.status === 'Scheduled' && row.resulting_ticket_id && onViewTicket;

  const canView = Boolean(onViewVehicle && row.vehicle);

  return (
    <div
      className="ticket-card"
      style={{ cursor: canView ? 'pointer' : 'default' }}
      onClick={canView ? () => onViewVehicle(row.vehicle) : undefined}
      role={canView ? 'button' : undefined}
      tabIndex={canView ? 0 : undefined}
      onKeyDown={canView ? (e) => { if (e.key === 'Enter') onViewVehicle(row.vehicle); } : undefined}
    >
      <div className="ticket-card-content-wrapper">
        <div className="ticket-card-info">
          <div className="ticket-card-top">
            <span className="ticket-card-id">#{row.schedule_id}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              <TicketStatusBadge value={row.status} />
              {overdue && (
                <span style={{ fontSize: '0.66rem', fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>OVERDUE</span>
              )}
            </span>
          </div>
          <p className="ticket-card-title">{row.maintenance_type}</p>
          <p className="ticket-card-vehicle" style={{ marginBottom: 8 }}>
            {row.vehicle?.vehicle_name}{row.vehicle?.plate_number ? ` · ${row.vehicle.plate_number}` : ''}
          </p>
        </div>
        {row.vehicle?.photo_url && (
          <div className="ticket-card-photo">
            <img src={resolvePhotoUrl(row.vehicle.photo_url)} alt={row.vehicle.vehicle_name} />
          </div>
        )}
      </div>

      {/* The date is the whole point of a schedule, so it leads here rather
          than being one column among many. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: '0.78rem', margin: '2px 0 8px' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontWeight: 700, color: overdue ? '#b91c1c' : undefined }}>
          <Icon name="calendar" size={13} /> {formatDate(row.scheduled_date)}{row.scheduled_time ? ` · ${row.scheduled_time}` : ''}
        </span>
        <span className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Icon name="undo" size={13} /> {row.recurrence_months ? (RECURRENCE_LABEL[row.recurrence_months] ?? `Every ${row.recurrence_months} mo`) : 'One-time'}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', marginBottom: 8, flexWrap: 'wrap' }}>
        {row.assigned_to_user?.name
          ? (
            <>
              <UserAvatarName user={row.assigned_to_user} />
              {isMine && <span style={{ fontSize: '0.64rem', fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>YOU</span>}
            </>
          )
          : <span className="muted">Unassigned</span>}
      </div>

      {row.service_location && (
        <p className="muted" style={{ fontSize: '0.74rem', margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 5 }}>
          <Icon name="pin" size={12} /> {row.service_location}
        </p>
      )}

      {/* Traceability, same as the table's Status column: "Completed" alone
          doesn't say whether the record it produced was ever verified. */}
      {row.status === 'Completed' && resulting && (
        <div style={{ marginBottom: 8 }}>
          {resulting.progress_status === 'Completed' ? (
            <span style={{ fontSize: '0.66rem', fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0' }}>
              Done {formatDate(resulting.date_completed)}
            </span>
          ) : (
            <span style={{ fontSize: '0.66rem', fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: '#fef9c3', color: '#854d0e', border: '1px solid #fde68a' }} title="The calendar task is done, but the record it created still needs Custodian verification.">
              Record: {resulting.progress_status}
            </span>
          )}
        </div>
      )}

      {row.status === 'Declined' && row.decline_reason && (
        <p className="muted" style={{ fontSize: '0.74rem', margin: '0 0 8px', color: '#991b1b' }}>
          <strong>Declined:</strong> {row.decline_reason}
        </p>
      )}

      {/* ticket-card-bottom pins this to the bottom of the card (margin-top:
          auto) the same way TicketCard's own footer does, so action buttons
          line up across a row of cards regardless of how much optional
          content (overdue flag, location, verification badge) a given card
          has above it. */}
      <div className="row-actions ticket-card-bottom" style={{ justifyContent: 'flex-start' }} onClick={(e) => e.stopPropagation()}>
        {canComplete && (
          <button className="btn-confirm-action icon-btn" onClick={() => onComplete(row)} type="button" title="Mark as Done" aria-label="Mark as Done"><Icon name="checkCircle" size={14} /></button>
        )}
        {becameTicket && (
          <button className="btn-view-action icon-btn" onClick={() => onViewTicket({ ticket_id: row.resulting_ticket_id })} type="button" title={`This schedule became Ticket #${row.resulting_ticket_id} — open it`} aria-label={`Open Ticket #${row.resulting_ticket_id}`}><Icon name="ticket" size={14} /></button>
        )}
        {row.status === 'Completed' && row.resulting_maintenance_id && onViewRecord && (
          <button className="btn-view-action icon-btn" onClick={() => onViewRecord(row)} type="button" title="View Maintenance Record" aria-label="View Maintenance Record"><Icon name="wrench" size={14} /></button>
        )}
        {/* Admin reviews a Custodian's booked schedule before it goes live —
            see scheduleColumns' matching Action column for the full
            reasoning. A Declined row can still be approved directly. */}
        {canDo(currentUser, 'schedule.approve') && ['Pending Approval', 'Declined'].includes(row.status) && onApprove && (
          <button className="btn-confirm-action icon-btn" onClick={() => onApprove(row)} type="button" title="Approve" aria-label="Approve"><Icon name="checkCircle" size={14} /></button>
        )}
        {canDo(currentUser, 'schedule.decline') && row.status === 'Pending Approval' && onDecline && (
          <button className="btn-delete-action icon-btn" onClick={() => onDecline(row)} type="button" title="Decline" aria-label="Decline"><Icon name="close" size={14} /></button>
        )}
        {/* Edit/Delete/Restore are Custodian-only abilities (config/
            permissions.php — Admin doesn't hold schedule.edit/.delete/
            .restore), gated by canDo so this matches what the backend
            actually accepts — see scheduleColumns' matching Action column
            for the full reasoning. Any Custodian may edit any schedule in
            their barangay. */}
        {canDo(currentUser, 'schedule.edit') && (
          <button className="btn-edit-action icon-btn" onClick={() => onEdit(row)} type="button" title="Edit" aria-label="Edit"><Icon name="edit" size={14} /></button>
        )}
        {/* schedule.reassign (Admin only) — Admin's one remaining lever over
            an already-booked schedule. */}
        {canDo(currentUser, 'schedule.reassign') && row.status === 'Scheduled' && onReassign && (
          <button className="btn-view-action icon-btn" onClick={() => onReassign(row)} type="button" title="Reassign" aria-label="Reassign"><Icon name="undo" size={14} /></button>
        )}
        {/* Same swap as the table: a cancelled schedule offers Restore, not a
            Delete that would just re-cancel something already cancelled. */}
        {row.status === 'Cancelled'
          ? canDo(currentUser, 'schedule.restore') && onRestore && (
            <button className="btn-confirm-action icon-btn" onClick={() => onRestore(row)} type="button" title="Restore" aria-label="Restore"><Icon name="undo" size={14} /></button>
          )
          : canDo(currentUser, 'schedule.delete') && (
            <button className="btn-delete-action icon-btn" onClick={() => onDelete(row)} type="button" title="Cancel Schedule" aria-label="Cancel Schedule"><Icon name="trash" size={14} /></button>
          )}
      </div>
    </div>
  );
}

const historyColumns = [
  { key: 'id', label: 'ID', locked: true, render: (row) => row.history_id },
  { key: 'vehicle', label: 'Vehicle', locked: true, render: (row) => <VehicleCell vehicle={row.vehicle} /> }, { key: 'plate', label: 'Plate Number', render: (row) => row.vehicle?.plate_number ?? '-' },
  { key: 'activity', label: 'Activity', render: (row) => row.activity_type },
  { key: 'related_record', label: 'Related Record', render: (row) => row.related_record_id ?? '-' },
  { key: 'updated_by', label: 'Updated By', render: (row) => <UserAvatarName user={row.updated_by} /> },
  { key: 'date', label: 'Date', render: (row) => <DateBadge value={row.created_at} /> },
  { key: 'time', label: 'Time', render: (row) => formatTime(row.created_at) },
];

const VEHICLE_HISTORY_EXPORT_COLUMNS = [
  { label: 'ID', value: (r) => r.history_id },
  { label: 'Vehicle', value: (r) => (r.vehicle ? `${r.vehicle.vehicle_name} (${r.vehicle.plate_number})` : '') },
  { label: 'Activity', value: (r) => r.activity_type },
  { label: 'Related Record', value: (r) => r.related_record_id ?? '' },
  { label: 'Updated By', value: (r) => r.updated_by?.name ?? '' },
  { label: 'Description', value: (r) => r.description ?? '' },
  { label: 'Date', value: (r) => r.created_at },
];

// Card-view counterpart to historyColumns — same fields, laid out for a
// grid instead of a row.
function HistoryCard({ row, onClick }) {
  return (
    <div className="history-card" onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <div className="history-card-top">
        <VehicleCell vehicle={row.vehicle} isRowTitle={false} />
        <span className="history-card-activity">{row.activity_type}</span>
      </div>
      {row.description && <p className="history-card-desc">{row.description}</p>}
      <div className="history-card-bottom">
        <UserAvatarName user={row.updated_by} />
        <span className="history-card-date">
          <DateBadge value={row.created_at} /> {formatTime(row.created_at)}
        </span>
      </div>
    </div>
  );
}

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
function GenerateReportButton({ rows }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleOutsideClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  const runReport = (type) => {
    setOpen(false);
    const stamp = new Date().toISOString().slice(0, 10);

    if (type === 'timeline') {
      exportRowsToCsv(`activity-timeline-${stamp}.csv`, [
        { label: 'Date and Time', value: (r) => formatLogDateTime(r.created_at) },
        { label: 'User', value: (r) => r.user?.name ?? 'System' },
        { label: 'Role', value: (r) => r.role ?? '-' },
        { label: 'Module', value: (r) => r.module ?? '-' },
        { label: 'Action', value: (r) => r.action },
        { label: 'Details', value: (r) => r.details ?? '' },
      ], rows);
      return;
    }

    if (type === 'user') {
      const byUser = new Map();
      rows.forEach((r) => {
        const key = r.user?.name ?? 'System';
        const entry = byUser.get(key) ?? { user: key, role: r.role ?? '-', total: 0, last: r.created_at };
        entry.total += 1;
        if (r.created_at && (!entry.last || new Date(r.created_at) > new Date(entry.last))) entry.last = r.created_at;
        byUser.set(key, entry);
      });
      exportRowsToCsv(`activity-by-user-${stamp}.csv`, [
        { label: 'User', value: (r) => r.user },
        { label: 'Role', value: (r) => r.role },
        { label: 'Total Actions', value: (r) => r.total },
        { label: 'Last Active', value: (r) => formatLogDateTime(r.last) },
      ], [...byUser.values()].sort((a, b) => b.total - a.total));
      return;
    }

    if (type === 'module') {
      const byModule = new Map();
      rows.forEach((r) => {
        const key = r.module ?? 'Other';
        byModule.set(key, (byModule.get(key) ?? 0) + 1);
      });
      exportRowsToCsv(`activity-by-module-${stamp}.csv`, [
        { label: 'Module', value: (r) => r.module },
        { label: 'Total Actions', value: (r) => r.total },
      ], [...byModule.entries()].map(([module, total]) => ({ module, total })).sort((a, b) => b.total - a.total));
    }
  };

  return (
    <div className="column-chooser generate-report" ref={containerRef}>
      <button type="button" className={`primary-button generate-report-btn${open ? ' is-active' : ''}`} onClick={() => setOpen((v) => !v)}>
        Generate Report <Icon name="chevronDown" size={13} />
      </button>
      {open && (
        <div className="column-chooser-panel generate-report-panel" role="menu">
          <button type="button" className="generate-report-option" onClick={() => runReport('timeline')}>
            <strong>Timeline Report</strong>
            <span>Every action, in order, exactly as shown below.</span>
          </button>
          <button type="button" className="generate-report-option" onClick={() => runReport('user')}>
            <strong>User Report</strong>
            <span>Action counts per user, most active first.</span>
          </button>
          <button type="button" className="generate-report-option" onClick={() => runReport('module')}>
            <strong>Module Report</strong>
            <span>Action counts per module, busiest first.</span>
          </button>
        </div>
      )}
    </div>
  );
}

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

  useEffect(() => {
    setPage(1);
  }, [count, pageSize]);

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

function PaginationControls({ page, setPage, pageSize, setPageSize, pageSizeOptions, totalPages }) {
  if (totalPages <= 1 && pageSizeOptions.length <= 1) return null;
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
      <div className="table-pagination-size">
        <span className="muted">Page size:</span>
        {pageSizeOptions.map((n) => (
          <button key={n} type="button" className={`pagination-page${n === pageSize ? ' active' : ''}`} onClick={() => setPageSize(n)}>{n}</button>
        ))}
      </div>
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
  return key.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function reportColumns(rows) {
  if (!rows?.length) {
    return [{ label: 'Result', render: () => 'No records' }];
  }

  const sample = rows[0];
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
  const plainColumns = plainKeys.slice(0, 8).map((key) => ({
    label: prettifyKey(key),
    render: (row) => String(row[key] ?? '-'),
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

// Clamps long free-text table cells to a fixed number of lines so they can't
// stretch the row/table. A "Show more" chevron only appears when the text
// actually overflows the clamp (measured via scrollHeight vs clientHeight),
// so short text that already fits gets no dead-looking toggle affordance.
function ExpandableText({ text, lines = 2, className = '' }) {
  const [expanded, setExpanded] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);
  const textRef = useRef(null);

  useLayoutEffect(() => {
    if (expanded) return;
    const el = textRef.current;
    if (el) setIsTruncated(el.scrollHeight > el.clientHeight + 1);
  }, [text, lines, expanded]);

  if (!text) return '-';

  const toggle = () => setExpanded((prev) => !prev);
  const canToggle = isTruncated || expanded;

  return (
    <span className="expandable-text-wrap">
      <span
        ref={textRef}
        className={`expandable-text ${canToggle ? 'is-clickable' : ''} ${expanded ? 'is-expanded' : ''} ${className}`.trim()}
        style={{ WebkitLineClamp: expanded ? 'unset' : lines }}
        onClick={canToggle ? (event) => { event.stopPropagation(); toggle(); } : undefined}
        onKeyDown={canToggle ? (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            toggle();
          }
        } : undefined}
        role={canToggle ? 'button' : undefined}
        tabIndex={canToggle ? 0 : undefined}
        title={canToggle ? (expanded ? 'Click to collapse' : 'Click to view full text') : undefined}
      >
        {text}
      </span>
      {canToggle && (
        <button
          type="button"
          className={`expandable-text-toggle${expanded ? ' is-expanded' : ''}`}
          onClick={(event) => { event.stopPropagation(); toggle(); }}
          title={expanded ? 'Collapse' : 'Show full text'}
        >
          {expanded ? 'Show less' : 'Show more'}
          <Icon name="chevronDown" size={11} />
        </button>
      )}
    </span>
  );
}

// Stacks two or more long-text fields (e.g. Problem/Reason + Action Taken)
// into one labeled multi-line block for a table's renderSubRow band,
// skipping whichever fields aren't populated on a given row.
function subRowFields(pairs) {
  const present = pairs.filter(([, value]) => value);
  if (!present.length) return null;
  return (
    <div className="table-subrow-lines">
      {present.map(([label, value]) => (
        <div key={label}><strong>{label}:</strong> {value}</div>
      ))}
    </div>
  );
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
function VehicleCell({ vehicle, isRowTitle = true }) {
  const actions = useContext(RowActionsContext);

  if (!vehicle) {
    return '-';
  }

  const textClassName = `vcn-text${isRowTitle ? ' row-title-text' : ''}`;

  return (
    <div className="vehicle-cell">
      <PhotoCell alt={vehicle.vehicle_name} url={vehicle.photo_url} />
      {actions?.viewVehicle && vehicle.vehicle_id ? (
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
      ? { method: 'put', path: `/maintenance-schedules/${editTarget.schedule_id}`, success: 'Schedule updated.' }
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
    dateStyle: 'medium',
    timeStyle: value.includes?.('T') ? 'short' : undefined,
  }).format(new Date(value));
}

// Compact "table cell" version of a date: a colored month/day pill plus the
// year underneath — used in place of the long formatDate() string inside
// table columns. Time (when the source field carries one) is its own
// adjacent "Time" column via formatTime(), so it never repeats here.
function DateBadge({ value }) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return (
    <span className="date-badge">
      <span className="date-badge-pill">
        <span className="date-badge-month">{date.toLocaleDateString('en-US', { month: 'short' })}</span>
        <span className="date-badge-day">{date.toLocaleDateString('en-US', { day: '2-digit' })}</span>
      </span>
      <span className="date-badge-meta">
        <span>{date.getFullYear()}</span>
      </span>
    </span>
  );
}

// Muted inline date for calm contexts (the ticket detail cards) where the
// chunky red DateBadge tile reads as an alert. Dense tables keep the tile.
function QuietDate({ value }) {
  if (!value) return <span className="muted">—</span>;
  const date = new Date(value);
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

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return new Intl.DateTimeFormat('en-PH', { timeStyle: 'short' }).format(date);
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
    return { iso: match[1].trim().replace(' ', 'T'), message: match[2].trim() };
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

const VEHICLE_EXPORT_COLUMNS = [
  { label: 'ID', value: (r) => r.vehicle_id },
  { label: 'Vehicle Name', value: (r) => r.vehicle_name },
  { label: 'Plate Number', value: (r) => r.plate_number },
  { label: 'Type', value: (r) => r.category?.category_name ?? 'Unassigned' },
  { label: 'Brand', value: (r) => r.brand },
  { label: 'Model', value: (r) => r.model },
  { label: 'Capacity', value: (r) => r.capacity },
  { label: 'Location', value: (r) => r.current_location },
  { label: 'Status', value: (r) => r.status },
  { label: 'Condition', value: (r) => r.condition },
  { label: 'Ready to Respond', value: (r) => READINESS_BADGE[r.readiness_state]?.label ?? '' },
];

const USER_EXPORT_COLUMNS = [
  { label: 'ID', value: (r) => r.id },
  { label: 'Name', value: (r) => r.name },
  { label: 'Email', value: (r) => r.email },
  { label: 'Phone', value: (r) => r.phone ?? '' },
  { label: 'Role', value: (r) => ((Array.isArray(r.roles) && r.roles.length) ? r.roles : [r.role].filter(Boolean)).join(', ') },
  { label: 'Status', value: (r) => (r.is_active ? 'Active' : 'Inactive') },
];

const SCHEDULE_EXPORT_COLUMNS = [
  { label: 'ID', value: (r) => r.schedule_id },
  { label: 'Vehicle', value: (r) => (r.vehicle ? `${r.vehicle.vehicle_name} (${r.vehicle.plate_number})` : '') },
  { label: 'Type', value: (r) => r.maintenance_type },
  { label: 'Date', value: (r) => r.scheduled_date },
  { label: 'Time', value: (r) => r.scheduled_time },
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
  // groupWorkTrackerByTicket's return is a synthesized summary row (one per
  // ticket_id, built from flattened sub-issue rows) — not the real ticket
  // object TicketCard needs (status/priority/created_at/progress). `tickets`
  // here is already the full raw ticket list, so just look the real one up.
  const ticketById = useMemo(() => {
    const map = new Map();
    (tickets ?? []).forEach((t) => map.set(t.ticket_id, t));
    return map;
  }, [tickets]);
  const groupedTicketCards = useMemo(
    () => groupedTickets.map((g) => ticketById.get(g.ticket_id)).filter(Boolean),
    [groupedTickets, ticketById]
  );

  return (
    <div className="module-grid">
      {tabBar}
      <ModuleStatCards
        totalLabel="Total"
        total={allRows.length}
        cards={WORK_TRACKER_STAT_CARDS}
        counts={counts}
        activeFilter={activeFilter}
        onFilterChange={setActiveFilter}
      />
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
            placeholder="Search vehicle, plate, or ticket..."
            onExport={() => exportRowsToCsv('work-tracker.csv', [
              { label: 'Ticket', value: (r) => `#${r.ticket_id} ${r.ticket_title}` },
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
        <PaginatedCardGrid
          items={groupedTicketCards}
          keyOf={(t) => t.ticket_id}
          emptyMessage="Nothing here yet — tickets you've worked on will show up here once they're done or deferred."
          renderItem={(t) => <TicketCard ticket={t} onClick={() => onViewTicket(t)} />}
        />
      </section>
    </div>
  );
}

// Problem 2 — the functional test ("UAT") checklist. What must be physically
// operated and confirmed depends on the KIND of vehicle, keyed off the same
// Land/Water domain that drives the specs form (plus a fire-truck extra).
function functionalTestChecklist(vehicle) {
  const domain = vehicle?.category?.domain ?? 'Land';
  const name = (vehicle?.category?.category_name ?? '').toLowerCase();
  const base = [
    'Engine / power system starts normally',
    'No warning indicators or abnormal noise',
    'The reported problem no longer occurs',
  ];
  if (domain === 'Water') {
    return [...base, 'Engine runs under load on the water', 'Bilge pump operates', 'No hull leaks or water ingress'];
  }
  const land = ['Brakes respond properly', 'Completed a short test drive'];
  const fireTruck = name.includes('fire') ? ['Water pump reaches full pressure'] : [];
  return [...base, ...land, ...fireTruck];
}

// The Custodian's verification IS the functional test: operate the vehicle
// against the checklist, mark each Pass/Fail, and the verdict follows the
// result — any Fail => Rejected (bounced back to the mechanic); all Pass =>
// Approved, but only once the tester attests they actually operated it.
function VerificationForm({ target, onCancel, onSubmit }) {
  const checklist = useMemo(() => functionalTestChecklist(target?.vehicle), [target?.vehicle]);
  const [results, setResults] = useState(() => checklist.map((item) => ({ item, passed: null })));
  const [attested, setAttested] = useState(false);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [newTestInput, setNewTestInput] = useState('');

  const allAnswered = results.every((r) => r.passed !== null);
  const anyFailed = results.some((r) => r.passed === false);
  const allPassed = results.length > 0 && results.every((r) => r.passed === true);
  const verdict = anyFailed ? 'Rejected' : 'Approved';
  const needsAttestation = !anyFailed;
  const canSubmit = allAnswered && (!needsAttestation || attested) && !submitting;

  const setResult = (i, passed) => setResults((rs) => rs.map((r, idx) => (idx === i ? { ...r, passed } : r)));
  // Same shortcut as the Readiness Check form — most checks are routine
  // passes, so bulk-marking everything Pass and flipping the odd real
  // failure afterward beats clicking Pass on every single row.
  const toggleAllPassed = (checked) => setResults((rs) => rs.map((r) => ({ ...r, passed: checked ? true : null })));
  const addTest = () => {
    if (newTestInput.trim()) {
      setResults((rs) => [...rs, { item: newTestInput.trim(), passed: null }]);
      setNewTestInput('');
    }
  };
  const removeTest = (i) => setResults((rs) => rs.filter((_, idx) => idx !== i));

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit({
        verification_verdict: verdict,
        verification_notes: notes || null,
        functional_test: results.map((r) => ({ item: r.item, passed: r.passed === true })),
        test_attested: verdict === 'Approved' ? attested : false,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: '0.85rem' }}>
        Physically operate the vehicle and mark each check. A repair is only accepted once it actually works — any failed check sends it back to the mechanic.
      </p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', marginBottom: 8, borderRadius: 8, background: '#eff6ff', border: '1px solid #bfdbfe', fontSize: '0.83rem', fontWeight: 600, color: '#1e40af', cursor: 'pointer' }}>
        <input type="checkbox" checked={allPassed} onChange={(e) => toggleAllPassed(e.target.checked)} style={{ width: 16, height: 16, cursor: 'pointer' }} />
        Mark all as Pass
      </label>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {results.map((r, i) => (
          <div key={r.item} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--surface-2, #f8fafc)', borderRadius: 8, border: '1px solid var(--border, #e2e8f0)' }}>
            <span style={{ fontSize: '0.85rem', flex: 1, color: 'var(--text, #1e293b)' }}>{r.item}</span>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => setResult(i, true)}
                aria-pressed={r.passed === true}
                aria-label={`Pass: ${r.item}`}
                style={{ padding: '4px 12px', borderRadius: 6, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', border: `1px solid ${r.passed === true ? '#16a34a' : '#cbd5e1'}`, background: r.passed === true ? '#16a34a' : '#fff', color: r.passed === true ? '#fff' : '#64748b' }}
              >
                Pass
              </button>
              <button
                type="button"
                onClick={() => setResult(i, false)}
                aria-pressed={r.passed === false}
                aria-label={`Fail: ${r.item}`}
                style={{ padding: '4px 12px', borderRadius: 6, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', border: `1px solid ${r.passed === false ? '#dc2626' : '#cbd5e1'}`, background: r.passed === false ? '#dc2626' : '#fff', color: r.passed === false ? '#fff' : '#64748b' }}
              >
                Fail
              </button>
              <button
                type="button"
                onClick={() => removeTest(i)}
                title="Remove this test"
                aria-label={`Remove check: ${r.item}`}
                style={{ padding: '4px 8px', borderRadius: 6, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', border: '1px solid #fca5a5', background: '#fef2f2', color: '#dc2626' }}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <input
            type="text"
            value={newTestInput}
            onChange={(e) => setNewTestInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && addTest()}
            placeholder="Add a custom test item..."
            style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: '0.85rem', fontFamily: 'inherit' }}
          />
          <button
            type="button"
            onClick={addTest}
            style={{ padding: '8px 16px', borderRadius: 6, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', border: '1px solid #2563eb', background: '#2563eb', color: '#fff' }}
          >
            + Add Test
          </button>
        </div>
      </div>

      {allAnswered && (
        <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 8, fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 8,
          background: anyFailed ? '#fef2f2' : '#ecfdf5', color: anyFailed ? '#991b1b' : '#065f46', border: `1px solid ${anyFailed ? '#fecaca' : '#a7f3d0'}` }}>
          <Icon name={anyFailed ? 'alert' : 'checkCircle'} size={15} />
          {anyFailed
            ? 'A check failed — this will be returned to the mechanic for repair.'
            : 'All checks passed — approving closes this ticket and returns the vehicle to service.'}
        </div>
      )}

      {needsAttestation && (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 12, fontSize: '0.85rem', cursor: 'pointer' }}>
          <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} style={{ marginTop: 3 }} />
          <span>I confirm I <strong>personally operated and tested</strong> this vehicle — this is not a paperwork-only sign-off.</span>
        </label>
      )}

      <div style={{ marginTop: 12 }}>
        <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#475569', marginBottom: 4 }}>Notes {anyFailed ? '(what failed / needs redoing)' : '(optional)'}</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ width: '100%', borderRadius: 8, border: '1px solid #cbd5e1', padding: '8px 10px', fontSize: '0.85rem', fontFamily: 'inherit', resize: 'vertical' }} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
        <button type="button" className="ghost-button" onClick={onCancel}>Cancel</button>
        <button type="button" className={anyFailed ? 'danger-button' : 'primary-button'} onClick={submit} disabled={!canSubmit}>
          {submitting ? 'Submitting…' : anyFailed ? 'Return for Repair' : 'Approve Repair'}
        </button>
      </div>
    </div>
  );
}

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
function TicketVerificationForm({ vehicle, onCancel, onSubmit }) {
  return <VerificationForm target={{ vehicle }} onCancel={onCancel} onSubmit={onSubmit} />;
}

// =========================================================================
// TICKET STATUS BADGE
// =========================================================================

function TicketStatusBadge({ value, size = 'normal' }) {
  const colorMap = {
    'Open': 'ticket-open',
    'Active': 'ticket-repair',
    'For Maintenance': 'ticket-formaint',
    'Under Repair': 'ticket-repair',
    'Pending Approval': 'ticket-formaint',
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

// =========================================================================
// TICKET PROPOSAL REVIEW — Admin's approve/decline screen for a Custodian's
// proposed ticket (status 'Pending Approval'). Kept as its own pair of
// components (not folded into the sub-issue cards below) so the existing
// read-only rendering for every other status stays completely untouched —
// TicketDetailPanel only ever mounts this while ticket.status is exactly
// 'Pending Approval', and swaps in a plain read-only notice instead for
// anyone viewing it without ticket.approve (i.e. the proposing Custodian).
// =========================================================================

function TicketProposalReview({ user, ticket, lookups, onApprove, onDecline, onUndecline }) {
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
  return <TicketProposalReviewForm key={ticket.ticket_id} ticket={ticket} lookups={lookups} onApprove={onApprove} onDecline={onDecline} onUndecline={onUndecline} />;
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
        ['Estimated Cost', si.external_estimated_cost != null ? `₱${Number(si.external_estimated_cost).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : null],
        ['Work to Be Done', si.external_work_scope],
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

function TicketProposalReviewForm({ ticket, lookups, onApprove, onDecline, onUndecline }) {
  const isDeclined = ticket.status === 'Declined';
  // Pre-fill from whatever the Custodian suggested when adding sub-issues
  // (if any) — Admin can still change it before approving.
  const suggestedMechanicId = (ticket.sub_issues ?? []).map((si) => si.suggested_mechanic_id).find(Boolean) ?? '';
  const [fields, setFields] = useState({
    ticket_description: ticket.ticket_description ?? '',
    priority: ticket.priority ?? '',
    assigned_mechanic_id: suggestedMechanicId ? String(suggestedMechanicId) : '',
  });
  const [subRows, setSubRows] = useState(() => (ticket.sub_issues ?? []).map((si) => ({
    sub_issue_id: si.sub_issue_id,
    title: si.title ?? '',
    maintenance_type: si.maintenance_type ?? '',
  })));
  const [declining, setDeclining] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [validationLine, setValidationLine] = useState(null);

  const setField = (name, value) => setFields((f) => ({ ...f, [name]: value }));
  const updateSubRow = (index, patch) => setSubRows((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  // One mechanic does the whole ticket now — approving is the single
  // moment the ticket gets both activated AND dispatched, in one step.
  const submitApprove = async () => {
    if (!fields.assigned_mechanic_id) {
      setValidationLine('Pick who will do this repair before approving.');
      return;
    }
    setValidationLine(null);
    setSubmitting(true);
    try {
      await onApprove({
        ticket_description: fields.ticket_description,
        priority: fields.priority,
        assigned_mechanic_id: fields.assigned_mechanic_id,
        sub_issues: subRows.map((r) => ({
          sub_issue_id: r.sub_issue_id,
          title: r.title,
          maintenance_type: r.maintenance_type || null,
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
          <Icon name="alert" size={15} /> You declined this proposal{ticket.decline_reason ? `: ${ticket.decline_reason}` : '.'} Undecline to send it back to the Custodian, or approve it as-is below.
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
              <select value={fields.priority} onChange={(e) => setField('priority', e.target.value)}>
                {(lookups.priorities ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          </div>
          <label>
            <span>Details</span>
            <textarea rows={3} value={fields.ticket_description} onChange={(e) => setField('ticket_description', e.target.value)} />
          </label>
          <label>
            <span>Assign Mechanic <span className="required-asterisk">*</span></span>
            <select value={fields.assigned_mechanic_id} onChange={(e) => setField('assigned_mechanic_id', e.target.value)}>
              <option value="">Select who will do this repair</option>
              {(lookups.maintenance_personnel ?? []).map((m) => <option key={m.id} value={m.id}>{mechanicWorkloadLabel(m)}</option>)}
            </select>
          </label>
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
          <label>
            <span>Maintenance Type</span>
            <CreatableSelect
              value={row.maintenance_type}
              onChange={(v) => updateSubRow(index, { maintenance_type: v })}
              options={lookups.maintenance_types ?? []}
              newItemLabel="maintenance type"
              catalogEndpoint="/maintenance-types"
            />
          </label>
          <RepairContextDetails si={original} />
        </div>
        );
      })}
        </div>
      </div>

      {validationLine && <p className="notice danger" style={{ margin: '0 0 12px' }}><Icon name="alert" size={14} /> {validationLine}</p>}

      {declining ? (
        <div className="proposal-review-actions is-declining">
          <SmartForm
            fields={[{ label: 'Decline Reason', name: 'decline_reason', type: 'textarea', rows: 2, required: true, placeholder: 'Let the Custodian know why this was declined' }]}
            key={`decline-proposal-${ticket.ticket_id}`}
            onCancel={() => setDeclining(false)}
            onSubmit={(payload) => onDecline(payload)}
            submitLabel="Decline Proposal"
            title=""
          />
        </div>
      ) : (
        <div className="proposal-review-actions">
          <p className="proposal-review-hint">
            {isDeclined
              ? 'Undecline to send this back to the Custodian as-is, or approve it directly below.'
              : 'Edit anything above before approving or declining.'}
          </p>
          <div className="proposal-review-buttons">
            {isDeclined ? (
              <button className="btn-sm ghost-button" type="button" onClick={onUndecline} disabled={submitting}>
                <Icon name="undo" size={14} /> Undecline
              </button>
            ) : (
              <button className="btn-sm danger-button" type="button" onClick={() => setDeclining(true)} disabled={submitting}>
                <Icon name="close" size={14} /> Decline
              </button>
            )}
            <button className="primary-button" type="button" onClick={submitApprove} disabled={submitting}>
              <Icon name="checkCircle" size={14} /> Approve & Assign
            </button>
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

  const subissueBoxStyle = { border: '1px solid #e2e8f0', borderRadius: 10, padding: 14, background: '#fff' };
  const subissueBoxHeadStyle = { display: 'block', fontSize: '0.8rem', fontWeight: 700, color: '#0f172a', marginBottom: 10 };

  return (
    <div className="subissue-two-col" style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1fr) minmax(260px, 1fr)', gap: 18, alignItems: 'start' }}>
      <div style={subissueBoxStyle}>
        <span style={subissueBoxHeadStyle}>Sub-Issue</span>
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
          <span>Maintenance Type</span>
          <CreatableSelect
            value={draft.maintenance_type}
            onChange={(v) => setDraft((d) => ({ ...d, maintenance_type: v }))}
            options={maintenanceTypeOptions ?? []}
            placeholder="Select a category or type to add new"
            newItemLabel="maintenance type"
            catalogEndpoint="/maintenance-types"
          />
        </label>
        {mechanicOptions && (
          <label style={{ marginTop: 10 }}>
            <span>Maintenance Personnel <span className="muted" style={{ fontWeight: 400 }}>(optional — Admin can change this)</span></span>
            <select
              value={draft.suggested_mechanic_id}
              onChange={(e) => setDraft((d) => ({ ...d, suggested_mechanic_id: e.target.value }))}
            >
              <option value="">Unassigned — Admin will decide</option>
              {mechanicOptions.map((m) => <option key={m.id} value={m.id}>{mechanicWorkloadLabel(m)}</option>)}
            </select>
          </label>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button type="button" className="primary-button" disabled={!draft.title.trim()} onClick={save}>
            <Icon name="plus" size={13} /> Add
          </button>
        </div>
      </div>

      <div style={subissueBoxStyle}>
        <span style={subissueBoxHeadStyle}>Saved Subissues</span>
        {items.length === 0 ? (
          <p className="muted" style={{ fontSize: '0.85rem' }}>Nothing added yet.</p>
        ) : (
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {items.map((it, index) => (
              <li key={index} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8 }}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', background: '#eff6ff', color: '#2563eb', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', fontWeight: 700, flexShrink: 0 }}>{index + 1}</span>
                <span style={{ flex: 1, fontSize: '0.85rem' }}>
                  {it.title}
                  {it.maintenance_type && <span className="muted"> — {it.maintenance_type}</span>}
                  {mechanicOptions && it.suggested_mechanic_id && (
                    <span className="muted"> · suggested: {mechanicOptions.find((m) => String(m.id) === String(it.suggested_mechanic_id))?.name ?? '—'}</span>
                  )}
                </span>
                <button type="button" className="icon-btn" title="Edit" aria-label="Edit" onClick={() => startEdit(index)}><Icon name="edit" size={13} /></button>
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

function TicketDetailPanel({ user, userId, ticket, lookups, onAddSubIssue, onEditSubIssue, onDeleteSubIssue, onAssignTicketMechanic, onReassignCustodian, onReopenDone, onLogRepairs, onSubmitForVerification, onVerifyTicket, onViewIssue, onCancel, onUncancel, onDelete, onRequestConfirmation, onApproveCannibalization, onRejectCannibalization, onApproveProposal, onDeclineProposal, onUndeclineProposal, onClose, asPage = false }) {
  const [subDraft, setSubDraft] = useState(null); // { id|null, title, maintenance_type }
  // Cannibalization approval — tracks which sub-issue's reject form is
  // open; Approve has no form of its own (it needs no input beyond the
  // click itself), so it doesn't need a tracked id.
  const [reviewingCannibalizationId, setReviewingCannibalizationId] = useState(null);
  const [approvingCannibalId, setApprovingCannibalId] = useState(null);
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
  const isAdminUser = hasRole(user, 'Admin');
  const isAssignedMechanic = ticket.assigned_mechanic_id != null && String(ticket.assigned_mechanic_id) === String(userId);
  const isAssignedCustodian = ticket.assigned_custodian_id != null && String(ticket.assigned_custodian_id) === String(userId);
  const resolvedCount = progress.done + progress.deferred;
  const inRepairCount = subIssues.filter((s) => s.status === 'Under Repair').length;
  const loggedCount = subIssues.filter((s) => s.status === 'For Inspection').length;
  const pendingApprovalCount = subIssues.filter((s) => s.status === 'Pending Approval').length;
  // Every sub-issue has to have its repair logged (For Inspection) before
  // the mechanic can hand the whole ticket to the Custodian — a cannibalized
  // line item still sitting at Pending Approval naturally blocks this,
  // since it isn't at For Inspection yet either.
  const allLogged = subIssues.length > 0 && subIssues.every((s) => s.status === 'For Inspection');
  const canSubmitForVerification = ticket.status === 'Active' && isAssignedMechanic && allLogged && canDo(user, 'ticket.submit_for_verification');
  const canVerifyTicket = ticket.status === 'For Verification' && isAssignedCustodian && canDo(user, 'ticket.verify');
  const ticketCost = subIssues.reduce((sum, s) => sum + (Number(s.maintenance_cost) || 0), 0);
  const resolvedPercent = ticket.status === 'Closed'
    ? 100
    : subIssues.length > 0 ? Math.round((resolvedCount / subIssues.length) * 100) : 0;
  const nextSignal = (() => {
    if (ticket.status === 'Cancelled') return { tone: 'alert', label: 'Ticket cancelled', detail: 'Restore it only if work needs to resume.' };
    if (ticket.status === 'Closed') return { tone: 'ok', label: 'Closed', detail: 'All recorded work is complete.' };
    if (ticket.status === 'Declined') return { tone: 'alert', label: 'Declined', detail: 'Undecline to revise and resubmit it, or approve it as-is below.' };
    if (ticket.status === 'Pending Approval') return { tone: 'warn', label: 'Review proposal', detail: 'A Custodian proposed this ticket — review and approve or decline it below.' };
    if (ticket.status === 'For Verification') return isAssignedCustodian
      ? { tone: 'warn', label: 'Verify repair', detail: 'The mechanic says this is done — confirm it before the ticket closes.' }
      : { tone: 'active', label: 'Awaiting verification', detail: `${ticket.assigned_custodian?.name ?? 'The assigned Custodian'} needs to verify this repair.` };
    if (canSubmitForVerification) return { tone: 'warn', label: 'Submit for verification', detail: 'Every sub-issue is logged — submit the ticket for the Custodian to verify.' };
    if (isAdminUser && pendingApprovalCount > 0) return { tone: 'warn', label: 'Approve cannibalized repair', detail: `${pendingApprovalCount} repair${pendingApprovalCount === 1 ? '' : 's'} using a part from another vehicle ${pendingApprovalCount === 1 ? 'needs' : 'need'} your approval.` };
    if (pendingApprovalCount > 0) return { tone: 'active', label: 'Awaiting Admin approval', detail: 'A cannibalized repair is waiting for Admin approval before it can be logged as done.' };
    if (!isAdminUser && isAssignedMechanic && inRepairCount > 0) return { tone: 'warn', label: 'Log your repairs', detail: `${inRepairCount} sub-issue${inRepairCount === 1 ? '' : 's'} still ${inRepairCount === 1 ? 'needs' : 'need'} a repair log.` };
    if (inRepairCount > 0) return { tone: 'active', label: 'Repair in progress', detail: `${ticket.assigned_mechanic?.name ?? 'The assigned mechanic'} is still working on ${inRepairCount} sub-issue${inRepairCount === 1 ? '' : 's'}.` };
    return { tone: 'active', label: 'Work in motion', detail: 'Follow the active handoff shown in the repair board.' };
  })();
  const processStats = [
    { icon: 'list', label: 'Sub-issues', value: subIssues.length },
    { icon: 'wrench', label: 'In repair', value: inRepairCount },
    { icon: 'search', label: 'Logged', value: loggedCount },
    { icon: 'clipboard', label: 'Cost', value: ticketCost ? `PHP ${ticketCost.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : 'PHP 0.00' },
  ];

  // "How long has this been sitting?" — the aging signal. Flagged past 30 days.
  const daysOpen = ticket.days_open;
  const isAging = ticket.status !== 'Closed' && ticket.status !== 'Cancelled' && typeof daysOpen === 'number' && daysOpen >= 30;

  const requestDelete = () => {
    onRequestConfirmation({
      title: 'Delete Ticket',
      message: `Are you sure you want to completely delete Ticket #${ticket.ticket_id}? This action cannot be undone.`,
      confirmLabel: 'Delete Ticket',
      variant: 'danger',
      onConfirm: () => onDelete(ticket),
    });
  };

  const requestCancel = () => {
    onRequestConfirmation({
      title: 'Cancel Ticket',
      message: `Are you sure you want to cancel Ticket #${ticket.ticket_id}? Work on it stops here — it can be uncancelled later if needed.`,
      confirmLabel: 'Cancel Ticket',
      variant: 'primary',
      onConfirm: () => onCancel(ticket),
    });
  };

  const panel = (
      <div className={`ticket-detail-panel${asPage ? ' is-page' : ''}`} onClick={asPage ? undefined : (e) => e.stopPropagation()}>
        <section className={`ticket-process-hero is-${nextSignal.tone}`}>
          <div className="ticket-process-meter" style={{ '--ticket-progress': `${resolvedPercent}%` }}>
            <div className="ticket-process-meter-core">
              <span>Resolved</span>
              {/* A zero-sub-issue ticket (inspection found nothing to repair) has
                  nothing to measure progress against — "0%" would read as
                  "nothing done" right next to a "ready to close" banner. */}
              <strong>{progress.total > 0 ? `${resolvedPercent}%` : '—'}</strong>
              <small>{progress.total > 0 ? `${resolvedCount}/${progress.total} items` : 'No sub-issues'}</small>
            </div>
          </div>
          <div className="ticket-process-hero-main">
            <div className="ticket-process-kicker">
              <span>Ticket #{ticket.ticket_id}</span>
              {typeof daysOpen === 'number' && (
                <span>{daysOpen === 0 ? 'Opened today' : `${daysOpen} day${daysOpen === 1 ? '' : 's'} open`}</span>
              )}
            </div>
            <h3 className="ticket-detail-title">{ticket.ticket_title}</h3>
            <div className="ticket-detail-meta">
              <TicketStatusBadge value={ticket.priority} />
              <TicketStageBadge ticket={ticket} variant="pill" />
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

          <div className="ticket-process-next-card">
            {asPage ? null : (
              <button className="icon-btn ticket-process-close" onClick={onClose} type="button" title="Close" aria-label="Close"><Icon name="close" size={18} /></button>
            )}
            <span className="ticket-process-next-label">Next best action</span>
            <strong>{nextSignal.label}</strong>
            <p>{nextSignal.detail}</p>
            <div className="ticket-process-stat-grid">
              {processStats.map((stat) => (
                <div key={stat.label} className="ticket-process-stat">
                  <span className="ticket-process-stat-icon"><Icon name={stat.icon} size={14} /></span>
                  <strong className="ticket-process-stat-value">{stat.value}</strong>
                  <span className="ticket-process-stat-label">{stat.label}</span>
                </div>
              ))}
            </div>
          </div>
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
              const hint = {
                'Pending Approval': 'Admin approves & assigns a mechanic',
                Active: 'Mechanic repairs, logs, submits',
                'For Verification': 'Custodian verifies',
                Closed: 'Return or archive',
              }[s];
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
                  <div className="ticket-preview-badges">
                    <StatusBadge value={ticket.vehicle?.status} />
                    <StatusBadge value={ticket.vehicle?.condition} />
                  </div>
                </div>
              </div>
              <div className="ticket-detail-description-box">
                <span className="ticket-detail-label">Description</span>
                <ExpandableText text={ticket.ticket_description} className="muted" lines={3} />
              </div>
              {ticket.issue_report_id && onViewIssue && canDo(user, 'issue.view') && (
                <button className="ghost-button" type="button" style={{ marginTop: 10 }} onClick={() => onViewIssue(ticket.issue_report_id)}>
                  <Icon name="alert" size={13} /> From Issue Report #{ticket.issue_report_id}
                </button>
              )}
            </section>

            {ticket.assigned_custodian_id && (
              <section className={`ticket-section${ticket.inspection_result === 'Needs Maintenance' ? ' ticket-section--flag-warn' : ticket.inspection_result === 'No Issues' ? ' ticket-section--flag-ok' : ''}`}>
                <h4><Icon name="search" size={14} /> Custodian Inspection</h4>
                <div className="ticket-kv-row" style={{ marginBottom: (ticket.inspection_notes ? 8 : 0) }}>
                  <div>
                    <span>Assigned To</span>
                    <UserAvatarName user={ticket.assigned_custodian} />
                  </div>
                  {ticket.inspection_result && (
                    <div>
                      <span>Result</span>
                      <TicketStatusBadge value={ticket.inspection_result} />
                    </div>
                  )}
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
              <FormModal open={reassigningCustodian} title="Reassign Custodian" onClose={() => setReassigningCustodian(false)}>
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

            {ticket.assigned_mechanic_id && (
              <section className="ticket-section">
                <h4><Icon name="wrench" size={14} /> Assigned Mechanic</h4>
                <div className="ticket-kv-row">
                  <div>
                    <span>Doing the repair</span>
                    <div className="ticket-person-row">
                      <UserAvatarName user={ticket.assigned_mechanic} />
                      <span className="ticket-role-tag">Maintenance Personnel</span>
                    </div>
                  </div>
                </div>
                {canDo(user, 'ticket.assign_mechanic') && onAssignTicketMechanic && !['Closed', 'Cancelled'].includes(ticket.status) && (
                  <button className="ghost-button btn-reassign-action" style={{ marginTop: 10 }} type="button" onClick={() => setReassigningMechanic(true)}>
                    <Icon name="undo" size={12} /> Reassign Mechanic
                  </button>
                )}
              </section>
            )}

            {canDo(user, 'ticket.assign_mechanic') && onAssignTicketMechanic && (
              <FormModal open={reassigningMechanic} title="Reassign Mechanic" onClose={() => setReassigningMechanic(false)}>
                <p className="muted" style={{ marginBottom: 8, fontSize: '0.8rem' }}>
                  Hand the whole ticket to a different mechanic (e.g. the current one is out sick). If it was already submitted for verification, this sends it back to Active — the new mechanic's work is what needs verifying.
                </p>
                <SmartForm
                  fields={[
                    { label: 'Reassign to Mechanic', name: 'assigned_mechanic_id', options: (lookups.maintenance_personnel ?? []).filter((m) => m.id !== ticket.assigned_mechanic_id).map((m) => ({ value: m.id, label: mechanicWorkloadLabel(m) })), required: true, type: 'select' },
                    { label: 'Reason for reassigning', name: 'reassign_reason', required: true, type: 'textarea', rows: 2 },
                  ]}
                  key={`reassign-mechanic-${ticket.ticket_id}`}
                  onCancel={() => setReassigningMechanic(false)}
                  onSubmit={(payload) => onAssignTicketMechanic(ticket, payload).then((ok) => { if (ok !== false) setReassigningMechanic(false); })}
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
                {[
                  { label: 'Created', at: ticket.created_at, by: ticket.created_by, icon: 'clipboard' },
                  ticket.assigned_at && { label: 'Assigned to Custodian', at: ticket.assigned_at, by: ticket.assigned_custodian, icon: 'search' },
                  // Pre-Diagnosed skips inspection entirely — inspected_by is
                  // stamped with whoever CREATED the ticket (usually Admin),
                  // not the Custodian above, so it's labelled by what actually
                  // happened instead of implying an inspection that didn't.
                  ticket.inspected_at && { label: ticket.inspected_by?.id === ticket.assigned_custodian_id ? 'Inspected' : 'Pre-diagnosed', at: ticket.inspected_at, by: ticket.inspected_by, icon: 'search' },
                  ticket.closed_at && { label: 'Closed', at: ticket.closed_at, by: ticket.closed_by, icon: 'checkCircle' },
                ].filter(Boolean).map((ev, i, all) => (
                  <div key={ev.label} className="ticket-timeline-item">
                    <div className="ticket-timeline-marker">
                      <span className="ticket-timeline-dot"><Icon name={ev.icon} size={11} /></span>
                      {i < all.length - 1 && <span className="ticket-timeline-line" />}
                    </div>
                    <div className="ticket-timeline-content">
                      <p>{ev.label}</p>
                      <div className="ticket-timeline-meta">
                        {ev.by?.name && <span>by {ev.by.name}</span>}
                        <QuietDate value={ev.at} />
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
            />
          )}
          {ticket.status !== 'Open' && ticket.status !== 'Pending Approval' && ticket.status !== 'Declined' && (
            <section className="ticket-section">
              <h4>
                <Icon name="wrench" size={14} /> Sub-Issues
                {progress.total > 0 && <span className="ticket-count-pill">{progress.total}</span>}
                <span
                  className="ticket-section-info-icon"
                  title="Keep sub-issues and the mechanic's Maintenance Type scoped to this Main Issue — an unrelated repair belongs on its own ticket instead."
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

              {/* Adding a brand-new sub-issue to an already-Active ticket is
                  deliberately not offered — every sub-issue is supposed to be
                  settled at Admin approval, before repair starts. This inline
                  form still renders for editing an existing sub-issue (the
                  pencil icon below sets subDraft with its id), since that's
                  unchanged — only the "Add Sub-issue" entry point is gone. */}
              {subDraft && (
                <div className="ticket-inline-form" style={{ marginBottom: 10, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input
                      type="text"
                      autoFocus
                      placeholder="What else is wrong?"
                      value={subDraft.title}
                      onChange={(e) => setSubDraft({ ...subDraft, title: e.target.value })}
                      style={{ flex: '2 1 240px' }}
                    />
                    <input
                      type="text"
                      list="subissue-maintenance-types"
                      placeholder="Maintenance type (optional)"
                      value={subDraft.maintenance_type}
                      onChange={(e) => setSubDraft({ ...subDraft, maintenance_type: e.target.value })}
                      style={{ flex: '1 1 180px' }}
                    />
                    <datalist id="subissue-maintenance-types">
                      {(lookups.maintenance_types ?? []).map((t) => <option key={t.name ?? t} value={t.name ?? t} />)}
                    </datalist>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={!subDraft.title.trim()}
                      onClick={async () => {
                        const payload = { title: subDraft.title.trim(), maintenance_type: subDraft.maintenance_type.trim() || null };
                        const ok = subDraft.id ? await onEditSubIssue(ticket, subDraft.id, payload) : await onAddSubIssue(ticket, payload);
                        if (ok !== false) setSubDraft(null);
                      }}
                    >
                      {subDraft.id ? 'Save' : 'Add'}
                    </button>
                    <button type="button" className="ghost-button" onClick={() => setSubDraft(null)}>Cancel</button>
                  </div>
                </div>
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
                    {onEditSubIssue && ticket.status === 'Active' && ['Open', 'Under Repair'].includes(si.status) && canDo(user, 'subissue.manage') && (hasRole(user, 'Admin') || String(ticket.assigned_custodian_id) === String(userId)) && (
                      <span className="subissue-card-head-actions">
                        <button type="button" className="btn-edit-action icon-btn" title="Edit sub-issue" aria-label="Edit sub-issue" onClick={() => setSubDraft({ id: si.sub_issue_id, title: si.title, maintenance_type: si.maintenance_type ?? '' })}><Icon name="edit" size={13} /></button>
                        {subIssues.length > 1 && (
                          <button type="button" className="btn-delete-action icon-btn" title="Remove sub-issue" aria-label="Remove sub-issue" onClick={() => onDeleteSubIssue(ticket, si)}><Icon name="trash" size={13} /></button>
                        )}
                      </span>
                    )}                  </div>

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
                  {open && <RepairContextDetails si={si} />}

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
                  {si.parts_used && (
                    <div className="subissue-field">
                      <span className="subissue-field-label">Parts Used</span>
                      <PartsTags value={si.parts_used} />
                    </div>
                  )}
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
                    <p className="muted">Admin verdict: <TicketStatusBadge value={si.confirmation_verdict} /> {si.confirmation_notes}</p>
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
              functional test, then Approve (closes it) or Return for Repair. */}
          {canVerifyTicket && (
            <section className="ticket-section">
              <h4><Icon name="checkCircle" size={14} /> Verify Repair</h4>
              {verifying ? (
                <TicketVerificationForm
                  vehicle={ticket.vehicle}
                  onCancel={() => setVerifying(false)}
                  onSubmit={(payload) => onVerifyTicket(ticket, payload).then((ok) => { if (ok !== false) setVerifying(false); })}
                />
              ) : (
                <button className="primary-button" type="button" onClick={() => setVerifying(true)}>
                  <Icon name="checkCircle" size={14} /> Verify Repair
                </button>
              )}
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
          <div className="ticket-detail-actions-row">
            {canDo(user, 'ticket.uncancel') && ticket.status === 'Cancelled' && onUncancel && (
              <button className="primary-button" type="button" onClick={() => onUncancel(ticket)}>Restore Ticket</button>
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
            {canDo(user, 'ticket.delete') && ticket.status !== 'Closed' && ticket.status !== 'Pending Approval' && (
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
    setLoading(true);
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
      <ModulePanel description="This ticket could not be found — it may have been deleted or archived.">
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
      onCancel={(t) => sendTicketAction(`/tickets/${t.ticket_id}/cancel`, {}, 'Ticket cancelled.').then(afterAction)}
      onUncancel={(t) => sendTicketAction(`/tickets/${t.ticket_id}/uncancel`, {}, 'Ticket restored.').then(afterAction)}
      onDelete={(t) => onDeleteTicket(t).then(onBack)}
      onApproveProposal={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/approve`, payload, 'Ticket proposal approved.').then(afterAction)}
      // Declining no longer deletes the ticket — it becomes a visible,
      // reversible Declined status, so this stays on the page and refreshes
      // in place, same as every other action here.
      onDeclineProposal={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/decline`, payload, 'Ticket proposal declined.').then(afterAction)}
      onUndeclineProposal={(t) => sendTicketAction(`/tickets/${t.ticket_id}/undecline`, {}, 'Proposal restored to Pending Approval.').then(afterAction)}
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
  const selectedVehicleId = liveValues.vehicle_id ?? null;
  const [openTicketsOnVehicle, setOpenTicketsOnVehicle] = useState([]);
  // Same reasoning as the open-tickets check above, for recurrence instead of
  // duplicates: this used to only ever reach Admin in a notification sent
  // AFTER the ticket was created — too late to change the decision. Checking
  // it here means "this fault came back a 3rd time" is visible while Admin is
  // still choosing, not after.
  const [recurrence, setRecurrence] = useState(null);

  useEffect(() => {
    if (!selectedVehicleId) {
      setOpenTicketsOnVehicle([]);
      return;
    }
    let cancelled = false;
    api.get(`/vehicles/${selectedVehicleId}/open-tickets`)
      .then((response) => { if (!cancelled) setOpenTicketsOnVehicle(response.data); })
      .catch(() => { if (!cancelled) setOpenTicketsOnVehicle([]); });
    return () => { cancelled = true; };
  }, [selectedVehicleId]);

  useEffect(() => {
    const title = (liveValues.ticket_title ?? '').trim();
    if (!selectedVehicleId || !title) { setRecurrence(null); return; }
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
    // especially "How Is This Being Reported?", which isn't a native form
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
            Linking this ticket to <strong>Issue Report #{prefilledTicketData.issue_report_id}</strong>.
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
                  <span style={{ flex: 1 }}>#{t.ticket_id} "{t.ticket_title}" — {t.status}</span>
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
      <form className="smart-form ticket-create-form" onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {validationLines && (
          <div className="toast-notice-overlay" onClick={() => setValidationLines(null)}>
            <div className="toast-notice toast-notice-validation error" role="alert" onClick={(e) => e.stopPropagation()}>
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
        <section className="veh-card">
          <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>How Is This Being Reported?</h4></div>
          <div style={{ padding: 18 }}>
            <div className="entry-mode-toggle" role="radiogroup" aria-label="Entry mode">
              {ENTRY_MODE_OPTIONS.map((opt) => {
                const checked = liveValues.entry_mode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    className={`entry-mode-btn entry-mode-btn--${opt.value} ${checked ? 'primary-button' : 'ghost-button'}`}
                    onClick={() => selectEntryMode(opt.value)}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <p className="muted" style={{ margin: '10px 0 0', fontSize: '0.82rem' }}>
              {liveValues.entry_mode == null
                ? 'Pick whichever matches what you already know about this repair.'
                : preDiagnosed
                  ? 'The problem (and how it will be fixed) is already known — this skips straight to a mechanic, no custodian inspection needed.'
                  : "Nobody has confirmed what's wrong yet — the assigned custodian will inspect the vehicle first."}
            </p>
            {isCannibalized && (
              <label style={{ marginTop: 12, maxWidth: 320 }}>
                <span>Source Vehicle (donor) <span className="required-asterisk">*</span></span>
                <select
                  required
                  value={liveValues.source_vehicle_id ?? ''}
                  onChange={(e) => setField('source_vehicle_id', e.target.value)}
                >
                  <option value="">{' '}</option>
                  {sourceVehicleOptions.map((v) => <option key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_name} ({v.plate_number})</option>)}
                </select>
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

        <section className="veh-card">
          <div className="veh-card-head"><Icon name="vehicle" size={16} /><h4>Vehicle & Assignment</h4></div>
          <div className="ticket-form-grid-2">
            <label>
              <span>Vehicle <span className="required-asterisk">*</span></span>
              <select required value={liveValues.vehicle_id ?? ''} onChange={(e) => setField('vehicle_id', e.target.value)}>
                <option value="">{' '}</option>
                {vehicleOptions.map((v) => <option key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_name} ({v.plate_number})</option>)}
              </select>
            </label>
            <label>
              <span>
                Assign to Custodian ({isExternal ? 'checks the vehicle when it returns' : 'verifies the repair later'})
                {' '}<span className="required-asterisk">*</span>
              </span>
              <select required value={liveValues.assigned_custodian_id ?? ''} onChange={(e) => setField('assigned_custodian_id', e.target.value)}>
                <option value="">{' '}</option>
                {custodianOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
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

        <section className="veh-card veh-card-form">
          <div className="veh-card-head"><Icon name="alert" size={16} /><h4>Issue Details</h4></div>
          <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
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
            <label style={{ maxWidth: 260 }}>
              <span>Priority <span className="required-asterisk">*</span></span>
              <select required value={liveValues.priority ?? ''} onChange={(e) => setField('priority', e.target.value)}>
                <option value="">{' '}</option>
                {priorityOptions.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
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
                  newItemLabel="maintenance type"
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
function ProposeTicketPage({ onBack, ticketLookups, onProposeTicket, onDirty, prefilledTicketData }) {
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

  const clearProposeDraft = () => {
    clearDraftState(`${draftKeyBase}:values`);
    clearDraftState(`${draftKeyBase}:sub-issues`);
    clearDraftState(`${draftKeyBase}:part-rows`);
  };
  const updatePartRow = (index, patch) => {
    setPartRows((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
    onDirty?.();
  };
  const addPartRow = () => setPartRows((rows) => [...rows, emptyPartRow]);
  const removePartRow = (index) => setPartRows((rows) => rows.filter((_, i) => i !== index));

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
  const entryMode = ['in_house', 'cannibalized', 'external'].includes(liveValues.entry_mode) ? liveValues.entry_mode : null;
  const pickerValue = entryMode === 'cannibalized' ? 'in_house' : entryMode;
  const isInHouse = entryMode === 'in_house';
  const isCannibalized = entryMode === 'cannibalized';
  const isExternal = entryMode === 'external';
  const toggleDonorPart = (checked) => {
    setLiveValues((v) => ({ ...v, entry_mode: checked ? 'cannibalized' : 'in_house', source_vehicle_id: '' }));
    onDirty?.();
  };
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
    if (!(liveValues.ticket_description ?? '').trim()) errors.push('Details is required.');
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
      if (!(liveValues.external_work_scope ?? '').trim()) errors.push('Work to Be Done at the Shop is required.');
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
        ticket_description: liveValues.ticket_description,
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
      if (created) { clearProposeDraft(); onBack(); }
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
  useEffect(() => {
    if (fromFlag || !liveValues.vehicle_id) { setOpenReports([]); return undefined; }
    let cancelled = false;
    api.get(`/vehicles/${liveValues.vehicle_id}/open-issues`)
      .then((response) => {
        if (cancelled) return;
        const open = (response.data ?? []).filter((r) => ['Pending', 'Under Review'].includes(r.status));
        setOpenReports(open);
        setLiveValues((v) => (v.link_issue_id && !open.some((r) => String(r.issue_report_id) === String(v.link_issue_id)) ? { ...v, link_issue_id: '' } : v));
      })
      .catch(() => { if (!cancelled) setOpenReports([]); });
    return () => { cancelled = true; };
  }, [liveValues.vehicle_id, fromFlag]);
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
      <form className="smart-form ticket-create-form" onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {validationLines && (
          <div className="toast-notice-overlay" onClick={() => setValidationLines(null)}>
            <div className="toast-notice toast-notice-validation error" role="alert" onClick={(e) => e.stopPropagation()}>
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

        <section className="veh-card">
          <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>How Is This Being Reported?</h4></div>
          <div style={{ padding: 18 }}>
            <div className="entry-mode-toggle" role="radiogroup" aria-label="Entry mode">
              {modeOptions.map((opt) => {
                const checked = pickerValue === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    className={`entry-mode-btn entry-mode-btn--${opt.value} ${checked ? 'primary-button' : 'ghost-button'}`}
                    onClick={() => selectEntryMode(opt.value)}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            {pickerValue === 'in_house' && (
              // A div, not a <label>: the form's label styles (small caps,
              // stacked layout) fight a checkbox row.
              <div
                role="checkbox"
                aria-checked={isCannibalized}
                tabIndex={0}
                onClick={() => toggleDonorPart(!isCannibalized)}
                onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleDonorPart(!isCannibalized); } }}
                style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginTop: 18, padding: '12px 14px', background: isCannibalized ? '#f0fdf4' : '#f8fafc', border: `1px solid ${isCannibalized ? '#86efac' : '#e2e8f0'}`, borderRadius: 8, cursor: 'pointer' }}
              >
                <span
                  aria-hidden="true"
                  style={{ flexShrink: 0, width: 20, height: 20, marginTop: 1, borderRadius: 5, border: `2px solid ${isCannibalized ? '#16a34a' : '#94a3b8'}`, background: isCannibalized ? '#16a34a' : '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}
                >
                  {isCannibalized && <Icon name="checkCircle" size={13} />}
                </span>
                <div>
                  <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#0f172a' }}>This repair uses a part taken from another vehicle</div>
                  <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: 2 }}>An Admin approves it before any part is removed from the other (donor) vehicle.</div>
                </div>
              </div>
            )}
            <p className="muted" style={{ margin: '10px 0 0', fontSize: '0.82rem' }}>
              {entryMode == null
                ? 'Pick how this repair will be done.'
                : 'Once an Admin approves, it goes straight to repair — a mechanic gets assigned to each sub-issue.'}
            </p>
          </div>
        </section>

        <section className="veh-card">
          <div className="veh-card-head"><Icon name="vehicle" size={16} /><h4>Vehicle</h4></div>
          {/* The picker and the selected vehicle's info now sit side by side
              (one .ticket-form-grid-2 row) instead of the preview stacking
              full-width underneath — picker on the left, info on the right. */}
          <div className="ticket-form-grid-2">
            <label>
              <span>Vehicle <span className="required-asterisk">*</span></span>
              <select required value={liveValues.vehicle_id ?? ''} onChange={(e) => setField('vehicle_id', e.target.value)}>
                <option value="">{' '}</option>
                {vehicleOptions.map((v) => <option key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_name} ({v.plate_number})</option>)}
              </select>
            </label>
            {selectedVehicle && (
              <div className="ticket-preview-card ticket-preview-card--lg" style={{ alignSelf: 'start' }}>
                {selectedVehicle.photo_url ? (
                  <img className="ticket-preview-photo ticket-preview-photo--lg" src={resolvePhotoUrl(selectedVehicle.photo_url)} alt={selectedVehicle.vehicle_name} />
                ) : (
                  <span className="ticket-preview-photo ticket-preview-photo--lg ticket-preview-photo-empty"><Icon name="vehicle" size={44} /></span>
                )}
                <div className="ticket-preview-body ticket-preview-body--lg">
                  <strong>{selectedVehicle.vehicle_name}</strong>
                  <span>{selectedVehicle.plate_number} &middot; {selectedVehicle.category?.category_name ?? 'Unclassified'}</span>
                  <span className="muted">{[selectedVehicle.brand, selectedVehicle.model].filter(Boolean).join(' ') || '—'} &middot; {selectedVehicle.current_location ?? 'No location on file'}</span>
                </div>
              </div>
            )}
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

        <section className="veh-card veh-card-form">
          <div className="veh-card-head"><Icon name="alert" size={16} /><h4>Issue Details</h4></div>
          <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* No Ticket Title field — it's automatic (vehicle + repair type),
                and the Admin folds the ticket's own # into it on approval. */}
            <label>
              <span>Details <span className="required-asterisk">*</span></span>
              <textarea required rows={3} value={liveValues.ticket_description ?? ''} onChange={(e) => setField('ticket_description', e.target.value)} />
            </label>
            <label style={{ maxWidth: 260 }}>
              <span>Priority <span className="required-asterisk">*</span></span>
              <select required value={liveValues.priority ?? ''} onChange={(e) => setField('priority', e.target.value)}>
                <option value="">{' '}</option>
                {priorityOptions.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          </div>
        </section>

        {isCannibalized && (
        <section className="veh-card veh-card-form">
          <div className="veh-card-head"><Icon name="wrench" size={16} /><h4>Cannibalization Details</h4></div>
          <div style={{ padding: 18 }}>
            <p className="muted" style={{ marginTop: 0, marginBottom: 14 }}>
              Identify what this vehicle is missing and which part will be taken off the donor to fix it — add a row per part. The Admin reviews this before any part is removed.
            </p>
            <label style={{ maxWidth: 420, marginBottom: 14 }}>
              <span>Donor Vehicle <span className="required-asterisk">*</span></span>
              <select required value={liveValues.source_vehicle_id ?? ''} onChange={(e) => setField('source_vehicle_id', e.target.value)}>
                <option value="">{' '}</option>
                {sourceVehicleOptions.map((v) => <option key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_name} ({v.plate_number})</option>)}
              </select>
            </label>
            <div className="sub-issue-rows sub-issue-rows-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 10, alignItems: 'start' }}>
              {partRows.map((row, index) => (
                <div key={index} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 10, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span className="sub-issue-row-index" style={{ marginTop: 12 }}>{index + 1}</span>
                  <div className="ticket-form-grid-2" style={{ padding: 0, flex: 1 }}>
                    <label>
                      <span>Missing / Faulty Part (on this vehicle) <span className="required-asterisk">*</span></span>
                      <input type="text" placeholder="e.g. Alternator" value={row.part_missing} onChange={(e) => updatePartRow(index, { part_missing: e.target.value })} />
                    </label>
                    <label>
                      <span>Part to Take From Donor <span className="required-asterisk">*</span></span>
                      <input type="text" placeholder="e.g. Alternator (12V, 90A)" value={row.part_needed} onChange={(e) => updatePartRow(index, { part_needed: e.target.value })} />
                    </label>
                    <label>
                      <span>Maintenance Type</span>
                      <CreatableSelect
                        value={row.maintenance_type ?? ''}
                        onChange={(v) => updatePartRow(index, { maintenance_type: v })}
                        options={ticketLookups?.maintenance_types ?? []}
                        placeholder="Select a category or type to add new"
                        newItemLabel="maintenance type"
                        catalogEndpoint="/maintenance-types"
                      />
                    </label>
                  </div>
                  <button
                    type="button"
                    className="btn-delete-action icon-btn"
                    style={{ marginTop: 10 }}
                    onClick={() => removePartRow(index)}
                    disabled={partRows.length === 1}
                    title="Remove part"
                    aria-label="Remove part"
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="primary-button" style={{ marginTop: 10 }} onClick={addPartRow}><Icon name="plus" size={14} /> Add another part</button>
          </div>
        </section>
        )}

        {isExternal && (
        <section className="veh-card veh-card-form">
          <div className="veh-card-head"><Icon name="wrench" size={16} /><h4>External Shop Details</h4></div>
          <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <p className="muted" style={{ margin: 0 }}>
              Give the Admin a verifiable reason for sending this out and exactly what the shop is asked to do.
            </p>
            <div className="ticket-form-grid-2" style={{ padding: 0 }}>
              <label>
                <span>Reason for Sending Out <span className="required-asterisk">*</span></span>
                <select required value={liveValues.external_reason ?? ''} onChange={(e) => setField('external_reason', e.target.value)}>
                  <option value="">{' '}</option>
                  {(ticketLookups.external_reasons ?? []).map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              <label>
                <span>Maintenance Type</span>
                <CreatableSelect
                  value={liveValues.external_maintenance_type ?? ''}
                  onChange={(v) => setField('external_maintenance_type', v)}
                  options={ticketLookups?.maintenance_types ?? []}
                  placeholder="Select a category or type to add new"
                  newItemLabel="maintenance type"
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
                <span>Estimated Cost (PHP)</span>
                <input type="number" min="0" placeholder="e.g. 5000" value={liveValues.external_estimated_cost ?? ''} onChange={(e) => setField('external_estimated_cost', e.target.value)} />
              </label>
            </div>
            <label>
              <span>Work to Be Done at the Shop <span className="required-asterisk">*</span></span>
              <textarea rows={3} placeholder="e.g. Diagnose and recharge A/C system, replace compressor if needed" value={liveValues.external_work_scope ?? ''} onChange={(e) => setField('external_work_scope', e.target.value)} />
            </label>
          </div>
        </section>
        )}

        {isInHouse && (
        <section className="veh-card veh-card-form">
          <div className="veh-card-head"><Icon name="wrench" size={16} /><h4>Sub-Issues</h4></div>
          <div style={{ padding: 18 }}>
            <p className="muted" style={{ marginTop: 0, marginBottom: 14 }}>
              List each specific problem you found, with its own maintenance type — different problems on the same ticket can need different kinds of repair. The Admin assigns one mechanic to the whole ticket when approving it.
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

        <div className="form-actions">
          <button className="ghost-button" onClick={() => { clearProposeDraft(); onBack(); }} type="button" disabled={submitting}>Cancel</button>
          <button className="primary-button" type="submit" disabled={submitting}>Submit for Admin Review</button>
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
  onViewVehicle,
}) {
  const [ticketViewMode, setTicketViewMode] = useState(
    () => localStorage.getItem('vms_ticket_view') || 'card'
  );

  const changeTicketViewMode = (mode) => {
    setTicketViewMode(mode);
    localStorage.setItem('vms_ticket_view', mode);
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
  // "Ready to close" now means what it actually takes to close a ticket:
  // the mechanic has submitted, and the Custodian's one verification is the
  // only thing left before it's Closed. (The old definition — every
  // sub-issue already Done while the ticket is still Active — can't happen
  // anymore: verifyTicket() marks every sub-issue Done and closes the
  // ticket in the same transaction.)
  const readyToCloseTickets = useMemo(
    () => statSourceTickets.filter((t) => t.status === 'For Verification'),
    [statSourceTickets]
  );

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

  const ticketColumnDefs =useMemo(() => ticketTableColumns(unreadByTicket), [unreadByTicket]);
  const ticketColumnChooser = useColumnChooser('vms_ticket_columns', ticketColumnDefs);

  return (
    <div className="module-grid">
      <DismissibleHint description="Central Ticket Ledger — review Custodian proposals, approve and assign a mechanic, then let the mechanic's submission and the Custodian's verification carry the ticket through to Closed." />
      <ModuleStatCards
        totalLabel="Total Tickets"
        total={ticketStats.total}
        cards={TICKET_STAT_CARDS}
        counts={ticketStats}
        activeFilter={filterStatus}
        onFilterChange={setFilterStatus}
      />
      {/* Same layout as the Issue Reports page: the priority bar and the
          filters stack on the left, Latest Reports spans both on the right.
          The bar counts the same full list as the stat cards above. */}
      <div className={`ticket-summary-grid${recentIssues && recentIssues.length > 0 ? '' : ' no-side'}`}>
        <div className="ticket-summary-chart">
          <StackedBarChart
            title="Maintenance Tickets"
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
          <LatestIssueCard issues={recentIssues} onRowClick={(row) => row.vehicle && onViewVehicle?.(row.vehicle)} />
        )}
      </div>

      <TicketsReadyToClosePanel tickets={readyToCloseTickets} onViewTicket={onViewTicket} />

      <section className="panel" style={{ width: '100%' }}>
        {/* Alert banners */}
        {pendingCannibalizationCount > 0 && (
          <div className="ticket-alert-banner formaint">
            <Icon name="alert" size={16} /> <strong>{pendingCannibalizationCount}</strong> cannibalized repair{pendingCannibalizationCount > 1 ? 's' : ''} waiting for your approval.
          </div>
        )}

        <div className="panel-header-bar" style={{ marginBottom: '8px' }}>
          <h3>All Tickets <span className="count-badge">{tickets.length}</span></h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {onViewArchives && (
              <button type="button" className="ghost-button" onClick={onViewArchives}>
                <Icon name="archive" size={14} /> Archives
              </button>
            )}
            <ViewModeDropdown value={ticketViewMode} onChange={changeTicketViewMode} />
            <LocalSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search tickets..."
              onAdd={onCreateNew}
              addLabel="Create Ticket"
              columnChooser={ticketViewMode === 'table' ? ticketColumnChooser : undefined}
            />
          </div>
        </div>

        <div style={{ height: '12px' }} />

        {tickets.length === 0
          ? <p className="empty-state">No tickets yet. Create one to begin the workflow.</p>
          : ticketViewMode === 'table'
            ? <PaginatedTable columns={ticketColumnChooser.visibleColumns} onReorderColumn={ticketColumnChooser.reorderColumn} rows={tickets} onRowClick={onViewTicket} />
            : (
              <PaginatedCardGrid
                items={tickets}
                keyOf={(t) => t.ticket_id}
                emptyMessage="No tickets yet. Create one to begin the workflow."
                renderItem={(t) => (
                  <TicketCard ticket={t} unreadCount={unreadByTicket[t.ticket_id] ?? 0} onClick={() => onViewTicket(t)} />
                )}
              />
            )
        }
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
function ReadinessCheckForm({ onCancel, onSubmit }) {
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!confirmed || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit({ confirmed: true });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.88rem', cursor: 'pointer' }}>
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ marginTop: 3 }} />
        <span>I confirm I <strong>personally checked and operated</strong> this vehicle and it is ready to respond.</span>
      </label>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
        <button type="button" className="ghost-button" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary-button" onClick={submit} disabled={!confirmed || submitting}>
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
function VehicleReliabilityCard({ vehicleId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get(`/vehicles/${vehicleId}/reliability`)
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [vehicleId]);

  const peso = (n) => `₱${Number(n ?? 0).toLocaleString()}`;

  return (
    <section className="veh-card">
      <div className="veh-card-head"><Icon name="wrench" size={16} /><h4>Reliability</h4></div>
      {loading ? (
        <p className="muted" style={{ padding: '10px 14px' }}>Loading…</p>
      ) : !data ? (
        <p className="muted" style={{ padding: '10px 14px' }}>Reliability data is unavailable right now.</p>
      ) : (
        <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(data.chronic || data.decommission_signal) && (
            <div className="ticket-alert-banner formaint" style={{ marginBottom: 2 }}>
              <Icon name="alert" size={14} />
              {data.chronic && data.decommission_signal
                ? 'Chronic repeat failures, and lifetime repair spend is a large share of this vehicle’s value.'
                : data.chronic
                  ? 'Chronic repeat failures on this vehicle — consider a deeper fix.'
                  : 'Lifetime repair spend is a large share of this vehicle’s value — a decommission review may be worth it.'}
            </div>
          )}
          <dl className="veh-kv" style={{ margin: 0 }}>
            <div><dt>Failures (6 mo)</dt><dd>{data.failures_6mo}</dd></div>
            <div><dt>Failures (12 mo)</dt><dd>{data.failures_12mo}</dd></div>
            <div><dt>Avg. Days Out of Service</dt><dd>{data.avg_days_out ?? '-'}</dd></div>
            <div><dt>Lifetime Repair Spend</dt><dd>{peso(data.total_spend)}</dd></div>
            {data.acquisition_cost != null && (
              <div><dt>Spend vs. Acquisition Cost</dt><dd>{data.cost_ratio != null ? `${Math.round(data.cost_ratio * 100)}%` : '-'}</dd></div>
            )}
          </dl>
        </div>
      )}
    </section>
  );
}

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
          <button type="button" className="file-card-icon-btn" onClick={() => openModal()} title="Expand" aria-label="Expand">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          </button>
          {canManage && (
            <button type="button" className="file-card-icon-btn" onClick={() => openModal()} title="Add file" aria-label="Add file">
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
          <div className="file-card-empty">No data</div>
        )}
        {canManage && (
          <button type="button" className="file-card-dropzone veh-files-dropzone-trigger" onClick={() => openModal()}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 18a4.5 4.5 0 0 1-1-8.9A5.5 5.5 0 0 1 16.7 7 4.5 4.5 0 0 1 18 18" />
              <path d="M12 12v7" />
              <path d="M9.5 14.5 12 12l2.5 2.5" />
            </svg>
            <span>Drag file here</span>
          </button>
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
      <div className="modal-box modal-box-wide files-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Files</h3>
          <div className="files-modal-toolbar">
            {canManage && (
              <>
                <button type="button" className="file-card-icon-btn" onClick={() => fileInputRef.current?.click()} title="Add file" aria-label="Add file">
                  <Icon name="plus" size={14} />
                </button>
                <button
                  type="button"
                  className="file-card-icon-btn"
                  disabled={!canEditSelected}
                  onClick={() => canEditSelected && startEdit(selected)}
                  title={selected && !canEditSelected ? 'You can only edit a file you uploaded yourself' : 'Edit selected'}
                  aria-label="Edit selected"
                >
                  <Icon name="edit" size={14} />
                </button>
                {canDeleteDocs && (
                  <button type="button" className="file-card-icon-btn" disabled={!selected} onClick={() => selected && handleDelete(selected)} title="Delete selected" aria-label="Delete selected">
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

function VehicleProfilePage({ vehicleId, lookups, allHubs, basePath, canManage = false, canManageDocuments = false, canViewDocuments = false, canCheckReadiness = false, canRequestInspection = false, canViewReliability = false, canViewUsage = false, canLogUsage = false, setNotice, onSaved, onRequestConfirmation }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(new URLSearchParams(location.search).get('tab') === 'edit');
  const [decommissioning, setDecommissioning] = useState(false);
  const [readiness, setReadiness] = useState(null);
  const [checkingReadiness, setCheckingReadiness] = useState(false);
  // Live-tracks the Edit form's Vehicle Type select so switching a vehicle
  // to a Water category shows Hull Material/Engine Type immediately,
  // instead of only after saving and reloading. Reset whenever a different
  // vehicle's edit form opens (see the effect below).
  const [editCategoryId, setEditCategoryId] = useState(null);

  const vehicle = (lookups.vehicles ?? []).find((v) => String(v.vehicle_id) === String(vehicleId));

  useEffect(() => {
    setEditCategoryId(vehicle?.category_id ?? null);
    // Deliberately keyed off vehicle_id only, not category_id — the latter
    // is exactly what this state tracks live while editing; including it
    // here would reset every live change right back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicle?.vehicle_id]);

  // Gap A — response-readiness state.
  const loadReadiness = useCallback(() => {
    api.get(`/vehicles/${vehicleId}/readiness`).then((r) => setReadiness(r.data)).catch(() => setReadiness(null));
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
  return (
    <ModulePanel description="Full profile, maintenance, and tickets for this vehicle.">
      <div className="vehicle-profile-header">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }}>
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
      <div className="veh-dash">
        <div className="veh-dash-left">
          <section className="veh-card veh-info">
            <div className="veh-card-head"><Icon name={vehicleIconName(vehicle.category?.domain)} size={16} /><h4>Vehicle Information</h4></div>
            <div className="veh-info-body">
              <div className="veh-info-identity">
                <h3>{vehicle.vehicle_name}</h3>
                <span>{vehicle.category?.domain ?? 'Land'}.{vehicle.plate_number}</span>
              </div>
              {vehicle.photo_url && (
                <div className="veh-info-photo"><PhotoCell alt={vehicle.vehicle_name} url={vehicle.photo_url} /></div>
              )}
              <dl className="veh-kv">
                <div><dt>Vehicle Type</dt><dd>{vehicle.category?.category_name ?? 'Unassigned'}</dd></div>
                <div><dt>Brand / Model</dt><dd>{`${vehicle.brand ?? '-'} ${vehicle.model ?? ''}`.trim() || '-'}</dd></div>
                <div><dt>Year Model</dt><dd>{vehicle.year_model ?? '-'}</dd></div>
                <div><dt>Capacity</dt><dd>{vehicle.capacity ?? '-'}</dd></div>
                <div><dt>Color</dt><dd>{vehicle.vehicle_color ?? '-'}</dd></div>
                {isWater && (
                  <>
                    <div><dt>Hull Material</dt><dd>{vehicle.hull_material ?? '-'}</dd></div>
                    <div><dt>Engine Type</dt><dd>{vehicle.engine_type ?? '-'}</dd></div>
                  </>
                )}
                <div><dt>Fuel Type</dt><dd>{vehicle.fuel_type ?? '-'}</dd></div>
                {customValueRows(vehicle, lookups)}
              </dl>
            </div>
            {vehicle.remarks && (
              <div className="veh-remarks"><span className="veh-remarks-label">Remarks</span><p>{vehicle.remarks}</p></div>
            )}
          </section>
        </div>

        <div className="veh-dash-right">
          <div className="veh-status-row">
            <section className="veh-card veh-keydates">
              <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>Status &amp; Key Dates</h4></div>
              <dl className="veh-kv">
                <div><dt>Availability</dt><dd><StatusBadge value={vehicle.status} /></dd></div>
                <div><dt>Condition</dt><dd><StatusBadge value={vehicle.condition} /></dd></div>
                {readiness && READINESS_BADGE[readiness.state] && (
                  <div><dt>Response Readiness</dt><dd>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.76rem', fontWeight: 700, padding: '3px 10px', borderRadius: 999, background: READINESS_BADGE[readiness.state].bg, color: READINESS_BADGE[readiness.state].color, border: `1px solid ${READINESS_BADGE[readiness.state].border}` }}>
                      <Icon name={READINESS_BADGE[readiness.state].icon} size={11} /> {READINESS_BADGE[readiness.state].label}
                    </span>
                    {readiness.last_checked && <div className="muted" style={{ fontSize: '0.72rem', marginTop: 3 }}>Last checked {formatDate(readiness.last_checked)}</div>}
                  </dd></div>
                )}
                {/* Confirmed via live review: a vehicle marked Under
                    Maintenance had no visible path to WHY, forcing a
                    separate hunt through Maintenance Tickets. */}
                {readiness?.active_ticket_id && (
                  <div><dt>Active Ticket</dt><dd>
                    <button
                      type="button"
                      className="btn-view-action"
                      style={{ fontSize: '0.78rem', padding: '3px 10px' }}
                      onClick={() => navigate(`${basePath}/tickets/${readiness.active_ticket_id}`)}
                    >
                      {readiness.active_ticket_title ?? `Ticket #${readiness.active_ticket_id}`} →
                    </button>
                  </dd></div>
                )}
                {/* Kept beside the other at-a-glance status signals (not
                    buried under specs) — this is how urgently a down unit of
                    this type matters, same scale as the dashboard's
                    Readiness & Criticality Watch. */}
                <div><dt>Criticality</dt><dd>
                  <span className={`risk-watch-tag${(vehicle.criticality ?? defaultCriticalityFor(vehicle, lookups)) === 'Critical' ? ' is-critical' : ''}`}>
                    {(vehicle.criticality ?? defaultCriticalityFor(vehicle, lookups)).toUpperCase()}
                  </span>
                  <div className="muted" style={{ fontSize: '0.72rem', marginTop: 3 }}>{vehicle.criticality ? 'Set for this vehicle' : 'From vehicle type'}</div>
                </dd></div>
                <div><dt>Current Location</dt><dd>{vehicle.current_location ?? '-'}</dd></div>
                {vehicle.estimated_return_date && (
                  <div><dt>Est. Return Date</dt><dd>{formatForecastDate(vehicle.estimated_return_date)}</dd></div>
                )}
                <div><dt>Date Added</dt><dd>{vehicle.created_at ? <QuietDate value={vehicle.created_at} /> : '-'}</dd></div>
                <div><dt>Last Updated</dt><dd>{vehicle.updated_at ? <QuietDate value={vehicle.updated_at} /> : '-'}</dd></div>
              </dl>
            </section>

            <div className="veh-square-col">
              <section className="veh-card veh-reports">
                <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>Reports</h4></div>
                <div className="veh-reports-body">
                  <select className="veh-reports-select" defaultValue="summary">
                    <option value="summary">Vehicle Summary Report</option>
                  </select>
                  <button type="button" className="veh-reports-print-btn" onClick={() => window.print()} title="Print report" aria-label="Print report">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M6 9V3h12v6" />
                      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                      <rect x="6" y="14" width="12" height="8" />
                    </svg>
                  </button>
                </div>
              </section>

              {canViewDocuments && <VehicleFiles vehicleId={vehicle.vehicle_id} canManage={canManageDocuments} onRequestConfirmation={onRequestConfirmation} />}

              {canViewReliability && <VehicleReliabilityCard vehicleId={vehicle.vehicle_id} />}
            </div>
          </div>

          <section className="veh-card veh-map">
            <div className="veh-card-head"><Icon name="pin" size={16} /><h4>Current Location — {vehicle.current_location ?? 'Unknown'}</h4></div>
            <div className="veh-map-wrap">
              <VehicleLocationMap lat={hub?.lat} lng={hub?.lng} label={vehicle.current_location} scrollWheelZoom />
            </div>
          </section>
        </div>
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
              <Icon name="gear" size={48} className="topbar-gear-icon" filled />
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
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', fontWeight: 700,
        padding: '5px 12px', borderRadius: 999, background: style.bg,
        border: `1px solid ${style.color}55`, color: style.color,
      }}>
        <Icon name={style.icon} size={12} /> {stage.label}
      </span>
    );
  }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', fontWeight: 700,
      padding: '6px 10px', borderRadius: '0 6px 6px 0', background: style.bg,
      borderLeft: `3px solid ${style.color}`, color: style.color,
    }}>
      <Icon name={style.icon} size={12} /> {stage.label}
    </div>
  );
}

function TicketCard({ ticket, unreadCount = 0, onClick }) {
  const progress = ticket.progress;
  const stage = ticketWorkflowStage(ticket);

  return (
    <div className={`ticket-card tc-${String(ticket.status ?? "").toLowerCase().replace(/[^a-z]+/g, "-")}`} style={{ position: 'relative' }} onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      {unreadCount > 0 && (
        <span
          title={`${unreadCount} unread update${unreadCount > 1 ? 's' : ''} on this ticket`}
          style={{
            position: 'absolute', top: -8, right: -8, minWidth: 20, height: 20, padding: '0 5px',
            borderRadius: 999, background: '#dc2626', color: '#fff', fontSize: '0.7rem', fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.25)', zIndex: 1,
          }}
        >
          {unreadCount > 9 ? '9+' : unreadCount}
        </span>
      )}
      <div className="ticket-card-content-wrapper">
        <div className="ticket-card-info">
          <div className="ticket-card-top">
            <span className="ticket-card-id">Ticket #{ticket.ticket_id}</span>
          </div>
          <p className="ticket-card-title">{ticket.ticket_title}</p>
          <p className="ticket-card-vehicle">{ticket.vehicle?.vehicle_name} · {ticket.vehicle?.plate_number}</p>
        </div>
        {ticket.vehicle?.photo_url && (
          <div className="ticket-card-photo">
            <img src={resolvePhotoUrl(ticket.vehicle.photo_url)} alt={ticket.vehicle.vehicle_name} />
          </div>
        )}
      </div>
      <div style={{ margin: '8px 0 2px', minHeight: 22 }}>
        {progress?.total > 0 && (
          <>
            <div style={{ height: 6, borderRadius: 999, background: '#e2e8f0', overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                width: `${(progress.done / progress.total) * 100}%`,
                background: progress.done === progress.total ? '#16a34a' : '#d97706',
                borderRadius: 999,
              }} />
            </div>
            <span className="muted" style={{ fontSize: '0.72rem' }}>{progress.done}/{progress.total} sub-issues done</span>
          </>
        )}
      </div>
      <div style={{ margin: '6px 0 2px', minHeight: 26 }}>
        {stage && <TicketStageBadge ticket={ticket} />}
      </div>
      <div className="ticket-card-bottom">
        <div className="ticket-card-badges">
          <TicketStatusBadge value={ticket.status} />
          <TicketStatusBadge value={ticket.priority} />
        </div>
        <DateBadge value={ticket.created_at} />
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
  onViewVehicle,
  stats,
  activeFilter,
  onFilterChange,
  tabBar
}) {
  const isPendingView = activeFilter !== 'Inspected';

  const inspectionColumnDefs = useMemo(() => [
    { key: 'ticket_id', label: 'Ticket ID', locked: true, className: 'cell-center', render: (r) => r.ticket_id },
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
  const inspectionColumnChooser = useColumnChooser('vms_custodian_inspection_columns', inspectionColumnDefs);

  return (
    <div className="module-grid">
      <DismissibleHint description="Phase 2 — Vehicle Evaluation. Review tickets assigned to you, submit physical inspection findings, and check back here for anything already diagnosed — either by your own inspection, or pre-diagnosed by an Admin (e.g. reassigned to you mid-repair)." />
      {tabBar}
      <ModuleStatCards
        totalLabel="Total Assigned"
        total={stats.total}
        cards={TICKET_INSPECTION_STAT_CARDS}
        counts={stats}
        activeFilter={activeFilter}
        onFilterChange={onFilterChange}
      />
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
              onRowClick={(row) => row.vehicle && onViewVehicle(row.vehicle)}
              renderSubRow={(row) => row.ticket_description}
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
  // Phase B4 — catalog.create (maintenance types) is Admin-only now, and
  // this Inspect page is Custodian-only (ticket.inspect), so the Category
  // picker below no longer offers CreatableSelect's "+ Add New" — "Other"
  // + this note stands in for it, folded into Inspection Notes on submit.
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
        <h3 className="ticket-detail-title" style={{ margin: 0 }}>Inspect Ticket #{ticket.ticket_id}</h3>
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
        <div className="ticket-detail-description-box">
          <span className="ticket-detail-label">Description</span>
          <ExpandableText text={ticket.ticket_description} className="muted" lines={3} />
        </div>
      </section>

      {/* One continuous form — Cancel/Submit sit at the very end, after every
          field (including Category/Root Causes), never in the middle. */}
      <form className="smart-form" onSubmit={handleSubmit} noValidate>
        <div className={resultValue === 'Needs Maintenance' ? 'inspect-form-grid' : undefined}>
        <div className="inspect-form-left">
        <label>
          <span>Inspection Result</span>
          <select required value={resultValue} onChange={(e) => { setResultValue(e.target.value); onDirty?.(); }}>
            <option value="">{' '}</option>
            <option value="Needs Maintenance">Needs Maintenance</option>
            <option value="No Issues">No Issues</option>
          </select>
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
  activeFilter,
  onFilterChange,
  tabBar
}) {
  const [viewLogsTarget, setViewLogsTarget] = useState(null);
  const panelTitle = activeFilter.includes('Active')
    ? 'Active Tickets'
    : activeFilter.includes('Verified')
      ? 'Verified Repairs'
      : activeFilter.includes('Pending')
        ? 'Pending Verifications'
        : 'My Tickets';
  const isMyTicketsView = panelTitle === 'My Tickets';
  const emptyStateText = activeFilter.includes('Active')
    ? 'No tickets currently active.'
    : activeFilter.includes('Verified')
      ? 'No repairs verified yet.'
      : activeFilter.includes('Pending')
        ? 'No repairs pending your verification.'
        : 'No tickets yet — once the Admin approves a proposal, it will show up here.';

  const verificationColumnDefs = useMemo(() => [
    { key: 'ticket_id', label: 'Ticket ID', locked: true, className: 'cell-center', render: (r) => r.ticket_id },
    { key: 'ticket_title', label: 'Ticket Title', render: (r) => r.ticket_title },
    { key: 'vehicle', label: 'Vehicle', locked: true, render: (r) => <VehicleCell vehicle={r.vehicle} /> }, { key: 'plate', label: 'Plate Number', className: 'cell-center', render: (r) => r.vehicle?.plate_number ?? '-' },
    {
      key: 'sub_issues',
      label: 'Sub-Issues',
      render: (r) => {
        const subs = r.sub_issues ?? [];
        if (subs.length === 0) return '—';
        if (subs.length === 1) return subs[0].title;
        return `${subs.length} sub-issues: ${subs.map((s) => s.title).join(', ')}`;
      }
    },
    // One mechanic per ticket now — the whole job (every sub-issue) is
    // assigned, logged and submitted together.
    { key: 'mechanic', label: 'Mechanic', className: 'cell-center', render: (r) => r.assigned_mechanic?.name ?? '—' },
    {
      key: 'repair_log',
      label: 'Repair Log',
      render: (r) => (r.sub_issues ?? []).some((si) => si.repair_logs) ? (
        <button
          type="button"
          className="link-button"
          style={{ background: 'none', border: 'none', padding: 0, color: 'var(--primary)', cursor: 'pointer', textDecoration: 'underline', fontWeight: 500 }}
          onClick={() => setViewLogsTarget(r)}
        >
          View Logs ↗
        </button>
      ) : '—'
    },
    // parts_used is a comma-separated string per sub-issue (PartsTags splits
    // it itself) — join every sub-issue's string into one, since a ticket
    // can now carry several sub-issues, each with its own parts.
    { key: 'parts_used', label: 'Parts Used', render: (r) => <PartsTags value={(r.sub_issues ?? []).map((si) => si.parts_used).filter(Boolean).join(', ')} /> },
    {
      key: 'status',
      label: 'Status',
      className: 'cell-center',
      render: (r) => {
        const reopenedSub = (r.sub_issues ?? []).find((si) => si.reopened_at && si.status !== 'Done');
        if (reopenedSub) {
          return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: '#fef3c7', border: '1px solid #fcd34d', color: '#92400e', borderRadius: 6, fontSize: '0.8rem', fontWeight: 600 }} title={`Reopened by ${reopenedSub.reopened_by?.name || 'Admin'}`}>
              <Icon name="alert" size={12} /> Reopened
            </span>
          );
        }
        return <TicketStatusBadge value={r.status === 'Closed' ? 'Verified' : r.status} />;
      }
    },
    {
      key: 'action',
      label: 'Action',
      locked: true,
      render: (r) => {
        if (r.status !== 'For Verification') {
          return <span className="muted">{r.status === 'Closed' ? 'Verified' : r.status}</span>;
        }
        // Mirrors TicketController::verifyTicket's own guard — a dual-role
        // (Custodian + Maintenance Personnel) account currently assigned as
        // this ticket's mechanic can't "grade their own homework" here even
        // though they're the assigned verifier. The button is hidden
        // proactively; the backend is what actually enforces it (including
        // any PRIOR mechanic on the ticket, which this UI hint doesn't check —
        // see verifyTicket()'s prior_mechanic_ids guard). Fixed by reassigning
        // the ticket to a different Custodian.
        const isOwnRepair = r.assigned_mechanic_id != null
          && (r.assigned_mechanic_id === user.id || String(r.assigned_mechanic_id) === String(user.id));
        if (isOwnRepair) {
          return <span className="muted" title="You performed this repair — reassign this ticket to a different Custodian to verify it.">Needs reassignment (you did this repair)</span>;
        }
        return <button className="btn-edit-action icon-btn" type="button" onClick={() => setEditTarget(r)} title="Verify Repair" aria-label="Verify Repair"><Icon name="checkCircle" size={14} /></button>;
      }
    },
  ], [user.id, setEditTarget]);
  const verificationColumnChooser = useColumnChooser('vms_custodian_verification_columns', verificationColumnDefs);

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
      <section className="panel">
        <div className="panel-header-bar">
          <h3>{panelTitle} <span className="count-badge">{tickets.length}</span></h3>
          {!isMyTicketsView && <ColumnChooserButton {...verificationColumnChooser} />}
        </div>
        <div style={{ height: '16px' }} />
        {tickets.length === 0
          ? <p className="empty-state">{emptyStateText}</p>
          : isMyTicketsView ? (
            // The plain "My Tickets" view (no Active/Pending/Verified filter
            // picked) reads as tickets, same as the Admin's own ticket list —
            // the verification-focused table (repair log, parts, verify
            // action) only makes sense once a specific status is picked.
            <PaginatedCardGrid
              items={tickets}
              keyOf={(t) => t.ticket_id}
              emptyMessage={emptyStateText}
              renderItem={(t) => <TicketCard ticket={t} onClick={() => (onViewTicket ? onViewTicket(t) : (t.vehicle && onViewVehicle(t.vehicle)))} />}
            />
          ) : (
            <DataTable
              columns={verificationColumnChooser.visibleColumns}
              onReorderColumn={verificationColumnChooser.reorderColumn}
              rows={tickets}
              onRowClick={(row) => (onViewTicket ? onViewTicket(row) : (row.vehicle && onViewVehicle(row.vehicle)))}
            />
          )
        }
      </section>
      {/* The Custodian's one plain attestation for the whole ticket — no
          checklist, no notes, no reject path (see verifyTicket()). Reuses
          the same TicketVerificationForm the ticket detail page's own
          "Verify Repair" section uses. */}
      <FormModal open={!!editTarget} title={`Verify Repair — ${editTarget?.ticket_title ?? `Ticket #${editTarget?.ticket_id}`}`} onClose={onCancelEdit}>
        <TicketVerificationForm
          key={editTarget?.ticket_id}
          vehicle={editTarget?.vehicle}
          onCancel={onCancelEdit}
          onSubmit={(payload) => onVerify(editTarget, payload)}
        />
      </FormModal>

      <FormModal open={!!viewLogsTarget} title={`Repair Details — Ticket #${viewLogsTarget?.ticket_id}`} onClose={() => setViewLogsTarget(null)}>
        <div style={{ padding: '8px 0' }}>
          <div style={{ marginBottom: '16px' }}>
            <h4 style={{ margin: '0 0 6px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Vehicle</h4>
            <div style={{ fontWeight: 600 }}>{viewLogsTarget?.vehicle?.vehicle_name} ({viewLogsTarget?.vehicle?.plate_number})</div>
          </div>
          <div style={{ marginBottom: '16px' }}>
            <h4 style={{ margin: '0 0 6px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Ticket Title</h4>
            <div style={{ fontWeight: 600 }}>{viewLogsTarget?.ticket_title}</div>
          </div>
          <div style={{ marginBottom: '16px' }}>
            <h4 style={{ margin: '0 0 6px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Mechanic</h4>
            <div>{viewLogsTarget?.assigned_mechanic?.name ?? '—'}</div>
          </div>
          {/* One block per sub-issue — a ticket can carry several now, so
              each gets its own log/parts/dates/cost instead of a single
              ticket-wide set (the common one-sub-issue ticket just renders
              one block, same information as before). */}
          {(viewLogsTarget?.sub_issues ?? []).map((si, idx, arr) => (
            <div key={si.sub_issue_id} style={{ marginBottom: '20px', paddingBottom: idx < arr.length - 1 ? '16px' : 0, borderBottom: idx < arr.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
              {arr.length > 1 && (
                <h4 style={{ margin: '0 0 10px 0', fontSize: '0.95rem' }}>{si.title}</h4>
              )}
              <div style={{ marginBottom: '12px' }}>
                <h4 style={{ margin: '0 0 6px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Repair Log Entry</h4>
                <pre style={{
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'inherit',
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  borderRadius: '6px',
                  padding: '12px',
                  fontSize: '0.9rem',
                  lineHeight: '1.5',
                  margin: '6px 0 0 0'
                }}>{si.repair_logs ?? 'No logs provided.'}</pre>
              </div>
              <div style={{ marginBottom: '12px' }}>
                <h4 style={{ margin: '0 0 6px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Parts / Materials Used</h4>
                <div style={{ marginTop: '6px' }}>
                  <PartsTags value={si.parts_used} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '12px' }}>
                <div>
                  <h4 style={{ margin: '0 0 4px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Repair Start Date</h4>
                  <div>{si.repair_started_at ? formatDate(si.repair_started_at) : '—'}</div>
                </div>
                <div>
                  <h4 style={{ margin: '0 0 4px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Repair Completion Date</h4>
                  <div>{si.repair_completed_at ? formatDate(si.repair_completed_at) : '—'}</div>
                </div>
              </div>
              <div>
                <h4 style={{ margin: '0 0 6px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Repair Cost / Expenses</h4>
                <div style={{ fontWeight: 600, color: 'var(--text-success)', fontSize: '1.1rem' }}>
                  {si.maintenance_cost ? `₱${Number(si.maintenance_cost).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '₱0.00'}
                </div>
              </div>
            </div>
          ))}
          {!(viewLogsTarget?.sub_issues ?? []).length && (
            <p className="empty-state">No sub-issues on this ticket.</p>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '24px', borderTop: '1px solid var(--border-subtle)', paddingTop: '16px' }}>
          <button className="primary-button" onClick={() => setViewLogsTarget(null)} type="button">Close</button>
        </div>
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
  const isPendingView = activeFilter !== 'Submitted';
  // Merge 2 — "Work Tracker" is no longer its own sidebar entry; it's this
  // Archive toggle over the same page, mirroring Admin's Maintenance Tickets
  // "Archives" button (see TicketModule's onViewArchives). Admin's version
  // swaps `activeModule` to a distinct key with its own fetch; this role's
  // GET /tickets already returns every ticket ever assigned to them (not
  // just the active ones — see loadModule), so a plain local boolean over
  // data already on hand is enough.
  const [showArchive, setShowArchive] = useState(false);

  // Resolve the real ticket object for a ticket_id — both grouping helpers
  // below return a synthesized summary row, not what TicketCard needs.
  const ticketById = useMemo(() => {
    const map = new Map();
    (allTickets ?? []).forEach((t) => map.set(t.ticket_id, t));
    return map;
  }, [allTickets]);

  // ---- Active work (unchanged scope: Pending vs Submitted, via `tickets`
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
    <div className="module-grid">
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
              categories={categories}
              vehicles={vehicles}
              filterCategory={filterCategory}
              setFilterCategory={setFilterCategory}
              filterCapacity={filterCapacity}
              setFilterCapacity={setFilterCapacity}
              filterPriority={filterPriority}
              setFilterPriority={setFilterPriority}
              priorityOptions={maintTypeOptions}
              priorityLabel="Maintenance Type"
            />
          </section>
          <section className="panel operations-board work-order-board">
            <div className="operations-board-head">
              <div>
                <span className="operations-kicker">Mechanic queue</span>
                <h3>{isPendingView ? 'Pending Work Orders' : 'Submitted Work Orders'} <span className="count-badge">{tickets.length}</span></h3>
                <p>{isPendingView ? 'Open a work order, record the repair, then send it for verification.' : 'Review work already submitted for Custodian verification.'}</p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <button type="button" className="ghost-button" onClick={() => setShowArchive(true)}>
                  <Icon name="archive" size={14} /> Archive
                </button>
                <LocalSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search work orders..." />
              </div>
            </div>
            <div className="operations-board-note"><Icon name={isPendingView ? 'wrench' : 'checkCircle'} size={14} /> {isPendingView ? 'Repair logs are due for the highlighted work orders.' : 'Submitted items remain here until their next workflow update.'}</div>
            <PaginatedCardGrid
              items={activeTicketCards}
              keyOf={(t) => t.ticket_id}
              emptyMessage={isPendingView ? 'No active work orders assigned to you.' : 'No repair logs submitted yet.'}
              renderItem={(t) => <TicketCard ticket={t} onClick={() => onViewTicket(t)} />}
            />
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
              <button type="button" className="ghost-button" onClick={() => setShowArchive(false)}>
                <Icon name="wrench" size={14} /> Back to Work Orders
              </button>
              <LocalSearchInput value={archiveSearch} onChange={setArchiveSearch} placeholder="Search vehicle, plate, or ticket..." />
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
          <PaginatedCardGrid
            items={archiveTicketCards}
            keyOf={(t) => t.ticket_id}
            emptyMessage="Nothing here yet — vehicles you repair will show up here with their current status."
            renderItem={(t) => <TicketCard ticket={t} onClick={() => onViewTicket(t)} />}
          />
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

function LogRepairsPage({ ticket, vehicleOptions = [], onBack, onSubmit, onDirty, onExternalSend, onExternalReturn }) {
  const [repairLogs, setRepairLogs] = useState('');
  const [parts, setParts] = useState([{ name: '', cost: '' }]);
  const [attachment, setAttachment] = useState(null);
  const [repairStartedAt, setRepairStartedAt] = useState('');
  const [repairCompletedAt, setRepairCompletedAt] = useState('');
  // Pre-filled from whatever was chosen at ticket creation (if this was a
  // pre-diagnosed sub-issue) — still editable here, since the actual repair
  // sometimes ends up differing from the original plan. Sub-issues created
  // via "Needs Inspection" arrive with this blank, since nobody could know
  // it yet — this is the first point it's actually knowable.
  const [repairType, setRepairType] = useState(ticket?.repair_type ?? '');
  const [sourceVehicleId, setSourceVehicleId] = useState(ticket?.source_vehicle_id ?? '');
  const [externalVendor, setExternalVendor] = useState(ticket?.external_vendor ?? '');
  // date casts serialize with a time component (ISO datetime) — <input
  // type="date"> needs exactly YYYY-MM-DD or it silently fails to populate.
  const [warrantyUntil, setWarrantyUntil] = useState((ticket?.warranty_until ?? '').slice(0, 10));
  // Cannibalized part details.
  const [partNeeded, setPartNeeded] = useState(ticket?.part_needed ?? '');
  const [partQuantity, setPartQuantity] = useState(ticket?.part_quantity ?? '');
  const [partCondition, setPartCondition] = useState(ticket?.part_condition ?? '');
  const [cannibalReason, setCannibalReason] = useState(ticket?.cannibal_reason ?? '');
  const [partInstalledAt, setPartInstalledAt] = useState((ticket?.part_installed_at ?? '').slice(0, 10));
  // External shop stages: send out, then mark returned, then submit.
  const [sendForm, setSendForm] = useState({ external_vendor: ticket?.external_vendor ?? '', external_reason: '', external_work_scope: '', external_shop_contact: '', external_estimated_cost: '' });
  const [returnForm, setReturnForm] = useState({ external_return_notes: '', external_actual_cost: '', warranty_until: '' });

  if (!ticket) {
    return (
      <ModulePanel description="This work order could not be found — it may no longer be assigned to you.">
      </ModulePanel>
    );
  }

  const updatePart = (index, field, value) => { setParts((rows) => rows.map((row, i) => (i === index ? { ...row, [field]: value } : row))); onDirty?.(); };
  const addPart = () => setParts((rows) => [...rows, { name: '', cost: '' }]);
  const removePart = (index) => setParts((rows) => rows.filter((_, i) => i !== index));

  // Live-running total instead of a manual "Generate" click — a click-based
  // total would go stale the moment another row is added or edited after
  // pressing it. This always reflects exactly what's in the rows right now.
  const totalCost = parts.reduce((sum, p) => sum + (parseFloat(p.cost) || 0), 0);
  // Confirmed via code audit: while a repair is sent out and waiting on the
  // shop, Parts/Attachment/Schedule don't apply yet — the mechanic has
  // nothing to log here until it comes back. De-emphasized, not removed or
  // disabled, since a mechanic may still want to note something early.
  const awaitingShopReturn = repairType === 'external' && !!ticket.external_sent_at && !ticket.external_returned_at;
  const sourceVehicleOptions = vehicleOptions.filter((v) => String(v.vehicle_id) !== String(ticket.vehicle?.vehicle_id));

  const handleSubmit = (e) => {
    e.preventDefault();
    const namedParts = parts.filter((p) => p.name.trim());
    onSubmit(ticket, {
      repair_logs: repairLogs,
      parts_used: namedParts.map((p) => p.name.trim()).join(', ') || undefined,
      photo: attachment || undefined,
      maintenance_cost: totalCost > 0 ? totalCost : undefined,
      repair_started_at: repairStartedAt || undefined,
      repair_completed_at: repairCompletedAt || undefined,
      repair_type: repairType || undefined,
      source_vehicle_id: repairType === 'cannibalized' ? sourceVehicleId : undefined,
      external_vendor: repairType === 'external' ? (externalVendor || undefined) : undefined,
      warranty_until: repairType === 'external' ? (warrantyUntil || undefined) : undefined,
      part_needed: repairType === 'cannibalized' ? (partNeeded || undefined) : undefined,
      part_quantity: repairType === 'cannibalized' ? (partQuantity || undefined) : undefined,
      part_condition: repairType === 'cannibalized' ? (partCondition || undefined) : undefined,
      cannibal_reason: repairType === 'cannibalized' ? (cannibalReason || undefined) : undefined,
      part_installed_at: repairType === 'cannibalized' ? (partInstalledAt || undefined) : undefined,
    });
  };

  // Display-only helpers for the workspace below — none of them feed into
  // handleSubmit, which still sends exactly the same payload as before.
  const REPAIR_TYPE_LABEL = { in_house: 'In-House Repair', cannibalized: 'Used Cannibalized Part', external: 'Sent to External Shop' };
  const idBase = `lr-${ticket.sub_issue_id ?? ticket.ticket_id}`;
  const workDescription = ticket.work_order_notes ?? ticket.ticket_description;
  const namedPartCount = parts.filter((p) => p.name.trim()).length;
  const formatFileSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
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
            {[ticket.vehicle?.plate_number, ticket.maintenance_type, `Ticket #${ticket.ticket_id}`].filter(Boolean).join(' · ')}
          </p>
        </div>
        <TicketStatusBadge value={ticket.status} />
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
            <h4 className="lr-section-label" id={`${idBase}-wo`}>Work Order</h4>
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
            <h4 className="lr-section-label" id={`${idBase}-rw`}>Repair Work</h4>
            <div className="lr-field">
              <span className="lr-label" id={`${idBase}-type`}>Repair Type</span>
              {/* Read-only on purpose: decided when the ticket was proposed
                  and never changed here — shown as a value, not a disabled
                  dropdown that looks clickable. */}
              <p className="lr-readonly" aria-labelledby={`${idBase}-type`}>
                {REPAIR_TYPE_LABEL[repairType] ?? 'Not set'}
                <span className="lr-hint"> · set when the ticket was proposed</span>
              </p>
            </div>

            {repairType === 'cannibalized' && (
              <div className="lr-field">
                <label className="lr-label" htmlFor={`${idBase}-source`}>Source Vehicle <abbr className="required-asterisk" title="required">*</abbr></label>
                <select
                  id={`${idBase}-source`}
                  required
                  value={sourceVehicleId}
                  onChange={(e) => { setSourceVehicleId(e.target.value); onDirty?.(); }}
                >
                  <option value="">Select source vehicle</option>
                  {sourceVehicleOptions.map((v) => <option key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_name} ({v.plate_number})</option>)}
                </select>
              </div>
            )}
            {repairType === 'external' && (
              <div className="lr-two-col">
                <div className="lr-field">
                  <label className="lr-label" htmlFor={`${idBase}-vendor`}>External Shop Name</label>
                  <input
                    id={`${idBase}-vendor`}
                    type="text"
                    placeholder="e.g. Dela Cruz Auto Repair"
                    value={externalVendor}
                    onChange={(e) => { setExternalVendor(e.target.value); onDirty?.(); }}
                  />
                </div>
                <div className="lr-field">
                  <label className="lr-label" htmlFor={`${idBase}-warranty`}>Warranty Until</label>
                  <DateFilterInput id={`${idBase}-warranty`} value={warrantyUntil} onChange={(v) => { setWarrantyUntil(v); onDirty?.(); }} />
                </div>
              </div>
            )}

            <div className="lr-field">
              <label className="lr-label" htmlFor={`${idBase}-work`}>Work Performed <abbr className="required-asterisk" title="required">*</abbr></label>
              <textarea
                id={`${idBase}-work`}
                className="lr-textarea"
                required
                rows={4}
                placeholder="Describe what you repaired, what you found, what you replaced, adjustments made, and testing performed."
                value={repairLogs}
                onChange={(e) => { setRepairLogs(e.target.value); onDirty?.(); }}
              />
            </div>
          </section>

          {repairType === 'cannibalized' && (
            <section className="lr-group" aria-labelledby={`${idBase}-donor`}>
              <h4 className="lr-section-label" id={`${idBase}-donor`}>Part Taken From Donor</h4>
              <div className="lr-two-col">
                <div className="lr-field">
                  <label className="lr-label" htmlFor={`${idBase}-pn`}>Part</label>
                  <input id={`${idBase}-pn`} type="text" placeholder="e.g. Radiator" value={partNeeded} onChange={(e) => { setPartNeeded(e.target.value); onDirty?.(); }} />
                </div>
                <div className="lr-field">
                  <label className="lr-label" htmlFor={`${idBase}-pq`}>Quantity</label>
                  <input id={`${idBase}-pq`} type="number" min="1" value={partQuantity} onChange={(e) => { setPartQuantity(e.target.value); onDirty?.(); }} />
                </div>
                <div className="lr-field">
                  <label className="lr-label" htmlFor={`${idBase}-pc`}>Part Condition</label>
                  <input id={`${idBase}-pc`} type="text" value={partCondition} onChange={(e) => { setPartCondition(e.target.value); onDirty?.(); }} />
                </div>
                <div className="lr-field">
                  <label className="lr-label" htmlFor={`${idBase}-pi`}>Date Installed</label>
                  <DateFilterInput id={`${idBase}-pi`} value={partInstalledAt} onChange={(v) => { setPartInstalledAt(v); onDirty?.(); }} />
                </div>
              </div>
              <div className="lr-field">
                <label className="lr-label" htmlFor={`${idBase}-cr`}>Why this donor / why not buy the part?</label>
                <textarea id={`${idBase}-cr`} className="lr-textarea" rows={2} value={cannibalReason} onChange={(e) => { setCannibalReason(e.target.value); onDirty?.(); }} />
              </div>
            </section>
          )}

          {repairType === 'external' && onExternalSend && (
            <section className="lr-group" aria-labelledby={`${idBase}-shop`}>
              <h4 className="lr-section-label" id={`${idBase}-shop`}>External Shop</h4>
              {!ticket.external_sent_at ? (
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
                      <label className="lr-label" htmlFor={`${idBase}-se`}>Estimated Cost (₱)</label>
                      <input id={`${idBase}-se`} type="number" min="0" value={sendForm.external_estimated_cost} onChange={(e) => setSendForm({ ...sendForm, external_estimated_cost: e.target.value })} />
                    </div>
                  </div>
                  <div className="lr-field">
                    <label className="lr-label" htmlFor={`${idBase}-sw`}>Work to Be Done <abbr className="required-asterisk" title="required">*</abbr></label>
                    <textarea id={`${idBase}-sw`} className="lr-textarea" rows={2} value={sendForm.external_work_scope} onChange={(e) => setSendForm({ ...sendForm, external_work_scope: e.target.value })} />
                  </div>
                  <button
                    type="button"
                    className="primary-button"
                    style={{ alignSelf: 'flex-start' }}
                    disabled={!sendForm.external_vendor.trim() || !sendForm.external_reason.trim() || !sendForm.external_work_scope.trim()}
                    onClick={() => onExternalSend(ticket, Object.fromEntries(Object.entries(sendForm).filter(([, v]) => String(v).trim() !== '')))}
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
                    disabled={!returnForm.external_return_notes.trim()}
                    onClick={() => onExternalReturn(ticket, Object.fromEntries(Object.entries(returnForm).filter(([, v]) => String(v).trim() !== '')))}
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

          {/* Compact uploader — a button, not a giant drop rectangle. Same
              single-file `attachment` state and accept list as before. */}
          <section className="lr-group" style={dimWhileAtShop} aria-labelledby={`${idBase}-ev`}>
            <h4 className="lr-section-label" id={`${idBase}-ev`}>Repair Evidence</h4>
            {attachment ? (
              <div className="lr-file-row">
                {attachment.type.startsWith('image/') ? (
                  <img src={URL.createObjectURL(attachment)} alt="" className="lr-file-thumb" />
                ) : (
                  <span className="lr-file-thumb lr-file-thumb-icon"><Icon name="archive" size={15} /></span>
                )}
                <span className="lr-file-name">{attachment.name}</span>
                <span className="lr-hint">{formatFileSize(attachment.size)}</span>
                <button type="button" className="lr-icon-btn" onClick={() => setAttachment(null)} title="Remove attachment" aria-label={`Remove ${attachment.name}`}>
                  <Icon name="close" size={13} />
                </button>
              </div>
            ) : (
              <div className="lr-upload-line">
                <label className="lr-upload-btn">
                  <Icon name="plus" size={14} /> Add Photo / Document
                  <input type="file" className="lr-file-input" accept="image/*,.pdf,.doc,.docx" onChange={(e) => { setAttachment(e.target.files[0] ?? null); onDirty?.(); }} />
                </label>
                <span className="lr-hint">JPG, PNG, PDF, or DOC · up to 8 MB</span>
              </div>
            )}
          </section>
        </div>

        <aside className="lr-side" aria-label="Repair record and submission">
          {/* Part name takes the row, cost is a fixed narrow column — no
              more fields pinned to opposite edges of the page. Same
              Part Name + Cost model the backend stores (a joined string +
              one total), so no quantity/unit-cost fields are invented. */}
          <section className="lr-side-group" style={dimWhileAtShop} aria-labelledby={`${idBase}-parts`}>
            <h4 className="lr-section-label" id={`${idBase}-parts`}>Parts &amp; Materials</h4>
            <div className="lr-parts" role="table" aria-labelledby={`${idBase}-parts`}>
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
                    className="lr-icon-btn"
                    onClick={() => removePart(index)}
                    disabled={parts.length === 1}
                    title="Remove part"
                    aria-label={`Remove part ${index + 1}`}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="lr-link-btn" onClick={addPart}><Icon name="plus" size={13} /> Add Part</button>
            <div className="lr-total">
              <span>Total Repair Cost</span>
              <strong>₱{totalCost.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong>
            </div>
          </section>

          <section className="lr-side-group" style={dimWhileAtShop} aria-labelledby={`${idBase}-dates`}>
            <h4 className="lr-section-label" id={`${idBase}-dates`}>Repair Date</h4>
            <div className="lr-dates">
              <div className="lr-field">
                <label className="lr-label" htmlFor={`${idBase}-start`}>Start</label>
                <DateFilterInput id={`${idBase}-start`} value={repairStartedAt} onChange={(v) => { setRepairStartedAt(v); onDirty?.(); }} />
              </div>
              <div className="lr-field">
                <label className="lr-label" htmlFor={`${idBase}-done`}>Completion</label>
                <DateFilterInput id={`${idBase}-done`} value={repairCompletedAt} onChange={(v) => { setRepairCompletedAt(v); onDirty?.(); }} />
              </div>
            </div>
          </section>

          <div className="lr-side-actions">
            <p className="lr-hint">
              Recorded under Ticket #{ticket.ticket_id} · {namedPartCount} part{namedPartCount === 1 ? '' : 's'} · {attachment ? '1 file attached' : 'no evidence attached'}
            </p>
            <button className="primary-button lr-submit" type="submit">Submit Repair Log</button>
            <button className="ghost-button lr-cancel" onClick={onBack} type="button">Cancel</button>
          </div>
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
function readyToCloseColumns() {
  return [
    { key: 'ticket_id', label: 'Ticket ID', className: 'cell-center', render: (r) => <span className="row-title-text">#{r.ticket_id}</span> },
    { key: 'vehicle', label: 'Vehicle', render: (r) => <VehicleCell vehicle={r.vehicle} isRowTitle={false} /> },
    { key: 'title', label: 'Title', render: (r) => r.ticket_title },
    { key: 'priority', label: 'Priority', className: 'cell-center', render: (r) => <TicketStatusBadge value={r.priority} /> },
    { key: 'progress', label: 'Sub-Issues', className: 'cell-center', render: (r) => `${r.progress?.done ?? 0}/${r.progress?.total ?? 0} done` },
    { key: 'created', label: 'Created', className: 'cell-center', render: (r) => <DateBadge value={r.created_at} /> },
  ];
}

function TicketsReadyToClosePanel({ tickets, onViewTicket }) {
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const columns = useMemo(() => readyToCloseColumns(), []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tickets;
    return tickets.filter((t) => (
      String(t.ticket_id).includes(q)
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

function ticketTableColumns(unreadByTicket = {}) {
  return [
    { key: 'ticket_id', label: 'Ticket ID', locked: true, className: 'cell-center', render: (r) => r.ticket_id },
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
                  minWidth: 18, height: 18, padding: '0 4px', borderRadius: 999,
                  background: '#dc2626', color: '#fff', fontSize: '0.65rem', fontWeight: 700,
                }}
              >
                {unread > 9 ? '9+' : unread}
              </span>
            )}
            <span className="row-title-text">{r.ticket_title}</span>
          </span>
        );
      },
    },
    { key: 'vehicle', label: 'Vehicle', render: (r) => <VehicleCell vehicle={r.vehicle} isRowTitle={false} /> }, { key: 'plate', label: 'Plate Number', className: 'cell-center', render: (r) => r.vehicle?.plate_number ?? '-' },
    { key: 'status', label: 'Status', className: 'cell-center', render: (r) => <TicketStatusBadge value={r.status} /> },
    { key: 'next_step', label: 'Next Step', className: 'cell-center', render: (r) => <TicketStageBadge ticket={r} /> },
    { key: 'priority', label: 'Priority', className: 'cell-center', render: (r) => <TicketStatusBadge value={r.priority} /> },
    { key: 'created', label: 'Created', className: 'cell-center', render: (r) => <DateBadge value={r.created_at} /> },
    { key: 'time', label: 'Time', className: 'cell-center', render: (r) => formatTime(r.created_at) },
  ];
}

// =========================================================================
// PHASE 5: TICKET ARCHIVE COLUMNS
// =========================================================================

const ticketArchiveColumns = [
  { key: 'archive_id', label: 'Archive ID', locked: true, className: 'cell-center', render: (r) => r.archive_id },
  { key: 'ticket_id', label: 'Ticket ID', className: 'cell-center', render: (r) => r.ticket_id },
  { key: 'title', label: 'Title', render: (r) => r.ticket_title },
  { key: 'vehicle', label: 'Vehicle', render: (r) => <VehicleCell vehicle={r.vehicle ?? { vehicle_name: r.vehicle_name, plate_number: r.plate_number }} /> },
  { key: 'plate', label: 'Plate Number', className: 'cell-center', render: (r) => (r.vehicle?.plate_number ?? r.plate_number) ?? '-' },
  { key: 'expenses', label: 'Expenses', className: 'cell-center', render: (r) => r.maintenance_cost ? `₱${Number(r.maintenance_cost).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '₱0.00' },
  { key: 'final_status', label: 'Final Status', className: 'cell-center', render: (r) => <TicketStatusBadge value={r.final_status} /> },
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
  'Active': '#d97706',
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
function DateFilterInput({ value, onChange, placeholder = 'mm/dd/yyyy', id, ariaLabel }) {
  const hiddenRef = useRef(null);
  const [text, setText] = useState(() => isoDateToDisplay(value));

  useEffect(() => {
    setText(isoDateToDisplay(value));
  }, [value]);

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
        className="filter-select"
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
// values instead of forcing a single native <select> choice.
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
  required = false, catalogEndpoint = null,
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
  // Only an Admin can remove a catalog entry — it's a shared list everyone
  // adds to, so letting any role delete from it risks a Custodian or
  // Mechanic wiping out something others rely on. The backend enforces
  // this too; hiding the button for non-Admins just avoids a guaranteed
  // 403 on click.
  const { user: currentUser } = useContext(AuthContext);
  const canDeleteCatalogItems = hasRole(currentUser, 'Admin');
  // Accepts either a plain name string (the simple catalogs) or a raw API
  // row keyed by idField/nameField (e.g. vehicle categories) — either way,
  // normalized to one {id, name} shape everything below works with.
  const normalizeItem = useCallback((raw) => (
    typeof raw === 'string' ? { id: null, name: raw } : { id: raw[idField] ?? null, name: raw[nameField] }
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
  const filtered = query ? catalogItems.filter((o) => o.name.toLowerCase().includes(query)) : catalogItems;
  const hasExactMatch = catalogItems.some((o) => o.name.toLowerCase() === query);
  const canAddNew = query.length > 0 && !hasExactMatch;

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
  // Renaming an existing entry — same little modal as add, pre-filled with
  // its current name. Only offered where add/delete already are (a real
  // catalogEndpoint, Admin), since it's the same permission story: a shared
  // list everyone reads, only Admin should be able to change it out from
  // under everyone else.
  const openEditModal = (item) => {
    setEditTarget(item);
    setAddModalName(item.name);
    setAddModalExtra(Object.fromEntries(extraFields.map((f) => [f.name, f.default ?? ''])));
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
          const exact = catalogItems.find((o) => o.name.toLowerCase() === query);
          if (exact) pick(exact);
          else if (filtered.length === 1) pick(filtered[0]);
          else if (canAddNew) openAddModal(text.trim());
        }}
      />
      {open && (
        <div className="creatable-select-panel">
          {!canAddNew && (
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
                {catalogEndpoint && canDeleteCatalogItems && o.id != null && (
                  <>
                    {/* Simple name-only catalogs (Fault Category, Maintenance
                        Type) only — a catalog with extraFields (e.g. Vehicle
                        Type's Domain) isn't safe to rename here, since this
                        list never carries those extra values to prefill the
                        modal with; blindly submitting would reset them to
                        whatever the field's bare default is. Those already
                        have their own proper edit page elsewhere. */}
                    {extraFields.length === 0 && (
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
                    <button
                      type="button"
                      className="creatable-select-option-delete"
                      onClick={(e) => { e.stopPropagation(); setDeleteTarget(o); setDeleteError(null); }}
                      title={`Remove ${o.name}`}
                      aria-label={`Remove ${o.name}`}
                    >
                      <Icon name="close" size={12} />
                    </button>
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
            <div className="toast-notice-overlay" onClick={() => setAddModalError(null)}>
              <div className="toast-notice toast-notice-validation error" role="alert" onClick={(e) => e.stopPropagation()}>
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
                <select
                  required={f.required}
                  value={addModalExtra[f.name] ?? ''}
                  onChange={(e) => setAddModalExtra((cur) => ({ ...cur, [f.name]: e.target.value }))}
                >
                  <option value="" disabled>{' '}</option>
                  {f.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
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
              <p>Remove "{deleteTarget.name}" from this list? It disappears for everyone — existing tickets/records that already used it keep showing it, but it won't be selectable anymore.</p>
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
            <div className="toast-notice-overlay" onClick={() => setError(null)}>
              <div className="toast-notice toast-notice-validation error" role="alert" onClick={(e) => e.stopPropagation()}>
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
  useEffect(() => {
    setDraft({
      category: filterCategory ?? [],
      capacity: filterCapacity ?? [],
      status: filterStatus ?? [],
      priority: filterPriority ?? [],
      location: filterLocation ?? [],
      domain: filterDomain ?? [],
    });
  }, [filterCategory, filterCapacity, filterStatus, filterPriority, filterLocation, filterDomain]);

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

// "Import Vehicle Data" wizard: template -> upload -> preview (nothing is saved
// yet) -> confirm -> summary. The server re-reads and re-validates the stored
// file on confirm, so this only ever names which preview to confirm.
function VehicleImportModal({ open, onClose, onImported }) {
  const [step, setStep] = useState('upload'); // upload | preview | done
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  if (!open) return null;

  const close = () => {
    setStep('upload'); setFile(null); setError(''); setResult(null); setBusy(false);
    onClose();
  };

  const saveBlob = async (path, params, filename) => {
    const response = await api.get(path, { params, responseType: 'blob' });
    const url = URL.createObjectURL(response.data);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  const guard = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); } catch (err) {
      setError(err.response?.data?.message || err.response?.data?.errors?.file?.[0] || 'Something went wrong. Please try again.');
    } finally { setBusy(false); }
  };

  const upload = () => guard(async () => {
    const body = new FormData();
    body.append('file', file);
    const res = await api.post('/vehicle-imports', body, { headers: { 'Content-Type': 'multipart/form-data' } });
    setResult(res.data); setStep('preview');
  });

  const confirm = () => guard(async () => {
    const res = await api.post(`/vehicle-imports/${result.id}/commit`);
    setResult(res.data); setStep('done');
    await onImported?.();
  });

  const findings = result?.findings ?? [];

  return (
    <FormModal open title="Import Vehicle Data" onClose={close} wide>
      {error && <div className="notice error" style={{ marginBottom: 12 }}>{error}</div>}

      {step === 'upload' && (
        <div style={{ display: 'grid', gap: 14 }}>
          <p style={{ margin: 0 }}>1. Download the template, fill in one vehicle per row, then upload it as .xlsx or .csv (up to 500 rows, 2 MB). You will review everything before anything is saved.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="ghost-button" onClick={() => guard(() => saveBlob('/vehicle-imports/template', { format: 'xlsx' }, 'vehicle-import-template.xlsx'))}>Download Excel template</button>
            <button type="button" className="ghost-button" onClick={() => guard(() => saveBlob('/vehicle-imports/template', { format: 'csv' }, 'vehicle-import-template.csv'))}>Download CSV template</button>
          </div>
          <input type="file" accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <div className="form-actions">
            <button type="button" className="ghost-button" onClick={close}>Cancel</button>
            <button type="button" className="primary-button" disabled={!file || busy} onClick={upload}>{busy ? 'Checking…' : 'Upload & Preview'}</button>
          </div>
        </div>
      )}

      {step === 'preview' && result && (
        <div style={{ display: 'grid', gap: 14 }}>
          <p style={{ margin: 0 }}><strong>{result.file_name}</strong> — {result.total_rows} rows: <strong>{result.valid_rows} valid</strong>, <strong>{result.error_rows} with errors</strong>, <strong>{result.warning_rows} with warnings</strong>.</p>
          {findings.length > 0 && (
            <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid var(--border, #d0d7e2)', borderRadius: 8 }}>
              <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                <thead><tr><th align="left">Row</th><th align="left">Field</th><th align="left">Issue</th></tr></thead>
                <tbody>
                  {findings.map((f, i) => (
                    <tr key={i} style={{ color: f.level === 'error' ? '#b42318' : '#b54708' }}>
                      <td>{f.row}</td><td>{f.field.replace(/_/g, ' ')}</td><td>{f.level === 'warning' ? 'Warning: ' : ''}{f.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p style={{ margin: 0, fontSize: 13 }}>Rows with errors will be skipped. Only the {result.valid_rows} valid row(s) are imported.</p>
          <div className="form-actions">
            {result.error_rows > 0 && (
              <button type="button" className="ghost-button" onClick={() => guard(() => saveBlob(`/vehicle-imports/${result.id}/errors`, {}, 'vehicle-import-errors.csv'))}>Download error report</button>
            )}
            <button type="button" className="ghost-button" onClick={() => { setStep('upload'); setResult(null); }}>Back</button>
            <button type="button" className="success-button" disabled={busy || result.valid_rows === 0} onClick={confirm}>{busy ? 'Importing…' : `Import ${result.valid_rows} vehicle(s)`}</button>
          </div>
        </div>
      )}

      {step === 'done' && result && (
        <div style={{ display: 'grid', gap: 14 }}>
          <p style={{ margin: 0 }}>Import complete: <strong>{result.imported_rows} vehicle(s) added</strong>, {result.failed_rows} skipped, out of {result.total_rows} rows.</p>
          <div className="form-actions">
            {result.failed_rows > 0 && (
              <button type="button" className="ghost-button" onClick={() => guard(() => saveBlob(`/vehicle-imports/${result.id}/errors`, {}, 'vehicle-import-errors.csv'))}>Download error report</button>
            )}
            <button type="button" className="primary-button" onClick={close}>Done</button>
          </div>
        </div>
      )}
    </FormModal>
  );
}
// Admin-defined custom fields for one Vehicle Type. Fields are archived, not
// deleted, so vehicles keep the values they already hold.
const CUSTOM_FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'date', label: 'Date' },
  { value: 'yes_no', label: 'Yes / No' },
];
const BLANK_FIELD_DRAFT = { label: '', field_type: 'text', is_required: false, unit: '', options: '' };

function CategoryFieldsManager({ categoryId, onChanged }) {
  const [fields, setFields] = useState([]);
  const [draft, setDraft] = useState(BLANK_FIELD_DRAFT);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get(`/categories/${categoryId}/fields`);
    setFields(res.data);
  }, [categoryId]);

  useEffect(() => {
    let cancelled = false;
    api.get(`/categories/${categoryId}/fields`).then((res) => { if (!cancelled) setFields(res.data); }).catch(() => {});
    return () => { cancelled = true; };
  }, [categoryId]);

  const run = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); await load(); await onChanged?.(); } catch (err) {
      setError(err.response?.data?.message || 'Could not save the field.');
    } finally { setBusy(false); }
  };

  const toPayload = (d) => ({
    label: d.label.trim(),
    field_type: d.field_type,
    is_required: d.is_required,
    unit: d.unit?.trim() || null,
    options: d.field_type === 'dropdown' ? String(d.options).split(',').map((o) => o.trim()).filter(Boolean) : null,
  });

  const save = () => run(async () => {
    if (editingId) await api.put(`/category-fields/${editingId}`, toPayload(draft));
    else await api.post(`/categories/${categoryId}/fields`, toPayload(draft));
    setDraft(BLANK_FIELD_DRAFT); setEditingId(null);
  });

  const move = (index, delta) => run(async () => {
    const a = fields[index]; const b = fields[index + delta];
    if (!b) return;
    // Renumber both neighbours so equal sort_orders can't leave them stuck.
    await api.put(`/category-fields/${a.field_id}`, { label: a.label, sort_order: index + delta });
    await api.put(`/category-fields/${b.field_id}`, { label: b.label, sort_order: index });
  });

  const startEdit = (f) => {
    setEditingId(f.field_id);
    setDraft({ label: f.label, field_type: f.field_type, is_required: f.is_required, unit: f.unit ?? '', options: (f.options ?? []).join(', ') });
  };

  return (
    <section className="veh-card" style={{ marginTop: 16 }}>
      <div className="veh-card-head"><Icon name="list" size={16} /><h4>Custom Fields</h4></div>
      <div style={{ padding: '0 20px 20px', display: 'grid', gap: 12 }}>
        <p style={{ margin: 0, fontSize: 13 }}>Extra details asked for whenever a vehicle of this type is added or edited. Archived fields stop being asked, but existing values are kept.</p>
        {error && <div className="notice error">{error}</div>}
        {fields.length === 0 && <p style={{ margin: 0, opacity: 0.7 }}>No custom fields yet.</p>}
        {fields.map((f, i) => (
          <div key={f.field_id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', opacity: f.is_active ? 1 : 0.55 }}>
            <strong style={{ flex: '1 1 200px' }}>{f.label}{f.is_required ? ' *' : ''}</strong>
            <span style={{ fontSize: 13 }}>{CUSTOM_FIELD_TYPES.find((t) => t.value === f.field_type)?.label}{f.unit ? ` · ${f.unit}` : ''}{f.options?.length ? ` · ${f.options.join(', ')}` : ''}{f.is_active ? '' : ' · archived'}</span>
            <button type="button" className="ghost-button" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label="Move up">▲</button>
            <button type="button" className="ghost-button" disabled={busy || i === fields.length - 1} onClick={() => move(i, 1)} aria-label="Move down">▼</button>
            <button type="button" className="ghost-button" disabled={busy} onClick={() => startEdit(f)}>Edit</button>
            <button type="button" className="ghost-button" disabled={busy} onClick={() => run(() => api.put(`/category-fields/${f.field_id}`, { label: f.label, is_active: !f.is_active }))}>{f.is_active ? 'Archive' : 'Restore'}</button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', borderTop: '1px solid var(--border, #d0d7e2)', paddingTop: 12 }}>
          <label style={{ flex: '1 1 180px' }}>Field name
            <input type="text" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="e.g. Tank Capacity" />
          </label>
          <label>Type
            <select value={draft.field_type} disabled={!!editingId} onChange={(e) => setDraft({ ...draft, field_type: e.target.value })}>
              {CUSTOM_FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
          {(draft.field_type === 'number' || draft.field_type === 'text') && (
            <label style={{ width: 90 }}>Unit
              <input type="text" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} placeholder="L, kg…" />
            </label>
          )}
          {draft.field_type === 'dropdown' && (
            <label style={{ flex: '1 1 220px' }}>Options (comma-separated)
              <input type="text" value={draft.options} onChange={(e) => setDraft({ ...draft, options: e.target.value })} placeholder="Front, Rear" />
            </label>
          )}
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={draft.is_required} onChange={(e) => setDraft({ ...draft, is_required: e.target.checked })} /> Required
          </label>
          <button type="button" className="primary-button" disabled={busy || !draft.label.trim()} onClick={save}>{editingId ? 'Update Field' : 'Add Field'}</button>
          {editingId && <button type="button" className="ghost-button" onClick={() => { setEditingId(null); setDraft(BLANK_FIELD_DRAFT); }}>Cancel</button>}
        </div>
      </div>
    </section>
  );
}

// Fleet Readiness & Criticality Watch — every operational vehicle that isn't
// verified ready, Critical first. Shown on the lean (Custodian/Maintenance)
// dashboard; Admin sees the same list inside Risk & Readiness Watch.
function CriticalityWatchCard({ items, onNavigate, basePath }) {
  const shown = (items ?? []).slice(0, 6);

  return (
    <section className="panel col-span-7 dashboard-lean-panel">
      <div className="panel-header-bar">
        <h3><Icon name="alert" size={16} /> Readiness &amp; Criticality Watch</h3>
        {items?.length > 0 && <span className="area-chart-tag">{items.length} not ready</span>}
      </div>
      {!items?.length ? (
        <p className="action-queue-clear"><Icon name="checkCircle" size={16} /> No readiness risks right now.</p>
      ) : (
        <>
          <div className="risk-watch-col">
            {shown.map((r) => (
              <button
                key={r.vehicle_id}
                type="button"
                className={`risk-watch-item risk-watch-item-clickable${r.criticality === 'Critical' ? ' is-critical' : ''}`}
                onClick={() => onNavigate(`${basePath}/vehicles/${r.vehicle_id}`)}
              >
                <span className={`risk-watch-item-dot${r.criticality === 'Critical' ? ' is-critical' : ''}`} />
                <div className="risk-watch-item-body">
                  <span className="risk-watch-item-top">
                    <span className="risk-watch-item-title">{r.vehicle_name}</span>
                    <span className={`risk-watch-tag${r.criticality === 'Critical' ? ' is-critical' : ''}`}>{r.criticality.toUpperCase()}</span>
                  </span>
                  <span className="risk-watch-item-sub">{r.category ?? '—'} · {r.reason}</span>
                </div>
              </button>
            ))}
          </div>
          {items.length > shown.length && (
            <p className="muted" style={{ margin: '8px 0 0', fontSize: '0.78rem' }}>+ {items.length - shown.length} more — open Vehicles to see them all.</p>
          )}
        </>
      )}
    </section>
  );
}

// Fleet Capability & Readiness Impact — final feature pass (2026-10-10).
// The per-vehicle Criticality Watch above, rolled up to "which emergency
// capability is at risk?" per Vehicle Type. Entirely server-computed
// (capability_impact on the dashboard response) — this component only
// renders what it's given, it never recomputes readiness/criticality itself.
const CAPABILITY_STATE_LABEL = { LIMITED: 'Limited', AT_RISK: 'At Risk', NO_COVERAGE: 'No Coverage' };

function CapabilityImpactCard({ items, onNavigate, basePath }) {
  return (
    <section className="panel col-span-7 dashboard-lean-panel">
      <div className="panel-header-bar">
        <h3><Icon name="alert" size={16} /> Fleet Capability Impact</h3>
        {items?.length > 0 && <span className="area-chart-tag">{items.length} type{items.length === 1 ? '' : 's'} affected</span>}
      </div>
      {!items?.length ? (
        <p className="action-queue-clear"><Icon name="checkCircle" size={16} /> No capability gaps right now.</p>
      ) : (
      <div className="risk-watch-col">
        {items.map((row) => (
          <div key={row.category} className={`risk-watch-item${row.criticality === 'Critical' ? ' is-critical' : ''}`} style={{ cursor: 'default', alignItems: 'flex-start' }}>
            <span className={`risk-watch-item-dot${row.criticality === 'Critical' ? ' is-critical' : ''}`} />
            <div className="risk-watch-item-body">
              <span className="risk-watch-item-top">
                <span className="risk-watch-item-title">{row.category}</span>
                <span className={`risk-watch-tag${row.coverage_state === 'NO_COVERAGE' ? ' is-critical' : ''}`}>
                  {CAPABILITY_STATE_LABEL[row.coverage_state] ?? row.coverage_state}
                </span>
              </span>
              <span className="risk-watch-item-sub">
                {row.ready}/{row.total} ready · {row.criticality} · {row.primary_reason ?? 'Based on current records.'}
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, alignItems: 'center' }}>
                {row.affected_vehicles.slice(0, 4).map((v) => (
                  <span key={v.vehicle_id} style={{ display: 'inline-flex', borderRadius: 999, overflow: 'hidden', border: '1px solid #cbd5e1' }}>
                    <button
                      type="button"
                      className="btn-view-action"
                      style={{ fontSize: '0.74rem', padding: '3px 9px', border: 'none', borderRadius: 0 }}
                      onClick={() => onNavigate(`${basePath}/vehicles/${v.vehicle_id}`)}
                    >
                      {v.vehicle_name}
                    </button>
                    {v.active_ticket_id && (
                      <button
                        type="button"
                        className="btn-view-action"
                        title={`Open Ticket #${v.active_ticket_id}`}
                        style={{ fontSize: '0.74rem', padding: '3px 9px', border: 'none', borderLeft: '1px solid #cbd5e1', borderRadius: 0, background: '#eff6ff' }}
                        onClick={() => onNavigate(`${basePath}/tickets/${v.active_ticket_id}`)}
                      >
                        Ticket
                      </button>
                    )}
                  </span>
                ))}
                {row.affected_vehicles.length > 4 && (
                  <span className="muted" style={{ fontSize: '0.72rem' }}>+ {row.affected_vehicles.length - 4} more</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      )}
    </section>
  );
}

// Vehicle Usage Log — open a trip when the vehicle goes out, close it when it
// is back. Recording only; it never changes the vehicle's status.
function VehicleUsageCard({ vehicleId, canLog, vehicleStatus }) {
  const [trips, setTrips] = useState([]);
  const [form, setForm] = useState({ purpose: '', destination: '', driver_name: '', odometer_start: '' });
  const [endForm, setEndForm] = useState({ odometer_end: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.get(`/vehicles/${vehicleId}/usage`).then((res) => { if (!cancelled) setTrips(res.data); }).catch(() => {});
    return () => { cancelled = true; };
  }, [vehicleId, reloadKey]);

  const open = trips.find((t) => !t.ended_at);

  const run = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); setReloadKey((k) => k + 1); } catch (err) {
      setError(err.response?.data?.message || err.response?.data?.errors && Object.values(err.response.data.errors)[0]?.[0] || 'Could not save.');
    } finally { setBusy(false); }
  };

  const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => String(v).trim() !== ''));

  return (
    <section className="veh-card">
      <div className="veh-card-head"><Icon name="vehicle" size={16} /><h4>Usage Log</h4></div>
      <div style={{ padding: '0 18px 18px', display: 'grid', gap: 10 }}>
        {error && <div className="notice error">{error}</div>}
        {canLog && !open && vehicleStatus === 'Available' && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="text" placeholder="Purpose *" value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} style={{ flex: '2 1 180px' }} />
            <input type="text" placeholder="Destination" value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} style={{ flex: '1 1 140px' }} />
            <input type="text" placeholder="Driver" value={form.driver_name} onChange={(e) => setForm({ ...form, driver_name: e.target.value })} style={{ flex: '1 1 120px' }} />
            <input type="number" min="0" placeholder="Odometer" value={form.odometer_start} onChange={(e) => setForm({ ...form, odometer_start: e.target.value })} style={{ width: 110 }} />
            <button type="button" className="primary-button" disabled={busy || !form.purpose.trim()} onClick={() => run(async () => { await api.post(`/vehicles/${vehicleId}/usage`, clean(form)); setForm({ purpose: '', destination: '', driver_name: '', odometer_start: '' }); })}>Take Out</button>
          </div>
        )}
        {canLog && open && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: '0.85rem' }}>Out since {formatDate(open.started_at)}: <strong>{open.purpose}</strong></span>
            <input type="number" min={open.odometer_start ?? 0} placeholder="Odometer on return" value={endForm.odometer_end} onChange={(e) => setEndForm({ odometer_end: e.target.value })} style={{ width: 150 }} />
            <button type="button" className="primary-button" disabled={busy} onClick={() => run(async () => { await api.put(`/usage-logs/${open.usage_id}/end`, clean(endForm)); setEndForm({ odometer_end: '' }); })}>Mark Returned</button>
          </div>
        )}
        {trips.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No trips recorded yet.</p>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {trips.slice(0, 8).map((t) => (
              <div key={t.usage_id} style={{ fontSize: '0.84rem', display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <span><strong>{t.purpose}</strong>{t.destination ? ` → ${t.destination}` : ''}{t.driver_name ? ` · ${t.driver_name}` : ''}</span>
                <span className="muted">{formatDate(t.started_at)}{t.ended_at ? ` – ${formatDate(t.ended_at)}` : ' · out now'}{t.odometer_start != null && t.odometer_end != null ? ` · ${t.odometer_end - t.odometer_start} km` : ''}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
function LocalSearchInput({ value, onChange, placeholder = "Search...", onExport, onAdd, addLabel = "Add", onImport, columnChooser }) {
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
        />
        {value && (
          <button className="local-search-clear" onClick={() => onChange('')} type="button" title="Clear search">
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
      {onImport && (
        <button className="export-btn" onClick={onImport} type="button" title="Import vehicles from a spreadsheet" aria-label="Import vehicles from a spreadsheet">
          <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><Icon name="download" size={15} /></span>
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
  useEffect(() => {
    setOrder((prev) => {
      const stillValid = prev.filter((k) => columnKeys.includes(k));
      const newOnes = columnKeys.filter((k) => !stillValid.includes(k));
      return newOnes.length || stillValid.length !== prev.length ? [...stillValid, ...newOnes] : prev;
    });
    setHidden((prev) => {
      const next = new Set([...prev].filter((k) => columnKeys.includes(k)));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnKeysSignature]);

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
  const visibleColumns = order.map((k) => byKey.get(k)).filter((c) => c && !hidden.has(c.key));

  return { allColumns, order, hidden, toggleColumn, reorderColumn, resetColumns, visibleColumns };
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
