// index.js
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();
app.use(bodyParser.json());

// Environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const SUPABASE_TABLE = "trades";

app.get("/", (req, res) => res.send("✅ Atenza Telegram Sync running"));

// Telegram webhook endpoint
app.post(`/telegram/${TELEGRAM_BOT_TOKEN}`, async (req, res) => {
  try {
    const update = req.body;

    // check if message exists
    if (!update.message || !update.message.text) {
      return res.status(200).send("No message");
    }

    const text = update.message.text.trim();
    const user = update.message.from?.username || "Unknown";
    console.log(`📩 Message from @${user}: ${text}`);

    // detect trade lines only
    if (text.match(/(BUY|SELL|Sell|Buy)/i)) {
      console.log("✅ Trade detected — saving to Supabase...");

      const payload = {
        message_text: text,
        telegram_user: user,
        created_at: new Date().toISOString(),
      };

      const resInsert = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Prefer": "return=representation",
        },
        body: JSON.stringify(payload),
      });

      if (!resInsert.ok) {
        const err = await resInsert.text();
        console.error("❌ Supabase insert failed:", err);
      } else {
        console.log("✅ Trade saved successfully!");
      }
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("❌ Error in webhook:", err);
    res.status(200).send("error");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
