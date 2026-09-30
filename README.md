# Find in Playlist for Amazon Music

A free Microsoft Edge extension that finds a song inside an Amazon Music playlist. Version 1.0.8.

It only runs on Amazon Music playlist pages. A floating button sits under the [Lyrics Translate & Romanize for Amazon Music](https://noodlesnom.github.io/lyrics-translate-for-amazon-music/) button. **Find next** searches for a case-insensitive substring of the title or artist, including songs that are not loaded yet. It scrolls the matching row into view and highlights the match. It does not play the row. After the last match, the next search wraps once, back to the first match. The button hides when lyrics or the queue is open.

The two extensions work together on Amazon Music with seamless compatibility: the translator button and the find button stack, and opening lyrics does not fight search. The translation panel stacks above the search button, and opening translation closes the search box.

Not affiliated with Amazon.

## Install (load unpacked)

1. Download this repository (or clone it) and unzip it.
2. Open `edge://extensions` (in Chrome: `chrome://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and pick the folder that contains `manifest.json`.
5. Open a playlist on [music.amazon.com](https://music.amazon.com).

English Amazon Music sites only: music.amazon.com, .ca, .co.uk, .com.au, .in, and .ae.

## What it does

- Shows a search button only on playlist pages (`/playlists/` and `/user-playlists/`).
- Matches a case-insensitive substring of the visible title or artist (the aria-label title and artist are used as extra signals).
- Scrolls the playlist so tracks that are not on screen yet can be searched.
- **Find next** moves to the next match. It centers that row and highlights the matching text. It does not click play.
- Wraps once. The status line says **Wrapped** when it returns to the first match.
- If you scroll away from the current match, the next **Find next** returns to the nearest match already found, instead of jumping backward through the list.
- Hides the button and closes the search box when the lyrics view or the queue is open.
- Closes the search box when the lyrics translator panel opens. Press Esc while the box or button is focused to close it.
- Does not send playlist contents anywhere. There is no account and no analytics.

## Privacy

The extension reads titles and artist names that are already on the playlist page, in your browser. It does not send them to a server. See [the site](https://noodlesnom.github.io/find-in-playlist-for-amazon-music/) for the same description.

## License

MIT. Copyright (c) 2026 NoodlesNom.
