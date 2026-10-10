// POST /api/paypal/capture-order  { orderID }
// Solo cobra órdenes creadas y firmadas por nuestro servidor, y confirma que el cobro quedó COMPLETED
// por el monto exacto de la orden.
import { config as ppConfig, api, verifyOrder, PayPalError } from "../lib/paypal.mjs";
import { json, readJson, logError } from "../lib/http.mjs";

const ORDER_ID = /^[A-Z0-9]{10,25}$/;

export async function handle(req, { fetchImpl } = {}) {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const cfg = ppConfig();
  if (!cfg) { logError("capture", new Error("PayPal no configurado (variables de entorno)")); return json(503, { error: "not_configured" }); }
  const body = await readJson(req, 1024);
  const id = body && typeof body.orderID === "string" ? body.orderID : "";
  if (!ORDER_ID.test(id)) return json(400, { error: "bad_request" });

  let order;
  try {
    order = await api(cfg, "/v2/checkout/orders/" + id, { fetchImpl });
  } catch (e) {
    logError("capture/get", e, { orderId: id });
    return json(e instanceof PayPalError && e.status === 404 ? 404 : 502, { error: e.status === 404 ? "not_found" : "paypal_error" });
  }
  if (!verifyOrder(cfg.secret, order)) {
    logError("capture/verify", new Error("Firma inválida: la orden no la creó este servidor o fue modificada"), { orderId: id });
    return json(403, { error: "unverified_order" });
  }
  const unit = order.purchase_units[0];
  const want = unit.amount;

  if (order.status === "COMPLETED") return checkCaptured(order, want, id); // ya cobrada (reintento)
  if (order.status !== "APPROVED") return json(409, { error: "not_approved", status: order.status || null });

  let cap;
  try {
    cap = await api(cfg, `/v2/checkout/orders/${id}/capture`, {
      method: "POST", body: "{}", fetchImpl,
      headers: { "PayPal-Request-Id": "sg-cap-" + id, Prefer: "return=representation" }, // evita cobro doble
    });
  } catch (e) {
    logError("capture/capture", e, { orderId: id });
    if (e instanceof PayPalError && e.issue === "INSTRUMENT_DECLINED") return json(422, { error: "instrument_declined" });
    if (e instanceof PayPalError && e.issue === "ORDER_ALREADY_CAPTURED") {
      try { return checkCaptured(await api(cfg, "/v2/checkout/orders/" + id, { fetchImpl }), want, id); } catch (e2) { logError("capture/recheck", e2, { orderId: id }); }
    }
    return json(502, { error: "paypal_error" });
  }
  return checkCaptured(cap, want, id);
}

function checkCaptured(res, want, id) {
  const c = res?.purchase_units?.[0]?.payments?.captures?.[0];
  if (res?.status !== "COMPLETED" || !c) {
    logError("capture/status", new Error("Cobro no completado"), { orderId: id, status: res?.status, captureStatus: c?.status });
    return json(409, { error: "not_completed", status: c?.status || res?.status || null });
  }
  if (c.amount?.currency_code !== want.currency_code || c.amount?.value !== want.value) {
    logError("capture/amount", new Error("Monto cobrado distinto al de la orden"), { orderId: id, got: c.amount?.value, want: want.value });
    return json(409, { error: "amount_mismatch" });
  }
  // PENDING = PayPal retuvo el pago para revisión; el dinero aún no está disponible.
  return json(200, { id, status: c.status === "COMPLETED" ? "COMPLETED" : "PENDING" });
}

export default (req) => handle(req);
export const config = { path: "/api/paypal/capture-order" };
