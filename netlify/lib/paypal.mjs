// Cliente mínimo de la API de PayPal. Solo habla con los hosts oficiales y no sigue redirecciones.
import { createHmac, timingSafeEqual } from "node:crypto";

const HOSTS = { sandbox: "https://api-m.sandbox.paypal.com", live: "https://api-m.paypal.com" };

export function env(k) {
  try { const v = globalThis.Netlify?.env?.get(k); if (v != null) return v; } catch {}
  return process.env[k];
}

export function config() {
  const mode = (env("PAYPAL_ENV") || "").trim().toLowerCase();
  const id = (env("PAYPAL_CLIENT_ID") || "").trim();
  const secret = (env("PAYPAL_CLIENT_SECRET") || "").trim();
  if (!HOSTS[mode] || !id || !secret) return null;
  return { mode, base: HOSTS[mode], id, secret };
}

export class PayPalError extends Error {
  constructor(status, body) {
    super(`PayPal HTTP ${status}`);
    this.status = status;
    this.issue = body?.details?.[0]?.issue || body?.name || body?.error || "unknown";
    this.debugId = body?.debug_id || null; // sirve para soporte de PayPal; no contiene datos personales
  }
}

let cachedToken = null; // { token, exp, key }

async function call(cfg, path, { method = "GET", headers = {}, body, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(cfg.base + path, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(15000) });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (!res.ok) throw new PayPalError(res.status, json);
  return json;
}

export async function accessToken(cfg, fetchImpl = fetch) {
  const key = cfg.mode + ":" + cfg.id;
  if (cachedToken && cachedToken.key === key && Date.now() < cachedToken.exp) return cachedToken.token;
  const json = await call(cfg, "/v1/oauth2/token", {
    method: "POST", fetchImpl,
    headers: { Authorization: "Basic " + Buffer.from(cfg.id + ":" + cfg.secret).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!json?.access_token) throw new PayPalError(500, { name: "NO_TOKEN" });
  cachedToken = { token: json.access_token, exp: Date.now() + Math.max(60, (json.expires_in || 300) - 120) * 1000, key };
  return cachedToken.token;
}

export async function api(cfg, path, opts = {}) {
  const token = await accessToken(cfg, opts.fetchImpl);
  return call(cfg, path, { ...opts, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(opts.headers || {}) } });
}

export function _resetTokenCache() { cachedToken = null; }

// Firma de la orden: solo las órdenes creadas por nuestro servidor la tienen.
// Una orden armada en el navegador con el Client ID público no puede falsificarla.
function canonical(order) {
  const u = order.purchase_units[0];
  const items = (u.items || []).map((it) => [it.sku || "", String(it.quantity), it.unit_amount?.value || ""].join("~")).join(";");
  const b = u.amount?.breakdown || {};
  return ["v1", u.amount?.currency_code, u.amount?.value, b.item_total?.value || "", b.shipping?.value || "", items].join("|");
}

function mac(secret, text) {
  return createHmac("sha256", "soulgarden-order-v1:" + secret).update(text).digest("base64url").slice(0, 43);
}

export function signOrder(secret, body) {
  return "sg1." + mac(secret, canonical(body));
}

export function verifyOrder(secret, order) {
  const u = order?.purchase_units?.[0];
  if (!u || typeof u.custom_id !== "string" || !u.custom_id.startsWith("sg1.")) return false;
  const want = Buffer.from(mac(secret, canonical(order)));
  const got = Buffer.from(u.custom_id.slice(4));
  return want.length === got.length && timingSafeEqual(want, got);
}
