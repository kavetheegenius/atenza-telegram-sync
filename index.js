import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();
app.use(bodyParser.json());

const SUPABASE_URL = "https://qlnryzyxbxkjooiwzbxh.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFsbnJ5enl4Ynhram9vaXd6YnhoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE5NDI2MDgsImV4cCI6MjA3NzUxODYwOH0.zsWCjSW3tAlIozBqx9C7q0V29GL6cT-Hr-BbudRhEm8";

app.post("/telegram/:token", async (req, res) => {
  try {
    const msg = req.body.message;
    if (!msg || !msg.text) return res.sendStatus(200);
    const text = msg.text;

    // ✅ detect "Daily Report" even with typos like Dialy / DAIL / DIAL
    const isReport = /🧾\s*(DAI|DIA)[A-Z\s]*REPORT/i.test(text);
    if (!isReport) return res.sendStatus(200);

    console.log("📩 New Daily Report received!");

    // Extract date
    const dateMatch = text.match(/🗓\s*([^\n]+)/);
    const reportDate = dateMatch ? dateMatch[1].trim() : "Unknown Date";

    // Split sessions
    const sessions = text.split(/🌑|🌤|☀️|🌙/).slice(1); // skip intro
    const sessionNames = [...text.matchAll(/(🌑|🌤|☀️|🌙)\s*([A-Z\s]+)/gi)].map(m => m[2].trim());

    let allTrades = [];

    sessions.forEach((block, i) => {
      const session = sessionNames[i] || "Unknown Session";
      const lines = block.split("\n").filter(l => l.includes("•"));
      lines.forEach(line => {
        const tradeMatch = line.match(/(✅|❌)(\S*)\s*(\d{2}:\d{2})\s*•\s*([^•]+)•\s*(Buy|Sell)/i);
        if (tradeMatch) {
          const result = tradeMatch[1] === "✅" ? "Win" : "Loss";
          const martingale = tradeMatch[2].replace(/[^\d]/g, "") || "0";
          const time = tradeMatch[3];
          const pair = tradeMatch[4].replace(/[🇦-🇿]/g, "").trim();
          const action = tradeMatch[5];

          allTrades.push({
            message_id: msg.message_id,
            report_date: reportDate,
            session,
            time,
            pair,
            action,
            martingale,
            result,
            source: "Telegram",
            message: line.trim()
          });
        }
      });
    });

    if (allTrades.length > 0) {
      console.log(`📊 Found ${allTrades.length} trades in this report.`);

      const insert = await fetch(`${SUPABASE_URL}/rest/v1/trades`, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal"
        },
        body: JSON.stringify(allTrades)
      });

      if (!insert.ok) {
        const err = await insert.text();
        console.error("❌ Supabase insert failed:", err);
      } else {
        console.log("✅ Trades saved successfully!");
      }
    } else {
      console.log("⚠️ No valid trade lines found.");
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("❌ Error:", e);
    res.sendStatus(500);
  }
});

app.get("/", (_, res) => res.send("Atenza Telegram Sync Bot is live ✅"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
