import { useContext, useState } from 'react';
import api from '../api/axios';
import AuthHeader from '../components/AuthHeader';
import { AuthContext } from '../context/AuthContextObject';

// Shown in place of every workspace while the account is still on the
// temporary password someone else gave it. The server enforces the same rule
// (EnsurePasswordChanged), so this screen is the only useful thing to show.
function ForceChangePassword() {
  const { user, logout, refreshUser } = useContext(AuthContext);
  const [form, setForm] = useState({ old_password: '', new_password: '', new_password_confirmation: '' });
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleChange = (event) => setForm((current) => ({ ...current, [event.target.name]: event.target.value }));

  const handleSubmit = async (event) => {
    event.preventDefault();
    setErrors({});
    setMessage('');
    if (form.new_password !== form.new_password_confirmation) {
      setErrors({ new_password_confirmation: 'The two new passwords do not match.' });
      return;
    }
    setSubmitting(true);
    try {
      await api.put('/profile/password', form);
      await refreshUser();
    } catch (error) {
      const data = error.response?.data;
      if (data?.errors) {
        setErrors(Object.fromEntries(Object.entries(data.errors).map(([field, list]) => [field, list[0]])));
      } else {
        setMessage(data?.message || 'Your password was not changed because the server could not be reached. Check your connection and try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const field = (name, label, autoComplete) => (
    <label className="auth-field">
      <span>{label}</span>
      <div className="auth-input-wrapper auth-input-plain">
        <input autoComplete={autoComplete} name={name} onChange={handleChange} required type="password" value={form[name]} />
      </div>
      {errors[name] ? <p className="notice error" role="alert">{errors[name]}</p> : null}
    </label>
  );

  return (
    <div className="auth-page-shell">
      <AuthHeader />
      <main className="auth-page">
        <section className="auth-card" aria-labelledby="force-change-title">
          <div className="auth-logo-header">
            <h1 id="force-change-title" className="auth-login-heading">Set your password</h1>
          </div>
          <p>Hi {user?.name}, you signed in with a temporary password. Choose your own password to continue.</p>
          <form className="auth-form" onSubmit={handleSubmit} noValidate>
            {field('old_password', 'Temporary password', 'current-password')}
            {field('new_password', 'New password (at least 8 characters)', 'new-password')}
            {field('new_password_confirmation', 'Confirm new password', 'new-password')}
            {message ? <p className="notice error" role="alert">{message}</p> : null}
            <button className="primary-button auth-submit-btn" disabled={submitting} type="submit">
              {submitting ? 'Saving…' : 'Save password and continue'}
            </button>
            <button className="ghost-button" onClick={logout} type="button">Sign out</button>
          </form>
        </section>
      </main>
    </div>
  );
}

export default ForceChangePassword;
