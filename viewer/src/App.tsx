import { useCallback, useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { buildModel, type Building, type Model, type RawModel } from "./model";
import { Scene, type Focus, type Layers, type Palette, type ViewName } from "./Scene";
import { loadJson, readStore, writeStore, type FacilitySpec, type Placement } from "./data";

const LAYER_LABELS: [keyof Layers, string, string][] = [
  ["houses", "الكتل السكنية", "3D-HOUSES"],
  ["publics", "المباني العامة", "3D-PUBLIC"],
  ["floors", "خط السقف الأول", "3D-FLOOR-LINE · +3.5 م"],
  ["plan", "الطرق وحدود القطع", "blocks"],
  ["details", "تفاصيل المباني العامة", "A-DETL"],
  ["fills", "المساحات المظللة", "HATCH"],
  ["codes", "رموز المباني والأحياء", "TEXT"],
];

const STATUS_TEXT = { ok: "سليم", check: "يحتاج تأكيد", fail: "غير مطابق" } as const;

const fmt = (n: number, digits = 0) => n.toLocaleString("ar-SA-u-nu-latn", { maximumFractionDigits: digits });

// Three.js needs real colours, so read the theme tokens from CSS and re-read on theme change.
function usePalette(): Palette {
  const read = (): Palette => {
    const s = getComputedStyle(document.documentElement);
    const v = (n: string) => s.getPropertyValue(n).trim() || "#888";
    return {
      sky: v("--bg"), ground: v("--ground"), house: v("--house"), public: v("--public"),
      line: v("--plan"), detail: v("--detail"), fill: v("--fill"), edge: v("--edge"), pick: v("--pick"),
      facility: v("--facility"),
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

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function App() {
  const [model, setModel] = useState<Model | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Building | null>(null);
  const [view, setView] = useState<{ name: ViewName; seq: number }>({ name: "perspective", seq: 0 });
  const [focus, setFocus] = useState<Focus | null>(null);
  // On phones the panel starts folded so the site is visible first.
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 640);
  const [layers, setLayers] = useState<Layers>({
    houses: true, publics: true, floors: true, plan: true, details: true, fills: true, codes: true,
  });
  const [facility, setFacility] = useState<FacilitySpec | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [facilitySelected, setFacilitySelected] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [meanings, setMeanings] = useState<Record<string, string>>({});
  const [codeCursor, setCodeCursor] = useState<Record<string, number>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const palette = usePalette();

  // Per-viewer notes and placement are stored under the project's name, so two plans don't mix.
  const key = (what: string) => `site-model:${model?.name || "plan"}:${what}`;

  const load = useCallback((raw: RawModel) => {
    setModel(buildModel(raw));
    setError(null);
  }, []);

  useEffect(() => {
    loadJson<RawModel>("model-data", "./model.json").then((raw) =>
      raw ? load(raw) : setError("ما لقيت ملف model.json. ولّده من ملف DXF بالأمر الموجود تحت، أو اسحبه هنا."),
    );
    loadJson<FacilitySpec>("facility-data", "./facility.json").then(setFacility);
  }, [load]);

  useEffect(() => {
    if (!model) return;
    setMeanings(readStore(key("codes"), {}));
    setPlacement(readStore<Placement | null>(key("facility"), null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  const onFile = (f: File) =>
    f.text().then((t) => load(JSON.parse(t))).catch(() => setError("الملف ما هو بصيغة model.json الصحيحة."));

  const go = (name: ViewName) => { selectBuilding(null); setView((v) => ({ name, seq: v.seq + 1 })); };
  const flyTo = (point: THREE.Vector3, dist: number) => setFocus((f) => ({ point, dist, seq: (f?.seq ?? 0) + 1 }));

  const selectBuilding = (b: Building | null) => {
    setSelected(b);
    setFacilitySelected(false);
    if (b) flyTo(b.center, b.kind === "public" ? 260 : 160);
  };

  const savePlacement = (p: Placement | null) => {
    setPlacement(p);
    writeStore(key("facility"), p);
  };

  const onPlace = (x: number, z: number) => {
    savePlacement({ x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, rot: placement?.rot ?? 0 });
    setPlacing(false);
    setSelected(null);
    setFacilitySelected(true);
    flyTo(new THREE.Vector3(x, 0, z), 120);
  };

  const setMeaning = (code: string, text: string) => {
    const next = { ...meanings, [code]: text };
    if (!text.trim()) delete next[code];
    setMeanings(next);
    writeStore(key("codes"), next);
  };

  // Building codes with every place they appear in the drawing; district names are left out.
  const codeList = useMemo(() => {
    if (!model) return [];
    const m = new Map<string, THREE.Vector3[]>();
    for (const c of model.codes) {
      if (c.text.startsWith("DISTRICT")) continue;
      m.set(c.text, [...(m.get(c.text) ?? []), c.position]);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [model]);

  const nextOf = (code: string, places: THREE.Vector3[]) => {
    const i = (codeCursor[code] ?? -1) + 1;
    setCodeCursor({ ...codeCursor, [code]: i % places.length });
    setSelected(null);
    setFacilitySelected(false);
    flyTo(places[i % places.length], 220);
  };

  const flash = (msg: string) => { setCopied(msg); setTimeout(() => setCopied(null), 2200); };

  const dxfPoint = (x: number, z: number) =>
    model ? [model.origin[0] + x, model.origin[1] - z].map((n) => n.toFixed(2)).join(", ") : "";

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
    >
      <div className="stage">
        {model ? (
          <Scene
            model={model} layers={layers} palette={palette} view={view} focus={focus}
            selected={selected} onSelect={selectBuilding}
            facility={facility} placement={placement} facilitySelected={facilitySelected}
            onSelectFacility={() => { setSelected(null); setFacilitySelected(true); }}
            placing={placing} onPlace={onPlace}
          />
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
        {placing && (
          <div className="banner" role="status">
            اضغط على مكان في الموقع عشان تحط {facility?.name}
            <button className="btn btn-small" onClick={() => setPlacing(false)}>إلغاء</button>
          </div>
        )}
        {copied && <div className="toast" role="status">{copied}</div>}
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
              {facilitySelected && facility && placement ? (
                <FacilityDetails spec={facility} />
              ) : selected ? (
                <>
                  <p className="eyebrow">المبنى المحدد</p>
                  <h2>
                    <span className={selected.kind === "house" ? "swatch house" : "swatch public"} />
                    {selected.kind === "house" ? "كتلة سكنية" : "مبنى عام"}
                    {selected.code && <span className="code" dir="ltr">{selected.code}</span>}
                  </h2>
                  {selected.code && meanings[selected.code] && <p className="meaning">{meanings[selected.code]}</p>}
                  <dl className="facts">
                    <div><dt>مساحة البصمة</dt><dd>{fmt(selected.area)} م²</dd></div>
                    <div><dt>الارتفاع في النموذج</dt><dd>{fmt(selected.height, 1)} م</dd></div>
                    <div><dt>إحداثي DXF</dt><dd dir="ltr">{dxfPoint(selected.center.x, selected.center.z)}</dd></div>
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

            {facility && (
              <details className="section" open>
                <summary>
                  <span className="swatch facility" />
                  {facility.name}
                  <span className="summary-note">{placement ? "محطوطة" : "غير محطوطة"}</span>
                </summary>
                <div className="section-body">
                  {placement ? (
                    <>
                      <dl className="facts">
                        <div><dt>إحداثي DXF</dt><dd dir="ltr">{dxfPoint(placement.x, placement.z)}</dd></div>
                        <div><dt>الدوران</dt><dd>{fmt(placement.rot)}°</dd></div>
                      </dl>
                      <div className="row-btns">
                        <button className="btn btn-small" onClick={() => savePlacement({ ...placement, rot: (placement.rot + 345) % 360 })} aria-label="تدوير 15 درجة مع عقارب الساعة">↻ 15°</button>
                        <button className="btn btn-small" onClick={() => savePlacement({ ...placement, rot: (placement.rot + 15) % 360 })} aria-label="تدوير 15 درجة عكس عقارب الساعة">↺ 15°</button>
                        <button className="btn btn-small" onClick={() => { setFacilitySelected(true); setSelected(null); flyTo(new THREE.Vector3(placement.x, 0, placement.z), 120); }}>روح لها</button>
                      </div>
                      <div className="row-btns">
                        <button className="btn btn-small" onClick={() => setPlacing(true)}>انقلها</button>
                        <button className="btn btn-small" onClick={() => copyText(`${facility.name}: ${dxfPoint(placement.x, placement.z)} · ${placement.rot}°`).then((ok) => flash(ok ? "انسخ الإحداثي" : "ما قدرت أنسخ، انسخه من الخانة يدوياً"))}>نسخ الإحداثي</button>
                        <button className="btn btn-small btn-quiet" onClick={() => { savePlacement(null); setFacilitySelected(false); }}>شيلها</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="hint">اضغط «حطها في الموقع» ثم اضغط المكان اللي تبيه على المخطط.</p>
                      <button className="btn" onClick={() => { setPlacing(true); setSelected(null); }}>حطها في الموقع</button>
                    </>
                  )}
                </div>
              </details>
            )}

            {codeList.length > 0 && (
              <details className="section">
                <summary>رموز المباني العامة <span className="summary-note">{fmt(Object.keys(meanings).length)} من {fmt(codeList.length)} لها معنى</span></summary>
                <div className="section-body">
                  <p className="hint">اكتب معنى كل رمز. ينحفظ في متصفحك، واضغط الرمز عشان تتنقل بين أماكنه.</p>
                  <ul className="codes">
                    {codeList.map(([code, places]) => (
                      <li key={code}>
                        <button className="code-go" onClick={() => nextOf(code, places)} aria-label={`روح للرمز ${code}`}>
                          <span className="code" dir="ltr">{code}</span>
                          <span className="count">×{fmt(places.length)}</span>
                        </button>
                        <input
                          id={`meaning-${code}`}
                          type="text"
                          placeholder="المعنى…"
                          value={meanings[code] ?? ""}
                          onChange={(e) => setMeaning(code, e.target.value)}
                          aria-label={`معنى الرمز ${code}`}
                        />
                      </li>
                    ))}
                  </ul>
                  {Object.keys(meanings).length > 0 && (
                    <button className="btn btn-small" onClick={() => copyText(codeList.map(([c]) => `${c}: ${meanings[c] ?? "—"}`).join("\n")).then((ok) => flash(ok ? "انسخت قائمة الرموز" : "ما قدرت أنسخ"))}>
                      نسخ القائمة
                    </button>
                  )}
                </div>
              </details>
            )}

            <details className="section">
              <summary>الطبقات</summary>
              <fieldset className="layers section-body">
                <legend className="visually-hidden">الطبقات الظاهرة</legend>
                {LAYER_LABELS.map(([k, label, src]) => (
                  <label key={k} className="layer">
                    <input id={`layer-${k}`} type="checkbox" checked={layers[k]} onChange={(e) => setLayers((l) => ({ ...l, [k]: e.target.checked }))} />
                    <span className={`chip chip-${k}`} />
                    <span className="layer-name">{label}</span>
                    <span className="layer-src" dir="ltr">{src}</span>
                  </label>
                ))}
              </fieldset>
            </details>
          </div>
        )}
      </aside>
    </div>
  );
}

function FacilityDetails({ spec }: { spec: FacilitySpec }) {
  return (
    <>
      <p className="eyebrow">{spec.source ?? "مبنى مضاف"}</p>
      <h2><span className="swatch facility" />{spec.name}</h2>
      {spec.summary && (
        <ul className="checks">
          {spec.summary.map(([label, value, status]) => (
            <li key={label} className={`check-${status ?? "ok"}`}>
              <span className="check-label">{label}</span>
              <span className="check-value" dir="ltr">{value}</span>
              {status && <span className="pill">{STATUS_TEXT[status]}</span>}
            </li>
          ))}
        </ul>
      )}
      <dl className="facts">
        {spec.equipment.map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd dir="ltr">{value}</dd></div>
        ))}
      </dl>
      {spec.warnings?.map((w) => <p key={w} className="warning">{w}</p>)}
      {spec.sizeNote && <p className="hint">{spec.sizeNote}</p>}
    </>
  );
}
