export function NotebookPanel({
  text,
  save,
  storageError,
}: {
  text: string;
  save: (value: string) => void;
  storageError: boolean;
}) {
  return (
    <div className="workspace">
      <section className="panel notebook">
        <div className="section-title">
          <div>
            <span className="eyebrow">Your space</span>
            <h2>Notebook</h2>
          </div>
          <span className="muted">Saved in this browser</span>
        </div>
        <p>Give your plan room to take shape.</p>
        <label htmlFor="notebook" className="sr-only">
          Your planning notebook
        </label>
        <textarea
          id="notebook"
          value={text}
          onChange={(event) => save(event.target.value)}
          placeholder="Start with the idea you are exploring…"
        />
        {storageError && <p role="alert">Could not save in this browser.</p>}
      </section>
      <aside className="panel thoughts">
        <span className="eyebrow">Alongside your work</span>
        <h2>Side thoughts</h2>
        <div className="empty">
          <div className="empty-icon">✦</div>
          <h3>A little space for perspective</h3>
          <p>Side thoughts are not available yet. This scaffold keeps your planning space ready.</p>
        </div>
      </aside>
    </div>
  );
}
