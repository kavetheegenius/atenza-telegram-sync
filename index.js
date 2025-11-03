import express from "express";
import fetch from "node-fetch";
import { DateTime } from "luxon";

const app = express();
app.use(express.json());

// 🧩 Environment variables
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 10000;

// --- Helper: Send Telegram message ---
async function sendTelegramMessage(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.error("❌ Telegram send error:", err.message);
  }
}

// --- Helper: Parse trade message ---
function parseTradeMessage(message) {
  const lines = message.split("\n").map((l) => l.trim());
  const dateLine = lines.find((l) => /daily|dialy/i.test(l));
  const reportDate = dateLine ? dateLine.replace("🗓", "").trim() : null;
  const results = [];

  let session = null;
  for (const line of lines) {
    if (/session/i.test(line)) {
      session = line.replace(/🌑|🌤|☀️|🌙|SESSION/gi, "").trim();
    } else if (/✅|❌/.test(line) && /•/.test(line)) {
      const match = line.match(/(✅\S?)\s*(\S+)\s*•\s*.*?([A-Z]{3}\/[A-Z]{3}).*•\s*(Buy|Sell)/i);
      if (match) {
        const martingale = match[1].match(/\d+/)?.[0] || "0";
        const time = match[2];
        const pair = match[3];
        const action = match[4];
        const result = match[1].includes("✅") ? "Win" : "Loss";
        results.push({ report_date: reportDate, session, time, pair, action, martingale, result });
      }
    }
  }

  return results;
}

// --- Telegram Webhook ---
app.post(`/telegram/${TELEGRAM_TOKEN}`, async (req, res) => {
  try {
    const message = req.body?.message?.text || "";
    const chatId = req.body?.message?.chat?.id;
    if (!message || !/daily|dialy/i.test(message)) return res.sendStatus(200);

    console.log("📩 New trade message received");
    const trades = parseTradeMessage(message);
    console.log(`🧮 Parsed ${trades.length} trades`);

    if (trades.length > 0) {
      const payload = trades.map((t) => ({
        ...t,
        source: "telegram",
        message,
        timestamp: DateTime.now().setZone("America/New_York").toISO(),
      }));

      const response = await fetch(`${SUPABASE_URL}/rest/v1/trades_data`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const err = await response.text();
        console.error("❌ Supabase error:", err);
      } else {
        console.log(`✅ ${trades.length} trades saved`);
        await sendTelegramMessage(chatId, `✅ ${trades.length} trades imported successfully`);
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("🚨 Webhook error:", err);
    res.sendStatus(500);
  }
});

// --- Health route for Render ---
app.get("/healthz", (_, res) => res.send("OK"));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
