import VMSLogo from './VMSLogo';
import Icon from './Icon';
import { useContext, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AuthContext } from '../context/AuthContextObject';

const roleRoutes = {
  Admin: '/admin',
  Custodian: '/custodian',
  'Maintenance Personnel': '/maintenance',
  'Super Admin': '/superadmin',
  Impersonator: '/impersonation',
};

// Shared header for the public-facing pages (Login, About, Developers) —
// the sign-in-side counterpart to WorkspaceFooter, so those pages read as
// one connected site instead of disconnected standalone screens.
export default function AuthHeader() {
  const { user } = useContext(AuthContext);
  // Signed-in visitors can return directly to their dashboard.
  const dashboardPath = user ? (roleRoutes[user.role] ?? '/admin') : null;
  // Phones fold the links into a burger menu. It is tied to the page it was
  // opened on, so following any link closes it without an effect.
  const { pathname } = useLocation();
  const [openOn, setOpenOn] = useState(null);
  const menuOpen = openOn === pathname;
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setOpenOn(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <header className="auth-page-header">
      <div className="auth-page-header-inner">
        <Link to={dashboardPath ?? '/login'} className="auth-page-header-brand">
          <VMSLogo variant="white" size={32} className="auth-page-header-gear" />
          <div className="auth-page-header-brand-text">
            <span className="vms-wordmark auth-page-header-wordmark">vms</span>
            <span className="auth-page-header-subtext">vehicle management system</span>
          </div>
        </Link>
        <button
          type="button"
          className="auth-page-burger"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          aria-controls="auth-page-menu"
          onClick={() => setOpenOn(menuOpen ? null : pathname)}
        >
          <Icon name={menuOpen ? 'close' : 'menu'} size={24} />
        </button>
        <div id="auth-page-menu" className={`auth-page-header-right${menuOpen ? ' is-open' : ''}`} onClick={(event) => { if (event.target.closest('a')) setOpenOn(null); }}>
          <nav className="auth-page-nav">
            <Link to={dashboardPath ?? '/login'}>Home</Link>
            <Link to="/about">About</Link>
            <Link to="/developers">Team</Link>
            <Link to="/support">Support Center</Link>
          </nav>
          {dashboardPath ? (
            <Link to={dashboardPath} className="auth-page-header-login-btn">Back to Dashboard</Link>
          ) : (
            <Link to="/login" className="auth-page-header-login-btn">Login</Link>
          )}
        </div>
      </div>
    </header>
  );
}
