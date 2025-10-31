import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const TABLE_NAME = "trades"; // we’ll create it later

// ✅ Confirm server is online
app.get("/", (req, res) => res.send("Atenza Trading Telegram Sync running..."));

// ✅ Telegram Webhook endpoint
app.post(`/telegram/${TELEGRAM_BOT_TOKEN}`, async (req, res) => {
  const message = req.body.message;
  if (!message || !message.text) return res.sendStatus(200);

  try {
    const tradeText = message.text;

    // Insert to Supabase
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE_NAME}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify({ raw_text: tradeText, timestamp: new Date().toISOString() })
    });

    console.log("Trade saved:", tradeText);
  } catch (e) {
    console.error("Error saving trade:", e);
  }

  res.sendStatus(200);
});

app.listen(10000, () => console.log("Server running on port 10000"));
