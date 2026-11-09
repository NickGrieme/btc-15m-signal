BTC SIGNAL DESK - IPHONE PWA

This is a browser-based, installable Progressive Web App. Host the files from the repository root using GitHub Pages, then open the Pages URL in Safari and choose Share > Add to Home Screen.

AUTOMATIC DATA
- Discovers the current BTC Up/Down 15-minute Polymarket event using its time-based market slug.
- Reads public Polymarket market metadata and CLOB order books to populate the UP and DOWN best asks.
- Requests the round's official opening reference from Polymarket's crypto-price endpoint.
- Listens for Polymarket's public Chainlink BTC/USD RTDS stream for the live oracle price.
- Uses Coinbase BTC/USD one-minute candles for technical indicators only. The app distinguishes this technical candle feed from the Chainlink resolution price.
- Displays a 15-minute countdown and the planned 10-minute, 7-minute, 5-minute, and 2-minute timing stages.

IMPORTANT LIMITATIONS
- Public endpoints, browser CORS rules, and Polymarket's data availability can change. If official reference, live Chainlink price, or both order-book asks are missing or stale, the app should show PASS and disable paper-trade recording rather than guess.
- The model probability is an experimental heuristic, not a calibrated forecast or evidence of an edge.
- Paper trades are stored only in this browser's local storage.
- No wallet, private API, or real order placement is used.
