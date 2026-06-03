# Myko Ops Hub — Setup Guide

## 1. Supabase

1. Go to [supabase.com](https://supabase.com) → New project
2. In **SQL Editor**, run the full contents of `backend/supabase/schema.sql`
3. In **Authentication → Users**, create 3 users:
   - Myko: email + password → after creating, run SQL:
     `UPDATE profiles SET role='admin' WHERE id='<user-id>';`
   - Abigél: email + password → role='approver'
   - Team member: role='viewer'
4. Copy your **Project URL** and **anon public key** (Settings → API) and **service_role key**

## 2. Backend (Railway)

1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
2. Set root directory to `backend/`
3. Add environment variables:
   ```
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   FRONTEND_URL=https://your-vercel-app.vercel.app
   NODE_ENV=production
   PORT=3001
   ```
4. Deploy — Railway will run `npm install && npm run build && npm start`
5. Copy the Railway service URL (e.g. `https://myko-hub-backend.up.railway.app`)

## 3. Seed existing Excel data

After Railway is deployed, or locally with a `.env` file:

```bash
cd backend
cp .env.example .env
# Fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
npm install
npm run seed
```

## 4. Frontend (Vercel)

1. Go to [vercel.com](https://vercel.com) → New Project → Import GitHub repo
2. Set root directory to `frontend/`
3. Add environment variables:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
   NEXT_PUBLIC_API_URL=https://your-railway-service.up.railway.app
   ```
4. Deploy

## 5. Local development

```bash
# Terminal 1 — backend
cd backend
cp .env.example .env   # fill in values
npm install
npm run dev            # runs on http://localhost:3001

# Terminal 2 — frontend
cd frontend
cp .env.local.example .env.local   # fill in values
npm install
npm run dev            # runs on http://localhost:3000
```

## Verification checklist

- [ ] Supabase: table editor shows builds, mistakes, settings rows after seed
- [ ] Backend health: GET https://your-railway.up.railway.app/health → `{"ok":true}`
- [ ] Login: Myko can sign in, sees full sidebar
- [ ] Dashboard: KPI cards show cycle times matching the spreadsheet
- [ ] Proofread Queue: shows 6 builds (the ones in Phase 2 from the seed)
- [ ] Jewelry Tracker: Week 1 shows 9 builds
- [ ] Abigél: can view everything, cannot delete builds (403)
