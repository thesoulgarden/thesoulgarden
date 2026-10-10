// Pruebas de las funciones de Netlify con un PayPal simulado (sin red).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.PAYPAL_ENV = "sandbox";
process.env.PAYPAL_CLIENT_ID = "test-client";
process.env.PAYPAL_CLIENT_SECRET = "test-secret";
const create = await import("../netlify/functions/paypal-create-order.mjs");
const capture = await import("../netlify/functions/paypal-capture-order.mjs");
const { _resetTokenCache, signOrder } = await import("../netlify/lib/paypal.mjs");

const data = {
  products: { products: [{ id: "a", name_es: "A", price: 10, cat: "rosarios", status: "disponible" }] },
  offers: { campaigns: [] }, gallery: { items: [] }, settings: { shipping_cost: 5 },
};
const req = (path, body, method = "POST") => new Request("https://x.test" + path, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? JSON.stringify(body) : undefined });

// PayPal falso: guarda órdenes y registra cada llamada.
function fakePayPal() {
  const orders = {}; const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    assert.equal(opts.redirect, "error");
    assert.ok(url.startsWith("https://api-m.sandbox.paypal.com/"), url);
    const u = new URL(url); const send = (s, b) => new Response(JSON.stringify(b), { status: s });
    if (u.pathname === "/v1/oauth2/token") return send(200, { access_token: "tok", expires_in: 3600 });
    if (u.pathname === "/v2/checkout/orders" && opts.method === "POST") {
      const id = "ORDER" + String(Object.keys(orders).length + 1).padStart(8, "0");
      orders[id] = { id, status: "CREATED", ...JSON.parse(opts.body) }; return send(201, { id, status: "CREATED" });
    }
    const m = u.pathname.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)(\/capture)?$/);
    if (m) {
      const o = orders[m[1]]; if (!o) return send(404, { name: "RESOURCE_NOT_FOUND" });
      if (!m[2]) return send(200, o);
      if (o.status === "COMPLETED") return send(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] });
      if (o.declined) return send(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] });
      o.status = "COMPLETED";
      o.purchase_units[0].payments = { captures: [{ status: o.pendingCapture ? "PENDING" : "COMPLETED", amount: o.capturedAmount || o.purchase_units[0].amount }] };
      return send(201, o);
    }
    return send(404, {});
  };
  return { orders, calls, fetchImpl };
}

beforeEach(() => _resetTokenCache());

async function newOrder(pp, lines = [{ id: "a", q: 2 }], expected = 20) {
  const r = await create.handle(req("/api/paypal/create-order", { lines, lang: "es", expected }), { data, fetchImpl: pp.fetchImpl });
  return { status: r.status, body: await r.json() };
}

test("crea la orden con el precio del servidor, firmada", async () => {
  const pp = fakePayPal();
  const { status, body } = await newOrder(pp);
  assert.equal(status, 201);
  const o = pp.orders[body.id].purchase_units[0];
  assert.equal(o.amount.value, "25.00");
  assert.match(o.custom_id, /^sg1\./);
  const auth = pp.calls[0].opts.headers.Authorization;
  assert.equal(auth, "Basic " + Buffer.from("test-client:test-secret").toString("base64"));
});

test("avisa si los precios cambiaron y no crea orden", async () => {
  const pp = fakePayPal();
  const { status, body } = await newOrder(pp, [{ id: "a", q: 2 }], 1);
  assert.equal(status, 409); assert.equal(body.error, "price_changed");
  assert.equal(Object.keys(pp.orders).length, 0);
});

test("errores de carrito devuelven 422 con el código", async () => {
  const { status, body } = await newOrder(fakePayPal(), [{ id: "zzz", q: 1 }], 10);
  assert.equal(status, 422); assert.equal(body.error, "unknown_product");
});

test("cobra una orden aprobada y confirma monto", async () => {
  const pp = fakePayPal();
  const { body } = await newOrder(pp);
  pp.orders[body.id].status = "APPROVED";
  const r = await capture.handle(req("/api/paypal/capture-order", { orderID: body.id }), { fetchImpl: pp.fetchImpl });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { id: body.id, status: "COMPLETED" });
  const cap = pp.calls.find((c) => c.url.endsWith("/capture"));
  assert.equal(cap.opts.headers["PayPal-Request-Id"], "sg-cap-" + body.id);
});

test("un reintento sobre una orden ya cobrada no cobra dos veces", async () => {
  const pp = fakePayPal();
  const { body } = await newOrder(pp);
  pp.orders[body.id].status = "APPROVED";
  await capture.handle(req("/api/paypal/capture-order", { orderID: body.id }), { fetchImpl: pp.fetchImpl });
  const n = pp.calls.filter((c) => c.url.endsWith("/capture")).length;
  const r = await capture.handle(req("/api/paypal/capture-order", { orderID: body.id }), { fetchImpl: pp.fetchImpl });
  assert.equal(r.status, 200);
  assert.equal(pp.calls.filter((c) => c.url.endsWith("/capture")).length, n);
});

test("rechaza órdenes que no creó el servidor (armadas en el navegador)", async () => {
  const pp = fakePayPal();
  pp.orders["FAKE00000001"] = { id: "FAKE00000001", status: "APPROVED", purchase_units: [{ amount: { currency_code: "USD", value: "1.00" }, items: [] }] };
  const r = await capture.handle(req("/api/paypal/capture-order", { orderID: "FAKE00000001" }), { fetchImpl: pp.fetchImpl });
  assert.equal(r.status, 403); assert.equal((await r.json()).error, "unverified_order");
  assert.ok(!pp.calls.some((c) => c.url.endsWith("/capture")));
});

test("rechaza órdenes con monto alterado después de firmar", async () => {
  const pp = fakePayPal();
  const { body } = await newOrder(pp);
  const o = pp.orders[body.id]; o.status = "APPROVED";
  o.purchase_units[0].amount.value = "1.00";
  const r = await capture.handle(req("/api/paypal/capture-order", { orderID: body.id }), { fetchImpl: pp.fetchImpl });
  assert.equal(r.status, 403);
});

test("rechaza si el monto cobrado no coincide", async () => {
  const pp = fakePayPal();
  const { body } = await newOrder(pp);
  Object.assign(pp.orders[body.id], { status: "APPROVED", capturedAmount: { currency_code: "USD", value: "3.00" } });
  const r = await capture.handle(req("/api/paypal/capture-order", { orderID: body.id }), { fetchImpl: pp.fetchImpl });
  assert.equal(r.status, 409); assert.equal((await r.json()).error, "amount_mismatch");
});

test("pago retenido por PayPal se informa como PENDING", async () => {
  const pp = fakePayPal();
  const { body } = await newOrder(pp);
  Object.assign(pp.orders[body.id], { status: "APPROVED", pendingCapture: true });
  const r = await capture.handle(req("/api/paypal/capture-order", { orderID: body.id }), { fetchImpl: pp.fetchImpl });
  assert.equal((await r.json()).status, "PENDING");
});

test("tarjeta rechazada devuelve instrument_declined", async () => {
  const pp = fakePayPal();
  const { body } = await newOrder(pp);
  Object.assign(pp.orders[body.id], { status: "APPROVED", declined: true });
  const r = await capture.handle(req("/api/paypal/capture-order", { orderID: body.id }), { fetchImpl: pp.fetchImpl });
  assert.equal(r.status, 422); assert.equal((await r.json()).error, "instrument_declined");
});

test("orden no aprobada no se cobra", async () => {
  const pp = fakePayPal();
  const { body } = await newOrder(pp);
  const r = await capture.handle(req("/api/paypal/capture-order", { orderID: body.id }), { fetchImpl: pp.fetchImpl });
  assert.equal(r.status, 409); assert.equal((await r.json()).error, "not_approved");
});

test("entradas inválidas y método", async () => {
  const pp = fakePayPal();
  for (const id of ["", "abc", "../../x", "A".repeat(40)]) {
    const r = await capture.handle(req("/api/paypal/capture-order", { orderID: id }), { fetchImpl: pp.fetchImpl });
    assert.equal(r.status, 400);
  }
  assert.equal((await capture.handle(req("/api/paypal/capture-order", null, "GET"))).status, 405);
  const big = await create.handle(new Request("https://x.test/a", { method: "POST", body: "x".repeat(20000) }), { data, fetchImpl: pp.fetchImpl });
  assert.equal(big.status, 400);
});

test("sin variables de entorno responde 503 y no llama a PayPal", async () => {
  const saved = process.env.PAYPAL_CLIENT_SECRET; delete process.env.PAYPAL_CLIENT_SECRET;
  const pp = fakePayPal();
  const { status } = await newOrder(pp);
  process.env.PAYPAL_CLIENT_SECRET = saved;
  assert.equal(status, 503); assert.equal(pp.calls.length, 0);
});

test("la firma depende del secreto", () => {
  const body = { purchase_units: [{ amount: { currency_code: "USD", value: "5.00" }, items: [] }] };
  assert.notEqual(signOrder("s1", body), signOrder("s2", body));
});
