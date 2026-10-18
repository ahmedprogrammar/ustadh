// ============================================================
//  أستاذ بجيبك - السيرفر
//  يستقبل صورة السؤال، يرسلها للذكاء الاصطناعي (Gemini)،
//  ويرجّع الحل على طريقة الكتاب العراقي.
//  + لوحة تحكم: كلمة سر، زر إيقاف، وسجل المستخدمين.
// ============================================================

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- الإعدادات (تجي من متغيرات البيئة على السيرفر) ---
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123"; // كلمة سر لوحة التحكم

// التطبيق يشتغل بالاثنين: إذا حطيت مفتاح Gemini يستخدم Gemini (مجاني)،
// وإذا حطيت مفتاح Claude يستخدم Claude. حط واحد منهم بس.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";         // مجاني - aistudio.google.com/apikey
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || "";         // مدفوع - console.anthropic.com
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5";
const PROVIDER = CLAUDE_API_KEY ? "claude" : (GEMINI_API_KEY ? "gemini" : "none");

// --- حالة بسيطة تنحفظ بملف (تشغيل/إيقاف + سجل المستخدمين) ---
const DATA_FILE = path.join(__dirname, "data.json");
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return { enabled: true, users: {}, totalSolved: 0 }; }
}
function saveData(d) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); } catch {}
}
let data = loadData();

const app = express();
app.use(express.json({ limit: "15mb" })); // حتى يتحمل الصور
app.use(express.static(path.join(__dirname, "public")));

// ============================================================
//  تعليمات الحل (أسلوب الكتاب العراقي)
// ============================================================
function buildPrompt(subject) {
  const common = `أنت مدرس عراقي خبير للصف السادس العلمي. مهمتك تحل السؤال المصوّر على طريقة الكتاب الوزاري العراقي والملازم العراقية بالضبط.

القواعد:
1. اقرأ السؤال من الصورة بدقة. إذا الصورة مو واضحة أو مو سؤال ${subject === "physics" ? "فيزياء" : "رياضيات"}، قل بصراحة "الصورة غير واضحة" واطلب صورة أوضح.
2. حُل خطوة بخطوة، بنفس ترتيب ورموز الكتاب العراقي.
3. تحت كل خطوة، اكتب سطر قصير بـ(اللهجة العراقية) يشرح الخطوة ببساطة.
4. تحقق من الجواب بالتعويض أو بطريقة ثانية.
5. اكتب الجواب النهائي واضح وبارز.
6. استخدم رموز رياضية عادية يقراها الطالب (مثل x^2، √، ∫، π)، وما تستخدم LaTeX.`;

  const math = `\nالمادة: رياضيات. انتبه للمصطلحات العراقية: النهايات، الاشتقاق، التكامل، الأعداد المركبة، القطوع المخروطية، المعادلات التفاضلية. استخدم \\therefore و⇒ مثل الكتاب.`;
  const physics = `\nالمادة: فيزياء. أول خطوة اكتب (المعطيات) بعد تحويل الوحدات للنظام الدولي (مثل μF إلى F، mm إلى m)، بعدها القانون بالرموز، بعدها التعويض بالأرقام، وآخر شي الناتج مع وحدته. إذا السؤال نظري (علل / ما الفرق)، جاوب بنقاط مختصرة مثل الكتاب.`;

  return common + (subject === "physics" ? physics : math) +
    `\n\nرتّب جوابك بهذا الشكل:\n\n📘 السؤال:\n(اكتب السؤال مثل ما قريته)\n\n✍️ الحل:\n(الخطوات مرقمة، وتحت كل خطوة سطر "بالعراقي:")\n\n✅ الجواب النهائي:\n(الجواب واضح)\n\n🔎 تحقق:\n(التحقق)`;
}

// ============================================================
//  نقطة النهاية: حل السؤال
// ============================================================
app.post("/api/solve", async (req, res) => {
  try {
    if (!data.enabled) {
      return res.status(403).json({ error: "التجربة موقوفة حالياً. تواصل مع صاحب التطبيق." });
    }
    if (PROVIDER === "none") {
      return res.status(500).json({ error: "ماكو مفتاح مضبوط على السيرفر (GEMINI_API_KEY أو CLAUDE_API_KEY)." });
    }

    const { image, mimeType, subject, student } = req.body || {};
    if (!image) return res.status(400).json({ error: "ماكو صورة." });

    // تسجيل المستخدم
    const name = (student || "طالب").toString().slice(0, 40);
    if (!data.users[name]) data.users[name] = { count: 0, first: Date.now() };
    data.users[name].count++;
    data.users[name].last = Date.now();
    data.totalSolved++;
    saveData(data);

    const prompt = buildPrompt(subject);
    const media = mimeType || "image/jpeg";
    let answer = "";

    if (PROVIDER === "gemini") {
      // نجرب أكثر من اسم موديل لحد ما يشتغل واحد منهم
      const candidates = [GEMINI_MODEL, "gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest", "gemini-1.5-flash"]
        .filter((v, i, a) => v && a.indexOf(v) === i);
      let lastErr = "";
      for (const model of candidates) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: media, data: image } }] }],
            generationConfig: { temperature: 0.2 }
          })
        });
        if (r.ok) {
          const j = await r.json();
          answer = j?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
          break;
        }
        lastErr = `[${model}] ${r.status}: ${(await r.text()).slice(0, 300)}`;
        console.error("Gemini error:", lastErr);
      }
      if (!answer) {
        return res.status(502).json({ error: "تعذّر الحل. التفاصيل التقنية: " + lastErr });
      }
    } else {
      // Claude (Anthropic)
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: CLAUDE_MODEL, max_tokens: 2000,
          messages: [{ role: "user", content: [
            { type: "text", text: prompt },
            { type: "image", source: { type: "base64", media_type: media, data: image } }
          ] }]
        })
      });
      if (!r.ok) { console.error("Claude error:", r.status, await r.text());
        return res.status(502).json({ error: "صار خطأ بالاتصال بالذكاء الاصطناعي. جرب مرة ثانية." }); }
      const j = await r.json();
      answer = (j?.content || []).filter(p => p.type === "text").map(p => p.text).join("") || "";
    }

    if (!answer) return res.status(502).json({ error: "ما رجع حل. جرب صورة أوضح." });

    res.json({ answer });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "خطأ غير متوقع بالسيرفر." });
  }
});

// ============================================================
//  لوحة التحكم (محمية بكلمة سر)
// ============================================================
function checkAdmin(req, res) {
  const pass = req.headers["x-admin-pass"] || req.query.pass || "";
  if (pass !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "كلمة السر غلط." });
    return false;
  }
  return true;
}

app.get("/api/admin/status", (req, res) => {
  if (!checkAdmin(req, res)) return;
  const users = Object.entries(data.users)
    .map(([name, u]) => ({ name, count: u.count, last: u.last }))
    .sort((a, b) => (b.last || 0) - (a.last || 0));
  res.json({
    enabled: data.enabled,
    totalSolved: data.totalSolved,
    userCount: users.length,
    users
  });
});

app.post("/api/admin/toggle", (req, res) => {
  if (!checkAdmin(req, res)) return;
  data.enabled = !!(req.body && req.body.enabled);
  saveData(data);
  res.json({ enabled: data.enabled });
});

app.get("/healthz", (_, res) => res.send("ok"));

app.listen(PORT, () => console.log(`أستاذ بجيبك شغّال على المنفذ ${PORT} — المزود: ${PROVIDER}`));
