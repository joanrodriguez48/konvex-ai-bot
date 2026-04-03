require("dotenv").config();
const { WebClient } = require("@slack/web-api");

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

const fs = require("fs");
const path = require("path");

const KNOWLEDGE_PATH = path.join(__dirname, "knowledge.json");

// --- Config ---
// Jorge's Slack user ID(s) — add more if needed
const JORGE_IDENTIFIERS = {
  displayNames: ["jorge", "jorge m", "jorge martinez"],
  // Add Jorge's Slack user ID here once known (e.g., "U01ABCDEF")
  userIds: [],
};

// Hardcoded client channels to ingest
const CHANNELS = [
  { id: "C084K03HEKA", name: "rindegastos-konvex" },
  { id: "C09SW5RBS56", name: "fonder-konvex" },
  { id: "C0AAQM61PC1", name: "jeeves-konvex" },
  { id: "C092MEKK5HP", name: "gigstack-konvex" },
  { id: "C085FQYL4R3", name: "nexxdi-konvex" },
  { id: "C09LW1BR021", name: "aindez-konvex" },
  { id: "C079XKDHJJC", name: "threxio-konvex" },
  { id: "C0943RMLH9C", name: "quantum-konvex" },
  { id: "C090UT764FL", name: "selaski-konvex" },
  { id: "C08FRE5DEU9", name: "loto-konvex" },
  { id: "C09238ZHXUZ", name: "khipu-konvex" },
  { id: "C0A8CUH84VC", name: "invoway-konvex" },
  { id: "C0AMFSR0LGK", name: "devkonvex2-0" },
];

// How far back to look (in days)
const LOOKBACK_DAYS = 90;

// --- Helpers ---
function loadKnowledge() {
  try {
    return JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function saveKnowledge(entries) {
  fs.writeFileSync(KNOWLEDGE_PATH, JSON.stringify(entries, null, 2));
}

function isDuplicate(existing, question, answer) {
  return existing.some(
    (e) =>
      e.question === question ||
      (e.answer === answer && e.source === "slack-ingest")
  );
}

async function joinChannel(channelId) {
  try {
    await slack.conversations.join({ channel: channelId });
  } catch (err) {
    // already_in_channel is fine, private channels may fail
    if (err.data?.error !== "already_in_channel") {
      throw err;
    }
  }
}

async function getUserMap() {
  const users = {};
  let cursor;

  do {
    const result = await slack.users.list({ limit: 200, cursor });
    for (const u of result.members) {
      users[u.id] = {
        name: (u.real_name || u.name || "").toLowerCase(),
        displayName: (u.profile?.display_name || "").toLowerCase(),
      };
    }
    cursor = result.response_metadata?.next_cursor;
  } while (cursor);

  return users;
}

function isJorge(userId, userMap) {
  if (JORGE_IDENTIFIERS.userIds.includes(userId)) return true;

  const user = userMap[userId];
  if (!user) return false;

  return JORGE_IDENTIFIERS.displayNames.some(
    (name) => user.name.includes(name) || user.displayName.includes(name)
  );
}

function isQuestion(text) {
  if (!text) return false;
  const t = text.trim();
  // Explicit question mark
  if (t.includes("?")) return true;
  // Common question starters (Spanish + English)
  const starters =
    /^(cómo|como|por qué|porque|qué|que|cuál|cual|dónde|donde|cuándo|cuando|hay|existe|se puede|es posible|alguien sabe|how|why|what|where|when|can|does|is there|has anyone)/i;
  if (starters.test(t)) return true;
  // Error-related messages are implicit questions
  const errorPatterns = /\b(error|falla|problema|issue|bug|no funciona|doesn't work|failed|timeout|401|400|403|404|500|504)\b/i;
  if (errorPatterns.test(t)) return true;
  return false;
}

async function getThreadReplies(channel, threadTs) {
  const replies = [];
  let cursor;

  do {
    const result = await slack.conversations.replies({
      channel,
      ts: threadTs,
      limit: 200,
      cursor,
    });
    replies.push(...result.messages);
    cursor = result.response_metadata?.next_cursor;
  } while (cursor);

  // Remove the parent message (first reply is the parent in threads)
  return replies.slice(1);
}

async function getMessages(channelId, oldest) {
  const messages = [];
  let cursor;

  do {
    const result = await slack.conversations.history({
      channel: channelId,
      oldest: String(oldest),
      limit: 200,
      cursor,
    });
    messages.push(...result.messages);
    cursor = result.response_metadata?.next_cursor;
  } while (cursor);

  return messages;
}

function cleanText(text) {
  return text
    .replace(/<@[A-Z0-9]+>/g, "") // remove mentions
    .replace(/<(https?:\/\/[^|>]+)\|?[^>]*>/g, "$1") // clean links
    .replace(/```[\s\S]*?```/g, (m) => m) // keep code blocks as-is
    .trim();
}

// --- Main ingestion ---
async function ingest() {
  console.log("🔍 Starting Slack ingestion...\n");

  const userMap = await getUserMap();

  // Identify Jorge
  const jorgeIds = Object.entries(userMap)
    .filter(([id]) => isJorge(id, userMap))
    .map(([id, u]) => ({ id, name: u.name }));

  if (jorgeIds.length === 0) {
    console.log(
      "⚠️  Could not identify Jorge in the workspace.\n" +
        "   Add his Slack user ID to JORGE_IDENTIFIERS.userIds in the script.\n" +
        "   Continuing anyway — will match by display name patterns.\n"
    );
  } else {
    console.log(`✅ Identified Jorge: ${jorgeIds.map((j) => `${j.name} (${j.id})`).join(", ")}\n`);
  }

  console.log(`📢 Scanning ${CHANNELS.length} channel(s)...\n`);

  const oldest = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
  const knowledge = loadKnowledge();
  let added = 0;
  let skipped = 0;

  for (const channel of CHANNELS) {
    console.log(`  #${channel.name}...`);
    let channelAdded = 0;

    try {
      const messages = await getMessages(channel.id, oldest);

      for (const msg of messages) {
        // Skip bot messages
        if (msg.bot_id || msg.subtype) continue;

        const questionText = cleanText(msg.text || "");
        if (!isQuestion(questionText)) continue;

        // Check thread for Jorge's reply
        if (!msg.reply_count || msg.reply_count === 0) continue;

        const replies = await getThreadReplies(channel.id, msg.ts);
        const jorgeReply = replies.find((r) => isJorge(r.user, userMap) && !r.bot_id);

        if (!jorgeReply) continue;

        const answerText = cleanText(jorgeReply.text || "");
        if (!answerText || answerText.length < 20) continue;

        // Check for duplicates
        if (isDuplicate(knowledge, questionText, answerText)) {
          skipped++;
          continue;
        }

        knowledge.push({
          question: questionText,
          answer: answerText,
          source: "slack-ingest",
          channel: channel.name,
          timestamp: new Date(parseFloat(jorgeReply.ts) * 1000).toISOString(),
        });

        channelAdded++;
        added++;
      }

      console.log(`    → ${channelAdded} Q&A pairs found`);

      // Rate limit: small pause between channels
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      const slackError = err.data?.error || err.message;
      if (slackError === "not_in_channel") {
        console.log(`    → skipped (bot not in channel — invite the bot or add channels:join scope)`);
      } else if (slackError === "missing_scope") {
        console.log(`    → missing scope: ${err.data?.needed || "unknown"} (have: ${err.data?.provided || "unknown"})`);
      } else {
        console.log(`    → error: ${slackError}`);
      }
    }
  }

  saveKnowledge(knowledge);

  console.log(`\n✅ Ingestion complete!`);
  console.log(`   Added: ${added} new Q&A pairs`);
  console.log(`   Skipped: ${skipped} duplicates`);
  console.log(`   Total knowledge base: ${knowledge.length} entries`);
}

ingest().catch((err) => {
  console.error("❌ Ingestion failed:", err.message);
  process.exit(1);
});
