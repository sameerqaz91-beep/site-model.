import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { buildModel, DEFAULT_FLOOR_HEIGHT, type Building, type Model, type RawModel } from "./model";
import { Scene, type Layers, type Palette, type ViewName } from "./Scene";

// Layers other than the building groups, with whether the loaded model has anything on them.
const OTHER_LAYERS: [string, string, string, (m: Model) => boolean][] = [
  ["floors", "خط السقف الأول", "3D-FLOOR-LINE", (m) => !!m.lines.floors],
  ["plan", "الطرق وحدود القطع", "roads · plots", (m) => !!m.lines.plan],
  ["details", "الأسوار والتفاصيل", "fences · details", (m) => !!m.lines.details],
  ["fills", "المساحات المظللة", "HATCH", (m) => !!m.fills],
  ["surfaces", "الأسفلت والأرصفة والملاعب", "surfaces", (m) => Object.keys(m.surfaces).length > 0],
  ["trees", "الأشجار", "trees", (m) => m.trees.length > 0],
  ["codes", "أرقام ورموز المباني", "TEXT", (m) => m.codes.length > 0],
  ["names", "أسماء الأماكن", "TEXT", (m) => m.names.length > 0],
];

const fmt = (n: number, digits = 0) => n.toLocaleString("ar-SA-u-nu-latn", { maximumFractionDigits: digits });

// Three.js needs real colours, so read the theme tokens from CSS and re-read on theme change.
function usePalette(): Palette {
  const read = (): Palette => {
    const s = getComputedStyle(document.documentElement);
    const v = (n: string) => s.getPropertyValue(n).trim() || "#888";
    return {
      sky: v("--bg"), ground: v("--ground"), meshes: [v("--house"), v("--public"), v("--mesh3"), v("--mesh4"), v("--mesh5")],
      line: v("--plan"), detail: v("--detail"), fill: v("--fill"), edge: v("--edge"), pick: v("--pick"), tree: v("--tree"),
      asphalt: v("--asphalt"), paving: v("--paving"), grass: v("--grass"), track: v("--track"), court: v("--court"),
      wall: v("--wall"), glass: v("--glass"),
      dark: s.getPropertyValue("color-scheme").trim() === "dark",
    };
  };
  const [p, setP] = useState(read);
  useEffect(() => {
    const update = () => setP(read());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", update);
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { mq.removeEventListener("change", update); mo.disconnect(); };
  }, []);
  return p;
}

export function App() {
  const [model, setModel] = useState<Model | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Building | null>(null);
  const [view, setView] = useState<{ name: ViewName; seq: number }>({ name: "perspective", seq: 0 });
  // On phones the panel starts folded so the site is visible first.
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 640);
  const [layers, setLayers] = useState<Layers>({}); // a layer is on unless set to false
  // How much of the canvas the panel covers, so the camera can frame the site beside it.
  const panelRef = useRef<HTMLElement>(null);
  const [inset, setInset] = useState({ right: 0, bottom: 0 });
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const measure = () => {
      const phone = window.innerWidth <= 640;
      const r = el.getBoundingClientRect();
      setInset(phone ? { right: 0, bottom: Math.round(r.height) } : { right: Math.round(window.innerWidth - r.left), bottom: 0 });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  const palette = usePalette();

  const load = useCallback((raw: RawModel) => {
    setModel(buildModel(raw));
    setError(null);
  }, []);

  useEffect(() => {
    // A standalone build may carry the model inline: <script id="model-data" type="application/json">.
    const inline = document.getElementById("model-data")?.textContent;
    if (inline) { load(JSON.parse(inline)); return; }
    fetch("./model.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(load)
      .catch(() => setError("ما لقيت ملف model.json. ولّده من ملف DXF بالأمر الموجود تحت، أو اسحبه هنا."));
  }, [load]);

  const onFile = (f: File) =>
    f.text().then((t) => load(JSON.parse(t))).catch(() => setError("الملف ما هو بصيغة model.json الصحيحة."));

  const go = (name: ViewName) => { setSelected(null); setView((v) => ({ name, seq: v.seq + 1 })); };

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
    >
      <div className="stage">
        {model ? (
          <Scene model={model} layers={layers} palette={palette} selected={selected} onSelect={setSelected} view={view} inset={inset} />
        ) : (
          <div className="empty">
            {error ? (
              <>
                <p>{error}</p>
                <code dir="ltr">python3 tools/dxf_to_model.py MASTER_PLAN.dxf viewer/public/model.json</code>
                <label className="btn">
                  اختر model.json
                  <input id="file" type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
                </label>
              </>
            ) : (
              <p>يحمّل المخطط…</p>
            )}
          </div>
        )}
      </div>

      <aside ref={panelRef} className={panelOpen ? "panel" : "panel closed"}>
        <header className="panel-head">
          <div>
            <p className="eyebrow">{model?.name || "مخطط عام من ملف DXF"}</p>
            <h1>المخطط العام</h1>
          </div>
          <button className="icon-btn" onClick={() => setPanelOpen((o) => !o)} aria-expanded={panelOpen} aria-label={panelOpen ? "إخفاء اللوحة" : "إظهار اللوحة"}>
            {panelOpen ? "−" : "+"}
          </button>
        </header>

        {panelOpen && (
          <div className="panel-body">
            {model && (
              <dl className="stats">
                {model.stats.groups.map((g) => (
                  <div key={g.kind}><dt>{g.label}</dt><dd>{fmt(g.count)}</dd></div>
                ))}
                <div><dt>مسطح البناء</dt><dd>{fmt(model.stats.builtArea)}<small> م²</small></dd></div>
                <div><dt>أبعاد الموقع</dt><dd dir="ltr">{fmt(model.size[0])}×{fmt(model.size[1])}<small> m</small></dd></div>
              </dl>
            )}
            {model?.assumedHeights && (
              <p className="hint note">المخطط ثنائي الأبعاد: المباني محسوبة بعدد أدوارها (3.5 م للدور)، والمظلات والكبائن بارتفاع مفترض.</p>
            )}

            <section className="selection" aria-live="polite">
              {selected ? (
                <>
                  <p className="eyebrow">المبنى المحدد</p>
                  <h2>
                    <span className="swatch" style={{ background: palette.meshes[model?.groups.find((g) => g.kind === selected.kind)?.colorIndex ?? 0] }} />
                    {selected.label}
                    {selected.code && <span className="code" dir="ltr">{selected.code}</span>}
                  </h2>
                  <dl className="facts">
                    <div><dt>مساحة البصمة</dt><dd>{fmt(selected.area)} م²</dd></div>
                    {selected.floors > 0 && <div><dt>عدد الأدوار</dt><dd>{fmt(selected.floors)}</dd></div>}
                    <div><dt>{model?.assumedHeights && selected.floors === 0 ? "الارتفاع (مفترض)" : "الارتفاع"}</dt><dd>{fmt(selected.height, 1)} م</dd></div>
                    <div><dt>الإحداثي من المركز</dt><dd dir="ltr">{fmt(selected.center.x)}, {fmt(-selected.center.z)}</dd></div>
                  </dl>
                  {selected.code && <p className="hint">الرقم مأخوذ من أقرب نص في المخطط للمبنى.</p>}
                </>
              ) : (
                <p className="hint">اضغط على أي مبنى عشان تشوف مساحته وارتفاعه. اسحب للتحريك، وكبّر بعجلة الماوس أو بإصبعين.</p>
              )}
            </section>

            <div className="views" role="group" aria-label="زاوية العرض">
              <button className="btn" onClick={() => go("perspective")}>منظور</button>
              <button className="btn" onClick={() => go("top")}>من فوق</button>
              <button className="btn" onClick={() => go("close")}>لقطة قريبة</button>
            </div>

            <fieldset className="layers">
              <legend className="eyebrow">الطبقات</legend>
              {model && [
                ...model.groups.map((g) => [`g:${g.kind}`, g.label, g.kind, g.colorIndex] as const),
                ...OTHER_LAYERS.filter(([, , , has]) => has(model)).map(([k, label, src]) => [k, label, src, -1] as const),
              ].map(([key, label, src, colorIndex]) => (
                <label key={key} className="layer">
                  <input id={`layer-${key}`} type="checkbox" checked={layers[key] !== false} onChange={(e) => setLayers((l) => ({ ...l, [key]: e.target.checked }))} />
                  <span className={`chip chip-${key}`} style={colorIndex >= 0 ? { background: palette.meshes[colorIndex] } : undefined} />
                  <span className="layer-name">{label}</span>
                  <span className="layer-src" dir="ltr">
                    {src}
                    {key === "floors" && ` · +${fmt(model?.floorHeight ?? DEFAULT_FLOOR_HEIGHT, 1)} m`}
                  </span>
                </label>
              ))}
            </fieldset>
          </div>
        )}
      </aside>
    </div>
  );
}
