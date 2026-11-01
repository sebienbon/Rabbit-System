// Address of the Apps Script Web App (Deploy > Web app > URL ending in /exec).
// Points at the TEST copy of the spreadsheet ("Claude copy Reception - RABBIT TREE")
// until we switch to the real one.
export const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbxjw8ldfWzInmkTP2K1c-OnyfkmA_zW2ekoEEBos1GTcxmMhgCBCUckXTt4oV1mconK/exec',
  PUSH_EVERY_MS: 15000,      // send waiting operations
  PULL_EVERY_MS: 5 * 60000,  // refresh catalog, guests, users
};
