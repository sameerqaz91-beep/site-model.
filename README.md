# site-model.

نمذجة الموقع والفيلا ثلاثية الأبعاد.

## viewer — عارض المخطط العام ثلاثي الأبعاد

[`viewer/`](viewer/) تطبيق React + Three.js يعرض مخططاً عاماً من ملف DXF ثلاثي الأبعاد: الكتل السكنية والمباني العامة كمجسّمات، والطرق وحدود القطع والتظليل على الأرض، ورموز المباني. تضغط على أي مبنى فيظهر لك مساحته وارتفاعه، وتقدر تشغّل الطبقات وتطفيها.

فيه بعد:
- **قائمة رموز المباني العامة:** تكتب معنى كل رمز، وتضغط الرمز فتتنقل بين أماكنه. المعاني تنحفظ في متصفحك.
- **مبنى مضاف تحطه بنفسك**، مثل غرفة المضخات: تضغط مكانه في الموقع وتدوّره، ويظهر لك إحداثيه في DXF وبيانات المعدات وفحوصاتها. بياناته في `viewer/public/facility.json`، وصيغته في [`viewer/facility.example.json`](viewer/facility.example.json).

ملف DXF وبيانات النموذج المولّدة منه **ما تنحفظ في المستودع** (`viewer/public/model.json` و`viewer/public/facility.json` مستثنيان في `.gitignore`)، لأن المستودع عام.

```bash
pip install ezdxf
python3 tools/dxf_to_model.py MASTER_PLAN.dxf viewer/public/model.json "اسم المشروع"   # استخراج النموذج من DXF
cd viewer && npm install
npm run dev                                                               # تشغيل محلي
npm run standalone -- public/model.json ../site.html                      # ملف HTML واحد فيه النموذج (ومعه facility.json إن وُجد)
```

الطبقات المتوقعة في DXF: `3D-HOUSES` و`3D-PUBLIC` (polyface mesh)، و`3D-FLOOR-LINE` و`blocks` و`A-DETL` (خطوط)، وتظليل SOLID على `blocks`.
