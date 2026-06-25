// Minimal UUID v7 generator (time-ordered, no external dependency)
let _seq = 0;
export function uuidv7() {
  const ms = Date.now();
  const hex = ms.toString(16).padStart(12, '0');
  _seq = (_seq + 1) & 0xfff;
  const seqHex = _seq.toString(16).padStart(3, '0');
  const rand = Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join(
    '',
  );
  return `${hex.slice(0, 8)}-${hex.slice(8)}${seqHex.slice(0, 1)}-7${seqHex.slice(1)}${rand.slice(0, 1)}-${(0x80 | (Math.random() * 0x40)).toString(16).slice(0, 2)}${rand.slice(1, 4)}-${rand.slice(4)}`;
}
