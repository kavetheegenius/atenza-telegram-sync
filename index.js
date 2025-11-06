import 'dotenv/config';
import express from "express";
import bodyParser from "body-parser";
import { Telegraf } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";

const PORT = process.env.PORT || 10000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // use anon for frontend, service key for backend if needed
const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g. https://atenza-telegram-sync.onrender.com
const NODE_ENV = process.env.NODE_ENV || 'development';

if (!TELEGRAM_BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Missing required environment variables. See README.");
  process.exit(1);
}

const app = express();
app.use(bodyParser.json());

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// health
app.get("/", (req, res) => res.status(200).send("✅ Atenza Telegram Sync is live!"));

// helper: map superscript char to number
const superscriptMap = { '⁰': 0, '¹': 1, '²': 2, '³': 3 };

// normalize session names map (accept different caps/typos)
const sessionNormaliser = (s) => {
  if (!s) return "Unknown";
  const t = s.toLowerCase();
  if (t.includes("overnight")) return "Overnight";
  if (t.includes("morning")) return "Morning";
  if (t.includes("afternoon")) return "Afternoon";
  if (t.includes("night")) return "Night";
  return s;
};

// parse daily report message into trades + summary
function parseDailyReport(text) {
  // tolerant to "DAILY" or "DIALY"
  if (!/DAILY REPORT|DIALY REPORT/i.test(text)) return null;

  // extract report date line after 🗓
  const dateMatch = text.match(/🗓\s*(.+)/);
  let reportDateISO = null;
  if (dateMatch) {
    // try a few formats
    const raw = dateMatch[1].trim();
    // remove trailing tokens like "#"
    const cleaned = raw.replace(/[#].*$/,'').trim();
    // attempt parse with luxon with several common patterns
    const dt = DateTime.fromFormat(cleaned, "cccc, LLLL d'th', yyyy", { zone: "Africa/Nairobi" })
             .isValid ? DateTime.fromFormat(cleaned, "cccc, LLLL d'th', yyyy", { zone: "Africa/Nairobi" })
             : DateTime.fromFormat(cleaned, "cccc, LLLL d, yyyy", { zone: "Africa/Nairobi" });
    if (dt && dt.isValid) reportDateISO = dt.toISODate();
  }
  if (!reportDateISO) reportDateISO = DateTime.now().setZone("Africa/Nairobi").toISODate();

  // parse reported accuracy/wins/losses line if present
  let reportedAccuracy = null, reportedWins = null, reportedLosses = null;
  const accMatch = text.match(/Accuracy:\s*([0-9.]+)%/i) || text.match(/Accuracy:\s*([0-9.]+)\%/i);
  if (accMatch) reportedAccuracy = parseFloat(accMatch[1]);
  const winsMatch = text.match(/Wins\s*([0-9️⃣0-9]+)\s*x\s*([0-9️⃣0-9]+)\s*Losses/i) ||
                    text.match(/Wins\s*([0-9]+)\s*x\s*([0-9]+)\s*Losses/i);
  if (winsMatch) {
    reportedWins = parseInt(winsMatch[1].toString().replace(/\D/g,''),10);
    reportedLosses = parseInt(winsMatch[2].toString().replace(/\D/g,''),10);
  } else {
    // alternate emoji form: ✅ Wins 2️⃣8️⃣ x 0️⃣ Losses — capture digits
    const alt = text.match(/✅\s*Wins\s*([0-9\D]+?)\s*x\s*([0-9\D]+?)\s*Losses/i);
    if (alt) {
      reportedWins = parseInt(alt[1].replace(/\D/g,''),10) || null;
      reportedLosses = parseInt(alt[2].replace(/\D/g,''),10) || null;
    }
  }

  // split into session blocks
  const sessions = [];
  // Regex to capture session blocks like "🌑 OVERNIGHT SESSION ... (until next session or end)"
  const sessionRegex = /(Overnight|Morning|Afternoon|Night)\s+Session[\s\S]*?(?=(?:Overnight|Morning|Afternoon|Night)\s+Session|$)/ig;
  // But the message might include emojis - so better to find lines that start with emoji + SESSION
  // We'll use simpler approach: split by session headers (search for the word SESSION)
  const parts = text.split(/\n(?=.*SESSION)/i); // best-effort
  // For more robust, fallback to find lines starting with session names
  // Now find all lines that start with header emoji textual marker
  const headerRegex = /(Overnight|Morning|Afternoon|Night)\s+Session/i;
  const lines = text.split('\n');

  // Build index mapping: find header lines and their indices
  const headers = [];
  for (let i=0;i<lines.length;i++){
    const h = lines[i].match(headerRegex);
    if (h) headers.push({ name: h[1], idx: i });
  }
  // Add sentinel at end
  headers.push({ name: 'END', idx: lines.length });

  // Extract blocks between headers
  const blocks = [];
  for (let i=0;i<headers.length-1;i++){
    const header = headers[i];
    const blockLines = lines.slice(header.idx+1, headers[i+1].idx);
    blocks.push({ session: header.name, lines: blockLines });
  }

  const trades = [];
  for (const b of blocks) {
    const sessionName = sessionNormaliser(b.session);
    // find lines starting with ✅ or similar
    for (const line of b.lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const tradeLineMatch = trimmed.match(/^✅([⁰¹²³])?\s*([\d]{2}:[\d]{2})\s*•\s*(?:🇨?[\w\W]*?\s)?([A-Z]{3}\/[A-Z]{3})\s*(?:[\w\W]*?)•\s*(Buy|Sell)/i);
      // Alternate pattern without country flags
      const altMatch = trimmed.match(/^✅([⁰¹²³])?\s*([\d]{2}:[\d]{2})\s*•\s*([A-Z]{3}\/[A-Z]{3}).*•\s*(Buy|Sell)/i);
      const use = tradeLineMatch || altMatch;
      if (!use) continue;
      const supChar = use[1] || '⁰';
      const time = use[2];
      const pair = use[3].toUpperCase();
      const action = (use[4] || use[4]).charAt(0).toUpperCase() + (use[4]||'').slice(1).toLowerCase();
      const resultNum = (superscriptMap[supChar] !== undefined) ? superscriptMap[supChar] : 0;
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

// Insert raw message row to messages table
async function saveRawMessageToDB(ctx, message) {
  try {
    const username = ctx.from?.username || ctx.from?.first_name || 'Unknown';
    const chatTitle = ctx.chat?.title || ctx.chat?.username || 'private';
    const ts = DateTime.now().setZone("Africa/Nairobi").toISO();
    const { error } = await supabase.from('messages').insert([{
      message_id: ctx.message.message_id,
      report_date: null,
      session: null,
      time: null,
      pair: null,
      action: null,
      martingale: null,
      result: null,
      source: chatTitle,
      message,
      username,
      created_at: ts
    }]);
    if (error) console.error("❌ Failed to save raw message:", error.message);
  } catch (err) {
    console.error("❌ saveRawMessageToDB error:", err.message);
  }
}

// main handler
bot.on("text", async (ctx) => {
  const text = ctx.message.text || '';
  const username = ctx.from?.username || ctx.from?.first_name || 'Unknown';
  const chatTitle = ctx.chat?.title || ctx.chat?.username || 'private';

  // save raw message (always)
  await saveRawMessageToDB(ctx, text);

  // detect report
  const parsed = parseDailyReport(text);
  if (!parsed) {
    // not a daily report — ignore parsing step
    console.log("⚪ Not a daily report message — raw saved.");
    return;
  }

  const trades = parsed.trades || [];
  if (trades.length === 0) {
    console.log("⚠️ Detected daily report but parsed 0 trades.");
    await ctx.reply("⚠️ Daily report detected but no trades were parsed. Check format.");
    return;
  }

  // dedupe: only insert trades that don't already exist (report_date+time+pair+session)
  // We perform upsert with conflict constraints in DB; here we check existing quickly
  const toInsert = [];
  for (const t of trades) {
    // prepare insert object: include raw_message and source info
    toInsert.push({
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
    });
  }

  // Insert trades one-by-one with check to avoid duplicates (simple approach)
  let inserted = 0;
  for (const rec of toInsert) {
    try {
      // check if exists
      const q = await supabase
        .from('trades')
        .select('id')
        .eq('report_date', rec.report_date)
        .eq('time', rec.time)
        .eq('pair', rec.pair)
        .eq('session', rec.session)
        .limit(1);

      if (q.error) {
        console.error("❌ Supabase select error:", q.error.message);
        continue;
      }
      if ((q.data || []).length > 0) {
        // duplicate — skip
        continue;
      }
      const ins = await supabase.from('trades').insert([rec]);
      if (ins.error) {
        console.error("❌ Supabase insert error:", ins.error.message);
      } else {
        inserted++;
      }
    } catch (err) {
      console.error("❌ Insert loop error:", err.message);
    }
  }

  // If the message reported overall summary, store reported fields separately in daily_reports.reported_*
  if (parsed.reportedAccuracy !== null || parsed.reportedWins !== null || parsed.reportedLosses !== null) {
    try {
      const upsert = await supabase.from('daily_reports').upsert([{
        report_date: parsed.report_date,
        -- /* NOTE: keep aggregate totals managed by DB trigger; these reported_* fields are informational */
        reported_accuracy: parsed.reportedAccuracy,
        reported_wins: parsed.reportedWins,
        reported_losses: parsed.reportedLosses,
        updated_at: new Date().toISOString()
      }], { onConflict: 'report_date' });
      if (upsert.error) console.error("❌ daily_reports upsert error:", upsert.error.message);
    } catch (err) {
      console.error("❌ daily_reports upsert exception:", err.message);
    }
  }

  // reply to group with confirmation
  await ctx.reply(`✅ Parsed report for ${parsed.report_date}: ${inserted} new trades saved. Reported accuracy: ${parsed.reportedAccuracy ?? 'N/A'}`);

  console.log(`✅ Saved ${inserted} trades for ${parsed.report_date}`);
});

// webhook endpoint + app start logic
app.post(`/webhook/${TELEGRAM_BOT_TOKEN}`, (req, res) => {
  bot.handleUpdate(req.body, res);
});

(async () => {
  if (NODE_ENV === 'production' && WEBHOOK_URL) {
    // try set webhook
    try {
      const set = await bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook/${TELEGRAM_BOT_TOKEN}`);
      console.log("✅ Telegram webhook set:", set);
    } catch (err) {
      console.error("❌ Error setting webhook:", err.message || err);
    }
    app.listen(PORT, () => console.log(`🚀 Server running (webhook) on port ${PORT}`));
  } else {
    // polling mode (local)
    await bot.launch();
    console.log("✅ Bot launched in polling mode (local/dev)");
  }
})();

// graceful shutdown handlers
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));