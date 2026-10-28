# Tracking server (optional)

Open and click tracking needs a public URL that email clients can load. This folder contains a
Supabase Edge Function that records opens/clicks and returns per-campaign stats to the extension.
Only campaign/recipient IDs, timestamps and clicked URLs are stored; no email content or addresses.

## Deploy

```bash
cd server
supabase link --project-ref <your-project-ref>
supabase db push
supabase functions deploy mm-track --no-verify-jwt
```

Then set `TRACKING_URL` in `extension/config.js` to
`https://<your-project-ref>.supabase.co/functions/v1/mm-track` and reload the extension.
