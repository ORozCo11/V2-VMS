import { useContext, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api/axios';
import AuthHeader from '../components/AuthHeader';
import AuthFooter from '../components/AuthFooter';
import { AuthContext } from '../context/AuthContextObject';

const roleRoutes = {
  Admin: '/admin',
  Custodian: '/custodian',
  'Maintenance Personnel': '/maintenance',
};

// Opened from the invite email: the invitee sets their own password, which
// activates the account and signs them in.
function AcceptInvite() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { login } = useContext(AuthContext);
  const email = params.get('email') ?? '';
  const token = params.get('token') ?? '';
  const [form, setForm] = useState({ password: '', password_confirmation: '' });
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
  const [finished, setFinished] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (!email || !token) {
    return <Navigate to="/login" replace />;
  }

  const update = (event) => setForm((current) => ({ ...current, [event.target.name]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setErrors({});
    setMessage('');
    if (form.password !== form.password_confirmation) {
      setErrors({ password_confirmation: 'The two passwords do not match.' });
      return;
    }
    setSubmitting(true);
    try {
      const { data } = await api.post('/invites/accept', { email, token, ...form });
      login(data.user, data.access_token, true);
      navigate(roleRoutes[data.user.role] ?? '/login', { replace: true });
    } catch (error) {
      const data = error.response?.data;
      if (data?.errors) {
        setErrors(Object.fromEntries(Object.entries(data.errors).map(([field, list]) => [field, list[0]])));
      } else {
        setMessage(data?.message ?? 'Your password was not set because the server could not be reached. Check your connection and try again.');
        // Used or expired links can't be retried from this page.
        setFinished(error.response?.status === 410);
      }
      setSubmitting(false);
    }
  };

  const field = (name, label) => (
    <label className="auth-field">
      <span>{label}</span>
      <div className="auth-input-wrapper auth-input-plain">
        <input autoComplete="new-password" name={name} onChange={update} required type="password" value={form[name]} />
      </div>
      {errors[name] ? <p className="notice error" role="alert">{errors[name]}</p> : null}
    </label>
  );

  return (
    <div className="auth-page-shell">
      <AuthHeader />
      <main className="auth-page">
        <section className="auth-card" aria-labelledby="accept-invite-title">
          <div className="auth-logo-header">
            <h1 id="accept-invite-title" className="auth-login-heading">Set your password</h1>
          </div>
          <p>You were invited to VMS as <strong>{email}</strong>. Choose a password to activate your account.</p>
          {finished ? (
            <>
              <p className="notice error" role="alert">{message}</p>
              <Link className="primary-link" to="/login">Go to sign in</Link>
            </>
          ) : (
            <form className="auth-form" onSubmit={submit} noValidate>
              {field('password', 'Password (at least 8 characters)')}
              {field('password_confirmation', 'Confirm password')}
              {message ? <p className="notice error" role="alert">{message}</p> : null}
              <button className="primary-button auth-submit-btn" disabled={submitting} type="submit">
                {submitting ? 'Activating…' : 'Set password and sign in'}
              </button>
            </form>
          )}
        </section>
      </main>
      <AuthFooter />
    </div>
  );
}

export default AcceptInvite;
