# Masrofi AI V6.2

تطبيق مساعد مالي شخصي مبني بـ React + Vite + Express + Firebase + Gemini.

## التشغيل المحلي

1. ثبت الاعتمادات:

```bash
npm install
```

2. انسخ ملف البيئة:

```bash
cp .env.example .env
```

3. عدّل القيم المطلوبة في `.env`، وأهمها:

- `GEMINI_API_KEY`
- `FIREBASE_SERVICE_ACCOUNT_KEY` أو `GOOGLE_APPLICATION_CREDENTIALS`

4. شغّل التطبيق:

```bash
npm run dev
```

سيفتح الخادم على `http://localhost:3000` ويستخدم Vite middleware في وضع التطوير.

## البناء والتشغيل الإنتاجي

```bash
npm run build
npm start
```

## النشر على Render

أنشئ Web Service من المستودع، أو استخدم ملف `render.yaml` الموجود في المشروع.

الإعدادات اليدوية المقترحة:

- Runtime: `Node`
- Build Command: `npm ci && npm run build`
- Start Command: `npm start`
- Health Check Path: `/api/health`

متغيرات البيئة المطلوبة في Render:

```bash
NODE_ENV=production
GEMINI_API_KEY=...
FIREBASE_SERVICE_ACCOUNT_KEY=...
```

قيمة `FIREBASE_SERVICE_ACCOUNT_KEY` تكون JSON كامل لحساب خدمة Firebase Admin. يمكن لصق JSON كسطر واحد، أو وضعه Base64. الكود يدعم أيضاً Secret File باسم `/etc/secrets/firebase-service-account.json`.

## ملاحظات مهمة

- الخادم يستخدم `process.env.PORT` تلقائياً، وهذا مطلوب على Render.
- لا تضع مفاتيح Gemini في رابط WebSocket؛ تم تعديل الصوت الحي لإرسال المفتاح في رسالة المصادقة وليس في URL.
- لا ترفع ملف `.env` أو مفاتيح الخدمة إلى GitHub.
