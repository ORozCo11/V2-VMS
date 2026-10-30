import LoadingOverlay from '../components/LoadingOverlay';
import { useContext, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import api from '../api/axios';
import Icon from '../components/Icon';
import Aurora from '../components/Aurora';
import AuthHeader from '../components/AuthHeader';
import AuthFooter from '../components/AuthFooter';
import { AuthContext } from '../context/AuthContextObject';

const roleRoutes = {
  Admin: '/admin',
  Custodian: '/custodian',
  'Maintenance Personnel': '/maintenance',
  'Super Admin': '/superadmin',
  Impersonator: '/impersonation',
};

function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, token, user } = useContext(AuthContext);
  const [credentials, setCredentials] = useState({
    email: '',
    password: '',
  });
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  if (token && user) {
    return <Navigate to={roleRoutes[user.role] ?? '/unauthorized'} replace />;
  }

  const finishLogin = ({ user: authenticatedUser, access_token: accessToken }) => {
    login(authenticatedUser, accessToken, rememberMe);
    // Return to wherever ProtectedRoute bounced them from, if anywhere —
    // only unauthenticated redirects land here with `from` set, so this
    // can never send someone to a page their role doesn't allow (a wrong
    // role goes to /unauthorized instead, not back through /login).
    const destination = authenticatedUser.role === 'Impersonator' ? '/impersonation' : location.state?.from
      ? `${location.state.from.pathname}${location.state.from.search ?? ''}`
      : (roleRoutes[authenticatedUser.role] ?? '/unauthorized');
    navigate(destination, { replace: true });
  };

  const handleChange = (event) => {
    const { name, value } = event.target;
    setCredentials((current) => ({
      ...current,
      [name]: value,
    }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (submitting) return;
    setError('');

    if (!credentials.email || !credentials.password) {
      setError('Email and password are required.');
      return;
    }

    setSubmitting(true);

    try {
      const response = await api.post('/login', credentials);
      finishLogin(response.data);
    } catch (requestError) {
      setError(
        requestError.response?.data?.message ??
          'Unable to sign in. Please check your connection and try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page-shell">
      <AuthHeader />

      <main className="auth-page">
      {submitting && <LoadingOverlay />}
      <Aurora colorStops={['#0b1220', '#1e3a5f', '#0f172a']} amplitude={0.6} blend={0.55} />
      <section className="auth-card" aria-labelledby="login-title">
        <div className="auth-logo-header">
          <h1 id="login-title" className="auth-login-heading">Login</h1>
        </div>

        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          <label className="auth-field">
            <span>Email Address</span>
            <div className="auth-input-wrapper auth-input-plain">
              <input
                autoComplete="email"
                name="email"
                onChange={handleChange}
                placeholder="Email address"
                required
                type="email"
                value={credentials.email}
              />
            </div>
          </label>

          <label className="auth-field">
            <span>Password</span>
            <div className="auth-input-wrapper auth-input-plain">
              <input
                autoComplete="current-password"
                name="password"
                onChange={handleChange}
                placeholder="Password"
                required
                type={showPassword ? 'text' : 'password'}
                value={credentials.password}
              />
              <button
                type="button"
                className="password-toggle-btn"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                <Icon name={showPassword ? 'eyeOff' : 'eye'} size={18} />
              </button>
            </div>
          </label>

          <label className="auth-remember">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
            />
            Remember Me
          </label>

          {error ? <p className="notice error" role="alert">{error}</p> : null}

          <button className="primary-button auth-submit-btn" disabled={submitting} type="submit">
            {submitting ? (
              <span className="btn-loading">
                <span className="btn-spinner" aria-hidden="true" />
                Signing in…
              </span>
            ) : 'Sign in'}
          </button>
        </form>

        <p className="auth-legal">
          <Link to="/privacy">Privacy</Link>
          {' · '}
          <Link to="/terms">Terms</Link>
        </p>
      </section>
      </main>

      <AuthFooter />
    </div>
  );
}

export default Login;
