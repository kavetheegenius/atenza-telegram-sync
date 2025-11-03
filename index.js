import express from "express";
import TelegramBot from "node-telegram-bot-api";
import pkg from "@supabase/supabase-js";
import { DateTime } from "luxon";

import dotenv from "dotenv";
dotenv.config();

console.log("🔍 ENV CHECK START");
console.log("TELEGRAM_TOKEN:", process.env.TELEGRAM_TOKEN ? "✅ Loaded" : "❌ Missing");
console.log("SUPABASE_URL:", process.env.SUPABASE_URL ? "✅ Loaded" : "❌ Missing");
console.log("SUPABASE_KEY:", process.env.SUPABASE_KEY ? "✅ Loaded" : "❌ Missing");
console.log("WEBHOOK_URL:", process.env.WEBHOOK_URL ? "✅ Loaded" : "❌ Missing");
console.log("🔍 ENV CHECK END\n");

const { createClient } = pkg;

const app = express();
app.use(express.json());

// 🌍 Config
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 10000;

const bot = new TelegramBot(TELEGRAM_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 🪝 Webhook endpoint
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const update = req.body;
  if (!update.message || !update.message.text) return res.sendStatus(200);

  const messageText = update.message.text.trim();
  console.log("New trade received:", messageText.substring(0, 40) + "...");

  // ✅ Match only daily/dialy reports
  if (/🧾\s*(DAILY|DIALY)\s*REPORT/i.test(messageText)) {
    const result = await parseAndSaveTrades(messageText);
    const reply = `✅ ${result.count} trades imported for ${result.reportDate}`;
    await bot.sendMessage(update.message.chat.id, reply);
  }

  res.sendStatus(200);
});

// 🧠 Parse and save trades
async function parseAndSaveTrades(message) {
  // 🗓 Extract report date
  const dateMatch = message.match(/🗓\s*(.+?)\n/);
  const reportDateText = dateMatch ? dateMatch[1].trim() : null;
  const reportDate = reportDateText
    ? DateTime.fromFormat(reportDateText, "cccc, LLLL d'th,' yyyy", {
        zone: "UTC-4",
      }).isValid
      ? DateTime.fromFormat(reportDateText, "cccc, LLLL d'th,' yyyy", {
          zone: "UTC-4",
        }).toISODate()
      : reportDateText
    : null;

  // 🧩 Split sessions
  const sessionBlocks = message.split(/🌑|🌤|☀️|🌙/).slice(1);
  const sessionNames = ["Overnight", "Morning", "Afternoon", "Night"];

  let allTrades = [];

  sessionBlocks.forEach((block, i) => {
    const session = sessionNames[i];
    const lines = block.split("\n").filter((l) => l.includes("•"));
    lines.forEach((line) => {
      const match = line.match(
        /✅([⁰¹²³])?\s*([\d:]+)\s*•.*?([A-Z]{3}\/[A-Z]{3}).*•\s*(Buy|Sell)/i
      );
      if (match) {
        const martingale = match[1] ? parseInt(match[1]) : 0;
        const time = match[2];
        const pair = match[3];
        const action = match[4];
        const result = "win"; // all ✅ are wins
        allTrades.push({
          report_date: reportDate,
          session,
          time,
          pair,
          action,
          martingale,
          result,
          source: "telegram",
          message,
        });
      }
    });
  });

  // 💾 Save each trade
  let count = 0;
  for (const trade of allTrades) {
    const { error } = await supabase.from("trades_data").insert(trade);
    if (!error) count++;
    else console.error("Save error:", error.message);
  }

  return { count, reportDate };
}

// 🚀 Start server

// 🩺 Health check endpoint (for Render)
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  try {
    await bot.setWebHook(`${WEBHOOK_URL}/webhook/${TELEGRAM_TOKEN}`);
    console.log("✅ Telegram webhook set successfully.");
  } catch (err) {
    console.error("❌ Error setting webhook:", err.message);
  }
});
