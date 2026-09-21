##The steps, in order:

Clone the repo, cd worker and run npm install.
Generate a Firebase service account key and minify it to one line.
Copy .dev.vars.example to .dev.vars and fill in the three secrets, generating the encryption key with openssl.
Set ALLOWED_ORIGINS in wrangler.toml to your app's domain.
Optionally run it locally with npm run dev.
Log in to Cloudflare, set the three secrets with wrangler secret put, and run wrangler deploy.
Copy the frontend files into your app and set VITE_EMAIL_WORKER_URL to the Worker URL.
Deploy the Firestore rules.
Each user creates a Gmail App Password and connects it in Settings.
Watch wrangler tail while triggering a sync to check it works.
