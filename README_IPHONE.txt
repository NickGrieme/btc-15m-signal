BTC 15-MINUTE SIGNAL DESK - IPHONE SETUP

This is a Progressive Web App (PWA). It must be hosted at an HTTPS address before Safari can install it to the Home Screen.

EASIEST PUBLISH METHOD (GitHub Pages):
1. Create/sign in to a GitHub account.
2. Create a NEW PUBLIC repository named btc-15m-signal.
3. Upload all files from this folder to the repository root (index.html, app.js, manifest.webmanifest, sw.js, icon-192.png, icon-512.png).
4. In the repository, open Settings > Pages.
5. Under Build and deployment, choose Deploy from a branch, select main and /(root), then Save.
6. Wait for GitHub Pages to publish. Your site URL will look like https://YOUR-USERNAME.github.io/btc-15m-signal/
7. Open that HTTPS URL in Safari on your iPhone.
8. Tap Share (square with arrow) > Add to Home Screen > Add.

The GitHub Pages URL is public. The app does not store wallet details or private keys. Paper trades are stored in Safari's local browser storage on that iPhone and do not automatically sync to other devices. Clearing Safari website data can erase the local ledger.

WHAT IT DOES:
- Loads public BTC/USDT 1-minute candles from Binance public market-data endpoints.
- Calculates EMA trend, RSI, 3-minute momentum, relative volume, and a hybrid directional score.
- Compares the experimental score with manually entered UP/DOWN contract asks.
- Records and settles simulated trades locally.

WHAT IT DOES NOT DO:
- It does not connect to Polymarket, use private endpoints, place real orders, connect a wallet, or bypass geographic restrictions.
- It does not automatically fetch Polymarket prices. Enter permitted public market quotes manually.
- Its probability estimate is not statistically calibrated or proof of an edge.

If GitHub Pages is not available, any HTTPS static host that serves these files can be used.
