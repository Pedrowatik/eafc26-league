# EAFC 26 Custom Fantasy League — standalone app

This is your fantasy league manager (squads, transfers, live auctions, standings, chat) as a
real, deployable web app — no longer dependent on Claude.ai. It uses **Supabase** as its
database, so everyone using the app sees the same live data with real real-time sync.

## What you're getting

- A React app (built with Vite) — the same app you had, restructured into a proper project
- Real-time sync via Supabase, instead of the ~8 second polling the Claude artifact version used
- A PWA setup, so people can "Add to Home Screen" on their phones and it opens like a real app
- No Claude.ai dependency at all once it's set up

## One-time setup (about 15 minutes)

### 1. Create a free Supabase project

1. Go to [supabase.com](https://supabase.com) and sign up (free tier is plenty for this)
2. Click **New Project**. Pick any name/password/region (save the DB password somewhere, though
   you won't need it for this app)
3. Wait ~2 minutes for the project to finish setting up

### 2. Create the database table

1. In your Supabase project, go to the **SQL Editor** (left sidebar)
2. Click **New query**
3. Open `supabase_schema.sql` from this project, copy its entire contents, paste into the editor
4. Click **Run**

That's it — this creates the one table the app needs and turns on real-time sync.

### 3. Get your API keys

1. In Supabase, go to **Settings** (gear icon) → **API**
2. You need two values: **Project URL** and the **anon public** key (NOT the `service_role` key —
   never expose that one in client-side code)

### 4. Configure the app

1. In this project folder, copy `.env.example` to a new file called `.env`
2. Paste in your Project URL and anon key:
   ```
   VITE_SUPABASE_URL=https://your-project-id.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-public-key
   ```

### 5. Run it locally to check it works

```bash
npm install
npm run dev
```

Open the URL it prints (usually `http://localhost:5173`). You should see the app load with the
default 10 teams. Open it in a second browser tab and make a change (e.g. add a fixture) — the
other tab should update within a second or two, with no page refresh. That's real-time sync working.

## Deploying so other people can actually use it

The easiest option is **Vercel** (free for this):

1. Push this project to a GitHub repository
2. Go to [vercel.com](https://vercel.com), sign up, click **Add New → Project**, and import your
   GitHub repo
3. Vercel will detect it's a Vite project automatically. Before deploying, add your environment
   variables: in the import screen (or later under Project → Settings → Environment Variables),
   add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` with the same values from your `.env` file
4. Click **Deploy**

You'll get a real URL (like `your-league.vercel.app`) that anyone can open. Every time you push
a change to GitHub, Vercel redeploys automatically.

(Netlify works the same way if you'd rather use that instead.)

## Making it feel like a real app on phones

Once deployed, open the Vercel URL on a phone:

- **iPhone (Safari):** Share button → "Add to Home Screen"
- **Android (Chrome):** Menu (⋮) → "Add to Home Screen" or "Install app"

It'll show up with its own icon and open full-screen, no browser bar — this works because of the
PWA setup already included in this project.

## About security

This app still uses the same admin PIN system from before (default `2026`, changeable in the
Rules tab) — that's a light deterrent for a private friend group, not real per-user
authentication. The Supabase table is set up so anyone with your site's public "anon" key
(which is embedded in the deployed app, by design — that's normal for this kind of key) can read
and write the data. That's an intentional trade-off to keep this simple: if you ever want real
logins where each manager can only touch their own team, that's a bigger step up (Supabase
Auth) — let me know if you want to go there later.

## If something breaks

- **Blank page / console errors about Supabase:** almost always a missing or wrong `.env` file.
  Double check `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, and that you restarted
  `npm run dev` after creating `.env` (Vite only reads it on startup).
- **Data not syncing between tabs/devices:** check that you ran `supabase_schema.sql` fully,
  including the last line (`alter publication supabase_realtime add table league_kv;`) — that's
  what turns realtime on.
- **Proof photos not saving:** these are stored as compressed images inside the same database
  table, so nothing extra to configure — but very large images can still be slow on a poor
  connection. The app already compresses images client-side before saving.

## Project structure

```
├── src/
│   ├── App.jsx          — the whole app (same one from Claude, adapted for Supabase)
│   ├── storage.js        — the Supabase adapter (get/set/delete + realtime subscription)
│   ├── main.jsx          — React entry point
│   └── index.css         — Tailwind + global styles
├── supabase_schema.sql   — run this once in Supabase's SQL Editor
├── .env.example          — copy to .env and fill in your keys
├── vite.config.js        — build config + PWA setup
└── package.json
```
