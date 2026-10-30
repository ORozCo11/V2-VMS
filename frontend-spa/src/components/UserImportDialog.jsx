import { useState } from 'react';
import api from '../api/axios';
import Icon from './Icon';

// Matches UserImportController::MAX_BYTES / MAX_ROWS on the backend.
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 500;

const download = async (path, fileName) => {
  const { data } = await api.get(path, { responseType: 'blob' });
  const url = URL.createObjectURL(data);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
};

const errorMessage = (error, action) => {
  const data = error.response?.data;
  return data?.errors?.file?.[0] ?? data?.message ?? `Could not ${action} because the server could not be reached. Check your connection and try again.`;
};

// Batch upload of staff: download the template, upload it, review the
// row-by-row preview, then confirm to email every valid person an invite.
export default function UserImportDialog({ onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const chooseFile = (event) => {
    const picked = event.target.files?.[0] ?? null;
    setPreview(null);
    setError('');
    if (picked && !/\.(xlsx|csv)$/i.test(picked.name)) {
      setFile(null);
      setError(`"${picked.name}" is not a spreadsheet. Only .xlsx or .csv files can be imported.`);
      return;
    }
    if (picked && picked.size > MAX_BYTES) {
      setFile(null);
      setError(`"${picked.name}" is ${(picked.size / 1024 / 1024).toFixed(1)} MB. The file must be 2 MB or smaller.`);
      return;
    }
    setFile(picked);
  };

  const runPreview = async () => {
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      const { data } = await api.post('/user-imports', form);
      setPreview(data);
    } catch (requestError) {
      setError(errorMessage(requestError, 'check the file'));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post(`/user-imports/${preview.id}/commit`);
      setResult(data);
      await onImported(`${data.imported_rows} invite${data.imported_rows === 1 ? '' : 's'} sent${data.failed_rows ? `, ${data.failed_rows} row${data.failed_rows === 1 ? '' : 's'} skipped` : ''}.`);
    } catch (requestError) {
      setError(errorMessage(requestError, 'send the invites'));
    } finally {
      setBusy(false);
    }
  };

  const shown = result ?? preview;
  const errors = (shown?.findings ?? []).filter((finding) => finding.level === 'error');

  return (
    <div className="confirm-overlay">
      <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="user-import-title" style={{ maxWidth: 640 }}>
        <div className="confirm-dialog-icon" aria-hidden="true"><Icon name="users" size={22} /></div>
        <div className="confirm-dialog-copy">
          <h3 id="user-import-title">Upload users</h3>
          <p>Add many people at once. Each valid row gets an email invite to set their password.</p>
        </div>

        {!result && (
          <>
            <p>
              1. Download the template:{' '}
              <button type="button" className="link-button" onClick={() => download('/user-imports/template?format=xlsx', 'user-import-template.xlsx').catch((e) => setError(errorMessage(e, 'download the template')))}>Excel (.xlsx)</button>
              {' · '}
              <button type="button" className="link-button" onClick={() => download('/user-imports/template?format=csv', 'user-import-template.csv').catch((e) => setError(errorMessage(e, 'download the template')))}>CSV</button>
            </p>
            <label className="auth-field">
              <span>2. Choose your filled-in file</span>
              <input type="file" accept=".xlsx,.csv" onChange={chooseFile} />
              <small className="muted">Excel (.xlsx) or CSV · up to 2 MB · up to {MAX_ROWS} people per file</small>
            </label>
          </>
        )}

        {shown && (
          <div className="notice" role="status">
            {result
              ? <strong>{result.imported_rows} invited, {result.failed_rows} skipped of {result.total_rows} rows.</strong>
              : <strong>{preview.valid_rows} of {preview.total_rows} rows are ready to invite. {preview.error_rows ? `${preview.error_rows} row${preview.error_rows === 1 ? ' has' : 's have'} problems and will be skipped.` : ''}</strong>}
          </div>
        )}

        {errors.length > 0 && (
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            <table>
              <thead><tr><th>Row</th><th>Column</th><th>Problem</th></tr></thead>
              <tbody>
                {errors.map((finding) => (
                  <tr key={`${finding.row}-${finding.field}-${finding.message}`}><td>{finding.row}</td><td>{finding.field}</td><td>{finding.message}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {error ? <p className="notice error" role="alert">{error}</p> : null}

        <div className="confirm-dialog-actions">
          {shown && errors.length > 0 && (
            <button type="button" className="ghost-button" onClick={() => download(`/user-imports/${shown.id}/errors`, `user-import-${shown.id}-report.csv`).catch((e) => setError(errorMessage(e, 'download the report')))}>Download problem list</button>
          )}
          <button type="button" className="ghost-button" disabled={busy} onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
          {!result && !preview && <button type="button" className="primary-button" disabled={busy || !file} onClick={runPreview}>{busy ? 'Checking file…' : 'Check file'}</button>}
          {!result && preview && <button type="button" className="primary-button" disabled={busy || !preview.valid_rows} onClick={commit}>{busy ? 'Sending invites…' : `Invite ${preview.valid_rows} ${preview.valid_rows === 1 ? 'person' : 'people'}`}</button>}
        </div>
      </div>
    </div>
  );
}
