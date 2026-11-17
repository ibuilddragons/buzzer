# BuzzBoard

A free, Jeopardy-style quiz game for playing online with friends. It's a static site (no server, no accounts) that runs on GitHub Pages.

- **Players** join from their phones with a 4-letter room code and a name.
- **The host** picks a board, sets up teams, reveals clues, opens buzzers and judges answers.
- **The display screen** shows the board, clues, media and scores (never the answers until revealed). It's meant to be screen-shared on your call.
- **The board editor** lets you build boards with clue text, answers, Daily Doubles, and images, audio or video on any clue.

## How it works

The host's browser *is* the game server. Players connect to it directly with WebRTC through [PeerJS](https://peerjs.com), whose free public broker introduces the browsers to each other. Nothing is stored online. Boards live in the host's browser (IndexedDB) and can be exported as JSON files.

Keep the host tab open during the game. If it's closed or refreshed, reopen `host.html` and click **Resume game**. Players reconnect automatically.

## Put it on GitHub Pages

1. Create a new public repository on GitHub (for example `buzzboard`).
2. Upload everything in this folder. On the repo page, use **Add file → Upload files**, drag the files and folders in, and commit.
3. Go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, then pick `main` and `/ (root)`, and save.
4. After a minute, the site is live at `https://<your-username>.github.io/buzzboard/`.

The pages are:

| Page | Who uses it |
|---|---|
| `index.html` | Players join here (the join link and QR code point here) |
| `host.html` | The host creates and runs a game |
| `display.html` | The screen to share on your call |
| `editor.html` | Make and edit boards |

## Running a game

1. In `editor.html`, make a board, or use the included **Sample Board**.
2. In `host.html`, pick the board, the number of teams (up to 6) and the rules, then click **Create room**.
3. Click **Open display screen** and screen-share that window on Discord, Zoom or Meet. Use "share tab/window audio" if you want everyone to hear clue audio through the call.
4. Players open the site, enter the room code and their name, and pick a team (or you assign them by dragging names between teams).
5. Click **Start game**, then pick clues:
   - **Space** opens the buzzers. Buzzing *before* they open locks that player out for a moment (configurable).
   - The first buzz locks everyone else out. **C** marks it correct, **X** wrong. A wrong answer locks out that team and re-opens buzzers for the others.
   - **A** reveals the answer, and **Enter** goes back to the board.
   - Daily Doubles ask you for the team's wager first. No buzzers are used.
   - Click a team's name or score to edit it. ★ marks which team picks next.

Teams can have any number of players. Anyone on a team can buzz for it.

## Boards and media

- Boards you make are saved **in that browser only**. Use **Export JSON** to back one up or move it to another computer, and **Import** to load it.
- To make a board available from any device, commit its JSON to `boards/` and add it to `boards/index.json`:
  ```json
  [
    { "file": "sample-board.json", "title": "Sample Board" },
    { "file": "movie-night.json", "title": "Movie Night" }
  ]
  ```
- **Media:** uploaded files are stored inside the board and sent to players when the clue opens. That's fine for images and short clips. For large audio or video, put the file in `media/` in the repo and add it in the editor by path (for example `media/theme-song.mp3`). Players then load it straight from GitHub Pages, which is faster. GitHub limits files to 100 MB.
- Phones only play sound after a tap, so players' first tap on **Join** enables it. The 🔊 button mutes a phone. The host can turn player-device sound off entirely in the settings, which is useful when everyone hears the shared screen anyway.

## Limits worth knowing

- Buzz order is decided by when buzzes *arrive* at the host, so a player with a much slower connection is at a small disadvantage. The buzz log shows the timings.
- Very restrictive networks (some corporate or school Wi-Fi) can block WebRTC. Home internet and mobile data are fine.
- The public PeerJS broker is free and shared. If it's ever down, rooms can't be created until it's back.
