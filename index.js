bot.on("message", async (msg) => {
  const text = msg.text || "";
  const chat = msg.chat?.title || msg.chat?.username || msg.chat?.id;

  console.log("📩 New message:", text.slice(0, 60), "...");
  console.log("👤 From:", chat);

  // Only process "Daily Report" or misspelled versions
  if (!/daily\s*report|dialy\s*report/i.test(text)) {
    console.log("⏭ Not a daily report, skipped.");
    return;
  }

  try {
    const reportDateMatch = text.match(/🗓\s*(.+)/);
    const reportDate = reportDateMatch ? reportDateMatch[1].trim() : null;

    // Detect session blocks dynamically
    const sessionBlocks = text.split(/🌑|🌤|☀️|🌙/g).slice(1);
    const sessionTitles = ["Overnight Session", "Morning Session", "Afternoon Session", "Night Session"];

    for (let i = 0; i < sessionBlocks.length; i++) {
      const sessionName = sessionTitles[i];
      const lines = sessionBlocks[i]
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("✅") || l.startsWith("❌"));

      for (const line of lines) {
        // Regex for ✅⁰ 00:35 • 🇪🇺 EUR/USD 🇺🇸 OTC • Buy
        const tradeMatch = line.match(/(✅|❌)[⁰¹²³]?\s*(\d{2}:\d{2}).*?([A-Z]{3}\/[A-Z]{3}).*?(Buy|Sell)/i);
        if (!tradeMatch) {
          console.log("❌ Skipped unmatched line:", line);
          continue;
        }

        const result = tradeMatch[1] === "✅" ? "win" : "loss";
        const time = tradeMatch[2];
        const pair = tradeMatch[3];
        const action = tradeMatch[4];
        const martingaleMatch = line.match(/⁰|¹|²|³/);
        const martingale = martingaleMatch ? "⁰¹²³".indexOf(martingaleMatch[0]) : 0;

        const { error } = await supabase.from("trades_data").insert([
          {
            message_id: msg.message_id,
            report_date: reportDate,
            session: sessionName,
            time,
            pair,
            action,
            martingale,
            result,
            source: chat,
            message: text,
          },
        ]);

        if (error) console.error("❌ Supabase insert error:", error);
        else console.log(`✅ Saved: ${pair} ${action} (${sessionName})`);
      }
    }
  } catch (err) {
    console.error("⚠️ Parse error:", err);
  }
});
