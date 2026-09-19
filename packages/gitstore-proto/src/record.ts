import { gzipSync, zstdCompressSync, constants as zc } from 'node:zlib';
import { canonical, sha256 } from './gitstore.ts';

/**
 * Denormalised, self-contained hand records. A table ref points at the table's current state;
 * a hand starts at `s0` (hash of the state before it) and ends at `s1`. Everything needed to
 * replay or audit the hand is inside the record: the cards each seat received, every action,
 * the result. `ph` chains records of one table. Card = 6-bit index (rank-2)*4 + suit(c,d,h,s).
 */
export interface OfcHandRecord {
  v: 1;
  g: 'ofc';
  c: string; // club id
  t: string; // table id
  n: number; // hand number
  s0: string; // start state hash (hex sha256)
  s1: string; // end state hash
  ph: string; // previous record hash ('genesis' for the first)
  at: [number, number]; // start/end ms
  seed?: string; // seeded-mode seed (hex), absent for per-draw
  btn: number;
  deals: number[][]; // per seat, cards in deal order
  acts: Array<{ s: number; p: Array<[number, number]>; d: number[] }>; // placements [card,row], discards
  res: {
    pts: number[];
    roy: number[];
    foul: number;
    fl: number[];
    rake: number;
    tr: Array<[number, number, number]>;
  };
}

export interface BgGameRecord {
  v: 1;
  g: 'bg';
  c: string;
  t: string;
  n: number; // game number
  s0: string;
  s1: string;
  ph: string;
  at: [number, number];
  seed?: string;
  /** Compact action stream: [code, ...payload]. 0 opening [w,b], 1 roll [p,d1,d2], 2 play [p, from,to,die ...], 3 double [p], 4 take [p], 5 drop [p], 6 resign… */
  acts: number[][];
  res: {
    winner: number;
    kind: number;
    points: number;
    cube: number;
    tr: Array<[number, number, number]>;
  };
}

export type AnyRecord = OfcHandRecord | BgGameRecord;

export const ROWS = ['top', 'middle', 'bottom'] as const;
const SUITS = 'cdhs';
export function cardIndex(card: { rank: number; suit: string }): number {
  return (card.rank - 2) * 4 + SUITS.indexOf(card.suit);
}

/** Verbose JSON: descriptive keys, what a naive implementation would store. */
export function verboseJson(r: AnyRecord): string {
  if (r.g === 'ofc') {
    return canonical({
      version: r.v,
      game: 'ofc',
      clubId: r.c,
      tableId: r.t,
      handNumber: r.n,
      startStateHash: r.s0,
      endStateHash: r.s1,
      previousHash: r.ph,
      startedAt: r.at[0],
      endedAt: r.at[1],
      seed: r.seed,
      button: r.btn,
      deals: r.deals.map((cards, seat) => ({ seat, cards: cards.map(cardName) })),
      actions: r.acts.map((a) => ({
        type: 'place',
        seat: a.s,
        placements: a.p.map(([card, row]) => ({ card: cardName(card), row: ROWS[row] })),
        discards: a.d.map(cardName),
      })),
      result: {
        points: r.res.pts,
        royalties: r.res.roy,
        fouled: r.res.pts.map((_, i) => Boolean(r.res.foul & (1 << i))),
        fantasylandNext: r.res.fl,
        rake: r.res.rake,
        transfers: r.res.tr.map(([from, to, points]) => ({ from, to, points })),
      },
    });
  }
  return canonical({
    version: r.v,
    game: 'backgammon',
    clubId: r.c,
    tableId: r.t,
    gameNumber: r.n,
    startStateHash: r.s0,
    endStateHash: r.s1,
    previousHash: r.ph,
    startedAt: r.at[0],
    endedAt: r.at[1],
    seed: r.seed,
    actions: r.acts.map((a) => {
      const [code, ...rest] = a;
      switch (code) {
        case 0:
          return { type: 'opening-roll', white: rest[0], black: rest[1] };
        case 1:
          return { type: 'roll', player: rest[0] ? 'black' : 'white', dice: [rest[1], rest[2]] };
        case 2: {
          const moves = [];
          for (let i = 1; i < rest.length; i += 3)
            moves.push({ from: rest[i], to: rest[i + 1], die: rest[i + 2] });
          return { type: 'play', player: rest[0] ? 'black' : 'white', play: moves };
        }
        case 3:
          return { type: 'double', player: rest[0] ? 'black' : 'white' };
        case 4:
          return { type: 'take', player: rest[0] ? 'black' : 'white' };
        case 5:
          return { type: 'drop', player: rest[0] ? 'black' : 'white' };
        default:
          return { type: 'other', code, payload: rest };
      }
    }),
    result: {
      winner: r.res.winner ? 'black' : 'white',
      kind: ['single', 'gammon', 'backgammon'][r.res.kind],
      points: r.res.points,
      cube: r.res.cube,
      transfers: r.res.tr,
    },
  });
}

export function cardName(i: number): string {
  const rank = Math.floor(i / 4) + 2;
  const r = rank <= 9 ? String(rank) : 'TJQKA'[rank - 10];
  return `${r}${SUITS[i % 4]}`;
}

/** Short-key JSON: the record as is, minified. */
export function shortJson(r: AnyRecord): string {
  return JSON.stringify(r);
}

// ---- compact binary -------------------------------------------------------------------------
class Writer {
  private buf = Buffer.alloc(1024);
  private pos = 0;
  private ensure(n: number) {
    if (this.pos + n > this.buf.length) {
      const nb = Buffer.alloc(Math.max(this.buf.length * 2, this.pos + n));
      this.buf.copy(nb);
      this.buf = nb;
    }
  }
  u8(v: number) {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
  }
  varint(v: number) {
    // zig-zag for negatives
    let z = v < 0 ? -2 * v - 1 : 2 * v;
    do {
      let b = z & 0x7f;
      z = Math.floor(z / 128);
      if (z > 0) b |= 0x80;
      this.u8(b);
    } while (z > 0);
  }
  bytes(b: Buffer) {
    this.ensure(b.length);
    b.copy(this.buf, this.pos);
    this.pos += b.length;
  }
  str(s: string) {
    const b = Buffer.from(s, 'utf8');
    this.varint(b.length);
    this.bytes(b);
  }
  hex(h: string) {
    this.bytes(Buffer.from(h === 'genesis' ? '00'.repeat(32) : h, 'hex'));
  }
  /** Pack 6-bit card indexes, 4 cards per 3 bytes. */
  cards(cs: number[]) {
    this.varint(cs.length);
    let acc = 0;
    let bits = 0;
    for (const c of cs) {
      acc = (acc << 6) | (c & 63);
      bits += 6;
      while (bits >= 8) {
        this.u8(acc >> (bits - 8));
        bits -= 8;
        acc &= (1 << bits) - 1;
      }
    }
    if (bits > 0) this.u8(acc << (8 - bits));
  }
  done(): Buffer {
    return this.buf.subarray(0, this.pos);
  }
}

/** Hand-rolled binary: ids omitted when `inChunk` (the chunk carries club/table once). */
export function binary(r: AnyRecord, inChunk = false): Buffer {
  const w = new Writer();
  w.u8(r.v);
  w.u8(r.g === 'ofc' ? 1 : 2);
  if (!inChunk) {
    w.str(r.c);
    w.str(r.t);
  }
  w.varint(r.n);
  w.hex(r.s0);
  w.hex(r.s1);
  if (!inChunk) w.hex(r.ph);
  w.varint(r.at[0]);
  w.varint(r.at[1] - r.at[0]);
  if (r.seed) {
    w.u8(1);
    w.hex(r.seed);
  } else w.u8(0);
  if (r.g === 'ofc') {
    w.u8(r.btn);
    w.u8(r.deals.length);
    for (const d of r.deals) w.cards(d);
    w.varint(r.acts.length);
    for (const a of r.acts) {
      w.u8(a.s);
      // placements: card index + row (2 bits) → one byte each (6+2 bits)
      w.varint(a.p.length);
      for (const [card, row] of a.p) w.u8((card << 2) | row);
      w.cards(a.d);
    }
    for (const p of r.res.pts) w.varint(p);
    for (const p of r.res.roy) w.varint(p);
    w.u8(r.res.foul);
    for (const f of r.res.fl) w.u8(f);
    w.varint(r.res.rake);
    w.varint(r.res.tr.length);
    for (const [f, t, p] of r.res.tr) {
      w.u8((f << 4) | t);
      w.varint(p);
    }
  } else {
    w.varint(r.acts.length);
    for (const a of r.acts) {
      w.u8(a[0]!);
      w.varint(a.length - 1);
      for (let i = 1; i < a.length; i++) w.u8(a[i]!);
    }
    w.u8((r.res.winner << 4) | r.res.kind);
    w.varint(r.res.points);
    w.varint(r.res.cube);
    w.varint(r.res.tr.length);
    for (const [f, t, p] of r.res.tr) {
      w.u8((f << 4) | t);
      w.varint(p);
    }
  }
  return w.done();
}

export interface SizeRow {
  verboseJson: number;
  shortJson: number;
  binary: number;
  verboseGzip: number;
  shortGzip: number;
  binaryGzip: number;
  shortZstd: number;
  binaryZstd: number;
}

export function sizes(r: AnyRecord): SizeRow {
  const v = Buffer.from(verboseJson(r));
  const s = Buffer.from(shortJson(r));
  const b = binary(r);
  const gz = (x: Buffer) => gzipSync(x, { level: 9 }).length;
  const zs = (x: Buffer) =>
    zstdCompressSync(x, { params: { [zc.ZSTD_c_compressionLevel]: 19 } }).length;
  return {
    verboseJson: v.length,
    shortJson: s.length,
    binary: b.length,
    verboseGzip: gz(v),
    shortGzip: gz(s),
    binaryGzip: gz(b),
    shortZstd: zs(s),
    binaryZstd: zs(b),
  };
}

/** Bytes of a chunk of records: NDJSON (short keys) and concatenated binary, raw and compressed. */
export function chunkSizes(rs: AnyRecord[]): {
  ndjson: number;
  ndjsonGzip: number;
  ndjsonZstd: number;
  bin: number;
  binGzip: number;
  binZstd: number;
} {
  const nd = Buffer.from(rs.map(shortJson).join('\n') + '\n');
  const bin = Buffer.concat(
    rs.map((r) => {
      const b = binary(r, true);
      const len = Buffer.alloc(2);
      len.writeUInt16BE(b.length);
      return Buffer.concat([len, b]);
    }),
  );
  const zs = (x: Buffer) =>
    zstdCompressSync(x, { params: { [zc.ZSTD_c_compressionLevel]: 19 } }).length;
  return {
    ndjson: nd.length,
    ndjsonGzip: gzipSync(nd, { level: 9 }).length,
    ndjsonZstd: zs(nd),
    bin: bin.length,
    binGzip: gzipSync(bin, { level: 9 }).length,
    binZstd: zs(bin),
  };
}

export function recordHash(r: AnyRecord): string {
  return sha256(canonical(r));
}
