import React from 'react';

// ─── CATEGORY GROUPS ─────────────────────────────────────────────────────────
const CORE_CATS = ["Case", "CPU", "CPUCooler", "Motherboard", "RAM", "GPU", "Storage", "PSU"];

// Peripheral = external devices the user plugs into a finished build.
// Expand this set if category keys differ from the assumptions below.
const PERIPHERAL_KEYS = new Set([
  "Monitor", "Keyboard", "Mouse", "Headset", "Webcam",
  "Microphone", "MousePad", "Speaker",
]);

export function CategoryBrowse({ sel, th, CATS, CAT, P, CatThumb }) {
  const counts = Object.fromEntries(CATS.map(c => [c, P.filter(p => p.c === c).length]));

  const core        = CORE_CATS.filter(c => CATS.includes(c));
  const peripherals = CATS.filter(c => !CORE_CATS.includes(c) && PERIPHERAL_KEYS.has(c));
  const accessories = CATS.filter(c => !CORE_CATS.includes(c) && !PERIPHERAL_KEYS.has(c));

  // Sort accessories/peripherals by product count desc (high-count first)
  const bycount = (a, b) => (counts[b] || 0) - (counts[a] || 0);
  peripherals.sort(bycount);
  accessories.sort(bycount);

  function Section({ title, cats, variant }) {
    const cols       = variant === 'core' ? 4 : variant === 'peripherals' ? 5 : 6;
    const thumbSize  = variant === 'core' ? 88 : variant === 'peripherals' ? 60 : 44;
    const padding    = variant === 'core' ? 20 : variant === 'peripherals' ? 14 : 10;
    const labelSize  = variant === 'core' ? 13 : 11;
    const showDesc   = variant !== 'accessories';

    return (
      <div style={{ marginBottom: 36 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 14 }}>
          <h3 style={{
            fontFamily: "var(--ff)",
            fontSize: variant === 'core' ? 15 : 13,
            fontWeight: 700,
            color: "var(--txt)",
            margin: 0,
            letterSpacing: -0.2,
          }}>
            {title}
          </h3>
          <div style={{ flex: 1, height: 1, background: "var(--bdr)" }} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--mute)" }}>
            {cats.length}
          </span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols},1fr)`, gap: 8 }}>
          {cats.map(c => {
            const meta = CAT[c] || {};
            const count = counts[c] || 0;
            const empty = count === 0;
            const lowCount = !empty && count <= 2;

            return (
              <button
                key={c}
                onClick={empty ? undefined : () => sel(c)}
                style={{
                  background: "var(--bg3)",
                  border: "1px solid var(--bdr)",
                  borderRadius: 10,
                  padding,
                  cursor: empty ? "default" : "pointer",
                  textAlign: "center",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 6,
                  position: "relative",
                  opacity: empty ? 0.45 : lowCount ? 0.7 : 1,
                  transition: "transform 0.15s",
                }}
                onMouseEnter={e => { if (!empty) e.currentTarget.style.transform = 'translateY(-2px)'; }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; }}
              >
                {empty && (
                  <div style={{
                    position: "absolute",
                    top: 6,
                    right: 6,
                    background: "var(--accent3)",
                    color: "var(--accent)",
                    fontFamily: "var(--mono)",
                    fontSize: 8,
                    padding: "2px 6px",
                    borderRadius: 4,
                    fontWeight: 700,
                    letterSpacing: 0.5,
                    zIndex: 1,
                  }}>
                    COMING SOON
                  </div>
                )}
                <CatThumb
                  cat={c}
                  thumbs={th.thumbs}
                  setThumb={th.setThumb}
                  removeThumb={th.removeThumb}
                  size={thumbSize}
                  rounded={10}
                  editable={false}
                />
                <div style={{
                  fontFamily: "var(--ff)",
                  fontSize: labelSize,
                  fontWeight: 600,
                  color: "var(--txt)",
                  lineHeight: 1.2,
                }}>
                  {meta.label || c}
                </div>
                {showDesc && (meta.description || meta.desc || meta.subtitle) && (
                  <div style={{
                    fontFamily: "var(--ff)",
                    fontSize: 10,
                    color: "var(--dim)",
                    lineHeight: 1.3,
                  }}>
                    {meta.description || meta.desc || meta.subtitle}
                  </div>
                )}
                <div style={{
                  fontFamily: "var(--mono)",
                  fontSize: 9,
                  color: empty ? "var(--accent)" : "var(--mute)",
                  fontWeight: empty ? 600 : 400,
                  marginTop: 2,
                }}>
                  {empty ? "Not yet available" : `${count} product${count !== 1 ? 's' : ''}`}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="fade" style={{ maxWidth: 1200, margin: "0 auto", padding: "36px 20px" }}>
      <div style={{ textAlign: "center", marginBottom: 36 }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--mint)", letterSpacing: 3 }}>
          BROWSE COMPONENTS
        </div>
        <h2 style={{
          fontFamily: "var(--ff)",
          fontSize: 28,
          fontWeight: 800,
          color: "var(--txt)",
          marginTop: 6,
          letterSpacing: -0.5,
        }}>
          What are you looking for?
        </h2>
        <p style={{ fontFamily: "var(--ff)", fontSize: 11, color: "var(--dim)", marginTop: 4 }}>
          📷 Hover any thumbnail to upload a custom image
        </p>
      </div>
      <Section title="Core Components" cats={core} variant="core" />
      {peripherals.length > 0 && <Section title="Peripherals" cats={peripherals} variant="peripherals" />}
      {accessories.length > 0 && <Section title="Accessories & Extras" cats={accessories} variant="accessories" />}
    </div>
  );
}
