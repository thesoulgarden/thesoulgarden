// Cálculo de precios del lado del servidor. El navegador solo dice QUÉ compra;
// los precios salen de data/*.json (los mismos que edita el panel /admin).
// Debe dar los mismos resultados que linePrice()/effPrice()/artDeal() de index.html.

export const STORE_TZ = "America/New_York";
export const MAX_LINES = 30;
export const MAX_QTY = 20;

export class PricingError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail; }
}

const num = (x) => { const n = parseFloat(x); return Number.isNaN(n) ? 0 : n; };
const cents = (n) => Math.round(n * 100);
export const m2 = (n) => (Math.round(n * 100) / 100).toFixed(2);

// Offset (ms) de la zona horaria en un instante dado.
function tzOffset(ms, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
}

// Fechas del panel: "2026-11-30T23:59" (sin zona) = hora de la tienda (Nueva York).
// Si trae zona ("...Z" o "+02:00") se respeta tal cual.
export function parseStoreDate(s, tz = STORE_TZ) {
  if (!s) return null;
  const str = String(s).trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(str)) { const t = Date.parse(str); return Number.isNaN(t) ? null : t; }
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  let t = guess - tzOffset(guess, tz);
  t = guess - tzOffset(t, tz); // segunda pasada por cambios de horario
  return t;
}

export function normalizeProducts(raw) {
  return ((raw && raw.products) || []).filter((p) => p && p.id && p.name_es).map((p) => {
    const o = { id: String(p.id), name: { es: p.name_es, en: p.name_en || p.name_es }, cat: p.cat || "rosarios",
      price: num(p.price), status: p.status || "disponible" };
    if (p.variants && p.variants.length) o.variants = p.variants.map((v) => ({ label: { es: v.label_es, en: v.label_en || v.label_es }, price: num(v.price) }));
    return o;
  });
}

export function activeCampaigns(offers, now) {
  return ((offers && offers.campaigns) || []).filter((c) => {
    if (!c || !c.active) return false;
    const st = parseStoreDate(c.start), en = parseStoreDate(c.end);
    return (st == null || now >= st) && (en == null || now <= en) && num(c.discount) > 0 && num(c.discount) < 100;
  });
}

function campaignApplies(c, p) {
  const to = c.applies_to || "all";
  if (to === "all") return true;
  if (to === "category") return c.category === p.cat;
  if (to === "products") return (c.products || []).map(String).includes(String(p.id));
  return false;
}

export function bestPromo(p, campaigns) {
  let best = null;
  for (const c of campaigns) if (campaignApplies(c, p) && (!best || num(c.discount) > num(best.discount))) best = c;
  return best ? { pct: num(best.discount), name: { es: best.name_es || "", en: best.name_en || best.name_es || "" } } : null;
}

// Productos de prueba (data/tests.json): solo existen si el modo está activado
// y el navegador trae el código correcto. Nunca tienen ofertas.
export function testProducts(tests, testCode) {
  if (!tests || !tests.active) return [];
  const code = String(tests.code || "");
  if (code.length < 6 || String(testCode || "") !== code) return [];
  return (tests.products || []).filter((p) => p && /^test-[a-z0-9-]{1,40}$/.test(String(p.id)) && num(p.price) > 0).map((p) => ({
    id: String(p.id), name: { es: "[PRUEBA] " + (p.name_es || p.name_en || "Producto de prueba"), en: "[TEST] " + (p.name_en || p.name_es || "Test item") },
    cat: "pruebas", price: num(p.price), status: "disponible", isTest: true,
  }));
}

export function shippingCost(settings) {
  const s = settings && settings.shipping_cost;
  return s != null && !Number.isNaN(parseFloat(s)) ? Math.max(0, parseFloat(s)) : 5;
}

const LBL = {
  es: { offer: "oferta", agreed: "precio acordado", code: "código" },
  en: { offer: "offer", agreed: "agreed price", code: "code" },
};

// lines: [{id, v, q}] o [{id:"art:<id>", art:true, code, q:1}]
export function priceCart(data, lines, { lang = "en", now = Date.now(), testCode = "" } = {}) {
  const L = LBL[lang] ? lang : "en";
  if (!Array.isArray(lines) || !lines.length) throw new PricingError("empty_cart");
  if (lines.length > MAX_LINES) throw new PricingError("too_many_lines");
  const products = normalizeProducts(data.products).filter((p) => !/^test-/.test(p.id))
    .concat(testProducts(data.tests, testCode));
  const byId = Object.fromEntries(products.map((p) => [p.id, p]));
  const camps = activeCampaigns(data.offers, now);
  const gallery = (data.gallery && data.gallery.items) || [];

  const items = lines.map((l, i) => {
    if (!l || typeof l !== "object") throw new PricingError("bad_line", i);
    if (l.art) {
      const id = String(l.id || "").replace(/^art:/, "");
      const it = gallery.find((x) => x && x.id === id);
      if (!it || it.sold || !it.deal || !it.deal.code || String(it.deal.code) !== String(l.code)) throw new PricingError("deal_invalid", i);
      const exp = it.deal.expires ? parseStoreDate(it.deal.expires) : null;
      if (exp != null && now > exp) throw new PricingError("deal_expired", i);
      const price = num(it.deal.price);
      if (!(price > 0)) throw new PricingError("deal_invalid", i);
      const title = L === "es" ? (it.title_es || it.title_en) : (it.title_en || it.title_es);
      return { sku: ("art:" + id).slice(0, 127), name: `${title || ""} [${LBL[L].agreed}, ${LBL[L].code} ${l.code}]`.slice(0, 127), quantity: 1, unit: price };
    }
    const p = byId[String(l.id)];
    if (!p) throw new PricingError("unknown_product", i);
    if (p.status === "agotado") throw new PricingError("sold_out", i);
    const q = l.q;
    if (!Number.isInteger(q) || q < 1 || q > MAX_QTY) throw new PricingError("bad_quantity", i);
    let v = l.v == null ? null : l.v;
    if (p.variants) {
      if (v == null) v = 0; // igual que la página: sin selección = primera opción
      if (!Number.isInteger(v) || v < 0 || v >= p.variants.length) throw new PricingError("bad_variant", i);
    } else if (v != null) throw new PricingError("bad_variant", i);
    const base = v != null ? p.variants[v].price : p.price;
    if (!(base > 0)) throw new PricingError("bad_price", i);
    const promo = p.isTest ? null : bestPromo(p, camps);
    const unit = promo ? Math.round(base * (100 - promo.pct)) / 100 : base;
    const name = p.name[L] + (v != null ? " — " + p.variants[v].label[L] : "") + (promo ? ` [${LBL[L].offer} ${promo.name[L]} -${promo.pct}%]` : "");
    return { sku: (p.id + (v != null ? ":" + v : "")).slice(0, 127), name: name.slice(0, 127), quantity: q, unit, isTest: !!p.isTest };
  });

  const itemCents = items.reduce((s, it) => s + cents(it.unit) * it.quantity, 0);
  const onlyTests = items.every((it) => it.isTest);
  const shipCents = onlyTests && data.tests && data.tests.no_shipping ? 0 : cents(shippingCost(data.settings));
  if (itemCents <= 0) throw new PricingError("bad_total");
  return { items, itemTotal: itemCents / 100, shipping: shipCents / 100, total: (itemCents + shipCents) / 100 };
}

// Cuerpo de la orden para la API de PayPal (Orders v2).
export function paypalOrderBody(priced, customId) {
  const usd = (n) => ({ currency_code: "USD", value: m2(n) });
  return {
    intent: "CAPTURE",
    purchase_units: [{
      description: "El Jardín de los Ángeles",
      custom_id: customId,
      items: priced.items.map((it) => ({ name: it.name, sku: it.sku, quantity: String(it.quantity), unit_amount: usd(it.unit), category: "PHYSICAL_GOODS" })),
      amount: { ...usd(priced.total), breakdown: { item_total: usd(priced.itemTotal), shipping: usd(priced.shipping) } },
    }],
  };
}
