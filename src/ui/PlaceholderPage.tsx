export function PlaceholderPage({ page }: { page: string }) {
  return (
    <section className="panel placeholder">
      <span className="eyebrow">Coming later</span>
      <h2>{page}</h2>
      <p>This area is a placeholder; no {page.toLowerCase()} features are active yet.</p>
    </section>
  );
}
