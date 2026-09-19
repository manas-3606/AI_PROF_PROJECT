# AI.Prof Healthcare Platform - Free-Tier Cloud Deployment Guide

This guide provides step-by-step instructions for deploying the **AI.Prof Healthcare Platform** entirely within free-tier cloud resources:
- **Database**: [Supabase](https://supabase.com/) (Managed PostgreSQL free tier)
- **Frontend**: [Render](https://render.com/) Static Site (`@health/web` React + Vite SPA)
- **Backend**: [Render](https://render.com/) Web Service (`@health/api-server` Fastify API)
- **AI Clinical Agent**: [Google Gemini API](https://aistudio.google.com/) (Free Tier Gemini 2.5 Flash / Flash Lite)
- **Optional Services**:
  - **Mock EHR**: Render Web Service (`@health/mock-ehr`)
  - **Voice Gateway**: Render Web Service (`@health/voice-gateway` WebSocket server)

---

## Architecture Overview

```mermaid
graph TD
    Client["Browser / Mobile Client"] -->|HTTPS (Static Site)| Web["Render Static Site<br/>(@health/web)"]
    Client -->|HTTPS REST API / CORS| API["Render Web Service<br/>(@health/api-server)"]
    Client -->|WSS Real-Time Audio HUD| Voice["Render Web Service<br/>(@health/voice-gateway)"]
    API -->|Prisma Pooler / Direct| DB[("Supabase PostgreSQL<br/>(Free Tier)")]
    Voice -->|Prisma Pooler / Direct| DB
    API -->|REST (MOCK_EHR_URL)| EHR["Render Web Service<br/>(@health/mock-ehr)"]
    API -->|REST (GEMINI_API_KEY)| Gemini["Google Gemini API<br/>(Free Tier)"]
    Voice -->|WebSocket / REST| Gemini
    API -.->|In-Process Queue (Zero-Config)| Worker["Embedded Workflow Engine<br/>(No Redis Needed)"]
```

---

## A. GitHub Preparation

1. **Verify your local git status**:
   Ensure all personal secret files (such as `.env`) are ignored:
   ```bash
   git status
   ```
   Confirm that `.env` is NOT tracked. (Only `.env.example` and `apps/web/.env.example` should be tracked).

2. **Commit and push changes to GitHub**:
   ```bash
   git add .
   git commit -m "chore: configure project for public free-tier Render and Supabase deployment"
   git push origin main
   ```

---

## B. Supabase PostgreSQL Setup

1. **Sign up / Log in** to [Supabase](https://supabase.com/) (Free Tier).
2. Click **New Project**:
   - **Name**: `ai-prof-healthcare`
   - **Database Password**: Set a strong database password (store this securely).
   - **Region**: Select a region close to your Render deployment (e.g., `East US (North Virginia)` or `Frankfurt`).
   - **Pricing Plan**: Free.
3. Once the project is provisioned (approx. 1-2 minutes):
   - Navigate to **Project Settings** > **Database**.
   - Under **Connection Strings**, locate:
     - **Session / Direct Connection (Port 5432)**:
       `postgresql://postgres:[YOUR-PASSWORD]@db.[YOUR-PROJECT-REF].supabase.co:5432/postgres`
     - **Transaction Pooler (Port 6543)** (Recommended for serverless & ephemeral web services):
       `postgresql://postgres.[YOUR-PROJECT-REF]:[YOUR-PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?pgbouncer=true`
4. Copy your connection URL and replace `[YOUR-PASSWORD]` with your actual password.

---

## C. Database Initialization & Seeding

Before starting the web services on Render, deploy the schema and initial seed data to Supabase from your local terminal:

1. In your local `.env` (or in your terminal session), temporarily set `DATABASE_URL` to your Supabase PostgreSQL connection string:
   ```bash
   # Linux/macOS
   export DATABASE_URL="postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres"

   # Windows PowerShell
   $env:DATABASE_URL="postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres"
   ```

2. **Push the schema directly to PostgreSQL**:
   ```bash
   pnpm db:push
   ```
   > [!NOTE]
   > `pnpm db:push` uses Prisma's production-safe schema synchronization. It creates all tables, foreign key constraints, indexes, and unique constraints in your Supabase database without requiring destructive resets.

3. **Seed the initial healthcare data**:
   ```bash
   pnpm db:seed
   ```
   This populates:
   - 3 Partner Hospitals (Apex Health Center, Metro General Hospital, Riverside Community Hospital)
   - 6 Physicians with active calendars and booking slots
   - 6 Realistic Patient Profiles
   - 17 Standard Clinical AI Capabilities
   - Pre-visit clinical intake questionnaires
   - Default Administrator Account: `platform.admin@health.test` / `Password123!`

---

## D. Google Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey).
2. Click **Create API Key** (Free Tier).
3. Copy the generated key (`AIza...`).
4. Keep this key handy to input into Render environment variables.
   > [!CAUTION]
   > NEVER add `GEMINI_API_KEY` to the frontend or prefix it with `VITE_`. The Gemini key is used exclusively on the backend (`@health/api-server` and `@health/voice-gateway`).

---

## E. Render Service 1: Backend API (`@health/api-server`)

1. Go to your [Render Dashboard](https://dashboard.render.com/) and click **New +** > **Web Service**.
2. Connect your GitHub repository.
3. Configure the service settings:
   - **Name**: `ai-prof-api`
   - **Region**: Same region as Supabase (e.g., `Ohio (US East)` or `Oregon (US West)`)
   - **Branch**: `main`
   - **Root Directory**: Leave blank (monorepo root)
   - **Runtime**: `Node`
   - **Plan**: `Free`
   - **Build Command**:
     ```bash
     pnpm install --frozen-lockfile && pnpm db:generate && pnpm --filter @health/api-server build
     ```
   - **Start Command**:
     ```bash
     pnpm --filter @health/api-server start
     ```
   - **Health Check Path**: `/health` (Expected response: `{"status":"ok","service":"api-server"}`)

4. **Environment Variables**:
   Click **Add Environment Variable** and enter:
   | Key | Value | Description |
   | :--- | :--- | :--- |
   | `NODE_ENV` | `production` | Enables production mode |
   | `DATABASE_URL` | `postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres` | Supabase connection string |
   | `JWT_SECRET` | `generate-a-32-char-random-secret-key-here` | JWT auth secret |
   | `GEMINI_API_KEY` | `AIza...` | Google AI Studio API key |
   | `FRONTEND_URL` | `https://ai-prof-web.onrender.com` | Deployed Frontend Static Site URL (update once frontend is created) |
   | `MOCK_EHR_URL` | `https://ai-prof-mock-ehr.onrender.com` | (Optional) URL of deployed Mock EHR service |
   | `LOG_LEVEL` | `info` | Structured logger level |

5. Click **Deploy Web Service**.
6. Once deployed, note down your backend URL: e.g., `https://ai-prof-api.onrender.com`.

---

## F. Render Service 2: Frontend (`@health/web`)

1. In Render Dashboard, click **New +** > **Static Site**.
2. Select your repository.
3. Configure the static site settings:
   - **Name**: `ai-prof-web`
   - **Branch**: `main`
   - **Root Directory**: Leave blank (monorepo root)
   - **Build Command**:
     ```bash
     pnpm install --frozen-lockfile && pnpm --filter @health/web build
     ```
   - **Publish Directory**: `apps/web/dist`

4. **Environment Variables**:
   Under the **Environment** tab, set:
   | Key | Value | Description |
   | :--- | :--- | :--- |
   | `VITE_API_BASE_URL` | `https://ai-prof-api.onrender.com/api` | Points to your deployed API backend with `/api` path |
   | `VITE_VOICE_GATEWAY_WS_URL` | `wss://ai-prof-voice-gateway.onrender.com` | (Optional) Points to your deployed Voice Gateway |

5. **SPA Rewrite Rule (Single Page App Routing)**:
   - Go to **Redirects / Rewrites** in the left sidebar.
   - Click **Add Rule**:
     - **Source**: `/*`
     - **Destination**: `/index.html`
     - **Action**: `Rewrite`
   - Click **Save Changes**.

6. Click **Create Static Site**.
7. Note down the deployed frontend URL: e.g., `https://ai-prof-web.onrender.com`.
8. *Back-reference check*: Go back to `ai-prof-api` Web Service > **Environment** and verify that `FRONTEND_URL` matches your frontend URL (`https://ai-prof-web.onrender.com`).

---

## G. Render Service 3: Mock EHR (`@health/mock-ehr`) - *Optional*

If you want live downstream EHR synchronization and chaos testing:

1. In Render Dashboard, click **New +** > **Web Service**.
2. Configure:
   - **Name**: `ai-prof-mock-ehr`
   - **Runtime**: `Node`
   - **Plan**: `Free`
   - **Build Command**:
     ```bash
     pnpm install --frozen-lockfile && pnpm --filter @health/mock-ehr build
     ```
   - **Start Command**:
     ```bash
     pnpm --filter @health/mock-ehr start
     ```
   - **Health Check Path**: `/health` (Expected response: `{"status":"ok","service":"mock-ehr"}`)
3. **Environment Variables**:
   | Key | Value |
   | :--- | :--- |
   | `NODE_ENV` | `production` |
4. Click **Deploy Web Service**.

---

## H. Render Service 4: Voice Gateway (`@health/voice-gateway`) - *Optional*

If you want real-time browser WebSocket audio/voice HUD interaction:

1. In Render Dashboard, click **New +** > **Web Service**.
2. Configure:
   - **Name**: `ai-prof-voice-gateway`
   - **Runtime**: `Node`
   - **Plan**: `Free`
   - **Build Command**:
     ```bash
     pnpm install --frozen-lockfile && pnpm db:generate && pnpm --filter @health/voice-gateway build
     ```
   - **Start Command**:
     ```bash
     pnpm --filter @health/voice-gateway start
     ```
   - **Health Check Path**: `/health`
3. **Environment Variables**:
   | Key | Value |
   | :--- | :--- |
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | `postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres` |
   | `GEMINI_API_KEY` | `AIza...` |
4. Click **Deploy Web Service**.
5. Ensure `VITE_VOICE_GATEWAY_WS_URL` in your frontend static site points to `wss://ai-prof-voice-gateway.onrender.com`.

---

## I. Verification & Testing

Once all services are deployed, perform the following verification checks:

1. **Verify Backend Health**:
   ```bash
   curl -i https://your-api.onrender.com/health
   # Returns HTTP 200: {"status":"ok","service":"api-server"}
   ```

2. **Verify Frontend Access**:
   Open `https://your-frontend.onrender.com` in your browser.
   - The AI.Prof login screen will render with tenant and demo persona options.

3. **Verify Authentication & Supabase Connectivity**:
   - Log in as Platform Admin:
     - **Email**: `platform.admin@health.test`
     - **Password**: `Password123!`
   - You should see the Platform Governance dashboard with hospitals and doctor rosters populated from Supabase.

4. **Verify AI Agent Chat (Gemini API)**:
   - Switch to or log in as Patient:
     - **Email**: `jane.doe@patient.test`
     - **Password**: `Password123!`
   - Open the Patient Assistant / Intake chat window.
   - Ask: `"I need to see an orthopedic specialist for shoulder discomfort."`
   - Verify that Gemini classifies the request, retrieves Dr. Arvind Rao's schedule, and proposes available booking slots.

---

## J. Free-Tier Limitations & Troubleshooting

### 1. Render Free-Tier Spin-Down (Cold Starts)
- **Behavior**: Free Web Services on Render automatically spin down after 15 minutes of inactivity. The first request after spin-down may experience a 30 to 60-second delay while the container boots up.
- **Handling**: The frontend includes retry and loading indicators. Simply wait ~45 seconds on initial access.

### 2. Supabase Free-Tier Pausing
- **Behavior**: Supabase free-tier projects pause after 1 week of zero query activity.
- **Handling**: If the database pauses, log in to the Supabase Dashboard and click **Restore Project** (takes ~1 minute).

### 3. Asynchronous Workflows Without Redis
- **Behavior**: The application runs an embedded in-process event scheduler when `REDIS_URL` is empty. Workflows and reminders run within the Fastify process.
- **Recommendation**: If Render spins down the backend container, scheduled reminders in memory pause until the next container start. For mission-critical background workers, provision an Upstash free Redis instance and configure `REDIS_URL`.

### 4. CORS Errors in Browser Console
- **Symptom**: `Cross-Origin Request Blocked` or `CORS header 'Access-Control-Allow-Origin' missing`.
- **Fix**: Check `FRONTEND_URL` on the `ai-prof-api` Web Service. Ensure it matches your Render Static Site URL (e.g. `https://ai-prof-web.onrender.com`) without a trailing slash.
