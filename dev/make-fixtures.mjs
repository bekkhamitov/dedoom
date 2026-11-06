// Builds fake Instagram data for dev/harness.html: API responses, plus a
// layout file the harness uses to draw a feed and an Explore-style grid.
// Shapes follow what the extension looks for (code/pk + video_versions or
// video_dash_manifest, coreVideoPlayerMetaData.videoFBID on the player), not
// a verified copy of Instagram's.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const M = '/dev/media';
const colors = ['#e4572e', '#29335c', '#f3a712', '#669bbc', '#a8c686', '#8e7dbe', '#d1495b', '#00798c'];
const people = [
  ['founder.clips', 'Founder Clips'],
  ['dailykitchen', 'Daily Kitchen'],
  ['nyc.tips', 'NYC Tips'],
  ['techmemes', 'Tech Memes'],
  ['gymbro_mike', 'Mike'],
];

fs.mkdirSync(path.join(dir, 'graphql'), { recursive: true });
for (let i = 0; i < people.length; i++) {
  fs.writeFileSync(
    path.join(dir, 'media', `avatar${i}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="${colors[i]}"/><text x="40" y="52" font-size="32" font-family="Arial" fill="#fff" text-anchor="middle">${people[i][1][0]}</text></svg>`
  );
}
for (let i = 0; i < 8; i++) {
  fs.writeFileSync(
    path.join(dir, 'media', `thumb${i}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640"><rect width="360" height="640" fill="${colors[(i + 3) % 8]}"/><circle cx="180" cy="320" r="60" fill="#fff" opacity=".35"/></svg>`
  );
}

const dash = (audio) =>
  `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT42.1S"><Period><AdaptationSet contentType="video"><Representation bandwidth="300000" mimeType="video/mp4"><BaseURL>${M}/speech2.mp4?x=1&amp;y=2</BaseURL></Representation></AdaptationSet><AdaptationSet contentType="audio"><Representation bandwidth="96000" mimeType="audio/mp4"><BaseURL>${audio}?big=1</BaseURL></Representation><Representation bandwidth="48000" mimeType="audio/mp4"><BaseURL>${audio}</BaseURL></Representation></AdaptationSet></Period></MPD>`;

let n = 0;
function video({ who, caption, dashAudio = 'ok', hasAudio = true, song = null, noMedia = false, comments = 12 }) {
  const i = n++;
  const [username, full_name] = people[who];
  return {
    pk: String(3400000000000000000n + BigInt(i)),
    code: `C${String(i).padStart(2, '0')}xReelAbc`,
    product_type: 'clips',
    media_type: 2,
    user: { username, full_name, profile_pic_url: `${M}/avatar${who}.svg` },
    caption: caption ? { text: caption } : null,
    like_count: [12400, 830, 45100, 2210000, 97][i % 5],
    comment_count: comments,
    has_audio: hasAudio,
    clips_metadata: song
      ? { music_info: { music_asset_info: { title: song[0], display_artist: song[1] } }, original_sound_info: null }
      : { music_info: null, original_sound_info: { consumption_info: {} } },
    image_versions2: { candidates: [{ width: 360, height: 640, url: `${M}/thumb${i % 8}.svg` }] },
    ...(noMedia
      ? {}
      : {
          video_versions: [
            { width: 720, height: 1280, url: `${M}/speech2.mp4?hd=1` },
            { width: 360, height: 640, url: `${M}/speech2.mp4` },
          ],
          video_dash_manifest: dashAudio === 'none' ? null : dash(dashAudio === '404' ? `${M}/missing.m4a` : `${M}/speech1.m4a`),
        }),
  };
}
const photo = (code, who, caption) => ({
  pk: String(3500000000000000000n + BigInt(n++)),
  code,
  media_type: 1,
  user: { username: people[who][0], profile_pic_url: `${M}/avatar${who}.svg` },
  caption: { text: caption },
  image_versions2: { candidates: [{ width: 360, height: 360, url: `${M}/thumb${n % 8}.svg` }] },
});

const wrap = (items) => ({ data: { xdt_api__v1__feed__timeline__connection: { edges: items.map((m) => ({ node: { media: m } })) } } });

// Home feed (embedded in the page on first load)
const feedA = video({ who: 0, caption: 'Seed round advice nobody gives you #startups' });
const feedPhoto = photo('PhotoAbc01', 1, 'Sunday pasta, no video here');
const feedSong = video({ who: 4, caption: 'Form check please', song: ['Eye of the Tiger', 'Survivor'] });
const feedSilent = video({ who: 1, caption: '3-ingredient pasta you need to try', hasAudio: false, comments: 0 });
const feedFallback = video({ who: 2, caption: 'Things I wish I knew before moving to NYC', dashAudio: '404' });
// A carousel with one photo and one video (children have no code of their own)
const carouselVideo = video({ who: 3, caption: null });
delete carouselVideo.code;
const carousel = {
  pk: String(3600000000000000000n),
  code: 'CarouselAb1',
  media_type: 8,
  user: { username: 'techmemes', profile_pic_url: `${M}/avatar3.svg` },
  caption: { text: 'Carousel: slide 2 is a video' },
  comment_count: 4,
  like_count: 512,
  carousel_media: [{ pk: '3600000000000000001', media_type: 1, image_versions2: { candidates: [{ width: 360, height: 360, url: `${M}/thumb1.svg` }] } }, carouselVideo],
};

// Explore grid (fetched after load)
const grid = [
  video({ who: 0, caption: 'How we got our first 100 users' }),
  video({ who: 2, caption: 'Best bagel in Manhattan? A thread' }),
  video({ who: 1, caption: 'Weeknight curry in 20 minutes' }),
  video({ who: 3, caption: 'POV: standup goes long', song: ['Bohemian Rhapsody', 'Queen'] }),
  video({ who: 0, caption: 'Grid item without media links', noMedia: true }),
];
const gridPhoto = photo('PhotoGrid01', 2, 'Skyline photo');

fs.writeFileSync(path.join(dir, 'embedded.json'), JSON.stringify(wrap([feedA, feedPhoto, feedSong, feedSilent, feedFallback])));
fs.writeFileSync(path.join(dir, 'graphql', 'page1.json'), JSON.stringify({ data: { explore: { sectional_items: [{ layout_content: { medias: [...grid, gridPhoto].map((m) => ({ media: m })) } }] } } }));
// Served the way some Instagram endpoints do: prefixed and newline-delimited.
fs.writeFileSync(path.join(dir, 'graphql', 'page2.json'), 'for (;;);' + JSON.stringify(wrap([carousel])) + '\n' + JSON.stringify({ extensions: { is_final: true } }));
fs.rmSync(path.join(dir, 'graphql', 'page3.json'), { force: true });

// What the harness draws. Videos carry their pk the way Instagram's player does.
fs.writeFileSync(
  path.join(dir, 'layout.json'),
  JSON.stringify(
    {
      feed: [
        { kind: 'video', pk: feedA.pk, user: 'founder.clips', caption: feedA.caption.text },
        { kind: 'photo', img: feedPhoto.image_versions2.candidates[0].url, user: 'dailykitchen', caption: feedPhoto.caption.text },
        { kind: 'video', pk: feedSong.pk, user: 'gymbro_mike', caption: feedSong.caption.text },
        { kind: 'video', pk: carouselVideo.pk, user: 'techmemes', caption: carousel.caption.text },
        { kind: 'video', pk: feedSilent.pk, user: 'dailykitchen', caption: feedSilent.caption.text },
        { kind: 'video', pk: feedFallback.pk, user: 'nyc.tips', caption: feedFallback.caption.text },
      ],
      grid: [...grid, gridPhoto].map((m) => ({ code: m.code, img: m.image_versions2.candidates[0].url })),
    },
    null,
    2
  )
);
console.log('fixtures written');
