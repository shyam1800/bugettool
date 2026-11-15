# Budget app

Your Excel budget workbook as an installable web app for Chrome on macOS, iPadOS and iOS.
Data is saved on each device and synced through one file in your Google Drive.

## What is in this folder

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js`, `core.js` | The app |
| `config.js` | **The two placeholders you fill in** (Google client ID, Drive folder link) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Make it installable and usable offline |
| `../your-data/budget-data.json` | Your workbook converted: 31 categories, the 2023–2026 plan, 1,756 records |

Keep `budget-data.json` **out of** the folder you publish. The app files contain none of your
figures, so they are safe on a public host; your data only ever lives on your devices and in your Drive.

## 1. Put the app online (needed once)

Google sign-in and "install as app" both need an `https://` address, so the folder has to be hosted.
Any static host works. With GitHub Pages:

1. Create a repository (for example `budget`) and upload everything in `budget-app/`.
2. Settings → Pages → deploy from the `main` branch, root folder.
3. Your address is `https://YOUR-NAME.github.io/budget/`.

## 2. Turn on Google Drive sync

1. In Google Drive, create a folder (for example "Budget app") and copy its link.
2. Go to <https://console.cloud.google.com>, create a project, and enable **Google Drive API**.
3. *APIs & Services → OAuth consent screen*: choose External, fill in the app name, and add your
   own Google address under **Test users**.
4. *Credentials → Create credentials → OAuth client ID → Web application*:
   - Authorised JavaScript origins: `https://YOUR-NAME.github.io`
   - Authorised redirect URIs: `https://YOUR-NAME.github.io/budget/`
     (the app shows the exact value to use under Settings → Google Drive sync)
5. Open `config.js` and replace the placeholders:

   ```js
   GOOGLE_CLIENT_ID: '1234567890-abc.apps.googleusercontent.com',
   GOOGLE_DRIVE_LINK: 'https://drive.google.com/drive/folders/1AbC...',
   ```
6. Upload the changed `config.js`, and change `VERSION` in `sw.js` (e.g. `budget-v2`) so devices fetch it.

Until this is done the app works normally but keeps data on the one device only.

## 3. First run

1. Open the address in Chrome and tap **Import budget-data.json**.
2. Tap **Connect Google Drive** (top right) and sign in. The app creates `budget-data.json` in your folder.
3. On every other device: open the address, tap **Connect Google Drive**. The data arrives by itself.

Install it: on iPhone/iPad, Chrome → Share → **Add to Home Screen**. On Mac, Chrome → ⋮ → **Cast, save and share → Install page as app**.

## How sync behaves

- Every change is saved on the device first, then uploaded a few seconds later.
- The app checks Drive when you open it, when you come back to it, and every minute while it is open.
- Two devices can edit at the same time, even offline. Records, plan cells and categories are merged
  one by one; if the very same item was changed on both, the later change wins.
- Google sign-ins last about an hour. The app renews silently when you open it; if Google wants
  confirmation, the chip at the top right says "Sign in to sync" – one tap.
- Google shows an "unverified app" notice the first time, because the OAuth client is your own. That is expected.

## Changing the app later

Edit the files, upload them, and bump `VERSION` in `sw.js`.
