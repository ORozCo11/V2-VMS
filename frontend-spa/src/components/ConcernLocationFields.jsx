import { useEffect, useId, useState } from 'react';
import api from '../api/axios';

const matchingId = (rows, text) => rows.find((row) => row.name.trim().toLowerCase() === (text ?? '').trim().toLowerCase())?.id;

export default function ConcernLocationFields({ value, onChange }) {
  const id = useId();
  const [provinces, setProvinces] = useState([]);
  const [cityResult, setCityResult] = useState({ parent: null, rows: [] });
  const [barangayResult, setBarangayResult] = useState({ parent: null, rows: [] });
  const [lookupFailed, setLookupFailed] = useState(false);
  const provinceId = matchingId(provinces, value.province_name);
  const cities = cityResult.parent === provinceId ? cityResult.rows : [];
  const cityId = matchingId(cities, value.city_name);
  const barangays = barangayResult.parent === cityId ? barangayResult.rows : [];
  useEffect(() => {
    let current = true;
    api.get('/provinces').then(({ data }) => { if (current) setProvinces(data); })
      .catch(() => { if (current) setLookupFailed(true); });
    return () => { current = false; };
  }, []);
  useEffect(() => {
    if (!provinceId) return;
    let current = true;
    api.get('/cities', { params: { province_id: provinceId } })
      .then(({ data }) => { if (current) setCityResult({ parent: provinceId, rows: data }); })
      .catch(() => { if (current) setLookupFailed(true); });
    return () => { current = false; };
  }, [provinceId]);
  useEffect(() => {
    if (!cityId) return;
    let current = true;
    api.get('/barangays', { params: { city_id: cityId } })
      .then(({ data }) => { if (current) setBarangayResult({ parent: cityId, rows: data }); })
      .catch(() => { if (current) setLookupFailed(true); });
    return () => { current = false; };
  }, [cityId]);
  return <>
    {[
      { key: 'province_name', label: 'Province', rows: provinces, clear: { city_name: '', barangay_name: '' }, waitFor: null },
      { key: 'city_name', label: 'City / Municipality', rows: cities, clear: { barangay_name: '' }, waitFor: provinceId ? null : 'province' },
      { key: 'barangay_name', label: 'Barangay', rows: barangays, clear: {}, waitFor: cityId ? null : 'city / municipality' },
    ].map(({ key, label, rows, clear, waitFor }) => <label className={`auth-field${key === 'barangay_name' ? ' auth-field-full' : ''}`} key={key}>
      <span>{label}</span>
      <div className="auth-input-wrapper auth-input-plain">
        {lookupFailed
          ? <input name={key} value={value[key] ?? ''} maxLength={255} autoComplete="off" placeholder={`Type ${label.toLowerCase()}`} onChange={(event) => onChange({ ...clear, [key]: event.target.value })} />
          : <select id={`${id}-${key}`} name={key} className="concern-location-select" value={value[key] ?? ''} disabled={Boolean(waitFor)} onChange={(event) => onChange({ ...clear, [key]: event.target.value })}>
            <option value="">{waitFor ? `Select a ${waitFor} first` : `Select ${label.toLowerCase()}`}</option>
            {rows.map((row) => <option key={row.id} value={row.name}>{row.name}</option>)}
          </select>}
      </div>
    </label>)}
    <p className="auth-field-full muted">Location is optional.{lookupFailed ? ' The location list is unavailable, so please type it instead.' : ''}</p>
  </>;
}
