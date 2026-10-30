import { BrowserRouter as Router, Routes, Route, Navigate, Link } from 'react-router-dom';
import { ProtectedRoute } from './components/ProtectedRoute';
import ErrorBoundary from './components/ErrorBoundary';
import { lazy, Suspense, useContext } from 'react';
import ManagedFileLinks from './components/ManagedFileLinks';
import { AuthContext } from './context/AuthContextObject';
import Login from './views/Login';
const AcceptInvite = lazy(() => import('./views/AcceptInvite'));
const Privacy = lazy(() => import('./views/Privacy'));
const Terms = lazy(() => import('./views/Terms'));
const About = lazy(() => import('./views/About'));
const Support = lazy(() => import('./views/Support'));
const Developers = lazy(() => import('./views/Developers'));
const Workspace = lazy(() => import('./views/Workspace'));
const ImpersonationHub = lazy(() => import('./views/ImpersonationHub'));
const SuperAdminWorkspace = lazy(() => import('./views/SuperAdminWorkspace'));
import './App.css';
import './WorkflowDetails.css';

function FleetWorkspace() {
  const { user } = useContext(AuthContext);
  // Changing identity or roles starts a fresh workspace. Ordinary profile
  // refreshes preserve the selected module and any in-progress form.
  return <Workspace key={JSON.stringify([user?.id, user?.role, user?.roles])} />;
}

function Unauthorized() {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <p className="eyebrow">Access Control</p>
        <h1>Access denied</h1>
        <p>Your account role does not have permission to view that workspace.</p>
        <Link className="primary-link" to="/login">Return to sign in</Link>
      </section>
    </main>
  );
}

function App() {
  return (
    <Router>
      <ManagedFileLinks />
      <ErrorBoundary>
        <Suspense fallback={<main className="auth-page" role="status">Loading…</main>}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/accept-invite" element={<AcceptInvite />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/about" element={<About />} />
          <Route path="/support" element={<Support />} />
          <Route path="/developers" element={<Developers />} />
          <Route path="/impersonation" element={<ProtectedRoute allowedRoles={['Impersonator']}><ImpersonationHub /></ProtectedRoute>} />
          <Route path="/unauthorized" element={<Unauthorized />} />
          <Route
            path="/admin/*"
            element={
              <ProtectedRoute allowedRoles={['Admin']}>
                <FleetWorkspace />
              </ProtectedRoute>
            }
          />
          <Route
            path="/custodian/*"
            element={
              <ProtectedRoute allowedRoles={['Custodian']}>
                <FleetWorkspace />
              </ProtectedRoute>
            }
          />
          <Route
            path="/maintenance/*"
            element={
              <ProtectedRoute allowedRoles={['Maintenance Personnel']}>
                <FleetWorkspace />
              </ProtectedRoute>
            }
          />
          <Route
            path="/superadmin/*"
            element={
              <ProtectedRoute allowedRoles={['Super Admin']}>
                <SuperAdminWorkspace />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
        </Suspense>
      </ErrorBoundary>
    </Router>
  );
}

export default App;
