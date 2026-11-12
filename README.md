# site-model.

## session-handoff

[`session-handoff/`](session-handoff/) هو Mod لـ Claude Code يسلّم العمل إلى جلسة أخرى. تكتب `/handoff` فتظهر لوحة تختار منها الجلسة المستقبلة وتراجع رسالة التسليم قبل إرسالها. تتكوّن الرسالة من ستة أقسام: الهدف، وما أُنجز، والقرارات، ومسارات الملفات، والخطوة التالية، ومعيار القبول. ولا يُرسَل معها سجل المحادثة ولا أي أسرار، ويُمنع تكرارها وحلقات الرد الآلي.

```bash
claude --plugin-dir ./session-handoff      # تشغيله لجلسة واحدة
claude plugin test ./session-handoff       # الاختبارات
```

التفاصيل، ومنها طريقة التعطيل، في [`session-handoff/README.md`](session-handoff/README.md).
