function text(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.subarray(start, end));
}
function starts(bytes: Uint8Array, signature: readonly number[]) {
  return signature.every((byte, index) => bytes[index] === byte);
}
function mp4Header(bytes: Uint8Array) {
  if (bytes.length < 16 || text(bytes, 4, 8) !== "ftyp") return false;
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (size < 16 || size > bytes.length || size % 4 !== 0) return false;
  return ["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V "].includes(
    text(bytes, 8, 12),
  );
}
function vint(bytes: Uint8Array, offset: number, id: boolean) {
  const first = bytes[offset];
  if (!first) return null;
  let mask = 0x80;
  let length = 1;
  while (!(first & mask)) {
    mask >>= 1;
    length++;
  }
  if (length > (id ? 4 : 8) || offset + length > bytes.length) return null;
  let value = id ? first : first & (mask - 1);
  for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i]!;
  if (!Number.isSafeInteger(value) || (!id && value === 2 ** (7 * length) - 1)) return null;
  return { value, end: offset + length };
}
function webmHeader(bytes: Uint8Array) {
  if (!starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return false;
  const size = vint(bytes, 4, false);
  if (!size || size.end + size.value > bytes.length) return false;
  const end = size.end + size.value;
  let webm = false;
  for (let offset = size.end; offset < end;) {
    const id = vint(bytes, offset, true);
    const length = id && vint(bytes, id.end, false);
    if (!id || !length || length.end + length.value > end) return false;
    if (id.value === 0x4282) {
      if (
        webm ||
        length.value !== 4 ||
        text(bytes, length.end, length.end + length.value) !== "webm"
      )
        return false;
      webm = true;
    }
    offset = length.end + length.value;
  }
  return webm;
}

export function nativeSpaceOriginalMime(bytes: Uint8Array) {
  if (starts(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (starts(bytes, [255, 216, 255])) return "image/jpeg";
  if (text(bytes, 0, 6) === "GIF87a" || text(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (text(bytes, 0, 4) === "RIFF" && text(bytes, 8, 12) === "WEBP") return "image/webp";
  if (/^%PDF-[12]\.[0-9]/.test(text(bytes, 0, 8))) return "application/pdf";
  if (mp4Header(bytes)) return "video/mp4";
  if (webmHeader(bytes)) return "video/webm";
  throw new Error("Choose an unchanged PNG, JPEG, GIF, WebP, PDF, MP4 or WebM original");
}
