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
const NODE_ENV = process.env.NODE_ENV || 'development';

if (!TELEGRAM_BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Missing required environment variables. See README.");
  process.exit(1);
}

const app = express();
app.use(bodyParser.json());

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// health endpoint
app.get("/", (req, res) => res.status(200).send("✅ Atenza Telegram Sync is live!"));

// helper maps
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

// ---------------- PARSER ----------------
function parseDailyReport(text) {
  if (!/DAILY REPORT|DIALY REPORT/i.test(text)) return null;

  // extract report date
  const dateMatch = text.match(/🗓\s*(.+)/);
  let reportDateISO = null;
  if (dateMatch) {
    const raw = dateMatch[1].trim().replace(/[#].*$/, '').trim();
    const dt = DateTime.fromFormat(raw, "cccc, LLLL d'th', yyyy", { zone: "Africa/Nairobi" });
    if (dt.isValid) reportDateISO = dt.toISODate();
    else {
      const alt = DateTime.fromFormat(raw, "cccc, LLLL d, yyyy", { zone: "Africa/Nairobi" });
      if (alt.isValid) reportDateISO = alt.toISODate();
    }
  }
  if (!reportDateISO) reportDateISO = DateTime.now().setZone("Africa/Nairobi").toISODate();

  // summary
  let reportedAccuracy = null, reportedWins = null, reportedLosses = null;
  const accMatch = text.match(/Accuracy:\s*([0-9.]+)%/i);
  if (accMatch) reportedAccuracy = parseFloat(accMatch[1]);

  const winsMatch = text.match(/Wins\s*([0-9️⃣\D]+?)\s*x\s*([0-9️⃣\D]+?)\s*Losses/i);
  if (winsMatch) {
    reportedWins = parseInt(winsMatch[1].replace(/\D/g, ''), 10) || null;
    reportedLosses = parseInt(winsMatch[2].replace(/\D/g, ''), 10) || null;
  }

  // parse trades by session
  const lines = text.split('\n');
  const headers = [];
  const headerRegex = /(Overnight|Morning|Afternoon|Night)\s+Session/i;

  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(headerRegex);
    if (h) headers.push({ name: h[1], idx: i });
  }
  headers.push({ name: 'END', idx: lines.length });

  const trades = [];
  for (let i = 0; i < headers.length - 1; i++) {
    const header = headers[i];
    const block = lines.slice(header.idx + 1, headers[i + 1].idx);
    const sessionName = normalizeSession(header.name);

    for (const line of block) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const match = trimmed.match(/^✅([⁰¹²³])?\s*([\d]{2}:[\d]{2})\s*•[\s\S]*?([A-Z]{3}\/[A-Z]{3})[\s\S]*?•\s*(Buy|Sell)/i);
      if (!match) continue;

      const supChar = match[1] || '⁰';
      const time = match[2];
      const pair = match[3].toUpperCase();
      const action = match[4].charAt(0).toUpperCase() + match[4].slice(1).toLowerCase();
      const resultNum = superscriptMap[supChar] ?? 0;

      trades.push({
        report_date: reportDateISO,
        session: sessionName,
        time,
        pair,
        action,
        result: resultNum,
        message_line: trimmed
      });
    }
  }

  return {
    report_date: reportDateISO,
    trades,
    reportedAccuracy,
    reportedWins,
    reportedLosses
  };
}

// ---------------- SAVE RAW MESSAGE ----------------
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

// ---------------- MAIN HANDLER ----------------
bot.on("text", async (ctx) => {
  const text = ctx.message.text || '';
  const username = ctx.from?.username || ctx.from?.first_name || 'Unknown';
  const chatTitle = ctx.chat?.title || ctx.chat?.username || 'private';

  await saveRawMessageToDB(ctx, text);

  const parsed = parseDailyReport(text);
  if (!parsed) {
    console.log("⚪ Not a daily report message — raw saved.");
    return;
  }

  const trades = parsed.trades || [];
  if (trades.length === 0) {
    console.log("⚠️ Detected daily report but parsed 0 trades.");
    await ctx.reply("⚠️ Daily report detected but no trades were parsed. Check format.");
    return;
  }

  // prepare records
  const toInsert = trades.map(t => ({
    report_date: t.report_date,
    session: t.session,
    time: t.time,
    pair: t.pair,
    action: t.action,
    martingale: null,
    result: t.result,
    message: t.message_line,
    source: chatTitle,
    username
  }));

  let inserted = 0;
  for (const rec of toInsert) {
    try {
      const { data: existing, error: selErr } = await supabase
        .from('trades')
        .select('id')
        .eq('report_date', rec.report_date)
        .eq('time', rec.time)
        .eq('pair', rec.pair)
        .eq('session', rec.session)
        .limit(1);

      if (selErr) {
        console.error("❌ Supabase select error:", selErr.message);
        continue;
      }

      if (existing && existing.length > 0) continue;

      const { error: insErr } = await supabase.from('trades').insert([rec]);
      if (!insErr) inserted++;
      else console.error("❌ Supabase insert error:", insErr.message);
    } catch (err) {
      console.error("❌ Insert loop error:", err.message);
    }
  }

  // store reported accuracy/wins/losses
  if (parsed.reportedAccuracy !== null || parsed.reportedWins !== null || parsed.reportedLosses !== null) {
    try {
      const { error: upErr } = await supabase.from('daily_reports').upsert([{
        report_date: parsed.report_date,
        // NOTE: keep aggregate totals managed by DB trigger; these reported_* fields are informational
        reported_accuracy: parsed.reportedAccuracy,
        reported_wins: parsed.reportedWins,
        reported_losses: parsed.reportedLosses,
        updated_at: new Date().toISOString()
      }], { onConflict: 'report_date' });

      if (upErr) console.error("❌ daily_reports upsert error:", upErr.message);
    } catch (err) {
      console.error("❌ daily_reports upsert exception:", err.message);
    }
  }

  await ctx.reply(`✅ Parsed report for ${parsed.report_date}: ${inserted} new trades saved. Reported accuracy: ${parsed.reportedAccuracy ?? 'N/A'}`);
  console.log(`✅ Saved ${inserted} trades for ${parsed.report_date}`);
});

// ---------------- WEBHOOK / POLLING ----------------
app.post(`/webhook/${TELEGRAM_BOT_TOKEN}`, (req, res) => {
  bot.handleUpdate(req.body, res);
});

(async () => {
  if (NODE_ENV === 'production' && WEBHOOK_URL) {
    try {
      await bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook/${TELEGRAM_BOT_TOKEN}`);
      console.log("✅ Telegram webhook set successfully.");
    } catch (err) {
      console.error("❌ Error setting webhook:", err.message);
    }
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  } else {
    await bot.launch();
    console.log("✅ Bot launched in polling mode (local/dev)");
  }
})();

// graceful shutdown
process.once('SIGINT', () => {
  try { bot.stop('SIGINT'); } catch { console.log('Bot already stopped.'); }
});
process.once('SIGTERM', () => {
  try { bot.stop('SIGTERM'); } catch { console.log('Bot already stopped.'); }
});
