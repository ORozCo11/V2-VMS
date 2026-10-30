import ConcernLocationFields from '../components/ConcernLocationFields';
import SearchableSelect from '../components/SearchableSelect';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import AuthHeader from '../components/AuthHeader';
import AuthFooter from '../components/AuthFooter';
import Icon from '../components/Icon';
import api from '../api/axios';

const FAQ = [
  {
    q: 'How do I get an account?',
    a: 'There is no public sign-up. Your LGU creates the Administrator account for each barangay and emails a temporary password with a sign-in link. A barangay Admin then invites the rest of the staff by email. If you should have an account but did not get an email, contact your barangay Admin or LGU.',
  },
  {
    q: 'How do I report a vehicle issue?',
    a: "As a Custodian, open Report Vehicle Issue to review issues and propose a maintenance ticket. Describe the problem and the planned repair. An Admin reviews the proposal and assigns the work. Maintenance Personnel can submit technical issue reports for a Custodian to review.",
  },
  {
    q: 'How do I add staff to my barangay?',
    a: 'As an Admin, open Users and choose Invite User. The person gets an email with a link to set their password; until they use it they show as Invited, and you can resend or cancel the invite from the same row.',
  },
  {
    q: 'How do I log completed repairs?',
    a: 'As Maintenance Personnel, open the work order from My Work Orders, record what was done and any parts used, then submit it for the Custodian to verify.',
  },
  {
    q: 'Why does a vehicle show "NOT ready to respond" or "Check stale"?',
    a: '"NOT ready" means the vehicle needs repair/is damaged, or its last readiness check failed. "Check stale" means it last passed but that check is over 24 hours old and should be re-verified before you trust it in an emergency.',
  },
  {
    q: 'What do the different vehicle statuses mean?',
    a: 'Available: available for service. Under Maintenance: currently being repaired. Inactive: temporarily out of service. Decommissioned: permanently retired.',
  },
  {
    q: "I forgot my password or can't log in — what do I do?",
    a: "There's no self-service password reset yet — contact your barangay's Admin, who can update your account. If your barangay's Admin account itself seems unreachable, use the form below to flag it."
  },
];

const CONCERN_TYPES = [
  { value: 'Barangay Inactive', label: "My barangay's account seems inactive or unmanaged" },
  { value: 'Suspected Fake Staff', label: "I don't think this person is really barangay staff" },
  { value: 'Other', label: 'Something else' },
];

function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`faq-item${open ? ' is-open' : ''}`}>
      <button type="button" className="faq-question" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>{q}</span>
        <Icon name="chevronDown" size={16} className="faq-chevron" />
      </button>
      {open && <p className="faq-answer">{a}</p>}
    </div>
  );
}

export default function Support() {
  const [form, setForm] = useState({
    concern_type: '',
    province_name: '',
    city_name: '',
    barangay_name: '',
    description: '',
    reporter_name: '',
    reporter_contact: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const location = useLocation();

  useEffect(() => {
    if (location.hash !== '#contact') return;
    // Wait a tick for layout to settle before scrolling — the target sits
    // well below the fold, past the hero.
    const id = setTimeout(() => {
      document.getElementById('contact')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
    return () => clearTimeout(id);
  }, [location.hash]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((current) => ({ ...current, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setResult(null);
    setSubmitting(true);
    try {
      const res = await api.post('/concern-reports', form);
      setResult({ type: 'success', text: res.data.message });
      setForm({ concern_type: '', province_name: '', city_name: '', barangay_name: '', description: '', reporter_name: '', reporter_contact: '' });
    } catch (error) {
      setResult({
        type: 'error',
        text: error.response?.data?.message || 'Could not submit your concern. Please try again.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page-shell">
      <AuthHeader />

      <main className="auth-hero is-compact">
        <div className="auth-hero-inner">
          <p className="auth-hero-eyebrow">Barangay VMS</p>
          <h1 className="auth-hero-title">Support Center</h1>
          <p className="auth-hero-subtitle">
            Answers to common questions, and a way to flag a real concern — like a
            barangay account that's gone unmanaged, or someone who doesn't seem to
            actually be barangay staff.
          </p>
        </div>
      </main>

      <section className="support-body">
        <div className="support-body-inner">
          <h2 className="support-section-title">Frequently Asked Questions</h2>
          <div className="faq-list">
            {FAQ.map((item) => <FaqItem key={item.q} {...item} />)}
          </div>

          <h2 className="support-section-title" id="contact">Report a Concern</h2>
          <p className="support-section-subtitle">
            Use this if a barangay's account seems dead, or you suspect someone
            isn't really barangay staff. A platform administrator reviews every
            submission.
          </p>

          <form className="auth-form auth-form-grid support-form" onSubmit={handleSubmit}>
            <label className="auth-field auth-field-full">
              <span>What's the concern?</span>
              <div className="auth-input-wrapper auth-input-plain">
                <SearchableSelect name="concern_type" value={form.concern_type} onChange={handleChange} required>
                  <option value="" disabled>Select a concern type</option>
                  {CONCERN_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </SearchableSelect>
              </div>
            </label>

            <ConcernLocationFields value={form} onChange={(patch) => setForm((current) => ({ ...current, ...patch }))} />

            <label className="auth-field auth-field-full">
              <span>Describe the concern</span>
              <div className="auth-input-wrapper auth-input-plain">
                <textarea
                  name="description"
                  value={form.description}
                  onChange={handleChange}
                  placeholder="What's happening, and why does it concern you?"
                  required
                  maxLength={2000}
                />
              </div>
            </label>

            <label className="auth-field">
              <span>Your name (optional)</span>
              <div className="auth-input-wrapper auth-input-plain">
                <input type="text" name="reporter_name" value={form.reporter_name} onChange={handleChange} maxLength={255} />
              </div>
            </label>

            <label className="auth-field">
              <span>Email or phone (optional)</span>
              <div className="auth-input-wrapper auth-input-plain">
                <input type="text" name="reporter_contact" value={form.reporter_contact} onChange={handleChange} maxLength={255} />
              </div>
            </label>

            {result && <p className={`notice ${result.type} auth-field-full`} role={result.type === 'error' ? 'alert' : 'status'}>{result.text}</p>}

            <button className="primary-button auth-submit-btn auth-field-full" type="submit" disabled={submitting}>
              {submitting ? 'Submitting…' : 'Submit Concern'}
            </button>
          </form>
        </div>
      </section>

      <AuthFooter />
    </div>
  );
}
