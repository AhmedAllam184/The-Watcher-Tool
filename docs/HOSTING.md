# Hosting The Watcher online (free, private, sign-in required)

This runs The Watcher on a free **Hugging Face Space** so you can open it from
any phone or computer without your laptop running. Everything (the page, every
script and every `/api` route that uses your keys) sits behind a username and
password that only you know.

How it works:

- The Space builds a container from `deploy/huggingface/Dockerfile`. The
  container downloads this repository's code from GitHub; your keys are **not**
  in the image or the repository.
- Your keys and login are saved as **Space secrets**. They are read only when
  the app starts. The browser keys (Google Maps, Cesium) are built into the page
  at start-up, and the page is only sent to someone who has signed in.
- The server runs in **hosted mode** (`GEV_HOSTED=1`, see
  `server/hosted/auth.js`): it shows a sign-in page and refuses to start at all
  if the login is missing or the password is shorter than 12 characters.
- Each restart pulls the newest version pushed to the branch, so **Restart =
  update**.

Free tier behaviour to expect: the Space goes to sleep after a period with no
visitors (Hugging Face sets this; it has been about 48 hours on free hardware).
The first visit after that wakes it, and it takes **a minute or two** to build
and start before the sign-in page appears.

## 1. Create the Space

1. Sign up or sign in at <https://huggingface.co> (free; no card needed for
   free CPU hardware).
2. **New → Space.** Name it (for example `the-watcher`), choose **Docker** as
   the SDK and the **Blank** template, and the free **CPU basic** hardware.
3. Visibility: **Public** is fine and is the simplest. The sign-in protects the
   app, and the Space itself contains only the Dockerfile and a short README.
   **Private** adds a second wall (only your Hugging Face account can reach
   it), but then every browser you use, phone included, must also be signed in
   to Hugging Face. If you try Private and the phone shows a Hugging Face error
   instead of The Watcher's sign-in page, switch the Space to Public.
4. In the Space's **Files** tab, replace `README.md` with the contents of
   `deploy/huggingface/README.md` and add a file named `Dockerfile` with the
   contents of `deploy/huggingface/Dockerfile` (both from this repository).
   Do this **after** step 2 below, so the first start already has a login.

## 2. Add your login and keys as secrets

In the Space: **Settings → Variables and secrets → New secret**. Use **secret**
(not variable) for every entry below. Names must match exactly.

Required, or the app will refuse to start:

| Secret | Value |
| --- | --- |
| `GEV_LOGIN_USER` | Your username |
| `GEV_LOGIN_PASSWORD` | A long password, **at least 12 characters**. A password manager's generated password is ideal. Changing it later signs every device out. |

Your API keys: add the same ones you have in your PC's `.env` file, with the
same names (only the ones you use):

`GOOGLE_MAPS_API_KEY`, `GOOGLE_MAPS_SERVER_API_KEY`, `CESIUM_ION_TOKEN`,
`OPENAI_API_KEY`, `MAPILLARY_CLIENT_TOKEN`, `OPENSKY_CLIENT_ID`,
`OPENSKY_CLIENT_SECRET`, `AISSTREAM_API_KEY`, `FIRMS_MAP_KEY`, `ACLED_EMAIL`,
`ACLED_KEY`, `TOMTOM_API_KEY`, `LL2_API_TOKEN`.

Never paste keys into the Dockerfile, the README, GitHub, or a chat.

## 3. Start it and sign in

After the Dockerfile is saved the Space builds (a few minutes the first time).
When the status shows **Running**, open the app at its direct address:

`https://<your-hf-username>-<space-name>.hf.space`

(The Space's **⋮ → Embed this Space** menu shows the exact "Direct URL".)
Use the direct address, not the huggingface.co page: The Watcher refuses to be
shown inside another site's frame.

On the phone, open the same address, sign in, and use the browser's
**Add to Home screen** for a one-tap icon. You stay signed in for 30 days per
device. To sign out: `https://<direct-url>/__watcher/logout`.

To update after new changes are pushed: Space **Settings → Restart this Space**.
If the Space's build ever gets stuck on an old version, use **Factory rebuild**.

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
   and a new API key in it for the Space, so you can revoke it without
   touching anything else.

### Google Maps Platform (3D tiles, place search, Street View) — hard cap

Budgets in Google Cloud only send alerts; **quotas** are what actually stop
spending. Google gives a monthly free allowance per API; set the quotas below
it.

1. <https://console.cloud.google.com> → **APIs & Services → Credentials**.
2. Browser key (`GOOGLE_MAPS_API_KEY`):
   - **Application restrictions → Websites**: add
     `https://<your-direct-url>/*` and, if you also run it on your PC,
     `http://localhost:4173/*` and `http://127.0.0.1:4173/*`.
   - **API restrictions → Restrict key**: tick only **Map Tiles API** and
     **Geocoding API**.
3. Server key (`GOOGLE_MAPS_SERVER_API_KEY`, optional but recommended):
   **API restrictions** to **Places API (New)** and **Street View Static API**.
   (It cannot be restricted by IP address because Hugging Face's addresses
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

## 5. What is protected, and the limits of that

- Nothing is served without the sign-in: the page and its scripts get a
  redirect to the sign-in page, and API routes get `401`.
- The session is a signed, `HttpOnly`, `Secure` cookie valid for 30 days;
  changing `GEV_LOGIN_PASSWORD` signs every device out.
- Wrong passwords are slowed down, and after 20 failures in 15 minutes all
  sign-ins pause for the rest of that window (from everywhere, so someone
  guessing can also keep you waiting for a few minutes; a long password makes
  guessing hopeless either way).
- The page tells search engines not to index it.
- The MCP endpoint and the key-setup panel stay local-only and are refused on
  the hosted site.
- Anyone who can sign in to your Hugging Face account can read the secrets,
  so turn on two-factor authentication there
  (**Settings → Authentication**), and on Google, OpenAI and GitHub too.
