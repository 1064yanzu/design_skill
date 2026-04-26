#!/usr/bin/env bash
# Mix BGM and optional voiceover into an MP4 video.
#
# Usage:
#   bash add-music.sh <input.mp4> [--mood=<name>] [--music=<path>] [--voiceover=<path>] [--out=<path>]
#
# Mood library (in ../assets/, matching bgm-<mood>.mp3):
#   tech              — Apple Silicon / product keynote vibe, minimal synth+piano (default)
#   ad                — upbeat modern, clear build + drop, social-media ad energy
#   educational       — warm, patient, inviting learning tone
#   educational-alt   — alternate take of educational
#   tutorial          — lo-fi background, stays out of voiceover's way
#   tutorial-alt      — alternate take of tutorial
#
# Flags (all optional):
#   --mood=<name>     pick a preset from the library (default: tech)
#   --music=<path>    override with your own audio file (wins over --mood)
#   --voiceover=<path> add a voiceover / narration track
#   --voice-volume=<n> voiceover gain (default: 1.0)
#   --bgm-volume=<n>  BGM gain (default: 0.45, or 0.18 when voiceover is present)
#   --ducking=<n>     sidechain makeup when voiceover is present (default: 1.0)
#   --no-bgm          skip BGM and only keep voiceover
#   --out=<path>      output path (default: <input-basename>-mix.mp4)
#
# Legacy positional form still works: bash add-music.sh in.mp4 music.mp3 out.mp4
#
# Behavior:
#   - Music is trimmed to match video duration
#   - 0.3s fade in, 1.5s fade out (avoids hard cuts)
#   - When voiceover exists, BGM is ducked automatically
#   - Video stream copied (no re-encode), audio AAC 192k
#
# Examples:
#   bash add-music.sh my.mp4                                                # default: tech mood
#   bash add-music.sh my.mp4 --mood=ad                                      # switch mood
#   bash add-music.sh my.mp4 --voiceover=tmp/voice.wav --mood=tutorial      # narration + BGM
#   bash add-music.sh my.mp4 --voiceover=tmp/voice.wav --no-bgm             # narration only
#   bash add-music.sh my.mp4 --music=~/Downloads/song.mp3 --out=final.mp4   # bring your own
#
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ASSETS_DIR="$SCRIPT_DIR/../assets"

# ── Parse args ───────────────────────────────────────────────────────
INPUT=""
MOOD="tech"
CUSTOM_MUSIC=""
VOICEOVER=""
VOICE_VOLUME="1.0"
BGM_VOLUME=""
DUCKING="1.0"
SKIP_BGM="0"
OUTPUT=""
POSITIONAL=()

for arg in "$@"; do
  case "$arg" in
    --mood=*)  MOOD="${arg#*=}" ;;
    --music=*) CUSTOM_MUSIC="${arg#*=}" ;;
    --voiceover=*) VOICEOVER="${arg#*=}" ;;
    --voice-volume=*) VOICE_VOLUME="${arg#*=}" ;;
    --bgm-volume=*) BGM_VOLUME="${arg#*=}" ;;
    --ducking=*) DUCKING="${arg#*=}" ;;
    --no-bgm) SKIP_BGM="1" ;;
    --out=*)   OUTPUT="${arg#*=}" ;;
    *)         POSITIONAL+=("$arg") ;;
  esac
done

# Legacy positional: <input> [music] [output]
INPUT="${POSITIONAL[0]}"
[ -z "$CUSTOM_MUSIC" ] && [ -n "${POSITIONAL[1]}" ] && CUSTOM_MUSIC="${POSITIONAL[1]}"
[ -z "$OUTPUT" ]       && [ -n "${POSITIONAL[2]}" ] && OUTPUT="${POSITIONAL[2]}"

if [ -z "$INPUT" ] || [ ! -f "$INPUT" ]; then
  echo "Usage: bash add-music.sh <input.mp4> [--mood=<name>] [--music=<path>] [--voiceover=<path>] [--out=<path>]" >&2
  echo "Moods available: $(ls "$ASSETS_DIR" | grep -E '^bgm-.*\.mp3$' | sed 's/^bgm-//;s/\.mp3$//' | tr '\n' ' ')" >&2
  exit 1
fi

if [ -n "$VOICEOVER" ] && [ ! -f "$VOICEOVER" ]; then
  echo "✗ Voiceover not found: $VOICEOVER" >&2
  exit 1
fi

if [ "$SKIP_BGM" = "0" ]; then
  if [ -n "$CUSTOM_MUSIC" ]; then
    MUSIC="$CUSTOM_MUSIC"
    SOURCE_LABEL="custom: $MUSIC"
  else
    MUSIC="$ASSETS_DIR/bgm-${MOOD}.mp3"
    SOURCE_LABEL="mood: $MOOD"
  fi

  if [ ! -f "$MUSIC" ]; then
    echo "✗ Music not found: $MUSIC" >&2
    echo "  Available moods: $(ls "$ASSETS_DIR" | grep -E '^bgm-.*\.mp3$' | sed 's/^bgm-//;s/\.mp3$//' | tr '\n' ' ')" >&2
    exit 1
  fi
else
  MUSIC=""
  SOURCE_LABEL="none"
fi

if [ -z "$VOICEOVER" ] && [ "$SKIP_BGM" = "1" ]; then
  echo "✗ --no-bgm requires --voiceover, otherwise there is no audio to mix." >&2
  exit 1
fi

# ── Resolve output path ─────────────────────────────────────────────
INPUT_DIR="$(cd "$(dirname "$INPUT")" && pwd)"
INPUT_NAME="$(basename "$INPUT" .mp4)"
[ -z "$OUTPUT" ] && OUTPUT="$INPUT_DIR/$INPUT_NAME-mix.mp4"

# ── Measure video duration, compute fade-out start ──────────────────
DURATION=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$INPUT")
if [ -z "$DURATION" ]; then
  echo "✗ Could not read video duration" >&2
  exit 1
fi
FADE_OUT_START=$(awk "BEGIN { d = $DURATION - 1.5; if (d < 0) d = 0; print d }")

if [ -z "$BGM_VOLUME" ]; then
  if [ -n "$VOICEOVER" ]; then
    BGM_VOLUME="0.18"
  else
    BGM_VOLUME="0.45"
  fi
fi

echo "▸ Mixing audio into video"
echo "  input:    $INPUT"
echo "  music:    $SOURCE_LABEL"
echo "  voice:    ${VOICEOVER:-none}"
echo "  duration: ${DURATION}s"
echo "  output:   $OUTPUT"

if [ -n "$VOICEOVER" ] && [ "$SKIP_BGM" = "0" ]; then
  ffmpeg -y -loglevel error \
    -i "$INPUT" \
    -i "$VOICEOVER" \
    -i "$MUSIC" \
    -filter_complex "[1:a]atrim=0:${DURATION},asetpts=PTS-STARTPTS,volume=${VOICE_VOLUME}[voice];[2:a]atrim=0:${DURATION},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.3,afade=t=out:st=${FADE_OUT_START}:d=1.5,lowpass=f=4000,volume=${BGM_VOLUME}[bgm];[bgm][voice]sidechaincompress=threshold=0.015:ratio=10:attack=20:release=300:makeup=${DUCKING}[bgmduck];[bgmduck][voice]amix=inputs=2:duration=first:normalize=0[a]" \
    -map 0:v -map "[a]" \
    -c:v copy -c:a aac -b:a 192k -shortest \
    "$OUTPUT"
elif [ -n "$VOICEOVER" ]; then
  ffmpeg -y -loglevel error \
    -i "$INPUT" \
    -i "$VOICEOVER" \
    -filter_complex "[1:a]atrim=0:${DURATION},asetpts=PTS-STARTPTS,volume=${VOICE_VOLUME}[a]" \
    -map 0:v -map "[a]" \
    -c:v copy -c:a aac -b:a 192k -shortest \
    "$OUTPUT"
else
  ffmpeg -y -loglevel error \
    -i "$INPUT" \
    -i "$MUSIC" \
    -filter_complex "[1:a]atrim=0:${DURATION},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.3,afade=t=out:st=${FADE_OUT_START}:d=1.5,volume=${BGM_VOLUME}[a]" \
    -map 0:v -map "[a]" \
    -c:v copy -c:a aac -b:a 192k -shortest \
    "$OUTPUT"
fi

SIZE=$(du -h "$OUTPUT" | cut -f1)
echo "✓ Done: $OUTPUT ($SIZE)"
