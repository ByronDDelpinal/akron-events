# The 330 — Akron & Summit County Events

## Local development setup

### 1. Clone and install
```bash
git clone <your-repo-url>
cd akron-events
npm install
```

### 2. Set up Supabase
1. Create a project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** and run the contents of `supabase/migrations/001_initial_schema.sql`
3. Go to **Settings → API** and copy your Project URL and `anon` key

### 3. Configure environment
```bash
cp .env.example .env
# Fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
```

### 4. Run
```bash
npm run dev
# → http://localhost:5173
```

## Supabase notes
- Row Level Security (RLS) is enabled. Public visitors can only read `published` events.
- To publish a submitted event: open the Supabase table editor → `events` table → change `status` from `pending_review` to `published`.
- The `anon` key is safe to expose in the browser — RLS ensures read-only public access.

## Stack
- **Frontend**: React 18 + Vite
- **Database / Auth / API**: Supabase (PostgreSQL)
- **Routing**: React Router v6
- **Dates**: date-fns
- **Fonts**: Space Grotesk + DM Sans (Google Fonts)
- **Hosting** (production): Vercel + Supabase cloud
