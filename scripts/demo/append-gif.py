#!/usr/bin/env python3
"""Append a GIF without decoding/requantizing the archived opening frames.

Usage: append-gif.py ORIGINAL.gif SEGMENT.gif OUTPUT.gif
The original bytes through its last frame stay unchanged. Segment global colors
become local frame palettes, so they cannot change the original's colors.
"""
import pathlib
import sys


def subblocks_end(data, at):
    while data[at]:
        at += data[at] + 1
    return at + 1


def append(original, segment):
    if original[:6] not in (b"GIF87a", b"GIF89a") or segment[:6] not in (b"GIF87a", b"GIF89a"):
        raise ValueError("Both inputs must be GIFs")
    if original[-1:] != b";":
        raise ValueError("Original GIF has no final trailer")
    if original[6:10] != segment[6:10]:
        raise ValueError("GIF canvas dimensions must match")
    packed = segment[10]
    palette_end = 13 + (3 * 2 ** ((packed & 7) + 1) if packed & 128 else 0)
    palette = segment[13:palette_end]
    result = bytearray(original[:-1])
    at = palette_end
    while segment[at] != 0x3B:
        start = at
        if segment[at] == 0x21:
            at = subblocks_end(segment, at + 2)
            # Keep the original's looping behavior, not a second application loop directive.
            if segment[start + 1] == 0xFF and segment[start + 3:start + 14] == b"NETSCAPE2.0":
                continue
            result.extend(segment[start:at])
        elif segment[at] == 0x2C:
            descriptor = bytearray(segment[at:at + 10])
            at += 10
            frame_packed = descriptor[9]
            if frame_packed & 128:
                frame_palette_end = at + 3 * 2 ** ((frame_packed & 7) + 1)
                colors = segment[at:frame_palette_end]
                at = frame_palette_end
            else:
                if not palette:
                    raise ValueError("Segment frame has no palette")
                descriptor[9] = (frame_packed & 0x78) | 0x80 | (packed & 7)
                colors = palette
            end = subblocks_end(segment, at + 1)  # skip LZW minimum code size
            result.extend(descriptor)
            result.extend(colors)
            result.extend(segment[at:end])
            at = end
        else:
            raise ValueError(f"Unexpected GIF block at {at}")
    result.append(0x3B)
    return bytes(result)


if __name__ == "__main__":
    source, segment, target = map(pathlib.Path, sys.argv[1:])
    if target.resolve() in (source.resolve(), segment.resolve()):
        raise ValueError("Write a new file; preserve the source GIFs")
    result = append(source.read_bytes(), segment.read_bytes())
    target.write_bytes(result)
    print(f"Wrote {target} ({len(result)} bytes); original GIF prefix preserved byte-for-byte")
