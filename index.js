import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const TABLE_NAME = "trades";

app.get("/", (req, res) => res.send("✅ Atenza Trading Sync is Live"));

app.post(`/telegram/${TELEGRAM_BOT_TOKEN}`, async (req, res) => {
  const msg = req.body.message;
  if (!msg || !msg.text) return res.sendStatus(200);

  const tradeText = msg.text;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${TABLE_NAME}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify({
        raw_text: tradeText,
        message_id: msg.message_id,
        chat_id: msg.chat.id,
        date: new Date().toISOString()
      })
    });
    console.log("✅ Trade saved:", tradeText.slice(0, 50));
  } catch (err) {
    console.error("❌ Error saving trade:", err);
  }
  res.sendStatus(200);
});

app.listen(10000, () => console.log("Server running on port 10000"));
