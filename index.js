import express from "express";
import axios from "axios";
import { DateTime } from "luxon";

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Log basic startup
console.log("✅ Starting Atenza Telegram Sync...");

// 🧠 Detect daily report messages (allow typos like “Dialy”)
const DAILY_REPORT_REGEX = /🧾\s*(DAILY|DIALY)\s*REPORT/i;

// 🧩 Parse trades from a report message
function parseTrades(messageText) {
  const lines = messageText.split("\n").map(l => l.trim());
  const trades = [];

  let currentSession = null;
  let currentDate = null;

  for (const line of lines) {
    if (line.startsWith("🗓")) {
      const match = line.match(/🗓 (.*)/);
      if (match) {
        currentDate = match[1];
      }
    } else if (line.match(/(🌑|🌤|☀️|🌙)/)) {
      const sessionMatch = line.match(/(🌑|🌤|☀️|🌙)\s*(.*)/);
      if (sessionMatch) {
        currentSession = sessionMatch[2].trim();
      }
    } else if (line.startsWith("✅") || line.startsWith("❌")) {
      const match = line.match(/(✅|❌)(\d*)\s+([\d:]+)\s+•\s+(.*?)\s+OTC\s+•\s+(Buy|Sell)/i);
