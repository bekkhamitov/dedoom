# Dedoom

Read Instagram videos instead of watching them.

Dedoom is a Chrome extension that keeps Instagram's normal interface but replaces every video with text: Reels, videos in the home feed, Explore and profile grids. Each video becomes a formatted transcript (a short title and clean paragraphs), with the caption and comments one click away, shown as threads. Photos stay as they are.

- **Reels and feed:** the video area shows the transcript. Caption and comments stay collapsed until you open them. "Play video" brings the video back for that post; "Read instead" switches back.
- **Explore and profile grids:** video tiles show the title and the opening lines instead of the thumbnail.
- **Videos set to a song:** shown as "Music only: ♪ title · artist", since a transcript would just be lyrics ("Transcribe anyway" is there if you want it).
- **Reading / watching switch:** the button in the bottom-left corner turns Dedoom off and on.

```
extension/            Chrome extension (Manifest V3, no build step)
  inject.js           runs inside Instagram's page: reads the post data Instagram downloads,
                      tags each <video> with its post ID, fetches comments with your session
  content.js          draws the text panels over videos and grid tiles
  background.js       downloads a post's audio and sends it to the backend
backend/server.js     transcription + formatting server (Node, no dependencies), cached by post
dev/                  mock Instagram page and tests
```

## Run it

**1. Start the backend** (Node 22.9+)

```bash
cd backend
cp .env.example .env    # add an OPENAI_API_KEY, and optionally a GROQ_API_KEY
npm start               # http://localhost:8787
```

- `OPENAI_API_KEY` formats transcripts (default model `gpt-4.1-mini`, change with `FORMAT_MODEL`) and can also transcribe.
- `GROQ_API_KEY` is optional. When set, Groq's Whisper does the transcribing because it's faster and cheaper, and OpenAI takes over whenever Groq's rate limit is hit.
- No keys yet? `npm run mock` returns placeholder text so you can try the interface.

**2. Load the extension**

1. Open `chrome://extensions` (in Helium: `helium://extensions`) and turn on Developer mode.
2. Click "Load unpacked" and choose the `extension/` folder.

**3. Use it**

Log in to instagram.com and browse normally.

After you change the extension's code, click the reload icon on its card and refresh Instagram.

## How it works

1. **Finding the posts.** `inject.js` wraps `fetch` and `XMLHttpRequest` inside Instagram's page and scans the JSON embedded in the HTML. It keeps any object that looks like a video post, matching by shape (a `code` or `pk`, plus `video_versions`, `video_dash_manifest`, `media_type: 2` or `product_type: "clips"`) rather than by exact location, because Instagram reshuffles its responses often.
2. **Matching videos to posts.** Instagram's video player receives the post's ID as `coreVideoPlayerMetaData.videoFBID`. `inject.js` reads it from React's props on each `<video>` and writes it to `data-dedoom-id`. Grid tiles are matched by their `/p/CODE/` link.
3. **Drawing the text.** `content.js` covers the video's box with a panel in a Shadow DOM, pauses and mutes the video, and asks for the transcript only once the panel is within a couple of screens.
4. **Transcribing.** `background.js` asks the backend whether the post is cached. If not, it downloads the post's audio-only track (falling back to the smallest mp4) and uploads it. When a grid item came without video links, the extension fetches the full post from Instagram first.
5. **Cleaning and formatting.** `backend/server.js` sends the audio to Whisper, drops segments Whisper marks as non-speech and the filler it invents on music ("Thank you.", subtitle credits), then has OpenAI format the text: punctuation, paragraphs, a title, the original language kept. Results are cached by post in `backend/data/transcripts.json`, so each video is processed once and is instant for every later viewer.

## Testing without Instagram

- **Extension:**
  1. Run `python3 -m http.server 8000 --bind 127.0.0.1` from the repo root.
  2. Start the backend with `npm run mock`.
  3. Open http://127.0.0.1:8000/dev/harness.html, adding `?backend=PORT` if the mock backend isn't on 8787.

  The page is a mock Instagram (feed videos, a photo, a carousel, an Explore grid, canned comments) running the real extension scripts. `node dev/make-fixtures.mjs` regenerates its data.
- **Backend:** `./dev/test-backend.sh` runs the server against fake Whisper and OpenAI endpoints. It covers caching, deduplication, filler filtering, the Groq-to-OpenAI fallback, rate-limit waits, formatting and errors.

## Known limits

- When a creator posts a song as their "original audio", the transcript is its lyrics; Instagram only labels licensed tracks.
- Tested in Chromium (Helium) with a logged-in account in November 2026. Instagram changes its web app often. If videos stop turning into text, check whether the `videoFBID` prop or the post JSON shape moved.
- Stories and DMs aren't handled on purpose.
