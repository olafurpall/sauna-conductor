# Sauna Conductor

Runs a whole sauna session from one laptop: Spotify playlists, a recorded narrator between rounds, and the clock.

- **Sessions** you build once and replay exactly: playlists, timing, levels, voice and every recorded message.
- **Session creator**: pick playlists from your Spotify, edit every narration message, choose and preview an ElevenLabs voice, then record.
- **Live view**: round timer, music that dips under the narrator, song controls (previous / pause / next), and an *Up next* list you can click to jump.
- **Playlists with Claude**: export your Spotify library, send it to Claude, import the playlists Claude builds.
- **Sign in and share**: your sessions, recordings, history and the ElevenLabs key follow you to any computer, and Thora sees the same ones.

**Open it at <https://sauna.roadtalk.io>** in Chrome on a computer.

---

## Setup

### 1. Sign in

Open <https://sauna.roadtalk.io>. The first time, Settings opens on **Account and sync**:

- **Continue with Google** (once Google sign-in is switched on, see *For the administrator* below), or
- type your email and press **Email me a sign-in link**, then open the link **in the same browser**.

The header shows **Synced · Ólafur** when everything is in the cloud.

### 2. Invite Thora

**Settings → Account and sync → Shared with**: type Thora's Gmail address and press **Invite**. She opens <https://sauna.roadtalk.io>, signs in with that address, and sees every session, recording and the run history. Invite her before her first sign-in. Otherwise she starts in a workspace of her own, and you pick the shared one under *Workspace*.

### 3. Connect Spotify (each person, once)

**Settings → Spotify → Connect Spotify** and approve. Everyone connects their own Spotify Premium account. Your Spotify login is saved in your account (only you can read it), so your other computers connect by themselves.

Spotify only lets accounts on the app's user list in: <https://developer.spotify.com/dashboard> → *Thora sauna conductor* → **User Management** → add the name and email of each Spotify account (up to 5).

### 4. Add the ElevenLabs API key (once, for everyone)

1. Go to **elevenlabs.io → Developers → API keys → Create key**.
2. Give it access to **Text to Speech**, **Voices** (read and write), **Models**, and **User** (read). Setting a monthly credit limit on the key is a good idea.
3. Paste it in **Settings → ElevenLabs** and press **Save and check**. The pill at the top shows how many credits you have left.

When you're signed in, the key is shared with your workspace, so Thora records with the same ElevenLabs account.

### Bringing over sessions from the launcher version

Sessions made at `127.0.0.1:8888` live in that copy of Chrome's storage. To bring them over, either:

- start the **new** launcher version (this folder) with *Start Sauna Conductor.command*, sign in there, and wait for **Synced**. Everything uploads, recordings included. Or:
- in the old version press **Export** on each session, then **Import session** on <https://sauna.roadtalk.io>.

### Running it from your own computer instead

Double-click **Start Sauna Conductor.command** (approve it once under System Settings → Privacy & Security → Open Anyway). Chrome opens at `http://127.0.0.1:8888/`. Keep the small Terminal window open. Sign-in and sync work there too. Never open `index.html` directly.

---

## Creating a session

**Sessions → New session**, then:

1. **Music**: choose the heat playlist and, optionally, a cool-down playlist from your Spotify. You can also paste a playlist link. Turn on *Fade between songs* for softer song changes.
2. **Rounds**: choose how a round's length is decided.
   - **Follow the songs** (default): the conductor splits the heat playlist into rounds of whole songs: 3–6 songs per round, between the *shortest* and *longest* length (14–20 min by default), as close to the *aim* (15 min) as possible. You see every round's songs and its exact length (e.g. Round 1 · 16:32). **Suggest again** gives the next set of songs. Untick *Keep the playlist's song order* to mix freely. During the session each round plays exactly those songs and ends when the last one ends.
   - Edit any round: **drag** songs (or use ▲▼) to reorder them or move them to another round, **⇄** swaps a song for an unused one of similar length, **×** removes it, and the list under each round adds one. **+ Add a theme or mood** lets you note what the round is about. The theme is shown on the live screen during that round.
   - **Fixed minutes**: every round lasts exactly the set minutes, playing through the playlist.
   - Spotify only lets the conductor read the songs of playlists **owned by** (or shared as a collaborator with) the logged-in account. Log in with the account that owns the playlists, or copy the songs into a playlist of your own.
3. **Voice**: pick a model and a narrator.
   - **Eleven v3** is the most expressive and understands delivery cues like `[softly]`, `[warmly]`, `[chuckles]`, `[sighs]`. Three dots `...` add a pause.
   - **Change voice** opens the ElevenLabs voice library. Search (e.g. "deep narrator", "southern storyteller"), press ▶ to hear a sample, and **Use** to pick one.
   - **Hear the welcome in this voice** records the welcome message so you can judge the voice with your own words.
4. **Narration**: every message is in its own text box. Edit freely. Each has ▶ Play, Record, and *Use my MP3* (or drag an MP3 onto it).
5. **Levels**: music volume for heat and cool-down, how far the music dips under the narrator, narrator volume.
6. **Create session**: records every message that isn't recorded yet (or has changed), then saves. A progress panel shows each message, which ones are recording, and roughly how long is left. Eleven v3 takes around 5–20 seconds per message. If ElevenLabs doesn't answer within 90 seconds the message is tried once more, and **Stop** cancels (messages already recorded are kept).

The bar at the bottom shows how many messages still need recording and roughly how many characters that is. ElevenLabs charges about one credit per character. Changing a message, the voice or the model marks the affected clips **Changed — record again**. Only those get re-recorded.

Sessions are saved in this browser and, when you're signed in, in the cloud within a few seconds of every change. **Duplicate** a session to make a variation (another host, other playlists) without touching the original.

## Running a session

Press **Run** on a session, check the Spotify pill is green, and press **Start session** when everyone is seated.

| Control | Key | |
|---|---|---|
| Pause / Resume | Space | Freezes the clock, music and narrator |
| Next phase | N | Ends the current round or cool-down |
| +1 min / +1 song | + | Adds a minute (fixed rounds) or the next unused song (song rounds) |
| Replay narration | R | Plays the current message again |
| Previous / next song | ← / → | Song controls (also on screen) |
| Pause music | | Pauses only the music |
| Up next | | Click a song to jump to it |

In song rounds the timer counts down the songs that are left, and skipping past the last song moves on to the cool-down. *Up next* shows the round's remaining songs, then what comes after the round. "+1 song" adds the next unused song to the end of the round. It never goes into Spotify's own queue, so it can't leak into later rounds.

At every phase change the narrator starts right away at full volume, while the old music fades out and the new music fades in underneath. If Spotify doesn't switch the music, the conductor notices within a few seconds and tries again.

### If the laptop or browser dies mid-session

The conductor saves where it is every two seconds (and, when signed in, reports to the cloud every 15 seconds, so you can resume on another computer too). Open it again and the Sessions page shows *"… stopped unexpectedly in Round 3 with 6:12 left"* with a **Resume** button. Resume picks up in the same round, on the same song, at the same point, without replaying the narration. **Recent sessions** lists the last runs (completed, ended early, interrupted). Without a cool-down playlist, the playlist's unused songs play softly during breaks. In fixed rounds, each heat round continues on the next song of the heat playlist. After the last round the closing message plays and the cool-down music keeps going until you press **End session**.

**Rehearsal**: Settings → *Clock speed ×60* runs a 15-minute round in 15 seconds. Demo mode runs without Spotify.

## Where the music plays

**Settings → Where the music plays**

- **This browser** (default): the laptop is the speaker. Connect it to the sauna speaker. *Fade between songs* gives a short fade-out and fade-in at each song change.
- **Spotify app or speaker**: the conductor remote-controls the Spotify app on your Mac (or another Spotify Connect device). Open the Spotify app, press **Refresh**, and pick it. In the Spotify app turn on **Settings → Playback → Crossfade songs** for real DJ-style blends. Transitions you create with Spotify's **Mix** feature on a playlist should also play this way. The narration always plays from the laptop.

## Playlists with Claude

1. **Sessions → Export my Spotify library** saves a file with your playlists, liked songs and top tracks.
2. Send the file to Claude and describe what you want (e.g. "three Interstellar-style deep-house playlists for 15-minute heat rounds, and a calm cool-down one").
3. Claude sends back a playlist file. **Import playlists from Claude** creates them in your Spotify (private).
4. Pick them in any session.

## Sync, sharing and backups

- Signed in, every change is uploaded within seconds and other computers pick it up when they open the page, come back to it, or every two minutes. **Settings → Account and sync → Sync now** does it immediately.
- Without internet the conductor keeps working from this browser's copy. The header shows **Offline**, and everything syncs when the connection is back.
- If two people change the same session, the most recent save wins.
- **Sign out** keeps the sessions on this computer.
- **Export** on a session card saves one file with everything, including the recorded narration. **Import session** restores it exactly. A good extra backup.

**What is stored where.** In the cloud (Supabase, Europe): sessions, recordings, run history and the ElevenLabs key, readable only by members of your workspace; your Spotify login, readable only by you. The security rules are in `supabase/schema.sql`.

## Troubleshooting

- **The sign-in link says it didn't work**: open the emailed link in the same browser where you asked for it (on the same computer).
- **"Sync problem"** in the header: open Settings → Account and sync to see the reason, then press **Sync now**. Copy diagnostics if it persists.
- **Something odd happened during a session**: Settings → **Copy diagnostics**, then paste it into the chat with Claude. It lists what the conductor asked Spotify to play and what actually played (no keys or passwords).
- **Old songs keep popping up between rounds**: earlier versions used Spotify's own queue for "+1 song", and those songs can still be sitting there. In the Spotify app, open the queue and press **Clear queue** once.
- **Still seeing the old version** (no *Sessions | Live* tabs, or Settings doesn't show the latest version number): close every old Sauna Conductor Terminal window, start the launcher again, and press Cmd+Shift+R in Chrome. The launcher stops an older copy by itself.
- **"Also open in another Chrome tab"**: keep one Sauna Conductor tab. When you open a new one, the older tab steps aside by itself, unless it's running a session or has unsaved changes. Tabs from the very first version can't do that, so close those by hand.
- **"Reconnect Spotify"**: press Reconnect in Settings → Spotify (needed once after updating).
- **"Invalid redirect URI"**: the Spotify app's Redirect URIs must include the exact address you use: `https://sauna.roadtalk.io/` or `http://127.0.0.1:8888/` (both are already added).
- **Spotify says the user isn't registered**: add that Spotify account under User Management in the Spotify developer dashboard (step 3).
- **Nothing plays**: the Spotify account needs Premium. In *Spotify app* mode, make sure the app is open and the device is picked in Settings.
- **ElevenLabs "missing permissions"**: edit the API key's permissions (see setup step 4).
- **A voice can't be used**: library voices are added to *My voices* when you pick them. That needs the *Voices: write* permission, and your plan has a limit on how many library voices you can add.
- Use Chrome on a computer. Phones and tablets can't run the Spotify web player.

---

## For the administrator

- **Hosting**: GitHub Pages from the `docs/` folder of <https://github.com/olafurpall/sauna-conductor>, at `sauna.roadtalk.io` (a CNAME record at IONOS points `sauna` to `olafurpall.github.io`). After changing the app, run `python3 tools/build.py --cname sauna.roadtalk.io` and push. The build adds a version to every file name so browsers never mix old and new files.
- **Supabase** project *sauna-conductor* (organization Roadtalk). The schema and security rules are in `supabase/schema.sql` (safe to run again). The app's address and publishable key are in `js/config.js`.
- **Google sign-in** (one-time):
  1. <https://console.cloud.google.com> → create a project (e.g. *Sauna Conductor*).
  2. **Google Auth Platform → Get started**: app name *Sauna Conductor*, your email, audience **External**.
  3. **Clients → Create client → Web application**. Authorized JavaScript origins: `https://sauna.roadtalk.io`. Authorized redirect URI: `https://cldzrjlznhyswfzylxsl.supabase.co/auth/v1/callback`. Create, and keep the window with the Client ID and Client secret open.
  4. **Audience → Publish app**, so anyone you invite can sign in with Google (only name and email are requested, so no review is needed).
  5. Supabase → Authentication → Sign In / Providers → **Google** → enable, paste the Client ID and Client secret, Save.
- **Email links**: Supabase's built-in email only sends to members of the Supabase organization, a few per hour. For anyone else use Google, or set up your own email sender under Supabase → Authentication → Emails → SMTP.
- **Who can sign up**: anyone who signs in gets their own empty workspace and can't see yours. To close the door completely, turn off *Allow new users to sign up* in Supabase → Authentication → Sign In / Providers once everyone has signed in once.
