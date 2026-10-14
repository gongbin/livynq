/** Bitstream helpers for parsing H.264 / H.265 parameter sets. */

/** Removes emulation-prevention bytes (00 00 03 → 00 00). */
export function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let o = 0;
  let zeros = 0;
  for (let i = 0; i < nal.length; i++) {
    const b = nal[i]!;
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    out[o++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, o);
}

export class BitReader {
  #data: Uint8Array;
  #pos = 0;

  constructor(data: Uint8Array) {
    this.#data = data;
  }

  get bitsLeft(): number {
    return this.#data.length * 8 - this.#pos;
  }

  bit(): number {
    const byte = this.#data[this.#pos >> 3];
    if (byte === undefined) throw new Error('bitstream overrun');
    const v = (byte >> (7 - (this.#pos & 7))) & 1;
    this.#pos++;
    return v;
  }

  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }

  skip(n: number): void {
    this.#pos += n;
  }

  /** Unsigned exp-Golomb */
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      zeros++;
      if (zeros > 31) throw new Error('invalid exp-Golomb code');
    }
    return (2 ** zeros - 1) + this.bits(zeros);
  }

  /** Signed exp-Golomb */
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
}

/** Splits an Annex-B byte stream (00 00 01 / 00 00 00 01 start codes) into NAL units. */
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && data[end - 1] === 0) end--;
        out.push(data.subarray(start, end));
      }
      i += 3;
      start = i;
    } else i++;
  }
  if (start >= 0 && start < data.length) out.push(data.subarray(start));
  return out;
}

export const hex = (b: number, n = 2) => b.toString(16).toUpperCase().padStart(n, '0');
