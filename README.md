# site-model.

نمذجة الموقع والفيلا ثلاثية الأبعاد. المستودع فيه ثلاثة أجزاء:

| المجلد | المحتوى |
|---|---|
| [`viewer/`](viewer/) و[`tools/`](tools/) | عارض ويب للمخطط العام (React + Three.js) وأدوات تحويل DXF |
| [`revit/`](revit/) | سكربت Dynamo يبني نموذج فيلا داخل Revit من `GPS.dwg` |
| [`concepts/villa-perspective/`](concepts/villa-perspective/) | صفحة HTML واحدة فيها منظور ثلاثي الأبعاد لفيلا فاخرة، تفتحها مباشرة في المتصفح |

## viewer — عارض المخطط العام ثلاثي الأبعاد

[`viewer/`](viewer/) تطبيق React + Three.js يعرض مخططاً عاماً من ملف DXF ثلاثي الأبعاد: الكتل السكنية والمباني العامة كمجسّمات، والطرق وحدود القطع والتظليل على الأرض، ورموز المباني. تضغط على أي مبنى فيظهر لك مساحته وارتفاعه، وتقدر تشغّل الطبقات وتطفيها.

ملف DXF وبيانات النموذج المولّدة منه **ما تنحفظ في المستودع** (`viewer/public/model.json` مستثنى في `.gitignore`)، لأن المستودع عام.

المتطلبات: Node.js 18 أو أحدث (جُرّب على 22)، وPython 3.9 أو أحدث مع `ezdxf` (جُرّب على 1.4.5).

### تجربة سريعة بملف تجريبي

ما عندك ملف DXF؟ `tools/make_sample_dxf.py` يولّد مخططاً وهمياً صغيراً فيه نفس الطبقات (41 كتلة سكنية، و3 مبانٍ عامة برموز MOSQ وSCH وCLN، وطرق، وحديقة مظللة):

```bash
pip install ezdxf
python3 tools/make_sample_dxf.py /tmp/sample.dxf
python3 tools/dxf_to_model.py /tmp/sample.dxf viewer/public/model.json "Sample site"
cd viewer && npm ci && npm run dev      # افتح http://localhost:5173
```

### مع ملف المشروع الحقيقي

```bash
pip install ezdxf
python3 tools/dxf_to_model.py MASTER_PLAN.dxf viewer/public/model.json "اسم المشروع"   # استخراج النموذج من DXF
cd viewer && npm ci
npm run dev                                                               # تشغيل محلي
npm run standalone -- public/model.json ../site.html                      # ملف HTML واحد فيه النموذج
```

الطبقات المتوقعة في DXF: `3D-HOUSES` و`3D-PUBLIC` (polyface mesh)، و`3D-FLOOR-LINE` و`blocks` و`A-DETL` (خطوط)، وتظليل SOLID على `blocks`.

أوامر أخرى داخل `viewer/`: `npm run build` يبني نسخة للنشر في `dist/` (يشمل فحص TypeScript)، و`npm run preview` يعرض هذي النسخة على http://localhost:4173. ملف `standalone` يشتغل بدون خادم لكنه يحمّل الخط من Google Fonts، فبدون إنترنت يظهر بخط النظام.

## revit

[`revit/villa_from_gps.py`](revit/villa_from_gps.py) سكربت Python لعقدة Dynamo داخل Revit، يبني نموذج فيلا مبدئياً (مستويات، شبكات، جدران، بلاطات، أبواب ونوافذ، مناظير، ولوحة) ويربط ملف الموقع `GPS.dwg`. خطوات التشغيل وحل المشاكل في [`revit/README.md`](revit/README.md).

## concepts

[`concepts/villa-perspective/index.html`](concepts/villa-perspective/index.html) منظور تفاعلي لفيلا حديثة. ما يحتاج تثبيت: افتح الملف في المتصفح.
