# Sauna Conductor

Runs a whole sauna session: Spotify playlists, a recorded narrator between rounds and inside songs, and the clock.

- **Sessions** you build once and replay exactly: playlists, timing, levels, voice and every recorded message.
- **Session creator**: pick playlists from your Spotify, choose the narration language, let the AI write the narration from a description (or write it yourself), choose and preview a voice, then record.
- **Live view**: round timer, music that dips under the narrator, song controls (previous / pause / next), and an *Up next* list you can click to jump.
- **Session page and timeline**: every session at a glance with play counts; preview any song; place extra messages anywhere, even in the middle of a song.
- **Private by default, easy to share**: everyone has their own sessions. Invite people as collaborators or viewers, or post a link.
- **Your own voice, and callouts**: upload or record any message yourself, add short callouts ("Let's do this!", "Last song!") recorded by real people, and talk to the group with 🎙 Talk. Or run it without AI narration: just the music and the timers.
- **An app on your phone**: install it from the browser for a home-screen icon.
- **Playlists with Claude**: export your Spotify library, send it to Claude, import the playlists Claude builds.

**Open it at <https://sauna.roadtalk.io>.**

---

## Getting started

1. Open <https://sauna.roadtalk.io> and press **Continue with Google**. (Email sign-in is there too, but see *For the administrator*.)
2. The first time, there's one step: **Connect Spotify**. Log in with your own Spotify Premium account and press **Agree**. Nobody needs a Spotify app, a Client ID or an ElevenLabs key.
3. If Spotify turns you away, the app asks for the email you use for Spotify and sends a request to the admin, who adds you (Spotify allows 5 people while the app is in beta). Come back and press **Try again**. You can look around and plan sessions meanwhile.

Your Spotify login is saved in your account (only you can read it), so your other devices connect by themselves.

The header shows your name; click it for **Settings**, **Install the app** and **Sign out**. Signing out leaves nothing of yours on that device; your sessions come back when you sign in again.

### Install it as an app

- **Android, and Chrome or Edge on a computer**: press **Install the app** (on the front page, in the menu under your name, or in Settings → Account). One tap, and Sauna Conductor gets its own icon and opens full screen.
- **iPhone and iPad**: press **Add to Home Screen** to see the steps. In Safari: tap **•••** next to the address bar → **Share** → **Add to Home Screen**, leave *Open as Web App* on and tap **Add**. (Older iPhones show Share ⬆︎ directly in the toolbar.)
- **Safari on a Mac** (macOS Sonoma or later): press **Add to Dock**, or choose **File → Add to Dock…** in Safari's menu bar.

On a phone the music plays through the Spotify app: open Spotify once, then choose it under Settings → *Where the music plays*. The narration plays from the phone.

### Opened from Instagram or Facebook?

Their built-in browsers don't allow Google sign-in. The page says so and shows how to open it in Safari or Chrome (••• → *Open in browser*).

### Bringing over sessions from the launcher version

Sessions made at `127.0.0.1:8888` live in that copy of Chrome's storage. To bring them over, either:

- start the **new** launcher version (this folder) with *Start Sauna Conductor.command*, sign in there, and wait for **Synced**. Everything uploads, recordings included. Or:
- in the old version press **Export** on each session, then **Import session** on <https://sauna.roadtalk.io>.

### Running it from your own computer instead

Double-click **Start Sauna Conductor.command** (approve it once under System Settings → Privacy & Security → Open Anyway). Chrome opens at `http://127.0.0.1:8888/`. Keep the small Terminal window open. Sign-in and sync work there too. Never open `index.html` directly.

---

## The Sessions page

- Each card shows the session's **name**, your **notes**, how long it is, whether the narration is recorded, and how many times it was **played** (▶). A play is a run that finished, or lasted at least 10 minutes. Plays count from every computer and every person who runs it.
- **Sort by** Recently changed, Most played, Recently played or Name.
- Click a card to open its **session page**.

## The session page

Everything about one session in order: each round and cool-down with its message (▶ plays the recording) and its songs (▶ previews a song), and any messages placed inside songs.

- Click the **name** or the **notes** to change them.
- **Run**, **Edit**, **Timeline**, **Invite**, **Share link**, Duplicate, Export, Delete. A viewer only sees **Run** (and **Remove**).
- Each round and cool-down has its own **Edit**, which opens the editor at that part.

## Creating a session

**Sessions → New session**, then name it (the cursor starts in the name box), add notes if you like, and choose the **narration language** and **who leads the heat** (see *Narration in Icelandic* below). The links under the name jump to each part: Music, Rounds, Cool-downs, Voice, Narration, Levels. Then:

1. **Music**: choose the heat playlist and, optionally, a cool-down playlist from your Spotify. You can also paste a playlist link. Turn on *Fade between songs* for softer song changes.
2. **Rounds**: choose how a round's length is decided.
   - **Follow the songs** (default): the conductor splits the heat playlist into rounds of whole songs: 3–6 songs per round, between the *shortest* and *longest* length (14–20 min by default), as close to the *aim* (15 min) as possible. You see every round's songs and its exact length (e.g. Round 1 · 16:32). **Suggest again** gives the next set of songs. Untick *Keep the playlist's song order* to mix freely. During the session each round plays exactly those songs and ends when the last one ends.
   - Edit any round: **drag** songs (or use ▲▼) to reorder them or move them to another round, **⇄** swaps a song for an unused one of similar length, **×** removes it, and the list under each round adds one. **+ Add a theme or mood** lets you note what the round is about. The theme is shown on the live screen during that round.
   - **🔍 Search Spotify** on any round or cool-down finds any song on Spotify, not just the playlists. ▶ previews it, **Add** puts it at the end of the round or cool-down you choose.
   - **▶ next to every song** previews it from a third of the way in, so you remember its feel. A small player appears bottom right: pause, ±10 seconds, drag to any point, ✕ to stop. Previews play where the music plays (Settings → Where the music plays).
   - **Fixed minutes**: every round lasts exactly the set minutes, playing through the playlist.
   - Spotify only lets the conductor read the songs of playlists **owned by** (or shared as a collaborator with) the logged-in account. Log in with the account that owns the playlists, or copy the songs into a playlist of your own.
3. **Cool-downs**: the songs for each break are planned too, from the cool-down playlist (or, without one, from the heat songs that aren't in a round). Each break gets enough songs for its minutes. Preview, reorder, swap, remove and add songs exactly like in the rounds. Faded songs start after the break time, so they only play if the break runs long. **Suggest cool-down songs again** picks the next ones from the playlist. The cool-down playlist must be yours (or shared with you as a collaborator) for its songs to be read; otherwise the breaks play it as it is.
4. **Voice**: pick a model and a narrator.
   - **Eleven v3** is the most expressive and understands delivery cues like `[softly]`, `[warmly]`, `[chuckles]`, `[sighs]`. Three dots `...` add a pause.
   - **Change voice** opens the ElevenLabs voice library. Search (e.g. "deep narrator", "southern storyteller"), press ▶ to hear a sample, and **Use** to pick one.
   - **Hear the welcome in this voice** records the welcome message so you can judge the voice with your own words.
5. **Narration**: every message is in its own text box. Edit freely. Each has ▶ Play, Record, and **Use my recording**: upload an audio file (MP3, M4A or WAV; you can also drag one onto the message) or **record it now** with the microphone. The recorder shows the text to read, counts down 3-2-1, and lets you listen back before you use it; quiet bits at the start and end are trimmed and the level evened out. The callouts box above the messages adds callouts (see *Callouts* below).
6. **Levels**: music volume for heat and cool-down, how far the music dips under the narrator, narrator volume.
7. **Create session**: records every message that isn't recorded yet (or has changed), then saves. A progress panel shows each message, which ones are recording, and roughly how long is left. Eleven v3 takes around 5–20 seconds per message. If ElevenLabs doesn't answer within 90 seconds the message is tried once more, and **Stop** cancels (messages already recorded are kept).

The bar at the bottom shows how many messages still need recording and roughly how many characters that is. ElevenLabs charges about one credit per character. Changing a message, the voice or the model marks the affected clips **Changed — record again**. Only those get re-recorded.

Sessions are saved in this browser and, when you're signed in, in the cloud within a few seconds of every change. **Duplicate** a session to make a variation (another host, other playlists) without touching the original.

## Messages inside songs (the timeline)

**Timeline** (on the session page) lays the whole session out from left to right: the phases, every song, and the narration. It opens zoomed out to the whole session; **+** and **−** zoom.

1. Click a song where you want something said. The cursor marks the spot.
2. **+ Add a message**, then write it (e.g. a word about the song or the artist). With Eleven v3, cues like `[softly]` work here too.
3. **Record** makes it in the session's voice. The yellow block on the narration lane is as long as the recording.
4. **Drag** the block to move it, even into the middle of a song, or use −5 s / −1 s / +1 s / +5 s. ← and → nudge a selected block too.
5. **Music during the message** sets how far the music dips for this message (lower = quieter music), and **Narrator volume** how loud it is.
6. **▶ Hear it in place** plays the song from a few seconds before the message, with the message on top and the music dipping, exactly as in the sauna.

During a session the message plays when its song reaches its spot. If a round or cool-down message is still speaking, it waits until that one ends. Skipping past the spot skips the message, and going back before it plays it again. Messages also show on the session page under their song, and in the editor under Narration, where their text can be edited and re-recorded. If a message's song is removed from the session, the message stays but isn't placed until you drag it onto a song again.

## Running a session

Press **Run** on a session, check the Spotify pill is green, and press **Start session** in the middle of the ring when everyone is seated. If a session was cut off (a closed tab, a flat battery), the ring shows where it stopped and the button there is **Resume**, with **Start over** under it.

The controls sit right under the ring, so on a phone they're on the first screen without scrolling:

| Control | Key | |
|---|---|---|
| Pause / Resume | Space | Freezes the clock, music and narrator |
| Next phase | N | Ends the current round or cool-down |
| +1 min / +1 song | + | Adds a minute (fixed rounds) or the next unused song (song rounds) |
| Replay narration | R | Plays the current message again |
| Previous / next song | ← / → | Song controls (also on screen) |
| Pause music | | Pauses only the music |
| Up next | | Click a song to jump to it |
| 🎙 Talk / Resume | T | In the middle of the ring while a session runs: the music dips to your Talk level and the narrator fades out |

**🎙 Talk** is for when you want to say something to the group yourself. Press it and the music dips to 40% of its level (change this under Settings → *Talk button*; it follows you to your other devices). If the narrator is speaking, it fades out and that message is left for you to finish. Nothing new is narrated while you talk. Press **Resume** to bring the music back up.

**Without AI narration**: the switch at the top of *Narration* in the session creator. Off, the narration messages are greyed out and nothing is recorded or played for them: you lead the session yourself. The music, the timers, messages inside songs, callouts and Talk all still work.

In song rounds the timer counts down the songs that are left, and skipping past the last song moves on to the cool-down. *Up next* shows the round's remaining songs, then what comes after the round. "+1 song" adds the next unused song to the end of the round. It never goes into Spotify's own queue, so it can't leak into later rounds.

Each cool-down plays its planned songs, then more from the cool-down playlist if the break runs long. After the last round the leftover cool-down songs keep playing until you end the session.

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

## Sharing a session

Your sessions are private. Open one and use:

- **Invite**: type someone's email (the one they sign in with) and choose
  - **Collaborator**: can change songs, narration and messages, run it, invite others, and make their own copy;
  - **Viewer**: can only run it.

  It shows up in their Sessions marked **Shared · collaborator** or **Shared · viewer**, with the owner's name. You can change someone's role or remove them in the same window. Your own shared sessions say **Shared with 2** (etc.).
- **Share link**: makes a link for Facebook, Instagram or a message (**Copy**, **Share…** on phones, or **Facebook**; for an Instagram story, copy the link and add it with the *Link* sticker). Whoever opens it signs in, connects Spotify, and the session opens for them as a viewer. The link preview shows the Sauna Conductor image. **Stop this link** turns it off; people who already opened it keep the session.

Only the owner can delete a session. Others can **Remove** it from their own Sessions.

## Narration in Icelandic (and other languages)

At the top of the session creator, choose **Narration language** and fill in **Who leads the heat** (the host's name, used in the texts).

- **English and Icelandic** have built-in texts. Other languages (Danish, Swedish, Norwegian, Finnish, German, Polish, Spanish, French) start in English; use the AI writer below.
- Icelandic needs **Eleven v3** or newer: Multilingual v2 and Flash don't speak Icelandic, and the editor warns if one is chosen.
- **Change voice** shows voices recommended for the language first. For Icelandic these are native Reykjavík-accent voices from the ElevenLabs library: **Ingibjorg** (calm, warm; the default), **Katrin** (warm, patient), **Sigrun** (calm narrator), **Bjorn** and **Gunnar** (deep, calm narrators) and **Baldur** (patient). ▶ plays a sample. Listen to two or three before you choose.

### Write the narration with AI

Under **Narration**, describe your group and the mood in your own words, for example:

> My name is Júlía and I'm hosting a session for 12 girlfriends from school. We love Icelandic hip hop. Keep it short and warm, mostly the basic instructions.

Tick **Short check-ins at the start of each song** to add a message at the start of every song (after the first in each round) saying how many minutes are left in the round. Press **Write narration**: Claude writes every message in the session's language in about a minute. Nothing is recorded yet. Read it through, change anything, then press **Create session** to record. Check-ins appear under *Messages inside songs* and on the timeline, where you can move them.

## Callouts

Callouts are short clips real people recorded for Sauna Conductor, for example Bubbi or Bríet saying *“Gerum þetta!”*, *“Síðasta lagið!”* or *“Þetta var geggjað!”*. They're grouped by **author** and anyone can use the published ones in any session.

- **Add one to any message**: **📣 Callout** on a message opens the gallery, like an emoji picker: a tab per author (*Bubbi · 8 callouts*, *Þóra Hrund · 3 callouts*…), each callout with its words and ▶. Click one and it goes in at the cursor as a token like `{callout:bubbi-morthens/lets-start}`, shown under the message as *📣 Bubbi: “Gerum þetta!” ▶*. At the start of a message it plays just before the narrator; anywhere else, right after. A message can be only callouts.
- **📣 Suggest callouts** (under *Messages inside songs*, and on the timeline): pick an author and their callouts are placed at good moments as small messages inside the songs: *Let's do this* right after each round's message, *It's getting hot in here* as a song near the middle of the round starts, *Hang in* late in a long round, *Last song*, *1 minute left*, *Round done* (or *That's a wrap* in the final round) just before the round ends, and *That was amazing* after the closing message. Suggesting again, or with another author, replaces the suggested ones; **Remove suggested** takes them out. Callouts you added yourself stay. (Sessions with fixed-length rounds get them at the start and end of the phase messages instead.)
- **On the timeline** callouts are blue blocks. Drag any message or callout to move it, press **Delete** to remove it, and **📣 Add a callout** at the cursor. Nothing ever plays over anything else: dropped on another message, a callout or message moves to the nearest free spot next to it.
- **Over the music**: callouts play over the music, which only dips to 90% (a phase message dips it more, for the narrator). Each callout's level can be changed on the timeline.
- The editor flags any callout that isn't available any more. Callouts are kept in the browser after the first run, so they also play offline.

### Getting callouts recorded (admin)

**Settings → Callout recordings**: write the person's name (and their email, the language and a short note if you like) and press **Create invitation**. Then **Email** (opens your email app with a message in their language and the link), **Share…** (text message, WhatsApp…) or **Copy link**.

The link opens a page with no sign-in. It greets them by name (filled in, they can change it), explains what this is, shows your note, and lists the lines to record **in their language**, e.g. *Gerum þetta!*, *Síðasta lagið!*, each with when it plays. For each line: **● Record**, **■ Stop**, **▶ Listen**, **↺ Record again**. At the bottom they can add lines of their own. They tick that they agree to their recordings being played in sessions, press **Send**, and their callouts can be used in every session straight away. Opening the link again lets them change or add recordings. The list in Settings shows *Not opened yet*, *Opened the link* or *Sent 8 callouts*; **Turn off link** stops a link working.

The **Callouts** page (account menu) lists every author: listen, re-record or upload takes, change the words, unpublish, or delete. You can also make an author there yourself. An author you unpublish stays unpublished even if they send again.

## Sync, sharing and backups## Sync, sharing and backups

- Signed in, every change is uploaded within seconds and other computers pick it up when they open the page, come back to it, or every two minutes. **Settings → Account → Sync now** does it immediately.
- Without internet the conductor keeps working from this browser's copy. The header shows **Offline**, and everything syncs when the connection is back.
- If two people change the same session, the most recent save wins.
- **Sign out** keeps the sessions on this computer.
- **Export** on a session card saves one file with everything, including the recorded narration. **Import session** restores it exactly. A good extra backup.

**What is stored where.** In the cloud (Supabase, Europe): your sessions, recordings, run history and plays, readable only by you (and a shared session also by the people it's shared with); your Spotify login, readable only by you. The ElevenLabs and Anthropic keys are only on the server; no browser ever sees them. The security rules are in `supabase/schema.sql`.

## Troubleshooting

- **The sign-in link says it didn't work**: open the emailed link in the same browser where you asked for it (on the same computer).
- **"Sync problem"** in the header: open Settings → Account to see the reason, then press **Sync now**. Copy diagnostics if it persists.
- **Something odd happened during a session**: Settings → **Copy diagnostics**, then paste it into the chat with Claude. It lists what the conductor asked Spotify to play and what actually played (no keys or passwords).
- **Old songs keep popping up between rounds**: earlier versions used Spotify's own queue for "+1 song", and those songs can still be sitting there. In the Spotify app, open the queue and press **Clear queue** once.
- **Still seeing the old version** (no *Sessions | Live* tabs, or Settings doesn't show the latest version number): close every old Sauna Conductor Terminal window, start the launcher again, and press Cmd+Shift+R in Chrome. The launcher stops an older copy by itself.
- **"Also open in another Chrome tab"**: keep one Sauna Conductor tab. When you open a new one, the older tab steps aside by itself, unless it's running a session or has unsaved changes. Tabs from the very first version can't do that, so close those by hand.
- **"Reconnect Spotify"**: press Reconnect in Settings → Spotify (needed once after updating).
- **"Invalid redirect URI"**: the Spotify app's Redirect URIs must include the exact address you use: `https://sauna.roadtalk.io/` or `http://127.0.0.1:8888/` (both are already added).
- **Spotify says the user isn't registered**: add that Spotify account under User Management in the Spotify developer dashboard (step 3).
- **Nothing plays**: the Spotify account needs Premium. In *Spotify app* mode, make sure the app is open and the device is picked in Settings.
- **"You've used today's narration allowance"**: each person can record 25,000 characters a day; it starts again the next day. The admin has no limit.
- **"The AI writer is not set up yet"**: the admin needs to add the `ANTHROPIC_API_KEY` secret (see *For the administrator*).
- **A voice can't be used**: library voices are added to *My voices* when you pick them. That needs the *Voices: write* permission, and your plan has a limit on how many library voices you can add.
- Use Chrome on a computer. Phones and tablets can't run the Spotify web player.

---

## For the administrator

- **Hosting**: GitHub Pages from the `docs/` folder of <https://github.com/olafurpall/sauna-conductor>, at `sauna.roadtalk.io` (a CNAME record at IONOS points `sauna` to `olafurpall.github.io`). After changing the app, run `python3 tools/build.py --cname sauna.roadtalk.io` and push. The build adds a version to every file name, and to the service worker, so phones and browsers pick up a new version at once.
- **Supabase** project *sauna-conductor* (organization Roadtalk). The schema and security rules are in `supabase/schema.sql` (safe to run again). Version 3 (applied 4 October 2026) made spaces private: Þóra keeps all of Ólafur's sessions as a collaborator. It also added share roles, links, access requests and daily limits, and moved the ElevenLabs key into the server-only `app_secrets` table. The app's address and publishable key are in `js/config.js`.
- **Server functions** (Supabase → Edge Functions), source in `supabase/functions/`. All three are deployed with **Verify JWT off** (`eleven` and `write` check the signed-in person themselves; `collect` is for people without an account):
  - `eleven`: all ElevenLabs calls, with the key from `app_secrets` (or the `ELEVENLABS_API_KEY` secret). Each person can record **25,000 characters a day** (`TTS_DAILY_CHARS`) and add 10 library voices a day (`VOICE_ADDS_DAILY`); the admin has no limit. Voices you made or cloned in your own ElevenLabs account are only for you; others can use library and stock voices.
  - `write`: the AI writer (Claude), with the **`ANTHROPIC_API_KEY`** secret (Supabase → Edge Functions → Secrets). 20 writes per person per day (`AI_DAILY_CALLS`); model `claude-opus-5-5` (`WRITER_MODEL`).
  - `collect`: the public callout recording page (`record.html?i=<token>`). The invitation's long random token is the only key: it can read that invitation, upload recordings to that author (audio checked by its first bytes, 3 MB at most, 40 lines at most) and send them, which publishes the author with their agreement noted.
  - Usage per person and day is in the `usage_daily` table.
- **Admin**: the first person who set up the app (Ólafur, in `app_admins`). The admin sees ElevenLabs credits in the header, **Spotify access requests** (header: *1 waiting for Spotify*; Settings → *Spotify access*) and the **Callouts** page (account menu).
- **Callouts** (versions 3.1 and 3.2): tables `callout_profiles` (with a unique short name, `slug`), `callout_clips`, `callout_notes` (how each person agreed; admin only) and `callout_invites` (admin only), audio in the private `callouts` storage bucket (`<profile id>/<clip id>.wav`). Everyone signed in can read published authors; only the admin (and the `collect` function, for invitations) can write.
- **Letting someone into Spotify**: <https://developer.spotify.com/dashboard> → *Thora sauna conductor* → **User Management** → add their name and the **Spotify email** from the request (5 people at most), then press **Mark as added** in Settings. They see it and press Try again. If someone is turned away anyway, the email on the list doesn't match their Spotify login. Opening the app to everyone needs Spotify's *extended quota*, which Spotify now gives only to registered businesses with 250,000 monthly users.
- **Google sign-in**: Google Cloud project *Sauna Conductor* (account olafurpall@gmail.com, separate from TARS) → Google Auth Platform: app *Sauna Conductor*, External, **In production**, web client *Web client 1* with redirect URI `https://cldzrjlznhyswfzylxsl.supabase.co/auth/v1/callback`. Its Client ID and secret are in Supabase → Authentication → Sign In / Providers → Google.
- **Email sign-in**: Supabase's built-in email only reaches members of the Supabase organization, a few per hour, so others are told to use Google. To open email sign-in to everyone, add an email sender under Supabase → Authentication → Emails → SMTP (e.g. Resend).
- **Privacy page**: `privacy.html` (linked from the front page and Google's consent screen).
- **Who can sign up**: anyone. A new person gets their own empty space and sees nothing of anyone else's until it's shared with them.
