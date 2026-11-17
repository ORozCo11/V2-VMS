// Shown after an invitation or password-reset email is requested. There is no password to display:
// people choose their own through the emailed link, and the server never sees or stores a shared secret.
export default function CredentialsDialog({ result, onClose }) {
  if (!result) return null;
  const reset = result.kind === 'reset';
  return (
    <div className="confirm-overlay" onClick={onClose}>
      <section aria-labelledby="credentials-title" aria-modal="true" className="confirm-dialog" onClick={(event) => event.stopPropagation()} role="dialog">
        <div className="confirm-dialog-copy">
          <p className="eyebrow">{reset ? 'Password reset' : 'Invitation'}</p>
          <h3 id="credentials-title">{result.email_sent ? (reset ? 'Reset link sent' : 'Invitation sent') : 'Email could not be sent'}</h3>
          {result.email_sent
            ? <p>{reset ? 'A password-reset link' : 'An activation link'} was handed to the mail server for <strong>{result.email}</strong>. It works once and expires in 24 hours.</p>
            : <p className="notice error" role="alert">The email to {result.email} could not be sent. The account is saved. Check the mail settings, then use Resend invitation.</p>}
        </div>
        <div className="confirm-dialog-actions">
          <button className="primary-button" onClick={onClose} type="button">Done</button>
        </div>
      </section>
    </div>
  );
}
