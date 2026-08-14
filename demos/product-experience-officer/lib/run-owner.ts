const HTTPS_RUN_OWNER_COOKIE = "__Host-pxo_run_owner";
const LOCAL_RUN_OWNER_COOKIE = "pxo_run_owner";
const RUN_OWNER_PATTERN = /^[a-f0-9]{64}$/;
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export type RunOwner = {
  ownerId: string;
  setCookie: string | null;
};

function cookieValue(request: Request, name: string) {
  const cookies = request.headers.get("cookie") || "";
  for (const entry of cookies.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() === name) {
      return entry.slice(separator + 1).trim();
    }
  }
  return "";
}

function randomOwnerId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

function isHttps(request: Request) {
  if (process.env.MEOO_RUNTIME === "image") return true;
  const forwardedProtocol = request.headers
    .get("x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  return forwardedProtocol === "https" || new URL(request.url).protocol === "https:";
}

export function resolveRunOwner(request: Request): RunOwner {
  const secure = isHttps(request);
  const cookieName = secure
    ? HTTPS_RUN_OWNER_COOKIE
    : LOCAL_RUN_OWNER_COOKIE;
  const existing = cookieValue(request, cookieName);
  if (RUN_OWNER_PATTERN.test(existing)) {
    return { ownerId: existing, setCookie: null };
  }

  const ownerId = randomOwnerId();
  const attributes = [
    `${cookieName}=${ownerId}`,
    `Max-Age=${ONE_YEAR_SECONDS}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) attributes.push("Secure");

  return {
    ownerId,
    setCookie: attributes.join("; "),
  };
}

export function withRunOwnerCookie(response: Response, owner: RunOwner) {
  if (owner.setCookie) {
    response.headers.append("set-cookie", owner.setCookie);
  }
  return response;
}
