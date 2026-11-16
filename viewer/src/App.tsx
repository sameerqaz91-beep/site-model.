import { useCallback, useEffect, useState } from "react";
import { buildModel, type Building, type Model, type RawModel } from "./model";
import { Scene, type Layers, type Palette, type ViewName } from "./Scene";

const LAYER_LABELS: [keyof Layers, string, string][] = [
  ["houses", "الكتل السكنية", "3D-HOUSES"],
  ["publics", "المباني العامة", "3D-PUBLIC"],
  ["floors", "خط السقف الأول", "3D-FLOOR-LINE · +3.5 م"],
  ["plan", "الطرق وحدود القطع", "blocks"],
  ["details", "تفاصيل المباني العامة", "A-DETL"],
  ["fills", "المساحات المظللة", "HATCH"],
  ["codes", "رموز المباني والأحياء", "TEXT"],
];

const fmt = (n: number, digits = 0) => n.toLocaleString("ar-SA-u-nu-latn", { maximumFractionDigits: digits });

// Three.js needs real colours, so read the theme tokens from CSS and re-read on theme change.
function usePalette(): Palette {
  const read = (): Palette => {
    const s = getComputedStyle(document.documentElement);
    const v = (n: string) => s.getPropertyValue(n).trim() || "#888";
    return {
      sky: v("--bg"), ground: v("--ground"), house: v("--house"), public: v("--public"),
      line: v("--plan"), detail: v("--detail"), fill: v("--fill"), edge: v("--edge"), pick: v("--pick"),
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
  const [layers, setLayers] = useState<Layers>({
    houses: true, publics: true, floors: true, plan: true, details: true, fills: true, codes: true,
  });
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
          <Scene model={model} layers={layers} palette={palette} selected={selected} onSelect={setSelected} view={view} />
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

      <aside className={panelOpen ? "panel" : "panel closed"}>
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
                <div><dt>كتل سكنية</dt><dd>{fmt(model.stats.houses)}</dd></div>
                <div><dt>مبانٍ عامة</dt><dd>{fmt(model.stats.publics)}</dd></div>
                <div><dt>مسطح الكتل السكنية</dt><dd>{fmt(model.stats.houseArea / 10000, 1)}<small> هكتار</small></dd></div>
                <div><dt>أبعاد الموقع</dt><dd dir="ltr">{fmt(model.size[0])}×{fmt(model.size[1])}<small> m</small></dd></div>
              </dl>
            )}

            <section className="selection" aria-live="polite">
              {selected ? (
                <>
                  <p className="eyebrow">المبنى المحدد</p>
                  <h2>
                    <span className={selected.kind === "house" ? "swatch house" : "swatch public"} />
                    {selected.kind === "house" ? "كتلة سكنية" : "مبنى عام"}
                    {selected.code && <span className="code" dir="ltr">{selected.code}</span>}
                  </h2>
                  <dl className="facts">
                    <div><dt>مساحة البصمة</dt><dd>{fmt(selected.area)} م²</dd></div>
                    <div><dt>الارتفاع في النموذج</dt><dd>{fmt(selected.height, 1)} م</dd></div>
                    <div><dt>الإحداثي من المركز</dt><dd dir="ltr">{fmt(selected.center.x)}, {fmt(-selected.center.z)}</dd></div>
                  </dl>
                  {selected.code && <p className="hint">الرمز مأخوذ من أقرب نص في المخطط للمبنى.</p>}
                </>
              ) : (
                <p className="hint">اضغط على أي مبنى عشان تشوف مساحته وارتفاعه. اسحب للتحريك، وكبّر بعجلة الماوس أو بإصبعين.</p>
              )}
            </section>

            <div className="views" role="group" aria-label="زاوية العرض">
              <button className="btn" onClick={() => go("perspective")}>منظور</button>
              <button className="btn" onClick={() => go("top")}>من فوق</button>
            </div>

            <fieldset className="layers">
              <legend className="eyebrow">الطبقات</legend>
              {LAYER_LABELS.map(([key, label, src]) => (
                <label key={key} className="layer">
                  <input id={`layer-${key}`} type="checkbox" checked={layers[key]} onChange={(e) => setLayers((l) => ({ ...l, [key]: e.target.checked }))} />
                  <span className={`chip chip-${key}`} />
                  <span className="layer-name">{label}</span>
                  <span className="layer-src" dir="ltr">{src}</span>
                </label>
              ))}
            </fieldset>
          </div>
        )}
      </aside>
    </div>
  );
}
