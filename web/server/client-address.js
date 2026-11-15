import { BlockList, isIP } from "node:net";

function normalize(address) {
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6 || address.includes("%"))
    throw new Error("Use a valid IP address for the sign-in client.");
  const ip = new URL(`http://[${address}]`).hostname.slice(1, -1);
  // IPv4 and IPv4-mapped IPv6 must share one rate-limit bucket.
  const mapped = ip.match(/^::ffff:([a-f0-9]+):([a-f0-9]+)$/);
  if (!mapped) return ip;
  const high = parseInt(mapped[1], 16),
    low = parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

// Trust network peers explicitly, not a hop count or a caller-supplied header.
export function clientAddressResolver(config = "") {
  const proxies = new BlockList();
  for (const entry of config
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [address, prefix, extra] = entry.split("/");
    const family = isIP(address);
    if (
      !family ||
      address.includes("%") ||
      extra !== undefined ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) ||
          Number(prefix) > (family === 4 ? 32 : 128)))
    )
      throw new Error(
        "STAR_GAZER_TRUSTED_PROXIES must contain comma-separated IP addresses or CIDR ranges.",
      );
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) proxies.addAddress(address, type);
    else proxies.addSubnet(address, Number(prefix), type);
  }
  const trusted = (ip) =>
    proxies.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6");
  return (req) => {
    let client = normalize(req.socket.remoteAddress);
    if (!trusted(client)) return client;
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded !== "string" || !forwarded.trim())
      throw new Error(
        "The trusted proxy must supply X-Forwarded-For for sign-in requests.",
      );
    const chain = forwarded.split(",");
    if (chain.length > 32) throw new Error("Too many forwarded addresses.");
    // Work from the socket towards the client. Anything beyond the first
    // untrusted hop could have been forged by that client and is ignored.
    for (let i = chain.length - 1; i >= 0 && trusted(client); i--)
      client = normalize(chain[i].trim());
    return client;
  };
}
