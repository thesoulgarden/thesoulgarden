export const json = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

// Lee el cuerpo JSON con un límite de tamaño.
export async function readJson(req, maxBytes = 16384) {
  const len = parseInt(req.headers.get("content-length") || "0", 10);
  if (len > maxBytes) return null;
  const text = await req.text();
  if (text.length > maxBytes) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// Registro sin datos personales: solo código, número de orden y debug_id de PayPal.
export function logError(where, err, extra = {}) {
  console.error(JSON.stringify({ where, msg: err?.message, code: err?.code, issue: err?.issue, status: err?.status, debugId: err?.debugId, ...extra }));
}
