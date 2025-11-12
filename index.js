import 'dotenv/config';
import express from "express";
import bodyParser from "body-parser";
import { Telegraf } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";

// =========================
// 🔧 CONFIG
// =========================
const PORT = process.env.PORT || 10000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const NODE_ENV = process.env.NODE_ENV || 'development';

if (!TELEGRAM_BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Missing environment variables. Check .env file!");
  process.exit(1);
}

const app = express();
app.use(bodyParser.json());
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// =========================
// ✅ HEALTH CHECK
// =========================
app.get("/", (req, res) => res.status(200).send("✅ Atenza Telegram Sync is live!"));

// =========================
// 🔢 MAPS & HELPERS
// =========================
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

// =========================
// 🧠 PARSER: DAILY REPORT
// =========================
function parseDailyReport(text) {
  if (!/DAILY REPORT|DIALY REPORT/i.test(text)) return null;

  const dateMatch = text.match(/🗓\s*(.+)/);
  let reportDateISO = DateTime.now().setZone("Africa/Nairobi").toISODate();
  if (dateMatch) {
    const cleaned = dateMatch[1].trim().replace(/[#].*$/, '').trim();
    const dt = DateTime.fromFormat(cleaned, "cccc, LLLL d'th', yyyy", { zone: "Africa/Nairobi" });
    if (dt.isValid) reportDateISO = dt.toISODate();
  }

  // Capture reported accuracy and summary
  let reportedAccuracy = null, reportedWins = null, reportedLosses = null;
  const accMatch = text.match(/Accuracy:\s*([0-9.]+)%/i);
  if (accMatch) reportedAccuracy = parseFloat(accMatch[1]);
  const alt = text.match(/✅\s*Wins\s*([0-9\D]+?)\s*x\s*([0-9\D]+?)\s*Losses/i);
  if (alt) {
    reportedWins = parseInt(alt[1].replace(/\D/g, ''), 10) || null;
    reportedLosses = parseInt(alt[2].replace(/\D/g, ''), 10) || null;
  }

  // Split message into session blocks
  const lines = text.split("\n");
  const headers = [];
  for (let i = 0; i < lines.length; i++) {
    if (/SESSION/i.test(lines[i])) headers.push({ name: lines[i], idx: i });
  }
  headers.push({ name: "END", idx: lines.length });

  const blocks = [];
  for (let i = 0; i < headers.length - 1; i++) {
    const name = headers[i].name.replace(/[^a-z]/gi, "").toLowerCase();
    const session = normalizeSession(name);
    const blockLines = lines.slice(headers[i].idx + 1, headers[i + 1].idx);
    blocks.push({ session, lines: blockLines });
  }

  const trades = [];
  for (const block of blocks) {
    for (const line of block.lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("✅") && !trimmed.startsWith("❌")) continue;

      const match = trimmed.match(/([✅❌])([⁰¹²³])?\s*(\d{2}:\d{2})\s*•.*?([A-Z]{3}\/[A-Z]{3}).*•\s*(Buy|Sell)/i);
      if (!match) continue;

      const emoji = match[1];
      const martingaleSup = match[2] || '⁰';
      const martingale = superscriptMap[martingaleSup] ?? 0;
      const time = match[3];
      const pair = match[4].toUpperCase();
      const action = match[5].charAt(0).toUpperCase() + match[5].slice(1).toLowerCase();

      // ✅ core martingale logic
      const result = (emoji === '❌' && martingale === 3) ? "Loss" : "Win";

      trades.push({
        report_date: reportDateISO,
        session: block.session,
        time,
        pair,
        action,
        martingale,
        result,
        message_line: trimmed
      });
    }
  }

  return { report_date: reportDateISO, trades, reportedAccuracy, reportedWins, reportedLosses };
}

// =========================
// 💾 SAVE RAW MESSAGE
// =========================
async function saveRawMessage(ctx, message) {
  try {
    const username = ctx.from?.username || ctx.from?.first_name || "Unknown";
    const source = ctx.chat?.title || ctx.chat?.username || "private";
    const ts = DateTime.now().setZone("Africa/Nairobi").toISO();

    const { error } = await supabase.from("messages").insert([{
      message_id: ctx.message.message_id,
      username,
      source,
      message,
      created_at: ts
    }]);

    if (error) console.error("❌ Error saving raw message:", error.message);
  } catch (err) {
    console.error("❌ saveRawMessage:", err.message);
  }
}

// =========================
// 🤖 BOT HANDLER
// =========================
bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  await saveRawMessage(ctx, text);

  const parsed = parseDailyReport(text);
  if (!parsed) return console.log("⚪ Not a daily report.");

  const { report_date, trades, reportedAccuracy, reportedWins, reportedLosses } = parsed;
  if (trades.length === 0) return ctx.reply("⚠️ No trades found in report.");

  let inserted = 0;
  for (const t of trades) {
    const exists = await supabase
      .from("trades")
      .select("id")
      .eq("report_date", t.report_date)
      .eq("time", t.time)
      .eq("pair", t.pair)
      .eq("session", t.session)
      .maybeSingle();

    if (exists.data) continue;

    const { error } = await supabase.from("trades").insert([{
      report_date: t.report_date,
      session: t.session,
      time: t.time,
      pair: t.pair,
      action: t.action,
      martingale: t.martingale,
      result: t.result,
      message: t.message_line,
      source: ctx.chat?.title || ctx.chat?.username || "private",
      username: ctx.from?.username || ctx.from?.first_name
    }]);

    if (!error) inserted++;
    else console.error("❌ Insert trade error:", error.message);
  }

  if (reportedAccuracy || reportedWins || reportedLosses) {
    const { error } = await supabase.from("daily_reports").upsert([{
      report_date,
      reported_accuracy: reportedAccuracy,
      reported_wins: reportedWins,
      reported_losses: reportedLosses,
      updated_at: new Date().toISOString()
    }], { onConflict: "report_date" });
    if (error) console.error("❌ Upsert daily report error:", error.message);
  }

  await ctx.reply(`✅ Saved ${inserted} new trades for ${report_date}.`);
  console.log(`✅ ${inserted} trades stored for ${report_date}`);
});

// =========================
// 🌐 WEBHOOK OR POLLING
// =========================
app.post(`/webhook/${TELEGRAM_BOT_TOKEN}`, (req, res) => {
  bot.handleUpdate(req.body, res);
});

(async () => {
  if (NODE_ENV === "production" && WEBHOOK_URL) {
    await bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook/${TELEGRAM_BOT_TOKEN}`);
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  } else {
    await bot.launch();
    console.log("✅ Bot running in polling mode (local)");
  }
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
