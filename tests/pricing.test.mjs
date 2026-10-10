// Pruebas del cálculo de precios del servidor. Ejecutar: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { priceCart, parseStoreDate, paypalOrderBody, PricingError } from "../netlify/lib/pricing.mjs";

const P = (o) => ({ name_es: "Prod " + o.id, name_en: "Prod " + o.id, cat: "rosarios", status: "disponible", ...o });
const data = (over = {}) => ({
  products: { products: [
    P({ id: "a", price: 10 }),
    P({ id: "b", price: 28, cat: "sets" }),
    P({ id: "v", price: 0, variants: [{ label_es: "Chico", price: 12 }, { label_es: "Grande", price: 19.99 }] }),
    P({ id: "x", price: 15, status: "agotado" }),
  ] },
  offers: { campaigns: [] },
  gallery: { items: [{ id: "obra", title_es: "Obra", title_en: "Artwork", deal: { code: "ABC123", price: 35, expires: "2026-10-06T03:59:00.000Z" } }] },
  settings: { shipping_cost: 5 },
  ...over,
});
const NOW = Date.parse("2026-10-01T12:00:00Z");
const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof PricingError, e); return e.code; } assert.fail("no lanzó error"); };

test("precio base, cantidades y envío", () => {
  const r = priceCart(data(), [{ id: "a", q: 2 }, { id: "b", q: 1 }], { now: NOW });
  assert.equal(r.itemTotal, 48); assert.equal(r.shipping, 5); assert.equal(r.total, 53);
});

test("ignora cualquier precio que mande el navegador", () => {
  const r = priceCart(data(), [{ id: "a", q: 1, price: 0.01, unit: 0.01 }], { now: NOW });
  assert.equal(r.items[0].unit, 10);
});

test("variantes: usa el precio de la opción y la primera por defecto", () => {
  assert.equal(priceCart(data(), [{ id: "v", v: 1, q: 1 }], { now: NOW }).items[0].unit, 19.99);
  assert.equal(priceCart(data(), [{ id: "v", v: null, q: 1 }], { now: NOW }).items[0].unit, 12);
  assert.equal(code(() => priceCart(data(), [{ id: "v", v: 5, q: 1 }], { now: NOW })), "bad_variant");
  assert.equal(code(() => priceCart(data(), [{ id: "a", v: 0, q: 1 }], { now: NOW })), "bad_variant");
});

test("ofertas: mejor descuento aplicable, redondeo a centavos y fechas", () => {
  const offers = { campaigns: [
    { id: "t", active: true, start: "2026-09-28T00:00", end: "2026-11-30T23:59", discount: 15, applies_to: "all" },
    { id: "s", active: true, start: "2026-09-28T00:00", end: "2026-11-30T23:59", discount: 20, applies_to: "category", category: "sets" },
    { id: "off", active: false, discount: 90, applies_to: "all" },
  ] };
  const r = priceCart(data({ offers }), [{ id: "a", q: 1 }, { id: "b", q: 1 }, { id: "v", v: 1, q: 3 }], { now: NOW, lang: "es" });
  assert.equal(r.items[0].unit, 8.5);
  assert.equal(r.items[1].unit, 22.4);                 // 20% gana a 15% en sets
  assert.equal(r.items[2].unit, 16.99);                // 19.99 * 0.85 = 16.9915 → 16.99
  assert.equal(r.itemTotal, 8.5 + 22.4 + 16.99 * 3);
  assert.match(r.items[0].name, /\[oferta .* -15%\]/);
  const after = Date.parse("2026-12-01T06:00:00Z");
  assert.equal(priceCart(data({ offers }), [{ id: "a", q: 1 }], { now: after }).items[0].unit, 10);
});

test("fin de oferta en hora de Nueva York, no UTC", () => {
  const end = parseStoreDate("2026-11-30T23:59");
  assert.equal(new Date(end).toISOString(), "2026-12-01T04:59:00.000Z"); // EST = UTC-5
  assert.equal(new Date(parseStoreDate("2026-07-04T12:00")).toISOString(), "2026-07-04T16:00:00.000Z"); // EDT = UTC-4
  assert.equal(new Date(parseStoreDate("2026-10-06T03:59:00.000Z")).toISOString(), "2026-10-06T03:59:00.000Z");
  assert.equal(parseStoreDate("basura"), null);
});

test("rechaza agotados, desconocidos y cantidades inválidas", () => {
  assert.equal(code(() => priceCart(data(), [{ id: "x", q: 1 }], { now: NOW })), "sold_out");
  assert.equal(code(() => priceCart(data(), [{ id: "nope", q: 1 }], { now: NOW })), "unknown_product");
  for (const q of [0, -1, 21, 1.5, "2", null]) assert.equal(code(() => priceCart(data(), [{ id: "a", q }], { now: NOW })), "bad_quantity");
  assert.equal(code(() => priceCart(data(), [], { now: NOW })), "empty_cart");
  assert.equal(code(() => priceCart(data(), "x", { now: NOW })), "empty_cart");
  assert.equal(code(() => priceCart(data(), Array(31).fill({ id: "a", q: 1 }), { now: NOW })), "too_many_lines");
});

test("obras con precio acordado: código, vencimiento y vendidas", () => {
  const ok = priceCart(data(), [{ id: "art:obra", art: true, code: "ABC123", q: 5 }], { now: NOW });
  assert.equal(ok.items[0].unit, 35); assert.equal(ok.items[0].quantity, 1);
  assert.equal(code(() => priceCart(data(), [{ id: "art:obra", art: true, code: "WRONG", q: 1 }], { now: NOW })), "deal_invalid");
  assert.equal(code(() => priceCart(data(), [{ id: "art:obra", art: true, code: "ABC123", q: 1 }], { now: Date.parse("2026-10-07T00:00:00Z") })), "deal_expired");
  const sold = data(); sold.gallery.items[0].sold = true;
  assert.equal(code(() => priceCart(sold, [{ id: "art:obra", art: true, code: "ABC123", q: 1 }], { now: NOW })), "deal_invalid");
});

test("costo de envío del panel", () => {
  assert.equal(priceCart(data({ settings: { shipping_cost: 7.5 } }), [{ id: "a", q: 1 }], { now: NOW }).total, 17.5);
  assert.equal(priceCart(data({ settings: {} }), [{ id: "a", q: 1 }], { now: NOW }).shipping, 5);
  assert.equal(priceCart(data({ settings: { shipping_cost: -3 } }), [{ id: "a", q: 1 }], { now: NOW }).shipping, 0);
});

test("la orden de PayPal cuadra al centavo", () => {
  const r = priceCart(data(), [{ id: "v", v: 1, q: 3 }, { id: "a", q: 1 }], { now: NOW });
  const o = paypalOrderBody(r, "sg1.x").purchase_units[0];
  const sum = o.items.reduce((s, it) => s + Math.round(parseFloat(it.unit_amount.value) * 100) * +it.quantity, 0);
  assert.equal(sum, Math.round(parseFloat(o.amount.breakdown.item_total.value) * 100));
  assert.equal(o.amount.value, "74.97"); // 59.97 + 10 + 5
});

test("con los datos reales del panel no falla ningún producto disponible", async () => {
  const { readFile } = await import("node:fs/promises");
  const load = async (f) => JSON.parse(await readFile(new URL("../data/" + f, import.meta.url)));
  const real = { products: await load("products.json"), offers: await load("offers.json"), gallery: await load("gallery.json"), settings: await load("settings.json") };
  for (const p of real.products.products.filter((p) => p.status !== "agotado")) {
    const vs = p.variants?.length ? p.variants.map((_, i) => i) : [null];
    for (const v of vs) {
      const r = priceCart(real, [{ id: String(p.id), v, q: 1 }], { lang: "es" });
      assert.ok(r.items[0].unit > 0, p.id);
    }
  }
});
