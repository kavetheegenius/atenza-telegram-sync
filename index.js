import 'dotenv/config';
import express from "express";
import bodyParser from "body-parser";
import { Telegraf } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";

// 🧩 ENVIRONMENT CONFIG
const PORT = process.env.PORT || 10000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const NODE_ENV = process.env.NODE_ENV || "development";
const DEBUG = process.env.DEBUG === "true";

// 🚨 REQUIRED ENV CHECKS
if (!TELEGRAM_BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !WEBHOOK_URL) {
  console.error("❌ Missing environment variables. Please verify your .env includes:");
  console.error("TELEGRAM_BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY, WEBHOOK_URL");
  process.exit(1);
}

// 🧩 INITIALIZE SERVICES
const app = express();
app.use(bodyParser.json());
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ✅ HEALTH CHECK
app.get("/", (req, res) => res.status(200).send("✅ Atenza Telegram Sync is live!"));

// 🔢 SUPERSCRIPT MAP
const superscriptMap = { '⁰': 0, '¹': 1, '²': 2, '³': 3 };

// 🌞 SESSION NORMALIZER
const sessionNormaliser = (s) => {
  if (!s) return "Unknown";
  const t = s.toLowerCase();
  if (t.includes("overnight")) return "Overnight";
  if (t.includes("morning")) return "Morning";
  if (t.includes("afternoon")) return "Afternoon";
  if (t.includes("night")) return "Night";
  return s;
};

// 📊 PARSER FUNCTION
function parseDailyReport(text) {
  if (!/DAILY REPORT|DIALY REPORT/i.test(text)) return null;

  // extract date
  const dateMatch = text.match(/🗓\s*(.+)/);
  let reportDateISO = null;
  if (dateMatch) {
    const raw = dateMatch[1].trim().replace(/[#].*$/, '').trim();
    const dt =
      DateTime.fromFormat(raw, "cccc, LLLL d'th', yyyy", { zone: "Africa/Nairobi" }) ||
      DateTime.fromFormat(raw, "cccc, LLLL d, yyyy", { zone: "Africa/Nairobi" }) ||
      DateTime.fromFormat(raw, "LLLL d, yyyy", { zone: "Africa/Nairobi" });
    if (dt && dt.isValid) reportDateISO = dt.toISODate();
  }
  if (!reportDateISO)
    reportDateISO = DateTime.now().setZone("Africa/Nairobi").toISODate();

  // extract reported accuracy / wins / losses
  let reportedAccuracy = null, reportedWins = null, reportedLosses = null;
  const accMatch = text.match(/Accuracy:\s*([0-9.]+)%/i);
  if (accMatch) reportedAccuracy = parseFloat(accMatch[1]);

  const alt = text.match(/✅\s*Wins\s*([0-9\D]+?)\s*x\s*([0-9\D]+?)\s*Losses/i);
  if (alt) {
    reportedWins = parseInt(alt[1].replace(/\D/g, ''), 10) || null;
    reportedLosses = parseInt(alt[2].replace(/\D/g, ''), 10) || null;
  }

  // split by sessions
  const lines = text.split("\n");
  const headers = [];
  const headerRegex = /(Overnight|Morning|Afternoon|Night)\s+Session/i;

  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(headerRegex);
    if (h) headers.push({ name: h[1], idx: i });
  }
  headers.push({ name: "END", idx: lines.length });

  const trades = [];
  for (let i = 0; i < headers.length - 1; i++) {
    const header = headers[i];
    const blockLines = lines.slice(header.idx + 1, headers[i + 1].idx);
    const sessionName = sessionNormaliser(header.name);

    for (const line of blockLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const use = trimmed.match(/^✅([⁰¹²³])?\s*([\d]{2}:[\d]{2})\s*•\s*([A-Z]{3}\/[A-Z]{3}).*•\s*(Buy|Sell)/i);
      if (!use) continue;

      const supChar = use[1] || "⁰";
      const resultNum = superscriptMap[supChar] ?? 0;
      trades.push({
        report_date: reportDateISO,
        session: sessionName,
        time: use[2],
        pair: use[3].toUpperCase(),
        action: use[4].charAt(0).toUpperCase() + use[4].slice(1).toLowerCase(),
        result: resultNum,
        message_line: trimmed
      });
    }
  }

  if (DEBUG) console.log("📊 Parsed trades:", trades);

  return {
    report_date: reportDateISO,
    trades,
    reportedAccuracy,
    reportedWins,
    reportedLosses,
  };
}

// 💾 SAVE RAW MESSAGE
async function saveRawMessageToDB(ctx, message) {
  try {
    const username = ctx.from?.username || ctx.from?.first_name || "Unknown";
    const chatTitle = ctx.chat?.title || ctx.chat?.username || "private";
    const ts = DateTime.now().setZone("Africa/Nairobi").toISO();
    const { error } = await supabase.from("messages").insert([
      {
        message_id: ctx.message.message_id,
        source: chatTitle,
        username,
        message,
        created_at: ts,
      },
    ]);
    if (error) console.error("❌ Failed to save raw message:", error.message);
  } catch (err) {
    console.error("❌ saveRawMessageToDB error:", err.message);
  }
}

// 📥 MAIN HANDLER
bot.on("text", async (ctx) => {
  const text = ctx.message.text || "";
  await saveRawMessageToDB(ctx, text);

  const parsed = parseDailyReport(text);
  if (!parsed) {
    if (DEBUG) console.log("⚪ Not a daily report message — raw saved.");
    return;
  }

  const trades = parsed.trades || [];
  if (trades.length === 0) {
    console.log("⚠️ Daily report detected but 0 trades parsed.");
    await ctx.reply("⚠️ Detected daily report but no trades parsed. Check format.");
    return;
  }

  const username = ctx.from?.username || ctx.from?.first_name || "Unknown";
  const chatTitle = ctx.chat?.title || ctx.chat?.username || "private";

  // Insert trades
  let inserted = 0;
  for (const t of trades) {
    try {
      const q = await supabase
        .from("trades")
        .select("id")
        .eq("report_date", t.report_date)
        .eq("time", t.time)
        .eq("pair", t.pair)
        .eq("session", t.session)
        .limit(1);

      if (q.data?.length > 0) continue;

      const ins = await supabase.from("trades").insert([
        {
          report_date: t.report_date,
          session: t.session,
          time: t.time,
          pair: t.pair,
          action: t.action,
          martingale: null,
          result: t.result,
          message: t.message_line,
          source: chatTitle,
          username,
        },
      ]);

      if (!ins.error) inserted++;
    } catch (err) {
      console.error("❌ Insert error:", err.message);
    }
  }

  // Update daily_reports if accuracy summary is present
  if (parsed.reportedAccuracy || parsed.reportedWins || parsed.reportedLosses) {
    try {
      const { error } = await supabase.from("daily_reports").upsert([
        {
          report_date: parsed.report_date,
          reported_accuracy: parsed.reportedAccuracy,
          reported_wins: parsed.reportedWins,
          reported_losses: parsed.reportedLosses,
          updated_at: new Date().toISOString(),
        },
      ]);
      if (error) console.error("❌ daily_reports upsert error:", error.message);
    } catch (err) {
      console.error("❌ daily_reports upsert exception:", err.message);
    }
  }

  await ctx.reply(
    `✅ Parsed report for ${parsed.report_date}: ${inserted} new trades saved. Reported accuracy: ${parsed.reportedAccuracy ?? "N/A"}`
  );

  console.log(`✅ ${inserted} trades saved for ${parsed.report_date}`);
});

// 🪝 WEBHOOK HANDLER
app.post(`/webhook/${TELEGRAM_BOT_TOKEN}`, (req, res) => {
  bot.handleUpdate(req.body, res);
});

// 🚀 START BOT
(async () => {
  if (NODE_ENV === "production" && WEBHOOK_URL) {
    try {
      await bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook/${TELEGRAM_BOT_TOKEN}`);
      console.log("✅ Telegram webhook set successfully.");
    } catch (err) {
      console.error("❌ Error setting webhook:", err.message);
    }
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  } else {
    await bot.launch();
    console.log("✅ Bot running in polling mode (local/dev)");
  }
})();

// graceful shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
