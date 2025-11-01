import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();
app.use(bodyParser.json());

// --- CONFIG --- //
const SUPABASE_URL = "https://qlnryzyxbxkjooiwzbxh.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFsbnJ5enl4Ynhram9vaXd6YnhoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE5NDI2MDgsImV4cCI6MjA3NzUxODYwOH0.zsWCjSW3tAlIozBqx9C7q0V29GL6cT-Hr-BbudRhEm8";
const TELEGRAM_TOKEN = "8428884587:AAFmiTY0gPtH0kenAgxmi71n26Wqbg46oHA";

// --- SUPABASE SAVE FUNCTION --- //
async function saveTrade(messageText) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/trades`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: messageText,
      timestamp: new Date().toISOString()
    })
  });
  console.log("Trade saved:", await response.text());
}

// --- TELEGRAM WEBHOOK --- //
app.post(`/telegram/${TELEGRAM_TOKEN}`, async (req, res) => {
  try {
    const msg = req.body.message;
    if (msg && msg.text) {
      console.log("New trade received:", msg.text);
      await saveTrade(msg.text);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("Error:", err);
    res.sendStatus(500);
  }
});

app.get("/", (req, res) => res.send("✅ Atenza Telegram Sync is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
