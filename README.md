# site-model.

## session-handoff

[`session-handoff/`](session-handoff/) هو Mod لـ Claude Code يسلّم العمل إلى جلسة أخرى. تكتب `/handoff` فتظهر لوحة تختار منها الجلسة المستقبلة وتراجع رسالة التسليم قبل إرسالها. تتكوّن الرسالة من ستة أقسام: الهدف، وما أُنجز، والقرارات، ومسارات الملفات، والخطوة التالية، ومعيار القبول. ولا يُرسَل معها سجل المحادثة ولا أي أسرار، ويُمنع تكرارها وحلقات الرد الآلي.

التثبيت من داخل جلسة Claude Code في الطرفية:

```text
/plugin install session-handoff --marketplace sameerqaz91-beep/site-model.
```

أو من سطر الأوامر:

```bash
claude plugin install session-handoff --marketplace sameerqaz91-beep/site-model.
claude --plugin-dir ./session-handoff      # أو تشغيله لجلسة واحدة من نسخة محلية
claude plugin test ./session-handoff       # الاختبارات
```

التفاصيل، ومنها طريقة التعطيل، في [`session-handoff/README.md`](session-handoff/README.md).

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

### مخطط ثنائي الأبعاد (بدون مجسمات)

أغلب مخططات المواقع والرفع المساحي خطوط فقط بدون مجسمات. `tools/plan_to_model.py` يقرأ حدود المباني من طبقاتها، ويقفل الفتحات الصغيرة (أقل من نصف متر) ويدمج خطوط الجدار المزدوجة، وبعدها يرفع كل مبنى بارتفاع مفترض حسب نوعه: 4.5 م للمباني القائمة والمقترحة، و6 م للمظلات والمستودعات، و3 م لغرف الحراسة والكبائن. ويرسم الطرق والأسوار على الأرض، والأشجار كمجسمات صغيرة، وأرقام المباني فوقها. والعارض يكتب في اللوحة أن الارتفاعات مفترضة.

```bash
pip install ezdxf shapely
python3 tools/plan_to_model.py PLAN.dxf viewer/public/model.json "اسم الموقع" --bbox X0 Y0 X1 Y1 --floors 008=3
```

`--floors رقم=أدوار` يحدد عدد أدوار مبنى برقمه في المخطط (يتكرر لأكثر من مبنى)، والباقي دور واحد. الدور 3.5 م ومعه دروة 0.6 م. ويطلع المحوّل كمان الأسفلت والبلوكات المرصوفة والملاعب من خطوط الأرصفة، والأسوار كجدران، والشبابيك على الواجهات. وفي العارض زر "لقطة قريبة" للعرض.

`--bbox` يحدد الموقع بإحداثيات الرسم، لأن المخطط الواحد غالباً فيه أكثر من موقع ولوحات تفاصيل. أسماء الطبقات والارتفاعات في `DEFAULT_CONFIG` داخل الملف، ولرسم طبقاته مختلفة تمرّر ملف JSON بنفس الشكل عن طريق `--config`.

### الاختبارات

```bash
python3 -m unittest discover tools/tests    # المحوّلان، على رسومات تجريبية
cd viewer && npm test                       # منطق العارض
```

وفيه CI في `.github/workflows/viewer.yml` يشغّل الاختبارين ويبني العارض.

الطبقات المتوقعة في DXF ثلاثي الأبعاد (`dxf_to_model.py`): `3D-HOUSES` و`3D-PUBLIC` (polyface mesh أو MESH أو 3DFACE، مرسومة مباشرة أو داخل blocks)، و`3D-FLOOR-LINE` و`blocks` و`A-DETL` (خطوط)، وتظليل SOLID على `blocks`.

أوامر أخرى داخل `viewer/`: `npm run build` يبني نسخة للنشر في `dist/` (يشمل فحص TypeScript)، و`npm run preview` يعرض هذي النسخة على http://localhost:4173. ملف `standalone` يشتغل بدون خادم لكنه يحمّل الخط من Google Fonts، فبدون إنترنت يظهر بخط النظام.
