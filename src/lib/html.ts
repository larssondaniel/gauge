export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function page(title: string, body: string, status = 200, headers?: Headers): Response {
  const h = headers ?? new Headers();
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Cache-Control", "no-store");
  h.set("Referrer-Policy", "no-referrer");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#222}h1{font-size:1.4rem}code{background:#f3f3f3;padding:.1em .3em;border-radius:3px}button{font:inherit;padding:.5em 1.2em;border-radius:6px;border:1px solid #888;background:#fff;cursor:pointer}button.primary{background:#1a73e8;color:#fff;border-color:#1a73e8}</style></head><body>${body}</body></html>`,
    { status, headers: h },
  );
}
