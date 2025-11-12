// index.js (final)
import 'dotenv/config';
import express from "express";
import bodyParser from "body-parser";
import { Telegraf } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";

const PORT = process.env.PORT || 10000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const NODE_ENV = process.env.NODE_ENV || "development";

if (!TELEGRAM_BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Required env vars missing (TELEGRAM_BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY).");
  process.exit(1);
}

const app = express();
app.use(bodyParser.json());

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.get("/", (req, res) => res.status(200).send("✅ Atenza Telegram Sync is live!"));

// Superscript map
const superscriptMap = { '⁰': 0, '¹': 1, '²': 2, '³': 3 };

const normalizeSession = (s) => {
  if (!s) return "Unknown";
  const t = s.toLowerCase();
  if (t.includes("overnight")) return "Overnight";
  if (t.includes("morning")) return "Morning";
  if (t.includes("afternoon")) return "Afternoon";
  if (t.includes("night")) return "Night";
  return s;
};

function parseDailyReport(text) {
  if (!/DAILY REPORT|DIALY REPORT/i.test(text)) return null;

  // date
  const dateMatch = text.match(/🗓\s*(.+)/);
  let reportDateISO = null;
  if (dateMatch) {
    const raw = dateMatch[1].trim().replace(/[#].*$/, "").trim();
    const dt1 = DateTime.fromFormat(raw, "cccc, LLLL d'th', yyyy", { zone: "Africa/Nairobi" });
    const dt2 = DateTime.fromFormat(raw, "cccc, LLLL d, yyyy", { zone: "Africa/Nairobi" });
    if (dt1.isValid) reportDateISO = dt1.toISODate();
    else if (dt2.isValid) reportDateISO = dt2.toISODate();
  }
  if (!reportDateISO) reportDateISO = DateTime.now().setZone("Africa/Nairobi").toISODate();

  const lines = text.split("\n");
  const headerRegex = /(Overnight|Morning|Afternoon|Night)\s+Session/i;
  const headers = [];
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(headerRegex);
    if (h) headers.push({ name: h[1], idx: i });
  }
  headers.push({ name: "END", idx: lines.length });

  const trades = [];
  for (let i = 0; i < headers.length - 1; i++) {
    const header = headers[i];
    const blockLines = lines.slice(header.idx + 1, headers[i + 1].idx);
    const sessionName = normalizeSession(header.name);

    for (const rawLine of blockLines) {
      const line = rawLine.trim();
      if (!line) continue;

      // leading emoji -> win/loss
      const emoji = line[0];
      const isWin = emoji === "✅";
      const isLoss = emoji === "❌";
      const resultText = isWin ? "Win" : (isLoss ? "Loss" : "Unknown");

      // extract time, pair, action and superscript
      const match = line.match(/^[✅❌]([⁰¹²³])?\s*([\d]{2}:[\d]{2}).*?([A-Z]{3}\/[A-Z]{3}).*?•\s*(Buy|Sell)/i);
      if (!match) continue;

      const supChar = match[1] || '⁰';
      const time = match[2];
      const pair = match[3].toUpperCase();
      const action = match[4].charAt(0).toUpperCase() + match[4].slice(1).toLowerCase();
      const martingale = superscriptMap[supChar] ?? 0;

      trades.push({
        report_date: reportDateISO,
        session: sessionName,
        time,
        pair,
        action,
        martingale,
        result: resultText,
        message_line: line
      });
    }
  }

  return { report_date: reportDateISO, trades };
}

async function saveRawMessageToDB(ctx, message) {
  try {
    const username = ctx.from?.username || ctx.from?.first_name || 'Unknown';
    const chatTitle = ctx.chat?.title || ctx.chat?.username || 'private';
    const ts = DateTime.now().setZone("Africa/Nairobi").toISO();
    const { error } = await supabase.from('messages').insert([{
      message_id: ctx.message.message_id,
      username,
      source: chatTitle,
      message,
      created_at: ts
    }]);
    if (error) console.error("❌ Failed to save raw message:", error.message);
  } catch (err) {
    console.error("❌ saveRawMessageToDB error:", err.message);
  }
}

bot.on("text", async (ctx) => {
  const text = ctx.message.text || '';
  const chatTitle = ctx.chat?.title || ctx.chat?.username || 'private';

  await saveRawMessageToDB(ctx, text);

  const parsed = parseDailyReport(text);
  if (!parsed) {
    console.log("⚪ Not a daily report message — raw saved.");
    return;
  }
  if (!parsed.trades || parsed.trades.length === 0) {
    console.log("⚠️ Detected daily report but parsed 0 trades.");
    try { await ctx.reply("⚠️ Daily report detected but no trades were parsed. Check format."); } catch {}
    return;
  }

  let inserted = 0;
  for (const t of parsed.trades) {
    try {
      // dedupe - check existing
      const { data: existing, error: selErr } = await supabase
        .from('trades')
        .select('id')
        .eq('report_date', t.report_date)
        .eq('time', t.time)
        .eq('pair', t.pair)
        .eq('session', t.session)
        .limit(1);

      if (selErr) {
        console.error("❌ Supabase select error:", selErr.message);
        continue;
      }
      if (existing && existing.length > 0) continue;

      const { error: insErr } = await supabase.from('trades').insert([{
        report_date: t.report_date,
        session: t.session,
        time: t.time,
        pair: t.pair,
        action: t.action,
        martingale: t.martingale,
        result: t.result,
        message: t.message_line,
        source: chatTitle,
        username: ctx.from?.username || ctx.from?.first_name || 'Unknown'
      }]);

      if (insErr) console.error("❌ Supabase insert error:", insErr.message);
      else inserted++;
    } catch (err) {
      console.error("❌ Insert loop error:", err.message);
    }
  }

  try { await ctx.reply(`✅ Parsed ${inserted} new trades for ${parsed.report_date}.`); } catch {}
  console.log(`✅ Saved ${inserted} trades for ${parsed.report_date}`);
});

app.post(`/webhook/${TELEGRAM_BOT_TOKEN}`, (req, res) => {
  bot.handleUpdate(req.body, res);
});

(async () => {
  try {
    if (NODE_ENV === 'production' && WEBHOOK_URL) {
      await bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook/${TELEGRAM_BOT_TOKEN}`);
      console.log("✅ Telegram webhook set successfully.");
      app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
    } else {
      await bot.launch();
      console.log("✅ Bot launched in polling mode (local/dev)");
    }
  } catch (err) {
    console.error("❌ Startup error:", err.message || err);
    process.exit(1);
  }
})();

process.once("SIGINT", () => { try { bot.stop('SIGINT'); } catch {} });
process.once("SIGTERM", () => { try { bot.stop('SIGTERM'); } catch {} });
