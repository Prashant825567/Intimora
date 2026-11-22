# Browser streaming fixtures

These silent, synthetic test patterns contain no third-party or user content. They allow Chromium tests to exercise real decoding and HTTP range playback without a live backend:

- `stream-test.webm`: 20-second VP8 video with a silent Opus audio track, for general playback, autoplay-policy and cache tests.
- `stream-test.mp4`: 30-second H.264 video with its seek index at the front, for testing a later byte-range request before the first response completes. That test is skipped if Chromium lacks H.264 support.

- `hls/`: a six-second, three-segment HLS playlist (`index.m3u8` + `seg*.bin`, H.264/AAC) for the anime player's playlist path. Chromium has no native HLS reader where MediaSource exists, so this exercises hls.js end to end. The segments are MPEG-TS but are named `.bin`, because `node --test` treats every `.js`/`.ts` file it finds under `test/` as a test file.

They were generated with FFmpeg:

```sh
ffmpeg -f lavfi -i 'testsrc2=size=160x90:rate=10' \
  -f lavfi -i 'anullsrc=r=48000:cl=stereo' -t 20 \
  -c:v libvpx -b:v 100k -deadline good -cpu-used 4 -g 10 \
  -c:a libopus -b:a 16k -y stream-test.webm
ffmpeg -f lavfi -i 'testsrc2=size=160x90:rate=15' -t 30 -an \
  -c:v libx264 -preset veryfast -profile:v baseline -b:v 220k -g 15 \
  -movflags +faststart -y stream-test.mp4

# HLS (place inside test/fixtures/hls/)
ffmpeg -f lavfi -i 'testsrc=size=320x180:rate=25' -f lavfi -i 'sine=frequency=440' -t 6 \
  -c:v libx264 -preset ultrafast -g 25 -c:a aac \
  -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_filename 'seg%d.ts' index.m3u8
```
