import { isIP } from 'node:net';

/** Public global addresses only, including denial of metadata and IPv4 transition ranges. */
export function browserPublicAddress(value: string) {
  let address = value.toLowerCase();
  if (isIP(address) === 6)
    address = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number),
      a = parts[0],
      b = parts[1];
    if (a === undefined || b === undefined || address === '168.63.129.16')
      return false;
    return (
      a > 0 &&
      a < 224 &&
      a !== 10 &&
      a !== 127 &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && (b === 168 || b === 0)) &&
      !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 198 && (b === 18 || b === 19 || b === 51)) &&
      !(a === 203 && b === 0)
    );
  }
  return (
    isIP(address) === 6 &&
    /^[23][a-f\d]{3}:/.test(address) &&
    !/^2001:(?:db8:|:|0:|2:|20:|10:)/.test(address) &&
    !address.startsWith('2002:')
  );
}
