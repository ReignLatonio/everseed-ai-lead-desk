# Everseed AI Lead Desk

An AI-powered lead CRM built by Reign Latonio with Claude for the Everseed Ventures Virtual Assistant assessment.

## Features

- **AI Lead Qualifier**: paste a company, job post or notes. AI scores fit (1 to 10), picks Reclu, Yolii, Retrain or Giobs, explains why, and adds the lead in one click.
- **AI email writer**: personalised intro and follow-up emails per lead.
- **AI call prep**: discovery questions and objection handling per lead.
- **Automation**: "Mark as sent" moves the stage, schedules the follow-up 3 days later and logs the activity. Stage changes set the next step automatically.
- **Dashboard**: reply rate, demos booked, Today's actions (overdue follow-ups) and an AI daily briefing.
- **Pipeline board** with drag and drop, searchable leads table, CSV export.

Leads are saved in the browser (localStorage). Each visitor starts with the same 10 verified leads.

## Project structure

```
index.html     the app (no build step)
api/ai.js      Vercel serverless function that calls the AI; keeps the API key secret
package.json
```

## Deploy on Vercel

1. Push this folder to a GitHub repository.
2. In Vercel: **Add New > Project**, import the repository, leave every setting as default, click **Deploy**.
3. In the project: **Settings > Environment Variables**, add ONE of:
   - `ANTHROPIC_API_KEY` (Claude key from console.anthropic.com), or
   - `GEMINI_API_KEY` (Google key from aistudio.google.com, free tier available)
4. Optional: add `ACCESS_CODE` (any word). Visitors must enter it before using the AI, which protects your API credits.
5. **Deployments > ... > Redeploy** so the new variables take effect.

The page checks `/api/ai` on load. If no key is set, the CRM still works and the AI buttons stay hidden.
