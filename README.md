# Konvex AI Bot

Internal Slack support assistant for the Konvex team, powered by Azure OpenAI.

## Setup

### 1. Slack App Configuration

Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps):

- **Socket Mode**: Enable and generate an App-Level Token (`xapp-...`) with `connections:write` scope
- **Event Subscriptions**: Enable and subscribe to:
  - `app_mention`
  - `message.im`
- **OAuth Scopes** (Bot Token):
  - `app_mentions:read`
  - `chat:write`
  - `im:history`
  - `im:read`
  - `reactions:write`
- Install the app to your workspace and copy the Bot Token (`xoxb-...`)

### 2. Environment Variables

Copy `.env` and fill in your values:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
AZURE_OPENAI_ENDPOINT=https://konvex-ai-openai.openai.azure.com/
AZURE_OPENAI_KEY=...
AZURE_OPENAI_DEPLOYMENT=gpt-5.4-mini
```

### 3. Install & Run

```bash
npm install
npm start
```

## Usage

- **@Konvex AI [question]** — ask anything about Konvex integrations
- **@Konvex AI help** — show capabilities
- **@Konvex AI learn: [solution]** — save a confirmed solution
- **DM the bot** — same as mentioning, no @ needed

## Knowledge Base

The bot learns from every interaction. Q&A pairs are saved to `knowledge.json` and searched before calling Azure OpenAI. Confirmed solutions can be added manually with the `learn:` command.
