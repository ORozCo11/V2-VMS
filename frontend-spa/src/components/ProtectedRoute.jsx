import LoadingOverlay from './LoadingOverlay';
import { useContext } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { AuthContext } from '../context/AuthContextObject';
import ForceChangePassword from '../views/ForceChangePassword';

export const ProtectedRoute = ({ children, allowedRoles }) => {
  const { user, token, loading } = useContext(AuthContext);
  const location = useLocation();

  // Pause rendering while checking for an existing browser session token
  if (loading) {
    return <LoadingOverlay label="Verifying your session..." />;
  }

  // If not logged in, redirect them immediately back to the main login portal
  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // If logged in but lacks the required role, bounce them to an unauthorized alert view.
  // Mirrors Workspace.jsx's hasRole(): check the full `roles` set the account holds, not
  // just the primary `role` string, so a multi-role user isn't bounced from a secondary
  // role's URL that in-page gates would otherwise allow once there.
  const roles = user?.roles;
  const hasAnyAllowedRole = allowedRoles?.some((r) => (
    Array.isArray(roles) && roles.length ? roles.includes(r) : user?.role === r
  ));
  if (allowedRoles && !hasAnyAllowedRole) {
    return <Navigate to="/unauthorized" replace />;
  }

  // An account still on its temporary password can't use any workspace yet.
  if (user?.must_change_password) {
    return <ForceChangePassword />;
  }

  // Render the page workspace if security validations pass successfully
  return children;
};
