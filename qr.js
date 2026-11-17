// The sign-in code as a QR code, for the phone's camera to read (0.16.0): byte mode, error correction
// level M, versions 1 to 10, and the mask with the lowest penalty. The modules come back as [y][x],
// true for dark, without the quiet zone.
//
// This is a port of the phone's own encoder, `app/src/main/java/com/mehub/Qr.kt`, line for line and
// function for function, as `mirror.js` is of `Mirror.kt`. **A change to one needs the same change in
// the other.** `qr.test.js` pins this file to modules written out by the Kotlin encoder itself, so a
// port that drifts fails rather than quietly drawing a code the phone cannot read.
//
// Written from ISO/IEC 18004 along the lines of Nayuki's QR Code generator
// (../licenses/QR-Code-generator-MIT.txt), since no library is added.
export function qrCode(text, mask = null) {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    if (4 + countBits(v) + bytes.length * 8 <= dataCodewords(v) * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error('Too long for a version 10 QR code');
  const grid = new QrGrid(version);
  grid.place(withEcc(version, dataBits(version, bytes)));
  let best = mask;
  if (best === null) {
    let lowest = Infinity;
    for (let m = 0; m <= 7; m++) {
      grid.mask(m);
      grid.format(m);
      const score = grid.penalty();
      grid.mask(m);
      if (score < lowest) {
        lowest = score;
        best = m;
      }
    }
  }
  grid.mask(best);
  grid.format(best);
  return grid.dark;
}

// Level M, by version: error correction codewords per block, and the number of blocks.
const ECC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

const countBits = (version) => (version < 10 ? 8 : 16);

// Modules left for codewords once the function patterns are drawn, remainder bits included.
function rawModules(version) {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

const dataCodewords = (version) =>
  Math.floor(rawModules(version) / 8) - ECC[version] * BLOCKS[version];

// Mode, length, the bytes, a terminator, then the 0xEC 0x11 padding up to the version's capacity.
function dataBits(version, bytes) {
  const capacity = dataCodewords(version) * 8;
  const bits = [];
  const put = (value, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push(((value >>> i) & 1) === 1);
  };
  put(0b0100, 4);
  put(bytes.length, countBits(version));
  for (const b of bytes) put(b & 0xff, 8);
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  let pad = 0xec;
  while (bits.length < capacity) {
    put(pad, 8);
    pad = pad ^ 0xec ^ 0x11;
  }
  const out = new Uint8Array(capacity / 8);
  for (let i = 0; i < out.length; i++) {
    let acc = 0;
    for (let j = 0; j < 8; j++) acc = (acc << 1) | (bits[i * 8 + j] ? 1 : 0);
    out[i] = acc;
  }
  return out;
}

// Splits the data into blocks, adds each block's Reed-Solomon codewords, and interleaves them: the data
// a column at a time (the later, longer blocks have one more), then the error correction.
function withEcc(version, data) {
  const blocks = BLOCKS[version];
  const ecc = ECC[version];
  const raw = Math.floor(rawModules(version) / 8);
  const short = blocks - (raw % blocks);
  const shortData = Math.floor(raw / blocks) - ecc;
  const divisor = rsDivisor(ecc);
  const parts = [];
  let k = 0;
  for (let i = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortData + (i < short ? 0 : 1));
    k += dat.length;
    parts.push([dat, rsRemainder(dat, divisor)]);
  }
  const out = [];
  for (let i = 0; i <= shortData; i++) for (const [dat] of parts) if (i < dat.length) out.push(dat[i]);
  for (let i = 0; i < ecc; i++) for (const [, e] of parts) out.push(e[i]);
  return new Uint8Array(out);
}

// GF(256) over x^8 + x^4 + x^3 + x^2 + 1.
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z = z ^ (((y >>> i) & 1) * x);
  }
  return z;
}

function rsDivisor(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let n = 0; n < degree; n++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < r.length) r[j] = r[j] ^ r[j + 1];
    }
    root = gfMul(root, 2);
  }
  return r;
}

function rsRemainder(data, divisor) {
  const r = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = (b & 0xff) ^ r[0];
    r.copyWithin(0, 1);
    r[r.length - 1] = 0;
    for (let i = 0; i < r.length; i++) r[i] = r[i] ^ gfMul(divisor[i], factor);
  }
  return new Uint8Array(r);
}

// The standard's eight masks.
function qrMaskAt(m, x, y) {
  switch (m) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

const FINDER_LIKE = ['10111010000', '00001011101'];

class QrGrid {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.function = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    // Timing lines, the three finders, the alignment patterns, the format area and, from version 7,
    // the version.
    for (let i = 0; i < this.size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [this.size - 4, 3], [3, this.size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.set(x, y, ring !== 2 && ring !== 4);
      }
    }
    const align = this.alignment();
    for (let i = 0; i < align.length; i++) for (let j = 0; j < align.length; j++) {
      // The three corners already hold finders.
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        this.set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    this.format(0);
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const on = ((bits >>> i) & 1) === 1;
        const a = this.size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, on);
        this.set(b, a, on);
      }
    }
  }

  set(x, y, on) {
    this.dark[y][x] = on;
    this.function[y][x] = true;
  }

  alignment() {
    if (this.version === 1) return [];
    const n = Math.floor(this.version / 7) + 2;
    const step = Math.floor((this.version * 4 + n * 2 + 1) / (n * 2 - 2)) * 2;
    const out = [6];
    for (let i = 1; i < n; i++) out.push(this.size - 7 - (n - 1 - i) * step);
    return out;
  }

  // Level M (00) and the mask, BCH-coded, in both copies.
  format(mask) {
    let rem = mask;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((mask << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(i));
    this.set(8, this.size - 8, true);
  }

  // The codewords in two-column zigzags from the bottom right, skipping the vertical timing line.
  place(data) {
    let i = 0;
    let right = this.size - 1;
    while (right >= 1) {
      if (right === 6) right = 5;
      const upward = ((right + 1) & 2) === 0;
      for (let vert = 0; vert < this.size; vert++) for (let j = 0; j <= 1; j++) {
        const x = right - j;
        const y = upward ? this.size - 1 - vert : vert;
        if (!this.function[y][x] && i < data.length * 8) {
          this.dark[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
      right -= 2;
    }
  }

  // XOR, so applying the same mask again takes it off.
  mask(m) {
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) {
      if (qrMaskAt(m, x, y) && !this.function[y][x]) this.dark[y][x] = !this.dark[y][x];
    }
  }

  // The standard's four rules: long runs, 2x2 blocks, finder look-alikes, and too much of one colour.
  penalty() {
    let score = 0;
    const line = (at) => {
      let run = 1;
      for (let i = 1; i < this.size; i++) {
        if (at(i) === at(i - 1)) {
          run++;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
      for (let i = 0; i <= this.size - 11; i++) {
        let word = '';
        for (let j = 0; j < 11; j++) word += at(i + j) ? '1' : '0';
        if (FINDER_LIKE.includes(word)) score += 40;
      }
    };
    for (let y = 0; y < this.size; y++) line((i) => this.dark[y][i]);
    for (let x = 0; x < this.size; x++) line((i) => this.dark[i][x]);
    for (let y = 0; y < this.size - 1; y++) for (let x = 0; x < this.size - 1; x++) {
      const c = this.dark[y][x];
      if (c === this.dark[y][x + 1] && c === this.dark[y + 1][x] && c === this.dark[y + 1][x + 1]) score += 3;
    }
    let darkCount = 0;
    for (const row of this.dark) for (const on of row) if (on) darkCount++;
    const total = this.size * this.size;
    score += (Math.floor((Math.abs(darkCount * 20 - total * 10) + total - 1) / total) - 1) * 10;
    return score;
  }
}
