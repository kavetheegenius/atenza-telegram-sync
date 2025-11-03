// index.js
import express from "express";
import fetch from "node-fetch";
import { DateTime } from "luxon";

const app = express();
app.use(express.json());

// 🔑 Environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;

// 🧠 Telegram Webhook Handler
app.post(`/telegram/${BOT_TOKEN}`, async (req, res) => {
  try {
    const update = req.body;
    if (!update.message || !update.message.text) return res.sendStatus(200);

    const messageText = update.message.text.trim();
    const chatId = update.message.chat.id;

    // 🧾 Only handle daily report messages (allow for typos like "Dialy")
    if (!/DAI?LY REPORT/i.test(messageText)) {
      return res.sendStatus(200);
    }

    console.log("📩 New daily report detected");

    // Extract report date
    const dateMatch = messageText.match(/🗓\s*(.+)/);
    const reportDate = dateMatch ? dateMatch[1].trim() : null;

    // Split by session (🌑 OVERNIGHT, 🌤 MORNING, ☀️ AFTERNOON, 🌙 NIGHT)
    const sessions = messageText.split(/(?=🌑|🌤|☀️|🌙)/g);
    let totalTrades = 0;

    for (const sessionBlock of sessions) {
      const sessionMatch = sessionBlock.match(/(🌑|🌤|☀️|🌙)\s+([A-Z ]+)/);
      if (!sessionMatch) continue;
      const session = sessionMatch[2].trim();

      const tradeLines = sessionBlock.split("\n").filter((l) => /✅|❌/.test(l));
      let savedCount = 0;

      for (const line of tradeLines) {
        const tradeMatch = line.match(
          /(✅|❌)(\d*)\s+([\d:.]+)\s+•\s+(.+?)\s+•\s+(Buy|Sell)/i
        );
        if (!tradeMatch) continue;

        const [, winSymbol, martingaleStr, time, pairRaw, action] = tradeMatch;
        const result = winSymbol === "✅" ? "Win" : "Loss";
        const martingale = martingaleStr ? parseInt(martingaleStr) : 0;
        const pair = pairRaw.replace(/[🇦-🇿]/g, "").replace(/OTC/gi, "").trim();

        // Convert to UTC-4 timezone
        const timestamp = DateTime.now().setZone("UTC-4").toISO();

        const payload = {
          message_id: update.message.message_id,
          report_date: reportDate,
          session,
          time,
          pair,
          action,
          martingale,
          result,
          source: "Telegram",
          message: line,
          timestamp,
        };

        console.log("🧾 Parsed trade:", payload);

        const response = await fetch(`${SUPABASE_URL}/rest/v1/trades_data`, {
          method: "POST",
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          savedCount++;
          totalTrades++;
        } else {
          const errorText = await response.text();
          console.error("❌ Supabase insert failed:", errorText);
        }
      }

      // ✅ Send per-session confirmation
      if (savedCount > 0) {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: `✅ ${savedCount} trades imported from ${session} session.`,
          }),
        });
      }
    }

    // ✅ Final summary message
    if (totalTrades > 0) {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `✅ Total ${totalTrades} trades imported across all sessions.`,
        }),
      });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("💥 Telegram webhook error:", err);
    res.sendStatus(500);
  }
});

// 🌐 Health check
app.get("/", (req, res) => res.send("Atenza Telegram Sync running ✅"));
app.get("/healthz", (req, res) => res.sendStatus(200));

// 🚀 Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
