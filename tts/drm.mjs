/**
 * drm.mjs - Sec-MS-GEC v2 token for Edge ReadAloud (zero deps).
 *
 * Token = "<cs64 16 hex>-<sha256 64 hex>" of the ascii string
 *   String( floor((unix/300)*300 + 11644473600) * 1e7 ) + TRUSTED_CLIENT_TOKEN
 * using Microsoft-s hi(sha256)+cs64 hand-rolled digests.
 */
export const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const M = 0xffffffff;
const u = (x) => x >>> 0;
const imul = (a, b) => Math.imul(a, b) >>> 0;
const rol16 = (v) => u((u(v) << 16) | (u(v) >>> 16));

const SHA256_INITIAL = [0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19];
const SHA256_STATE = [0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A, 0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2];
const SHA256_SCHEDULE = [0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA, 0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6, 0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33, 0xD258B060, 0x72766564];
const SHA256_ROUND_CONSTANTS = [
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
  0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
  0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
  0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
  0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
  0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
  0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
];
const SHA256_ADJUSTMENT = 0xC9DC06A7;
const SHA256_BLOCK_CONSTANTS = SHA256_ROUND_CONSTANTS.slice(0, 14).concat([SHA256_ADJUSTMENT], SHA256_ROUND_CONSTANTS.slice(15));
const SIGMA0_ADJ = 0x059C0B80;
const SIGMA1_ADJ = 0x000B92C0;

const CS64_COEFFICIENTS = [
  [0xE82E91B1, 0xB32700D0], [0x44DE24C6, 0x88DFF51D], [0x3BEB65BC, 0x29514038],
  [0xC89C5933, 0xB328CBDF], [0x8D1EC211, 0xD405B4D5], [0x314EF5D5, 0x26E55F3C],
  [0xE92491B1, 0x607801C6], [0xF0A5B9D5, 0x82B2C1FB], [0x06064CF3, 0xFA51A3DA],
  [0xDA79FA60, 0x207CC464], [0xBED20560, 0x3C3C74F3], [0x89F9C9F8, 0xD2D14B61],
  [0x35FA38C6, 0xBB04A2C1], [0xCB49E3C6, 0xC5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJ0 = 0xF2F90B1A;
const CS64_ADJ1 = 0x0B1A0000;

const rotr = (v, n) => u((v >>> n) | (v << (32 - n)));
const sigma0 = (v) => u((v >>> 7) ^ (v << 25) ^ (v >>> 18) ^ (v << 14) ^ (v >>> 3));
const sigma1 = (v) => u((v >>> 17) ^ (v << 15) ^ (v >>> 19) ^ (v << 13) ^ (v >>> 10));

function sha256Rounds(state, words, firstRound = 0) {
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  let [a, b, c, d, e, f, g, h] = state.map(u);
  for (let i = firstRound; i < 64; i++) {
    const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + (g ^ (e & (f ^ g))) + constants[i] + words[i]) >>> 0;
    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) | (c & (a | b)))) >>> 0;
    h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }
  return [a, b, c, d, e, f, g, h];
}

function expandSchedule(words, firstWord = 16) {
  for (let i = firstWord; i < 64; i++) {
    const x = words[i - 2], y = words[i - 15];
    const s1 = (((x >>> 17) ^ (x << 15) ^ (x >>> 19) ^ (x << 13) ^ (x >>> 10)) >>> 0);
    const s0 = (((y >>> 7) ^ (y << 25) ^ (y >>> 18) ^ (y << 14) ^ (y >>> 3)) >>> 0);
    words.push((s1 + words[i - 7] + s0 + words[i - 16]) >>> 0);
  }
}

function sha256Init(data) {
  const words = new Array(14).fill(0);
  words.push(u(data.readUIntBE(0, 3)));
  words.push(u(data.readUIntBE(3, 4)));
  for (let index = 16; index < 30; index++) {
    let value = SHA256_SCHEDULE[index - 16];
    if (index - 2 >= 14) value += (index === 16 ? (sigma1(words[index - 2]) ^ SIGMA1_ADJ) >>> 0 : sigma1(words[index - 2]));
    if (index - 7 >= 14) value += words[index - 7];
    if (index - 15 >= 14) value += (index === 29 ? (sigma0(words[index - 15]) ^ SIGMA0_ADJ) >>> 0 : sigma0(words[index - 15]));
    words.push(value >>> 0);
  }
  words.push((sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] + SHA256_ADJUSTMENT - SHA256_ROUND_CONSTANTS[14]) >>> 0);
  expandSchedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((init, i) => (init + working[i]) >>> 0);
}

export function sha256Digest(data) {
  if (data.length < 7) throw new Error('token salt must be at least 7 bytes');
  const length = 57 + data.length;
  const parts = [data.subarray(7), Buffer.from([0x80])];
  const padLen = (((55 - length) % 64) + 64) % 64;
  if (padLen) parts.push(Buffer.alloc(padLen));
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeUInt32BE(Math.floor((length * 8) / 4294967296), 0);
  lenBuf.writeUInt32BE((length * 8) >>> 0, 4);
  parts.push(lenBuf);
  const padded = Buffer.concat(parts);
  let state = sha256Init(data.subarray(0, 7));
  for (let off = 0; off < padded.length; off += 64) {
    const words = [];
    for (let i = 0; i < 16; i++) words.push(padded.readUInt32BE(off + i * 4));
    expandSchedule(words);
    const working = sha256Rounds(state, words);
    state = state.map((s, i) => (s + working[i]) >>> 0);
  }
  const out = Buffer.alloc(32);
  state.forEach((w, i) => out.writeUInt32BE(w, i * 4));
  return out;
}

function wordsLe4Even(data) {
  const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
  const words = [];
  for (let i = 0; i + 4 <= padded.length; i += 4) words.push(padded.readUInt32LE(i));
  if (words.length % 2) words.push(0);
  return words;
}

export function cs64Digest(data, digest) {
  let keyA = (digest.readUInt32LE(0) | 1) >>> 0;
  let keyB = (digest.readUInt32LE(4) | 1) >>> 0;
  const factors = [imul(keyA, CS64_FACTOR), imul(keyB, CS64_FACTOR)];
  const terms = CS64_COEFFICIENTS.map(([coef], i) => imul(coef, factors[i % 2]));
  const offsets = CS64_COEFFICIENTS.map(([, off]) => u(off));
  const src = Buffer.concat([Buffer.from([0]), data]);
  wordsLe4Even(src).forEach((word, index) => {
    let term = imul(word, index % 2 === 0 ? keyA : keyB);
    let offset = imul(rol16(word), index % 2 === 0 ? 0xEF0569FB : 0xC31713DB);
    if (index === 0) {
      term = (term + imul(CS64_ADJ0, factors[0])) >>> 0;
      offset = (offset + CS64_ADJ1) >>> 0;
    }
    terms.push(term >>> 0);
    offsets.push(offset >>> 0);
  });
  let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let t = rol16((offsets[i] + x) >>> 0);
    let q = imul(t, 0x76F50F34);
    swapAcc = (swapAcc + ((imul(rol16(q), 0xC3EFEA97) + q) >>> 0)) >>> 0;
    t = rol16((offsets[i + 1] + y) >>> 0);
    q = imul(t, 0x1881CE3C);
    swapLast = (imul(rol16(q), 0x35BD1EC9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (imul(state, keyA) + x) >>> 0;
    state = imul(rol16(state), 0xCF98B111);
    state = imul(rol16(state), 0x87085B9F);
    state = imul(rol16(state), 0x12CEB96D);
    state = imul(rol16(state), 0x257E1D83);
    acc = (acc + state) >>> 0;
    t = (imul(state, keyB) + y) >>> 0;
    t = imul(rol16(t), 0xA27416F5);
    t = imul(rol16(t), 0xD38396FF);
    state = imul(rol16(imul(rol16(t), 0x7C932B89)), 0xBFA49F69);
    acc = (acc + state) >>> 0;
  }
  const outBuf = Buffer.alloc(8);
  outBuf.writeUInt32LE((swapLast ^ state) >>> 0, 0);
  outBuf.writeUInt32LE((swapAcc ^ acc) >>> 0, 4);
  return outBuf;
}

export function generateSecMsGec(unixTimestamp) {
  const unix = unixTimestamp === undefined ? Math.floor(Date.now() / 1000) : unixTimestamp;
  const winSeconds = Math.floor(unix / 300) * 300 + 11644473600;
  const ticks = BigInt(winSeconds) * 10000000n;
  const data = Buffer.from(ticks.toString() + TRUSTED_CLIENT_TOKEN, 'ascii');
  const sha = sha256Digest(data);
  const cs = cs64Digest(data, sha);
  return cs.toString('hex').toUpperCase() + '-' + sha.toString('hex').toUpperCase();
}
