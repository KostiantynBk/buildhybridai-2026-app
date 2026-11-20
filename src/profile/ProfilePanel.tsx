import { useEffect, useRef, useState } from 'react';
import type { Depth, ProfileRecord, ProfileType } from '../store';
import { demoNeverSend, demoProfile, exportProfile, importProfileBundle, profileWarnings, TOPICS, validateRecord }
  from './profile';
import { validateNeverSend } from '../privacy/terms';

type Props = {
  records: ProfileRecord[];
  save(record: ProfileRecord): Promise<void>;
  remove(id: string): Promise<void>;
  replace(records: ProfileRecord[], neverSend: string[]): Promise<void>;
  neverSend?: string[];
  saveNeverSend?(terms: string[]): Promise<void>;
  clearAll(): Promise<void>;
  cloudConsent?: boolean;
  revokeCloudConsent?(): Promise<void>;
  cloudMode?: boolean;
  revokeCloudMode?(): Promise<void>;
};
export function ProfilePanel({ records, save, remove, replace, neverSend = [], saveNeverSend, clearAll,
  cloudConsent, revokeCloudConsent, cloudMode, revokeCloudMode }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [type, setType] = useState<ProfileType>('skill');
  const [depth, setDepth] = useState<Depth>('some');
  const [text, setText] = useState('');
  const [topics, setTopics] = useState<string[]>([]);
  const [tags, setTags] = useState('');
  const [term, setTerm] = useState('');
  const [error, setError] = useState('');
  const [draftDirty, setDraftDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const draftGeneration = useRef(0);
  const savingRef = useRef(false);
  const operationEpoch = useRef(0);
  useEffect(() => () => { operationEpoch.current++; }, []);
  const changed = () => { draftGeneration.current++; setDraftDirty(true); };
  const reset = () => {
    draftGeneration.current++; setDraftDirty(false);
    setEditing(null); setType('skill'); setDepth('some'); setText(''); setTopics([]); setTags('');
  };
  const edit = (record: ProfileRecord) => {
    changed();
    setEditing(record.id); setType(record.type); setDepth(record.depth ?? 'some'); setText(record.text);
    setTopics(record.topics); setTags(record.tags.join(', ')); setError('');
  };
  const submit = async () => {
    if (savingRef.current) return;
    const generation = draftGeneration.current;
    savingRef.current = true; setSaving(true);
    try {
      const record = validateRecord({ id: editing ?? crypto.randomUUID(), type, text, topics,
        tags: tags.split(','), ...(type === 'skill' ? { depth } : {}), updatedAt: Date.now() });
      await save(record);
      if (generation === draftGeneration.current) { reset(); setError(''); }
    } catch {
      setError(generation === draftGeneration.current
        ? 'Could not save. Check the text, topic choices and maximum of five tags.'
        : 'The earlier save failed. Your current draft has not been saved.');
    } finally {
      savingRef.current = false; setSaving(false);
    }
  };
  const overwrite = async (next: ProfileRecord[], terms: string[]) => {
    if ((records.length || neverSend.length) && !window.confirm('Replace the existing local profile and terms?')) {
      return;
    }
    await replace(next, terms); reset(); setTerm(''); setError('');
  };
  const updateTerms = async (terms: string[]) => {
    if (!saveNeverSend) throw new Error('Local privacy settings unavailable.');
    await saveNeverSend(validateNeverSend(terms));
    setTerm(''); setError('');
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([exportProfile(records, neverSend)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'thoughtpartner-profile.json';
    link.click(); URL.revokeObjectURL(url);
  };
  return (
    <section className="panel profile">
      <span className="eyebrow">Only in this browser</span>
      <h2>Builder profile</h2>
      <p>Skills, projects, lessons and preferences stay local. Selected records may be read by the on-device
        why-note model only. They are never put in the public question or any cloud prompt, and they stay on
        this device.</p>
      {revokeCloudMode && <section><h3>Cloud mode for plan processing</h3>
        <p>{cloudMode ? 'On: plan processing uses the cloud.' : 'Off: strict on-device mode.'}</p>
        {cloudMode && <button onClick={() => { void revokeCloudMode().catch(() =>
          setError('Could not revoke cloud mode.')); }}>Switch off cloud mode</button>}</section>}
      {revokeCloudConsent && <section><h3>Cloud research consent</h3>
        <p>{cloudConsent ? 'Approved for this browser.' : 'Not approved.'}</p>
        {cloudConsent && <button onClick={() => { void revokeCloudConsent().catch(() =>
          setError('Could not revoke cloud research consent.')); }}>Revoke consent</button>}</section>}
      {profileWarnings(records).map(warning => <p role="status" key={warning}>{warning}</p>)}
      <div className="profile-actions">
        <button onClick={download}>Export profile JSON</button>
        <label>Import profile JSON <input type="file" accept="application/json,.json" onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          const epoch = operationEpoch.current;
          if (file) void file.text().then(content => {
            if (epoch === operationEpoch.current) {
              const bundle = importProfileBundle(content);
              return overwrite(bundle.records, bundle.neverSend);
            }
          }).catch(() => setError('Profile import failed; no records were changed.'));
        }} /></label>
        {(['A', 'B'] as const).map(which => <button key={which} onClick={() => {
          void overwrite(demoProfile(which), demoNeverSend(which))
            .catch(() => setError('Could not load demo profile.'));
        }}>Load demo {which}</button>)}
      </div>
      <p>Loading a demo or importing replaces the current profile and terms after confirmation.
        Profile exports include your private never-send list.</p>
      <section aria-labelledby="never-send-title">
        <h3 id="never-send-title">Never send</h3>
        <p>Names inside your profile text aren't detected automatically — add them here.</p>
        <label>Private name or term <input value={term} onChange={event => setTerm(event.target.value)} />
        </label>{' '}
        <button type="button" onClick={() => {
          void updateTerms([...neverSend, term]).catch(() =>
            setError('Cannot save: use at most 200 terms and 100 characters per term.'));
        }}>Add term</button>
        {(term.trim().length > 0 && term.trim().length < 4 || neverSend.some(value => value.length < 4)) &&
          <p role="status">Short terms may hold back many questions.</p>}
        <ul>{neverSend.map(value => <li key={value}>{value}{' '}
          <button type="button" onClick={() => {
            if (window.confirm('Remove this privacy term? Future questions may contain it.')) {
              void updateTerms(neverSend.filter(existing => existing !== value))
                .catch(() => setError('Could not remove the privacy term.'));
            }
          }}>Remove</button>
        </li>)}</ul>
      </section>
      <ul className="profile-records">{records.map(record => <li key={record.id}>
        <strong>{record.type}{record.depth ? ` · ${record.depth}` : ''}</strong> — {record.text}
        <div className="muted">{[...record.topics, ...record.tags].join(', ')}</div>
        <button onClick={() => edit(record)}>Edit</button>
        <button onClick={() => {
          if (window.confirm('Delete this profile record?')) {
            void remove(record.id).catch(() => setError('Delete failed.'));
          }
        }}>Delete</button>
      </li>)}</ul>
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <h3>{editing ? 'Edit record' : 'Add a record'}</h3>
        {draftDirty && <p role="status">Unsaved profile draft.</p>}
        {saving && <p id="profile-saving" role="status">Saving the previous profile record.</p>}
        <label>Type <select value={type} onChange={event => { changed(); setType(event.target.value as ProfileType); }}>
          {(['skill', 'project', 'lesson', 'preference'] as const).map(value => <option key={value}>{value}</option>)}
        </select></label>
        {type === 'skill' && <label>Depth <select value={depth}
          onChange={event => { changed(); setDepth(event.target.value as Depth); }}>
          {(['new', 'some', 'deep'] as const).map(value => <option key={value}>{value}</option>)}
        </select></label>}
        <label>Text <textarea className="profile-text" value={text}
          onChange={event => { changed(); setText(event.target.value); }} />
        </label>
        <fieldset><legend>Topics</legend><div className="topic-grid">{TOPICS.map(topic => <label key={topic}>
          <input type="checkbox" checked={topics.includes(topic)} onChange={event => {
            changed(); setTopics(event.target.checked ? [...topics, topic] : topics.filter(value => value !== topic));
          }} /> {topic}
        </label>)}</div></fieldset>
        <label>Tags (up to five, comma-separated) <input value={tags}
          onChange={event => { changed(); setTags(event.target.value); }} />
        </label>
        <div><button type="submit" disabled={saving} aria-describedby={saving ? 'profile-saving' : undefined}>
          {editing ? 'Save changes' : 'Add record'}</button>
          {editing && <button type="button" onClick={reset}>Cancel edit</button>}</div>
      </form>
      {error && <p role="alert">{error}</p>}
      <hr />
      <button onClick={() => {
        if (window.confirm('Delete all local notebook, profile, jobs and items? This cannot be undone.')) {
          operationEpoch.current++;
          void clearAll().then(() => { reset(); setTerm(''); setError(''); })
            .catch(() => setError('Could not delete all local data.'));
        }
      }}>Delete all local data</button>
    </section>
  );
}
