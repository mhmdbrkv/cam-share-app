"use strict";
// Makes a MediaRecorder WebM file seekable in desktop players.
//
// Chromium's MediaRecorder writes WebM with an unknown-size Segment, unknown-size Clusters, no
// Duration and no Cues (seek index). Players such as Windows Media Player then refuse to seek
// (the slider does not move). finalizeWebm() writes a copy that adds:
//   - Duration in Info,
//   - a SeekHead at the start of the Segment (points to Info, Tracks and Cues),
//   - known sizes for the Segment and every Cluster (patched in place, same byte length),
//   - a Cues index at the end: one CuePoint per video keyframe.
// Media data (every block) is copied byte for byte. The input file is only read.
const fs = require("fs");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
};
// Segment children: an unknown-size Cluster ends where the next one of these starts.
const SEGMENT_CHILDREN = new Set([ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, 0x1043a770, 0x1254c367, 0x1941a469]);

// Buffered random-access reader (1 MB window) over an open file handle.
class Reader {
  constructor(fh, size) {
    this.fh = fh;
    this.size = size;
    this.buf = Buffer.alloc(1 << 20);
    this.start = 0;
    this.end = 0;
  }
  async bytes(pos, n) {
    if (pos < this.start || pos + n > this.end) {
      const { bytesRead } = await this.fh.read(this.buf, 0, this.buf.length, pos);
      this.start = pos;
      this.end = pos + bytesRead;
      if (pos + n > this.end) throw new Error("Unexpected end of file");
    }
    return this.buf.subarray(pos - this.start, pos - this.start + n);
  }
}

async function vint(r, pos, isId) {
  const first = (await r.bytes(pos, 1))[0];
  const len = Math.clz32(first) - 23; // position of the first set bit
  if (len < 1 || len > 8 || (isId && len > 4)) throw new Error(`Bad EBML data at byte ${pos}`);
  const b = await r.bytes(pos, len);
  let v = BigInt(isId ? b[0] : b[0] & (0xff >> len));
  for (let i = 1; i < len; i++) v = (v << 8n) | BigInt(b[i]);
  const unknown = !isId && v === (1n << BigInt(7 * len)) - 1n;
  return { len, value: Number(v), unknown };
}

async function header(r, pos) {
  const id = await vint(r, pos, true);
  const size = await vint(r, pos + id.len, false);
  return { pos, id: id.value, sizePos: pos + id.len, sizeLen: size.len, size: size.value, unknown: size.unknown, dataStart: pos + id.len + size.len };
}

const readUInt = (b) => b.reduce((v, x) => v * 256 + x, 0);

// ---- EBML writers ----
function idBytes(id) {
  const out = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return Buffer.from(out);
}
function sizeBytes(n, len) {
  if (!len) for (len = 1; n >= 2 ** (7 * len) - 1; len++);
  if (len > 8 || n >= 2 ** (7 * len) - 1) throw new Error("Element too large");
  const b = Buffer.alloc(len);
  let v = BigInt(n) | (1n << BigInt(7 * len));
  for (let i = len - 1; i >= 0; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}
function uintBytes(n, len) {
  if (!len) for (len = 1; len < 8 && n >= 2 ** (8 * len); len++);
  const b = Buffer.alloc(len);
  let v = BigInt(n);
  for (let i = len - 1; i >= 0; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}
const el = (id, payload) => Buffer.concat([idBytes(id), sizeBytes(payload.length), payload]);
const uintEl = (id, n, len) => el(id, uintBytes(n, len));

async function videoTrackNumber(r, tracks) {
  for (let p = tracks.dataStart; p < tracks.dataStart + tracks.size; ) {
    const e = await header(r, p);
    if (e.id === ID.TrackEntry) {
      let number = null,
        type = null;
      for (let q = e.dataStart; q < e.dataStart + e.size; ) {
        const c = await header(r, q);
        if (c.id === ID.TrackNumber) number = readUInt(await r.bytes(c.dataStart, c.size));
        if (c.id === ID.TrackType) type = readUInt(await r.bytes(c.dataStart, c.size));
        q = c.dataStart + c.size;
      }
      if (type === 1 && number != null) return number;
    }
    p = e.dataStart + e.size;
  }
  return null;
}

// Pass 1: read the structure (headers only).
async function scan(file) {
  const fh = await fs.promises.open(file, "r");
  try {
    const size = (await fh.stat()).size;
    const r = new Reader(fh, size);
    const ebml = await header(r, 0);
    if (ebml.id !== ID.EBML) throw new Error("Not a WebM file");
    const seg = await header(r, ebml.dataStart + ebml.size);
    if (seg.id !== ID.Segment) throw new Error("Segment not found");
    const end = seg.unknown ? size : Math.min(size, seg.dataStart + seg.size);
    let info = null,
      tracks = null,
      video = null;
    const clusters = [];
    let pos = seg.dataStart;
    while (pos < end) {
      const h = await header(r, pos);
      if (h.id === ID.Cluster) {
        const limit = h.unknown ? end : h.dataStart + h.size;
        let p = h.dataStart,
          timecode = null;
        const keyframes = [];
        while (p < limit) {
          const c = await header(r, p);
          if (h.unknown && SEGMENT_CHILDREN.has(c.id)) break;
          if (c.unknown) throw new Error("Unknown-size element inside a cluster");
          if (c.dataStart + c.size > limit) throw new Error("Truncated block at the end of the recording");
          if (c.id === ID.Timecode) timecode = readUInt(await r.bytes(c.dataStart, c.size));
          else if (c.id === ID.SimpleBlock && video != null) {
            const track = await vint(r, c.dataStart, false);
            const b = await r.bytes(c.dataStart + track.len, 3);
            if (track.value === video && b[2] & 0x80) keyframes.push(b.readInt16BE(0));
          }
          p = c.dataStart + c.size;
        }
        if (timecode == null) throw new Error("Cluster without a timecode");
        clusters.push({ pos, sizePos: h.sizePos, sizeLen: h.sizeLen, unknown: h.unknown, dataStart: h.dataStart, end: p, timecode, keyframes });
        pos = p;
      } else {
        if (h.unknown) throw new Error("Unknown-size element in the segment");
        if (h.id === ID.Cues || h.id === ID.SeekHead) throw new Error("Recording is already indexed");
        if (h.id === ID.Info) {
          let scale = 1000000;
          for (let q = h.dataStart; q < h.dataStart + h.size; ) {
            const c = await header(r, q);
            if (c.id === ID.Duration) throw new Error("Duration already present");
            if (c.id === ID.TimecodeScale) scale = readUInt(await r.bytes(c.dataStart, c.size));
            q = c.dataStart + c.size;
          }
          info = { pos, end: h.dataStart + h.size, payload: Buffer.from(await r.bytes(h.dataStart, h.size)), scale };
        } else if (h.id === ID.Tracks) {
          tracks = { pos };
          video = await videoTrackNumber(r, h);
        }
        pos = h.dataStart + h.size;
      }
    }
    if (!info) throw new Error("Info element not found");
    if (!tracks) throw new Error("Tracks element not found");
    if (video == null) throw new Error("No video track");
    if (!clusters.length) throw new Error("No media clusters");
    if (info.pos > tracks.pos || tracks.pos > clusters[0].pos) throw new Error("Unexpected element order");
    return { size, seg, end: pos, info, tracks, video, clusters };
  } finally {
    await fh.close();
  }
}

// Pass 2: write the indexed copy. `output` must not exist.
async function finalizeWebm(file, output, durationMs) {
  const s = await scan(file);
  const segData = s.seg.dataStart;

  const duration = Buffer.alloc(8);
  duration.writeDoubleBE((durationMs * 1e6) / s.info.scale);
  const newInfo = el(ID.Info, Buffer.concat([s.info.payload, el(ID.Duration, duration)]));

  // SeekHead with fixed 8-byte positions, so its length is known before the positions are.
  const seek = (id, at) => el(ID.Seek, Buffer.concat([el(ID.SeekID, idBytes(id)), uintEl(ID.SeekPosition, at, 8)]));
  const seekHeadLen = el(ID.SeekHead, Buffer.concat([seek(ID.Info, 0), seek(ID.Tracks, 0), seek(ID.Cues, 0)])).length;

  // Offsets inside the new segment data for bytes of the original file.
  const shiftAfterInfo = seekHeadLen + newInfo.length - (s.info.end - s.info.pos);
  const newPos = (abs) => abs - segData + (abs >= s.info.end ? shiftAfterInfo : seekHeadLen);

  const points = [];
  for (const c of s.clusters) {
    const times = c.keyframes.length ? c.keyframes : [0];
    for (const rel of times) {
      points.push(
        el(
          ID.CuePoint,
          Buffer.concat([
            uintEl(ID.CueTime, Math.max(0, c.timecode + rel)),
            el(ID.CueTrackPositions, Buffer.concat([uintEl(ID.CueTrack, s.video), uintEl(ID.CueClusterPosition, newPos(c.pos))])),
          ]),
        ),
      );
    }
  }
  const cues = el(ID.Cues, Buffer.concat(points));
  const cuesPos = newPos(s.end);

  const seekHead = el(ID.SeekHead, Buffer.concat([seek(ID.Info, seekHeadLen + (s.info.pos - segData)), seek(ID.Tracks, newPos(s.tracks.pos)), seek(ID.Cues, cuesPos)]));
  if (seekHead.length !== seekHeadLen) throw new Error("SeekHead size changed");

  const segmentSize = cuesPos + cues.length;
  const segHeader = Buffer.concat([idBytes(ID.Segment), sizeBytes(segmentSize, s.seg.sizeLen === 8 ? 8 : undefined)]);

  async function* parts() {
    const range = (start, end) => (end > start ? fs.createReadStream(file, { start, end: end - 1 }) : null);
    const ebmlHeader = range(0, s.seg.pos);
    if (ebmlHeader) yield* ebmlHeader;
    yield segHeader;
    yield seekHead;
    const beforeInfo = range(segData, s.info.pos);
    if (beforeInfo) yield* beforeInfo;
    yield newInfo;
    // Tracks and everything up to the end of the last cluster, with cluster sizes made known.
    let from = s.info.end;
    for (const c of s.clusters) {
      if (!c.unknown || c.sizeLen !== 8) continue; // already known, or no room to patch in place
      const before = range(from, c.sizePos);
      if (before) yield* before;
      yield sizeBytes(c.end - c.dataStart, 8);
      from = c.sizePos + 8;
    }
    const rest = range(from, s.end);
    if (rest) yield* rest;
    yield cues;
  }
  await pipeline(Readable.from(parts()), fs.createWriteStream(output, { flags: "wx" }));
  return { clusters: s.clusters.length, cuePoints: points.length, videoTrack: s.video };
}

module.exports = { finalizeWebm };
