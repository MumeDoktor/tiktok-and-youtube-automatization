"""
Speaks a narration script with edge-tts and reports word timings.

Called by src/lib/tts.ts. Reads one JSON job from a file and writes one mp3
per script line, because per-line synthesis buys three things that speaking
the whole script at once does not:

  - exact per-line timings, so a shot can be cut to the line it illustrates
  - deliberate pauses between lines, which is most of what makes narration
    sound like a person rather than a wall of speech
  - word timings that never have to be re-aligned against the input text

edge-tts 7.x defaults to SentenceBoundary and silently emits no word events;
boundary="WordBoundary" is required and is the whole reason this file exists.
"""

import asyncio
import json
import sys

import edge_tts


async def speak_line(text: str, voice: str, rate: str, out_path: str) -> list:
    communicate = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
    audio = bytearray()
    words = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            # edge-tts reports in 100-nanosecond units.
            words.append(
                {
                    "text": chunk["text"],
                    "startMs": chunk["offset"] / 10_000,
                    "endMs": (chunk["offset"] + chunk["duration"]) / 10_000,
                }
            )
    if not audio:
        raise RuntimeError(f"no audio returned for: {text[:60]!r}")
    with open(out_path, "wb") as handle:
        handle.write(audio)
    return words


async def main() -> None:
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        job = json.load(handle)

    voice = job.get("voice") or "en-US-GuyNeural"
    rate = job.get("rate") or "+0%"
    results = []

    for index, line in enumerate(job["lines"]):
        out_path = job["files"][index]
        # The service refuses a handshake now and then (HTTP 403) and accepts the
        # next one. One refused line used to cost the whole narration.
        for attempt in range(5):
            try:
                words = await speak_line(line["text"], voice, rate, out_path)
                break
            except Exception:
                if attempt == 4:
                    raise
                await asyncio.sleep(2 + attempt * 4)
        results.append({"index": index, "file": out_path, "words": words})

    json.dump({"lines": results}, sys.stdout)


asyncio.run(main())
