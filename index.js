require("dotenv").config();
const { App } = require("@slack/bolt");
const { AzureOpenAI } = require("openai");
const fs = require("fs");
const path = require("path");

// --- Azure OpenAI setup ---
const openai = new AzureOpenAI({
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  apiKey: process.env.AZURE_OPENAI_KEY,
  apiVersion: "2024-02-01",
});
const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;

// --- Slack setup (Socket Mode) ---
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
});

// --- Knowledge base ---
const KNOWLEDGE_PATH = path.join(__dirname, "knowledge.json");

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

function searchKnowledge(question) {
  const entries = loadKnowledge();
  const words = question.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  let best = null;
  let bestScore = 0;

  for (const entry of entries) {
    const target = `${entry.question} ${entry.answer}`.toLowerCase();
    const score = words.filter((w) => target.includes(w)).length / Math.max(words.length, 1);
    if (score > bestScore && score >= 0.5) {
      best = entry;
      bestScore = score;
    }
  }

  return best;
}

function addToKnowledge(question, answer, source = "ai") {
  const entries = loadKnowledge();
  entries.push({
    question,
    answer,
    source,
    timestamp: new Date().toISOString(),
  });
  saveKnowledge(entries);
}

// --- System prompt ---
const SYSTEM_PROMPT = `You are Konvex AI, an expert internal support assistant for Konvex — a unified API integration platform connecting ERPs and accounting systems.

Current connectors include: SAP B1, SAP S/4HANA, Siigo, NetSuite, Zoho Books, FreshBooks, Holded, Xero, Sage Business Cloud, Wave, QuickBooks, Dynamics 365, Odoo, Bejerman — and more being added continuously.

You help the Konvex support team answer client questions quickly.
You know:
- Konvex API base URL: https://api.getkonvex.com/core/api
- Auth headers: x-connection, x-secret, x-software, x-db, x-url, x-user, x-apikey
- Common errors:
  * 401 → bad credentials or wrong x-secret
  * 400 → bad request, check Content-Type (never send on GET requests)
  * 504 → timeout or IP not whitelisted in ERP firewall
  * 403 → insufficient permissions in ERP
- SAP errors often relate to IP whitelisting or wrong DB name
- Siigo: cannot mix cash and credit payment in same invoice (policy change)
- Wave: requires Pro plan for OAuth — free plan blocked
- Holded: docType for purchase invoices is 'purchase' not 'bill'
- Holded: never send Content-Type header on GET requests
- NetSuite: requires netsuite.fullname field when creating customers
- Xero: OAuth callback must be /callback not /oauth/callback
- Zoho: organization_id auto-discovered via /organizations endpoint
- When a new ERP question comes in that you don't know — say so honestly and suggest escalating to Jorge (head of integrations)

Always respond in the same language as the question (Spanish or English).
Keep responses concise and actionable. Include curl examples when helpful.
When you don't know something, say so — never invent API behavior.`;

// --- Help text ---
const HELP_TEXT = `*Konvex AI* — Internal Support Assistant :robot_face:

I can help with:
• *API endpoints* — which endpoints exist for each ERP
• *Error explanations* — translate cryptic ERP errors to plain language
• *Integration troubleshooting* — timeout, 401, 400, 504 errors
• *ERP-specific quirks* — for all Konvex connectors
• *Konvex API usage* — headers, auth, request format

*Commands:*
• \`@Konvex AI help\` — show this message
• \`@Konvex AI learn: [solution]\` — save a confirmed solution to the knowledge base

Just ask me anything about Konvex integrations!`;

// --- Azure OpenAI call ---
async function askAI(question) {
  const response = await openai.chat.completions.create({
    model: deployment,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: question },
    ],
    max_completion_tokens: 1024,
    temperature: 0.3,
  });

  return response.choices[0].message.content;
}

// --- Process a question ---
async function handleQuestion(question) {
  // Check knowledge base first
  const cached = searchKnowledge(question);
  if (cached) {
    return {
      answer: cached.answer,
      fromKnowledge: true,
    };
  }

  // Call Azure OpenAI
  const answer = await askAI(question);

  // Save to knowledge base
  addToKnowledge(question, answer, "ai");

  return { answer, fromKnowledge: false };
}

// --- Strip bot mention from message text ---
function stripMention(text) {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

// --- Handle app_mention events ---
app.event("app_mention", async ({ event, client, say }) => {
  const text = stripMention(event.text);

  // Add eyes reaction to show we're processing
  try {
    await client.reactions.add({
      channel: event.channel,
      name: "eyes",
      timestamp: event.ts,
    });
  } catch {}

  try {
    // Handle "help" command
    if (/^\s*help\s*$/i.test(text)) {
      await say({ text: HELP_TEXT, thread_ts: event.ts });
      await client.reactions.add({ channel: event.channel, name: "white_check_mark", timestamp: event.ts });
      return;
    }

    // Handle "learn:" command
    const learnMatch = text.match(/^learn:\s*(.+)/is);
    if (learnMatch) {
      const solution = learnMatch[1].trim();
      addToKnowledge(`Learned solution`, solution, "human");
      await say({ text: `:brain: Solution saved to knowledge base!\n>${solution}`, thread_ts: event.ts });
      await client.reactions.add({ channel: event.channel, name: "white_check_mark", timestamp: event.ts });
      return;
    }

    // Handle regular question
    if (!text) {
      await say({ text: "Hey! Ask me anything about Konvex integrations. Type `@Konvex AI help` for more info.", thread_ts: event.ts });
      return;
    }

    const { answer, fromKnowledge } = await handleQuestion(text);
    const prefix = fromKnowledge ? ":file_folder: *From knowledge base:*\n\n" : "";
    await say({ text: `${prefix}${answer}`, thread_ts: event.ts });

    await client.reactions.add({ channel: event.channel, name: "white_check_mark", timestamp: event.ts });
  } catch (error) {
    console.error("Error handling mention:", error);
    await say({ text: `:warning: Something went wrong: ${error.message}`, thread_ts: event.ts });
  }
});

// --- Handle DMs ---
app.event("message", async ({ event, client, say }) => {
  // Only handle DMs (im channel type), ignore bot messages and subtypes
  if (event.channel_type !== "im" || event.bot_id || event.subtype) return;

  const text = (event.text || "").trim();

  // Add eyes reaction
  try {
    await client.reactions.add({
      channel: event.channel,
      name: "eyes",
      timestamp: event.ts,
    });
  } catch {}

  try {
    // Handle "help" command
    if (/^\s*help\s*$/i.test(text)) {
      await say({ text: HELP_TEXT, thread_ts: event.ts });
      await client.reactions.add({ channel: event.channel, name: "white_check_mark", timestamp: event.ts });
      return;
    }

    // Handle "learn:" command
    const learnMatch = text.match(/^learn:\s*(.+)/is);
    if (learnMatch) {
      const solution = learnMatch[1].trim();
      addToKnowledge(`Learned solution`, solution, "human");
      await say({ text: `:brain: Solution saved to knowledge base!\n>${solution}`, thread_ts: event.ts });
      await client.reactions.add({ channel: event.channel, name: "white_check_mark", timestamp: event.ts });
      return;
    }

    if (!text) return;

    const { answer, fromKnowledge } = await handleQuestion(text);
    const prefix = fromKnowledge ? ":file_folder: *From knowledge base:*\n\n" : "";
    await say({ text: `${prefix}${answer}`, thread_ts: event.ts });

    await client.reactions.add({ channel: event.channel, name: "white_check_mark", timestamp: event.ts });
  } catch (error) {
    console.error("Error handling DM:", error);
    await say({ text: `:warning: Something went wrong: ${error.message}`, thread_ts: event.ts });
  }
});

// --- Start the bot ---
(async () => {
  await app.start();
  console.log("⚡ Konvex AI bot is running!");
})();
