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

```bash
pip install ezdxf
python3 tools/dxf_to_model.py MASTER_PLAN.dxf viewer/public/model.json "اسم المشروع"   # استخراج النموذج من DXF
cd viewer && npm install
npm run dev                                                               # تشغيل محلي
npm run standalone -- public/model.json ../site.html                      # ملف HTML واحد فيه النموذج
```

الطبقات المتوقعة في DXF: `3D-HOUSES` و`3D-PUBLIC` (polyface mesh)، و`3D-FLOOR-LINE` و`blocks` و`A-DETL` (خطوط)، وتظليل SOLID على `blocks`.
