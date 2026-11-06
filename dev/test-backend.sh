#!/usr/bin/env bash
# End-to-end test of backend/server.js against a fake Whisper API (no real key needed).
set -u
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1: expected [$3] got [$2]"; FAIL=$((FAIL+1)); fi; }

# Fake OpenAI-compatible transcription endpoint.
cat > "$TMP/fake.mjs" <<'EOF'
import http from 'node:http';
let calls = 0;
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    calls++;
    const body = Buffer.concat(chunks).toString('latin1');
    if (req.url === '/calls') return res.end(String(calls - 1));
    // OpenAI chat stand-in for the formatting step. Fails once for FMTFAIL transcripts.
    if (req.url.startsWith('/chat')) {
      const msg = JSON.parse(Buffer.concat(chunks).toString('utf8')).messages[1].content;
      if (msg.includes('FMTFAIL') && !global.fmtFailed) { global.fmtFailed = true; res.writeHead(500); return res.end('{"error":"boom"}'); }
      const caption = /^Caption: (.*)$/m.exec(msg)?.[1] || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'T', body: 'Formatted. caption=' + caption }) } }] }));
    }
    // Groq stand-in: rate-limits LIMITME always and LIMITONCE on its first try.
    if (req.url.startsWith('/groq')) {
      const once = body.includes('LIMITONCE') && !global.limitedOnce;
      if (once) global.limitedOnce = true;
      if (body.includes('LIMITME') || once) {
        res.writeHead(429);
        return res.end('{"error":{"message":"Rate limit reached ... Please try again in 1.5s. Need more tokens?"}}');
      }
    }
    if (!/Bearer (test-key|groq-key)/.test(req.headers.authorization || '')) { res.writeHead(401); return res.end('{"error":"auth"}'); }
    if (body.includes('BADMEDIA')) { res.writeHead(400); return res.end('{"error":{"message":"could not decode"}}'); }
    if (body.includes('SERVERDOWN')) { res.writeHead(503); return res.end('{"error":"overloaded"}'); }
    const model = /name="model"\r\n\r\n([^\r]+)/.exec(body)?.[1];
    const file = /filename="([^"]+)"/.exec(body)?.[1];
    const fmt = /name="response_format"\r\n\r\n([^\r]+)/.exec(body)?.[1];
    const segments = body.includes('FMTFAIL')
      ? [{ text: ' FMTFAIL real speech here.', no_speech_prob: 0.01, avg_logprob: -0.2 }]
      : body.includes('FILLER')
      ? [{ text: ' Thank you.', no_speech_prob: 0.1, avg_logprob: -0.2 }]
      : body.includes('MUSICONLY')
      ? [{ text: ' Thank you for watching.', no_speech_prob: 0.92, avg_logprob: -0.3 }]
      : [
          { text: ' Investors fund momentum.', no_speech_prob: 0.01, avg_logprob: -0.2 },
          { text: ' Thank you.', no_speech_prob: 0.7, avg_logprob: -1.1 },
          { text: ` [${model}|${file}|${fmt}]`, no_speech_prob: 0.02, avg_logprob: -0.3 },
        ];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: segments.map((s) => s.text).join(''), segments }));
  });
}).listen(9911);
EOF
node "$TMP/fake.mjs" & FAKE=$!

CACHE="$TMP/cache.json"
export FORMAT_URL=http://127.0.0.1:9911/chat
start_backend() { PORT=8799 CACHE_FILE="$CACHE" OPENAI_API_KEY=test-key TRANSCRIBE_URL=http://127.0.0.1:9911/v1/audio/transcriptions node backend/server.js > "$TMP/backend.log" 2>&1 & BACK=$!; sleep 0.8; }
start_backend
B=http://127.0.0.1:8799

check "health reports provider" "$(curl -s $B/health | grep -o '"providers":"openai"')" '"providers":"openai"'
check "uncached reel is 404" "$(curl -s -o /dev/null -w '%{http_code}' $B/transcript/AbcDEF123)" "404"
check "bad code rejected" "$(curl -s -o /dev/null -w '%{http_code}' -X POST --data x "$B/transcribe/bad%20code")" "400"
check "empty body rejected" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/transcribe/AbcDEF123")" "400"

OUT=$(curl -s -X POST --data-binary @dev/media/speech1.m4a -H 'Content-Type: audio/mp4' "$B/transcribe/AbcDEF123?kind=audio")
check "drops hallucinated segment, keeps speech" "$(echo "$OUT" | grep -o '"text":"[^"]*"')" '"text":"Investors fund momentum. [whisper-1|reel.m4a|verbose_json]"'

check "transcript is formatted" "$(curl -s $B/transcript/AbcDEF123 | grep -o '"formatted":{"title":"T"')" '"formatted":{"title":"T"'
OUT=$(curl -s -X POST --data-binary @dev/media/speech1.m4a -H 'X-Caption: Caf%C3%A9%20talk' "$B/transcribe/CapReel001")
check "caption reaches the formatter" "$(echo "$OUT" | grep -o 'caption=Café talk')" "caption=Café talk"

OUT=$(curl -s -X POST --data 'FMTFAIL' "$B/transcribe/FmtFail001")
check "format failure still returns the transcript" "$(echo "$OUT" | grep -o '"text":"FMTFAIL real speech here."') $(echo "$OUT" | grep -c formatted)" '"text":"FMTFAIL real speech here." 0'
check "cached unformatted entry is formatted on next read" "$(curl -s $B/transcript/FmtFail001 | grep -o '"formatted":{"title":"T"')" '"formatted":{"title":"T"'

OUT=$(curl -s -X POST --data-binary @dev/media/speech2.mp4 "$B/transcribe/VidReel01?kind=video")
check "video upload named .mp4" "$(echo "$OUT" | grep -o 'reel.mp4')" "reel.mp4"

OUT=$(curl -s -X POST --data 'MUSICONLY' "$B/transcribe/MusicReel1")
check "music-only becomes noSpeech" "$(echo "$OUT" | grep -o '"noSpeech":true')" '"noSpeech":true'
check "no-speech entries skip formatting" "$(echo "$OUT" | grep -c formatted)" "0"

OUT=$(curl -s -X POST --data 'FILLER' "$B/transcribe/FillerOnly1")
check "filler-only transcript becomes noSpeech" "$(echo "$OUT" | grep -o '"noSpeech":true')" '"noSpeech":true'

CODE=$(curl -s -o "$TMP/bad.json" -w '%{http_code}' -X POST --data 'BADMEDIA' "$B/transcribe/BadMedia01")
check "undecodable media -> 422 bad_media" "$CODE $(grep -o '"error":"bad_media"' "$TMP/bad.json")" '422 "error":"bad_media"'

CODE=$(curl -s -o "$TMP/down.json" -w '%{http_code}' -X POST --data 'SERVERDOWN' "$B/transcribe/Down000001")
check "provider outage -> 502" "$CODE" "502"
check "failed reel not cached" "$(curl -s -o /dev/null -w '%{http_code}' $B/transcript/Down000001)" "404"

BEFORE=$(curl -s http://127.0.0.1:9911/calls)
curl -s -X POST --data-binary @dev/media/speech1.m4a "$B/transcribe/AbcDEF123" > /dev/null
AFTER=$(curl -s http://127.0.0.1:9911/calls)
check "second upload of same reel served from cache (no API call)" "$((AFTER - BEFORE))" "1"   # 1 = only the /calls probe itself

# Two simultaneous requests for a new reel -> one API call
BEFORE=$(curl -s http://127.0.0.1:9911/calls)
curl -s -X POST --data-binary @dev/media/speech1.m4a "$B/transcribe/Parallel01" > /dev/null &
curl -s -X POST --data-binary @dev/media/speech1.m4a "$B/transcribe/Parallel01" > /dev/null &
wait %3 %4 2>/dev/null; sleep 0.3
AFTER=$(curl -s http://127.0.0.1:9911/calls)
check "concurrent requests for one reel share one transcription and one format call" "$((AFTER - BEFORE))" "3"   # whisper + format + probe

sleep 0.8  # let the debounced cache write land
kill $BACK; wait $BACK 2>/dev/null
start_backend
check "cache survives restart" "$(curl -s $B/transcript/AbcDEF123 | grep -o '"code":"AbcDEF123"')" '"code":"AbcDEF123"'

kill $BACK; wait $BACK 2>/dev/null

# Groq rate-limited -> falls over to OpenAI
PORT=8799 CACHE_FILE="$TMP/c3.json" GROQ_API_KEY=groq-key GROQ_URL=http://127.0.0.1:9911/groq OPENAI_API_KEY=test-key TRANSCRIBE_URL=http://127.0.0.1:9911/v1/audio/transcriptions node backend/server.js > "$TMP/fallback.log" 2>&1 & BACK=$!; sleep 0.8
check "health lists both providers" "$(curl -s $B/health | grep -o '"providers":"groq -> openai"')" '"providers":"groq -> openai"'
OUT=$(curl -s -X POST --data 'LIMITME' "$B/transcribe/Limited001")
check "groq 429 falls back to openai" "$(echo "$OUT" | grep -o '"provider":"openai"')" '"provider":"openai"'
OUT=$(curl -s -X POST --data 'hello' "$B/transcribe/AfterLimit1")
check "groq skipped while cooling down" "$(echo "$OUT" | grep -o '"provider":"openai"')" '"provider":"openai"'
sleep 2
OUT=$(curl -s -X POST --data 'hello' "$B/transcribe/AfterCool01")
check "groq used again after cooldown" "$(echo "$OUT" | grep -o '"provider":"groq"')" '"provider":"groq"'
kill $BACK; wait $BACK 2>/dev/null

# Groq only, rate-limited once -> waits and retries
PORT=8799 CACHE_FILE="$TMP/c4.json" GROQ_API_KEY=groq-key GROQ_URL=http://127.0.0.1:9911/groq OPENAI_API_KEY= node backend/server.js > "$TMP/wait.log" 2>&1 & BACK=$!; sleep 0.8
START=$(date +%s)
OUT=$(curl -s -X POST --data 'LIMITONCE' "$B/transcribe/WaitRetry1")
ELAPSED=$(( $(date +%s) - START ))
check "groq-only waits out 429 then succeeds" "$(echo "$OUT" | grep -o '"provider":"groq"') $([ $ELAPSED -ge 1 ] && echo waited)" '"provider":"groq" waited'
kill $BACK; wait $BACK 2>/dev/null

# No key at all -> clear error
PORT=8799 CACHE_FILE="$TMP/c2.json" OPENAI_API_KEY= GROQ_API_KEY= node backend/server.js > "$TMP/nokey.log" 2>&1 & BACK=$!; sleep 0.8
check "no key -> helpful message" "$(curl -s -X POST --data x "$B/transcribe/NoKey00001" | grep -o 'No API key')" "No API key"

kill $BACK $FAKE 2>/dev/null; wait 2>/dev/null
rm -rf "$TMP"
echo "---- $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
