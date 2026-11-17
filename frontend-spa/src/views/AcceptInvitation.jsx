import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import api from '../api/axios';
import AuthHeader from '../components/AuthHeader';
import AuthFooter from '../components/AuthFooter';
import Aurora from '../components/Aurora';

const PASSWORD_HINT = 'At least 8 characters, with letters and numbers.';

// The emailed "Activate Your Account" link lands here. The server decides who the account is,
// its role and barangay; the visitor only ever chooses a password.
export default function AcceptInvitation() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState(token ? 'loading' : 'invalid');
  const [invite, setInvite] = useState(null);
  const [form, setForm] = useState({ password: '', password_confirmation: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) return undefined;
    let current = true;
    api.get(`/invitations/${encodeURIComponent(token)}`)
      .then(({ data }) => { if (current) { setInvite(data); setState('form'); } })
      .catch((requestError) => { if (current) setState(axios.isAxiosError(requestError) && !requestError.response ? 'offline' : 'invalid'); });
    return () => { current = false; };
  }, [token]);

  useEffect(() => {
    if (state !== 'done') return undefined;
    const timer = setTimeout(() => navigate('/login', { replace: true }), 3000);
    return () => clearTimeout(timer);
  }, [state, navigate]);

  const mismatch = form.password_confirmation !== '' && form.password !== form.password_confirmation;
  const weak = form.password !== '' && (form.password.length < 8 || !/[A-Za-z]/.test(form.password) || !/\d/.test(form.password));

  const submit = async (event) => {
    event.preventDefault();
    if (submitting || weak || mismatch || !form.password) return;
    setSubmitting(true);
    setError('');
    try {
      await api.post('/invitations/accept', { token, ...form });
      setState('done');
    } catch (requestError) {
      if (requestError.response?.status === 410) setState('invalid');
      else setError(requestError.response?.data?.errors?.password?.[0] ?? requestError.response?.data?.message ?? 'Could not activate your account. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const reset = invite?.purpose === 'reset';

  return (
    <div className="auth-page-shell">
      <AuthHeader />
      <main className="auth-page">
        <Aurora colorStops={['#0b1220', '#1e3a5f', '#0f172a']} amplitude={0.6} blend={0.55} />
        <section className="auth-card" aria-labelledby="invite-title">
          <div className="auth-logo-header">
            <h1 id="invite-title" className="auth-login-heading">{reset ? 'Choose a new password' : 'Activate your account'}</h1>
          </div>

          {state === 'loading' && <p role="status">Checking your invitation…</p>}

          {state === 'offline' && <p className="notice error" role="alert">Could not reach the server. Check your connection and reload this page.</p>}

          {state === 'invalid' && (
            <>
              <p className="notice error" role="alert">This invitation link is invalid or has expired. Ask your administrator to send you a new one.</p>
              <Link className="primary-link" to="/login">Go to sign in</Link>
            </>
          )}

          {state === 'done' && (
            <>
              <p className="notice success" role="status">{reset ? 'Your password was changed.' : 'Your account is active.'} Redirecting you to sign in…</p>
              <Link className="primary-link" to="/login">Sign in now</Link>
            </>
          )}

          {state === 'form' && invite && (
            <form className="auth-form" onSubmit={submit} noValidate>
              <p>
                Hello <strong>{invite.name}</strong>.
                {' '}{reset ? 'Choose a new password for your' : 'You are being activated as'} <strong>{invite.role}</strong>
                {invite.barangay ? <> of Barangay <strong>{invite.barangay}</strong>{invite.lgu ? `, ${invite.lgu}` : ''}</> : null}.
              </p>
              <label className="auth-field">
                <span>New password</span>
                <div className="auth-input-wrapper auth-input-plain">
                  <input autoComplete="new-password" type="password" required value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} aria-describedby="invite-password-hint" />
                </div>
                <small id="invite-password-hint" className={weak ? 'fx-error' : 'muted'}>{PASSWORD_HINT}</small>
              </label>
              <label className="auth-field">
                <span>Confirm password</span>
                <div className="auth-input-wrapper auth-input-plain">
                  <input autoComplete="new-password" type="password" required value={form.password_confirmation} onChange={(event) => setForm({ ...form, password_confirmation: event.target.value })} />
                </div>
                {mismatch && <small className="fx-error" role="alert">The passwords do not match.</small>}
              </label>
              {error && <p className="notice error" role="alert">{error}</p>}
              <button type="submit" className="primary-button" disabled={submitting || weak || mismatch || !form.password || !form.password_confirmation}>
                {submitting ? 'Saving…' : reset ? 'Save new password' : 'Activate account'}
              </button>
            </form>
          )}
        </section>
      </main>
      <AuthFooter />
    </div>
  );
}
