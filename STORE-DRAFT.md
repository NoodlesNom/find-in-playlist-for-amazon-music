# Edge Add-ons store draft

Do not submit this. Paste it into Partner Center only when you choose to publish.

The short description is not a separate store field you can type. Microsoft Edge Add-ons uses the `description` string in `manifest.json`. That string is already set to the short description below. The extension name in the manifest is already the name below. Version in the package is 1.0.8. This draft was not submitted.

## Name

Find in Playlist for Amazon Music

## Short description

Find the next song in an Amazon Music playlist by title or artist, including tracks that are not loaded yet.

(108 characters. Chromium shows the manifest description in the browser UI with a 132-character limit.)

## Long description

Find in Playlist for Amazon Music finds a song inside a playlist on the Amazon Music website. It works only on playlist pages.

A round button appears at the top right of the player, directly under the Lyrics Translate button if you use that extension too. Click it and type part of a song title or an artist name, then choose Find next. The match is case-insensitive and can be any part of the title or the artist. Find next scrolls that row into view and highlights the matching text. It does not play the song.

Tracks that are not loaded yet are included. The extension scrolls the playlist so later songs can be searched, then stops on the next match. After the last match, the next search wraps once, back to the first match, and the box says Wrapped.

The button hides when the lyrics view or the queue is open. It works alongside Lyrics Translate and Romanize for Amazon Music with seamless compatibility: the translator button and the find button stack, the translation panel sits above the search button, and opening translation closes the search box. Opening lyrics does not fight search.

There is no account. Searching happens on the page in your browser. Playlist titles and artist names are not sent anywhere.

English Amazon Music sites only: music.amazon.com, music.amazon.ca, music.amazon.co.uk, music.amazon.com.au, music.amazon.in, and music.amazon.ae. Not affiliated with Amazon. Amazon Music is a trademark of Amazon.com, Inc. or its affiliates.

## Category suggestion

Search tools.

If that category is not in the dashboard, use Productivity. Entertainment is a reasonable alternate because the extension only runs on Amazon Music, but Search tools matches what people are looking for.

## Search terms (optional)

Up to seven terms, 30 characters each, 21 words total.

1. Amazon music
2. find song
3. find
4. playlist search
5. search playlist
6. ctrl f
7. amazon music playlist

## Privacy notes

What it does:

- Runs as a content script on the English Amazon Music sites listed above.
- The button and search box appear only on playlist pages (paths containing /playlists/ or /user-playlists/).
- Reads song titles and artist names that are already shown in the playlist in the page.
- Scrolls that playlist in the page so songs that are not loaded yet can be matched, then scrolls the matching row into view and highlights the matching text.
- Stores the current search only in the page while the playlist is open. Nothing is written to extension storage. There is no background script.

What it does not do:

- No account, no sign-in, and no analytics.
- Does not send playlist contents, titles, or artist names anywhere. Search is local to the page.
- Does not read cookies, the Amazon account, or listening history.
- Does not play, pause, or skip the row.
- Does not download or display lyrics.
- Does not talk to the lyrics translator except to sit under its button and to close the search box when that extension opens its panel.

Suggested privacy disclosure for the listing: this extension does not collect or transmit personal data. Playlist search runs entirely in the browser on the open Amazon Music playlist page.
