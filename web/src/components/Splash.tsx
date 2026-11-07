export function Splash({ error }: { error?: string | null }) {
  return (
    <div className="splash">
      <div className="splash__card">
        <div className="splash__mark">T</div>
        <div>Typsidian</div>
        {error ? (
          <div className="splash__error">{error}</div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="spinner" />
            <span>starting the typesetting engine…</span>
          </div>
        )}
      </div>
    </div>
  );
}
