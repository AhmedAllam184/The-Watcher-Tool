# Hosting The Watcher on Render

GitHub Actions builds the image; Render runs it. No API keys or login details
are in the repository, image, or built browser files. Render reads them at
startup. Browser keys reach only signed-in browsers; server keys stay on the server.
The host never builds at startup. Hugging Face Docker Spaces became paid in November 2026.

## 1. Build the image on GitHub

1. Push the approved changes to `claude/upbeat-volta-volh6b`, or open the
   repository's **Actions -> Deploy image -> Run workflow** on the desired branch.
2. Wait for the workflow to finish. It publishes
   `ghcr.io/ahmedallam184/the-watcher:latest` and a `sha-<short>` version.
3. After the first run, open your GitHub profile's **Packages -> the-watcher ->
   Package settings -> Change visibility -> Public**. The image contains no keys.
   Alternatively, keep it private and give Render a registry credential with package-read access.

## 2. Create the free service

1. Sign up at <https://render.com> using GitHub sign-in; choose the free option,
   with no card.
2. Choose **New -> Web Service -> Existing image** and enter
   `ghcr.io/ahmedallam184/the-watcher:latest`.
3. Select the **Free** instance. Leave the image's start command unchanged.
   Render sets `PORT`; the image defaults to 10000.
4. In **Environment**, add `GEV_LOGIN_USER` (your username) and
   `GEV_LOGIN_PASSWORD` (at least 12 characters). Without these the server refuses
   to start. Changing the password signs every device out.
5. Add the three browser keys you use: `GOOGLE_MAPS_API_KEY`, `CESIUM_ION_TOKEN`,
   `MAPILLARY_CLIENT_TOKEN`. Add each server setting that has a value in your
   PC's `.env`, using exactly the same names:
   `GOOGLE_MAPS_SERVER_API_KEY`, `OPENAI_API_KEY`, `OPENSKY_CLIENT_ID`,
   `OPENSKY_CLIENT_SECRET`, `AISSTREAM_API_KEY`, `FIRMS_MAP_KEY`, `ACLED_EMAIL`,
   `ACLED_KEY`, `TOMTOM_API_KEY`, `LL2_API_TOKEN`.
   Optional providers can remain blank. Never put values in GitHub files or build arguments.
6. Create the service. Open `https://<service-name>.onrender.com` and sign in.
   On your phone, use **Add to Home screen**. Sessions last 30 days.
   Sign out at `https://<service-name>.onrender.com/__watcher/logout`.

Render supplies its public hostname automatically. A custom domain also needs
`GEV_PUBLIC_HOST` set to that hostname (without `https://`).

The free service sleeps after about 15 minutes idle and takes about a minute
to wake. Check [Render's current free-plan page](https://render.com/docs/free)
for current limits. These plan details were supplied for this migration and
were not checked online during the offline implementation.

## 3. Connect automatic updates

In Render's service settings, copy the **Deploy Hook URL**. In the GitHub
repository open **Settings -> Secrets and variables -> Actions -> New repository
secret**, name it `RENDER_DEPLOY_HOOK_URL`, and paste the URL as its value.
After an image publishes successfully, Actions calls the hook. Without the
secret it quietly skips this step; you can deploy manually from Render.
A restart uses the existing image; publish and redeploy to update the code.
Use a `sha-<short>` image tag in Render to pin or roll back a version.

## 4. Put limits on every key that can cost money

Only two providers can charge you: **Google** and **OpenAI**. Every other key in
the list is a free tier with no card attached, so the worst case there is that
the feed stops for the rest of the day or month.

The app has its own per-minute throttles on the paid routes
(`GEV_RATELIMIT_OPENAI_PER_MIN`, default 30; `GEV_RATELIMIT_GOOGLE_PER_MIN`,
default 120). They are a speed bump, not a spending cap. The steps below are
the real caps.

### OpenAI (voice control, HUD summaries) — hard cap

1. <https://platform.openai.com> → **Settings → Billing**: use **prepaid
   credits** and turn **auto-recharge off**. You can then never spend more
   than the balance you loaded (for example $5).
2. **Settings → Limits** (or the project's limits): set a monthly budget and
   an email alert below it.
3. Best practice: create a separate **project** called "The Watcher (hosted)"
   and a new API key in it for Render, so you can revoke it without
   touching anything else.

### Google Maps Platform (3D tiles, place search, Street View) — hard cap

Budgets in Google Cloud only send alerts; **quotas** are what actually stop
spending. Google gives a monthly free allowance per API; set the quotas below
it.

1. <https://console.cloud.google.com> → **APIs & Services → Credentials**.
2. Browser key (`GOOGLE_MAPS_API_KEY`):
   - **Application restrictions → Websites**: add
     `https://<service-name>.onrender.com/*` and, if you also run it on your PC,
     `http://localhost:4173/*` and `http://127.0.0.1:4173/*`.
   - **API restrictions → Restrict key**: tick only **Map Tiles API** and
     **Geocoding API**.
3. Server key (`GOOGLE_MAPS_SERVER_API_KEY`, optional but recommended):
   **API restrictions** to **Places API (New)** and **Street View Static API**.
   (It cannot be restricted by IP address because Render's outbound addresses
   change, so the quotas in the next step matter most for it.)
4. **APIs & Services → Enabled APIs**, open each of Map Tiles API, Places API
   (New), Geocoding API and Street View Static API → **Quotas** → set
   **requests per day** to a number you are comfortable with (for one person,
   a few hundred to a couple of thousand per day each is plenty).
5. **Billing → Budgets & alerts**: add a monthly budget (for example $1) with
   email alerts at 50% and 100%, as an early warning.

### Cesium ion (3D terrain and imagery) — free, no card

At <https://ion.cesium.com/tokens> create a token with only the
**assets:read** scope and, under **Allowed URLs**, add your direct URL (and
`http://localhost:4173` for the PC). Use that token as `CESIUM_ION_TOKEN`.

### Free-tier feeds — no card, nothing to cap

AISStream, OpenSky, NASA FIRMS, ACLED, TomTom (its free tier needs no card, and
the app keeps TomTom under a daily ceiling by default), Launch Library and
Mapillary. If one of them is abused it simply stops answering until its limit
resets; you will not be charged.

## 5. What is protected

Every provider route and static file passes the sign-in gate. Unauthenticated
page navigation redirects to the login form; other requests receive 401.
Runtime browser keys are inserted as escaped, inert JSON into authenticated
HTML and marked `no-store`. They remain visible to anyone you allow to sign in,
so keep provider restrictions and quotas enabled. Local desktop builds still
use their existing build-time browser keys.

Sessions use signed Secure, HttpOnly, SameSite cookies. Wrong passwords are
slowed; 20 failures in 15 minutes pause sign-ins globally for that window.
The site asks search engines not to index it. MCP and key setup remain local-only.
Enable two-factor authentication on Render, GitHub and provider accounts;
anyone with access to the service's settings can read its environment values.

The runtime has a 384 MB V8 heap limit, not a total-memory limit. Render's
512 MB memory and 0.1 CPU free instance still needs live workload validation.
