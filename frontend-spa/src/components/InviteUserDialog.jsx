import { useState } from 'react';
import api from '../api/axios';
import Icon from './Icon';

const ROLES = ['Admin', 'Custodian', 'Maintenance Personnel'];

// A barangay Admin invites a staff member by email. The server creates the
// account and emails a "Set your password" link; nothing secret is shown here.
export default function InviteUserDialog({ onClose, onInvited }) {
  const [form, setForm] = useState({ name: '', email: '', phone: '', roles: ['Custodian'] });
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  const update = (event) => setForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  const toggleRole = (role) => setForm((current) => ({
    ...current,
    roles: current.roles.includes(role) ? current.roles.filter((r) => r !== role) : [...current.roles, role],
  }));

  const submit = async (event) => {
    event.preventDefault();
    setErrors({});
    setMessage('');
    if (!form.roles.length) {
      setErrors({ roles: 'Choose at least one role.' });
      return;
    }
    setSending(true);
    try {
      const { data } = await api.post('/users/invite', { ...form, phone: form.phone || null });
      await onInvited(data.message);
    } catch (error) {
      const data = error.response?.data;
      if (data?.errors) setErrors(Object.fromEntries(Object.entries(data.errors).map(([field, list]) => [field.split('.')[0], list[0]])));
      else setMessage(data?.message ?? `The invite to ${form.email} was not sent because the server could not be reached. Check your connection and try again.`);
      setSending(false);
    }
  };

  const field = (name, label, type, extra = {}) => (
    <label className="auth-field">
      <span>{label}</span>
      <div className="auth-input-wrapper auth-input-plain">
        <input name={name} type={type} value={form[name]} onChange={update} {...extra} />
      </div>
      {errors[name] ? <p className="notice error" role="alert">{errors[name]}</p> : null}
    </label>
  );

  return (
    <div className="confirm-overlay">
      <form className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="invite-user-title" onSubmit={submit} noValidate>
        <div className="confirm-dialog-icon" aria-hidden="true"><Icon name="mail" size={22} /></div>
        <div className="confirm-dialog-copy">
          <h3 id="invite-user-title">Invite a user</h3>
          <p>They will get an email with a link to set their password. The link works once and expires in 7 days.</p>
        </div>
        {field('name', 'Full name', 'text', { required: true, autoComplete: 'off', autoFocus: true })}
        {field('email', 'Email address', 'email', { required: true, autoComplete: 'off' })}
        {field('phone', 'Phone (optional)', 'tel', { placeholder: '09171234567', inputMode: 'numeric' })}
        <fieldset className="auth-field">
          <legend>Role</legend>
          {ROLES.map((role) => (
            <label key={role} className="auth-remember">
              <input type="checkbox" checked={form.roles.includes(role)} onChange={() => toggleRole(role)} />
              {role}
            </label>
          ))}
          {errors.roles ? <p className="notice error" role="alert">{errors.roles}</p> : null}
        </fieldset>
        {message ? <p className="notice error" role="alert">{message}</p> : null}
        <div className="confirm-dialog-actions">
          <button className="ghost-button" disabled={sending} onClick={onClose} type="button">Cancel</button>
          <button className="primary-button" disabled={sending || !form.name.trim() || !form.email.trim()} type="submit">{sending ? 'Sending invite…' : 'Send invite'}</button>
        </div>
      </form>
    </div>
  );
}
