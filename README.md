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
