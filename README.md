# Board Game Stall Tracker

A phone web app for a school Blitz day board game stall. It records who played, which games they
picked, how they did, and which prize they took.

**How the stall works**

- One token = **2 different games**, picked from the 8 on the table.
- Every token gets a **sticker**. A player who wins at least one of the two games also picks
  **one prize** (pen, crayons, keychain, ...).
- A player can buy as many tokens as they like.

## On the day

Open the app's link on the phone, then use **Add to Home screen**. After it has opened once, it also
works without internet.

1. **Setup**: before the stall opens, set the stall's name, type in the 8 game names, and enter
   how many of each prize you're starting with. The app then counts down what's left, shows it on
   the prize buttons, and warns at the top when something gets down to 3. Leave a quantity blank to
   not count that prize. If you restock, add the new ones to the starting number.
2. **New token**: when someone hands over a token, type their name. Tap them if they've played
   before, or add them as a new player (student or teacher, plus class for
   students). Pick their 2 games and tap **Start token**.
3. **In play**: everyone who is still playing. When someone finishes, tap their card and set
   Won or Lost for each game. If they won one, tap the prize they chose. Then tap
   **Finish token**. Made a mistake? Tap **Undo** on the message at the bottom.
4. **Log**: every finished token. Tap one to fix or delete it.
5. **Stats**: highlights first (busiest half hour, most players at once, most and least popular
   game, hardest and easiest game, favourite pair and prize, most active class, top winner), then
   how players did (won both, won one, lost both), busy times, plays and win rate per game,
   students against teachers, classes, prizes given and left, and the players with the most wins
   and tokens.

## Back up, because the data lives only on this phone

Everything is kept in this phone's browser. Nothing is sent anywhere. That also means clearing the
browser, or using a private/incognito tab, **loses it**.

- **Setup → Back up** saves a `.json` file, through the share sheet where the phone has one (send it
  to yourself on WhatsApp, email or Drive). The app reminds you after every 20 tokens.
- **Setup → Export for a spreadsheet** gives a `.csv` with one row per token, for Google Sheets or
  Excel.
- **Setup → Restore from a backup** loads a `.json` backup back in, on this phone or another one.

Never commit backup or CSV files to this repo: they contain children's names. `.gitignore` blocks
them.

## For developers

Plain HTML, CSS and JavaScript, with no build step and nothing to install.

| File | What it does |
|---|---|
| `index.html`, `style.css` | The page and its look (mobile first, light and dark) |
| `app.js` | Screens and taps |
| `rules.js` | Token rules, stats, CSV and backup checks. No browser code, so it's tested with Node |
| `store.js` | Saving to `localStorage`, sharing files |
| `sw.js`, `manifest.json` | Offline use and Add to Home screen |
| `tools/make_icons.py` | Redraws the PNG icons from the same shapes as `icons/icon.svg` |

```bash
node --test tests/            # run the tests (Node 20+)
python3 -m http.server 8000   # then open http://localhost:8000
```

**After changing any app file, raise `CACHE` in `sw.js`**, or phones that already opened the app may
keep the old version until they're back online.

Saved data has a `version`. If its shape ever changes, raise `DATA_VERSION` in `rules.js` and add a
conversion, so a phone with data from the day still loads.
