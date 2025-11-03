import express from "express";
import { Telegraf } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";

// === Environment Variables ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 10000;

// === Safety Checks ===
if (!TELEGRAM_TOKEN) {
  console.error("❌ Error: TELEGRAM_BOT_TOKEN not provided!");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Error: Supabase credentials missing!");
  process.exit(1);
}

// === Initialize Clients ===
const app = express();
app.use(express.json());

const bot = new Telegraf(TELEGRAM_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// === Health Check Endpoint ===
app.get("/", (req, res) => {
  res.status(200).send("✅ Atenza Telegram Sync is live!");
});

// === Telegram Webhook ===
bot.on("message", async (ctx) => {
  try {
    const text = ctx.message.text?.trim();
    if (!text) return;

    console.log("New trade received:", text.slice(0, 50));

    // Detect daily report messages
    if (text.includes("DIALY REPORT")) {
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      const dateLine = lines.find((l) => l.includes("🗓"));
      const reportDate = dateLine
        ? DateTime.fromFormat(dateLine.replace("🗓", "").trim(), "cccc, LLLL d'th', yyyy").toISODate()
        : null;

      // Extract trade lines
      const tradeLines = lines.filter((l) => l.match(/^✅/));
      let inserted = 0;

      for (const line of tradeLines) {
        const match = line.match(/^✅(\S*) (\d{2}:\d{2}) • .* ([A-Z]{3}\/[A-Z]{3}) .* • (Buy|Sell)/);
        if (match) {
          const [, martingale, time, pair, action] = match;
          const trade = {
            message_id: ctx.message.message_id,
            report_date: reportDate,
            session: "Auto",
            time,
            pair,
            action,
            martingale,
            result: "✅",
            source: "telegram",
            message: text,
          };

          const { error } = await supabase.from("trades_data").insert([trade]);
          if (!error) inserted++;
          else console.error("Supabase insert error:", error.message);
        }
      }

      console.log(`Trade saved: ${inserted} inserted`);
      await ctx.reply(`✅ ${inserted} trades imported successfully.`);
    }
  } catch (err) {
    console.error("Error processing message:", err);
  }
});

// === Start Server and Set Webhook ===
app.use(bot.webhookCallback(`/bot${TELEGRAM_TOKEN}`));

bot.telegram
  .setWebhook(`${WEBHOOK_URL}/bot${TELEGRAM_TOKEN}`)
  .then(() => console.log("✅ Telegram webhook set successfully."))
  .catch((err) => console.error("❌ Error setting webhook:", err.message));

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
