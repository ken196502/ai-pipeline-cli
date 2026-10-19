#!/usr/bin/env python3
"""edge-tts narration synthesizer.

Synthesizes one narration line into an MP3 file and a word-boundary JSON file
using the official `edge-tts` package (Microsoft Edge neural voices).

Usage:
    python3 tools/edge_tts_synth.py \
        --text "大家好" \
        --voice zh-CN-YunxiNeural \
        --rate "+0%" \
        --out-audio scene-001.mp3 \
        --out-words scene-001.words.json

Output words JSON:
    { "voice": "...", "rate": "...", "text": "...", "durationSec": 2.31,
      "words": [ { "word": "大家好", "t0": 0.12, "t1": 0.78 }, ... ] }
"""
import argparse
import asyncio
import json
import sys
import time


def fail(message: str) -> None:
    sys.stderr.write(f"edge_tts_synth: {message}\n")
    sys.exit(2)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="edge-tts narration synthesizer")
    parser.add_argument("--text", required=True, help="Narration text to synthesize")
    parser.add_argument("--voice", required=True, help="edge-tts voice name (e.g. zh-CN-YunxiNeural)")
    parser.add_argument("--rate", default="+0%", help="Speech rate adjustment (e.g. +10%%, -5%%)")
    parser.add_argument("--out-audio", required=True, help="Destination MP3 path")
    parser.add_argument("--out-words", required=True, help="Destination word-boundary JSON path")
    return parser.parse_args()


async def synthesize(text: str, voice: str, rate: str, out_audio: str) -> list:
    import edge_tts

    communicate = edge_tts.Communicate(text, voice=voice, rate=rate, boundary="WordBoundary")
    words = []
    audio_bytes = bytearray()
    async for chunk in communicate.stream():
        kind = chunk.get("type")
        if kind == "audio":
            audio_bytes.extend(chunk["data"])
        elif kind == "WordBoundary":
            offset = float(chunk.get("offset", 0)) / 1e7
            duration = float(chunk.get("duration", 0)) / 1e7
            if not chunk.get("text"):
                continue
            words.append(
                {
                    "word": chunk.get("text", ""),
                    "t0": round(offset, 3),
                    "t1": round(offset + duration, 3),
                }
            )

    if not audio_bytes:
        raise RuntimeError(f"edge-tts returned no audio for voice '{voice}' (text length {len(text)})")

    with open(out_audio, "wb") as handle:
        handle.write(audio_bytes)
    return words


def synthesize_with_retry(text: str, voice: str, rate: str, out_audio: str, attempts: int = 3) -> list:
    """Bounded retry with exponential backoff for transient edge-tts failures
    (throttling / network hiccups). Persistent failures surface the error."""
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            return asyncio.run(synthesize(text, voice, rate, out_audio))
        except Exception as error:  # noqa: BLE001 - surfaced after bounded retries
            last_error = error
            if attempt < attempts:
                time.sleep(2 ** attempt)
    raise last_error  # type: ignore[misc]


def main() -> None:
    args = parse_args()

    if not args.text.strip():
        fail("--text must not be empty")

    try:
        import edge_tts  # noqa: F401
    except ImportError:
        fail(
            "python package 'edge-tts' is not installed. Install it with: "
            "python3 -m pip install --user edge-tts"
        )

    words = synthesize_with_retry(args.text, args.voice, args.rate, args.out_audio)

    duration_sec = max((word["t1"] for word in words), default=0.0)
    payload = {
        "voice": args.voice,
        "rate": args.rate,
        "text": args.text,
        "durationSec": round(duration_sec, 3),
        "words": words,
    }
    with open(args.out_words, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
