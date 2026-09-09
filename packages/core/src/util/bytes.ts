export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);
export const toHex = (b: Uint8Array): string => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h: string): Uint8Array => {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (s.length % 2) throw new Error("odd hex length");
  if (!/^[0-9a-fA-F]*$/.test(s)) throw new Error("invalid hex");
  return Uint8Array.from(s.match(/../g) ?? [], x => parseInt(x, 16));
};
export const toB64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
export const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));
export const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));
