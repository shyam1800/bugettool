/* ─────────────────────────────────────────────────────────────────────────
   Google Drive sync settings — replace the two placeholders below.
   See README.md ("Turn on Google Drive sync") for where to get each value.
   ───────────────────────────────────────────────────────────────────────── */
window.BUDGET_CONFIG = {
  // 1. OAuth client ID from Google Cloud Console (type: Web application)
  GOOGLE_CLIENT_ID: '827079378126-nhht9udredqph6sqno2c0m464pc9m8ke.apps.googleusercontent.com',

  // 2. Link to the Google Drive folder that should hold the data file.
  //    (A link straight to an existing budget-data.json file also works.)
  GOOGLE_DRIVE_LINK: 'https://drive.google.com/drive/folders/1WP9GSIiB214PCOdHZQbmDU8LgKbIa1pY?usp=drive_link',

  // Name of the data file kept in that folder.
  DATA_FILE_NAME: 'budget-data.json',

  // Permission the app asks for. Full Drive access is needed to read and
  // write inside a folder you picked yourself.
  GOOGLE_SCOPE: 'https://www.googleapis.com/auth/drive'
};
