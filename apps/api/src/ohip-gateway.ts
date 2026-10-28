import { isIP } from "node:net";
export class OhipError extends Error {
  constructor(
    public status: number,
    public classification: string,
    public retryAfter = 0,
  ) {
    super(classification);
  }
}
export const classify = (status: number) =>
  status === 401
    ? "authentication"
    : status === 403
      ? "permission"
      : status === 429
        ? "throttled"
        : status >= 500
          ? "upstream"
          : status === 0
            ? "network"
            : "contract";
export function validateGateway(gateway: string) {
  let url: URL;
  try {
    url = new URL(gateway);
  } catch {
    throw new OhipError(400, "gateway_not_allowed");
  }
  const allowed = (process.env.OHIP_ALLOWED_HOSTS || "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  if (
    url.protocol !== "https:" ||
    isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0 ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname.endsWith(".local") ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !allowed.includes(url.hostname)
  )
    throw new OhipError(400, "gateway_not_allowed");
  return url.origin;
}
