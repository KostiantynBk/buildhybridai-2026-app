import { useEffect, useRef, useState } from 'react';
import type { Depth, ProfileRecord, ProfileType } from '../store';
import { demoProfile, exportProfile, importProfile, profileWarnings, TOPICS, validateRecord } from './profile';

type Props = {
  records: ProfileRecord[];
  save(record: ProfileRecord): Promise<void>;
  remove(id: string): Promise<void>;
  replace(records: ProfileRecord[]): Promise<void>;
  clearAll(): Promise<void>;
};
export function ProfilePanel({ records, save, remove, replace, clearAll }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [type, setType] = useState<ProfileType>('skill');
  const [depth, setDepth] = useState<Depth>('some');
  const [text, setText] = useState('');
  const [topics, setTopics] = useState<string[]>([]);
  const [tags, setTags] = useState('');
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
  const overwrite = async (next: ProfileRecord[]) => {
    if (records.length && !window.confirm('Replace the existing local profile?')) return;
    await replace(next); reset(); setError('');
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([exportProfile(records)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'thoughtpartner-profile.json';
    link.click(); URL.revokeObjectURL(url);
  };
  return (
    <section className="panel profile">
      <span className="eyebrow">Only in this browser</span>
      <h2>Builder profile</h2>
      <p>Skills, projects, lessons and preferences stay local. They are not sent to the model in this version.</p>
      {profileWarnings(records).map(warning => <p role="status" key={warning}>{warning}</p>)}
      <div className="profile-actions">
        <button onClick={download}>Export profile JSON</button>
        <label>Import profile JSON <input type="file" accept="application/json,.json" onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          const epoch = operationEpoch.current;
          if (file) void file.text().then(content => {
            if (epoch === operationEpoch.current) return overwrite(importProfile(content));
          }).catch(() => setError('Profile import failed; no records were changed.'));
        }} /></label>
        {(['A', 'B'] as const).map(which => <button key={which} onClick={() => {
          void overwrite(demoProfile(which)).catch(() => setError('Could not load demo profile.'));
        }}>Load demo {which}</button>)}
      </div>
      <p>Loading a demo or importing replaces the current profile after confirmation.</p>
      <ul className="profile-records">{records.map(record => <li key={record.id}>
        <strong>{record.type}{record.depth ? ` · ${record.depth}` : ''}</strong> — {record.text}
        <div className="muted">{[...record.topics, ...record.tags].join(', ')}</div>
        <button onClick={() => edit(record)}>Edit</button>{' '}
        <button onClick={() => {
          if (window.confirm('Delete this profile record?')) {
            void remove(record.id).catch(() => setError('Delete failed.'));
          }
        }}>Delete</button>
      </li>)}</ul>
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <h3>{editing ? 'Edit record' : 'Add a record'}</h3>
        {draftDirty && <p role="status">Unsaved profile draft.</p>}
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
        <div><button type="submit" disabled={saving}>{editing ? 'Save changes' : 'Add record'}</button>{' '}
          {editing && <button type="button" onClick={reset}>Cancel edit</button>}</div>
      </form>
      {error && <p role="alert">{error}</p>}
      <hr />
      <button onClick={() => {
        if (window.confirm('Delete all local notebook, profile, jobs and items? This cannot be undone.')) {
          operationEpoch.current++;
          void clearAll().then(() => { reset(); setError(''); })
            .catch(() => setError('Could not delete all local data.'));
        }
      }}>Delete all local data</button>
    </section>
  );
}
