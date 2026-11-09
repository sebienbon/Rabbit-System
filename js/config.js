// Address of the Apps Script Web App (Deploy > Web app > URL ending in /exec).
// Points at the REAL spreadsheet "Reception - RABBIT TREE" (live since 04/11/2026).
// Test copy ("Claude copy Reception - RABBIT TREE"): AKfycbxjw8ldfWzInmkTP2K1c-OnyfkmA_zW2ekoEEBos1GTcxmMhgCBCUckXTt4oV1mconK
export const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbwtm3tI5vEvnxyzSFIsvcd2lJ7pQ3scoR_LweGWFXF3wJc4gf3Es9FcdXmE4K7yxNJKoA/exec',
  PUSH_EVERY_MS: 15000,      // send waiting operations
  PULL_EVERY_MS: 2 * 60000,
  // The bar POS (github.com/sebienbon/rabbit-pos) runs on this same reception computer: "Bar POS" opens it logged in.
  POS_URL: 'http://localhost:8080',  // refresh catalog, guests, users, gear (the gear staff's work shows within 2 min)
};
