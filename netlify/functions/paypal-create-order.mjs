// POST /api/paypal/create-order  { lines:[...], lang:"es"|"en", expected:<subtotal que vio el cliente> }
// Calcula el precio en el servidor y crea la orden en PayPal. "expected" NO se usa para cobrar:
// solo sirve para avisar al cliente si los precios cambiaron desde que cargó la página.
import products from "../../data/products.json" with { type: "json" };
import offers from "../../data/offers.json" with { type: "json" };
import gallery from "../../data/gallery.json" with { type: "json" };
import settings from "../../data/settings.json" with { type: "json" };
import { priceCart, paypalOrderBody, PricingError } from "../lib/pricing.mjs";
import { config as ppConfig, api, signOrder, PayPalError } from "../lib/paypal.mjs";
import { json, readJson, logError } from "../lib/http.mjs";

export const DATA = { products, offers, gallery, settings };

export async function handle(req, { data = DATA, now = Date.now(), fetchImpl } = {}) {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const cfg = ppConfig();
  if (!cfg) { logError("create", new Error("PayPal no configurado (variables de entorno)")); return json(503, { error: "not_configured" }); }
  const body = await readJson(req);
  if (!body) return json(400, { error: "bad_request" });

  let priced;
  try {
    priced = priceCart(data, body.lines, { lang: body.lang === "es" ? "es" : "en", now });
  } catch (e) {
    if (e instanceof PricingError) return json(422, { error: e.code, line: e.detail ?? null });
    logError("create/pricing", e); return json(500, { error: "server_error" });
  }
  const expected = parseFloat(body.expected);
  if (!Number.isFinite(expected) || Math.round(expected * 100) !== Math.round(priced.itemTotal * 100)) {
    return json(409, { error: "price_changed", subtotal: priced.itemTotal });
  }

  const order = paypalOrderBody(priced, "");
  order.purchase_units[0].custom_id = signOrder(cfg.secret, order);
  try {
    const res = await api(cfg, "/v2/checkout/orders", { method: "POST", body: JSON.stringify(order), fetchImpl });
    if (!res?.id) throw new PayPalError(502, { name: "NO_ORDER_ID" });
    return json(201, { id: res.id });
  } catch (e) {
    logError("create/paypal", e);
    return json(502, { error: "paypal_error" });
  }
}

export default (req) => handle(req);
export const config = { path: "/api/paypal/create-order" };
