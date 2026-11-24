// The page a provider's sign-in comes back to (Pi's local callback server shows it), in Lightair's
// look instead of Pi's. scripts/build.ts puts it in place of pi-ai's utils/oauth-page.js; the two
// functions are what Pi's flows import from there. The Lightair logo is the Lightair project's
// mark: see docs/licences.md.

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" aria-hidden="true"><path d="M627.36 100C731.19 100 783.11 100 822.77 120.21A185.4 185.4 0 0 1 903.79 201.23C924 240.89 924 292.81 924 396.64L924 627.36C924 731.19 924 783.11 903.79 822.77A185.4 185.4 0 0 1 822.77 903.79C783.11 924 731.19 924 627.36 924L396.64 924C292.81 924 240.89 924 201.23 903.79A185.4 185.4 0 0 1 120.21 822.77C100 783.11 100 731.19 100 627.36L100 396.64C100 292.81 100 240.89 120.21 201.23A185.4 185.4 0 0 1 201.23 120.21C240.89 100 292.81 100 396.64 100Z" fill="#2A2A2D"/><path d="M625.68 106C728 106 779.16 106 818.24 125.91A182.7 182.7 0 0 1 898.09 205.76C918 244.84 918 296 918 398.32L918 625.68C918 728 918 779.16 898.09 818.24A182.7 182.7 0 0 1 818.24 898.09C779.16 918 728 918 625.68 918L398.32 918C296 918 244.84 918 205.76 898.09A182.7 182.7 0 0 1 125.91 818.24C106 779.16 106 728 106 625.68L106 398.32C106 296 106 244.84 125.91 205.76A182.7 182.7 0 0 1 205.76 125.91C244.84 106 296 106 398.32 106Z" fill="#141414"/><rect x="330.72" y="297.76" width="127.72" height="428.48" rx="63.86" fill="#FFFFFF"/><rect x="330.72" y="598.52" width="362.56" height="127.72" rx="63.86" fill="#FFFFFF"/><circle cx="623.24" cy="404.88" r="86.52" fill="#FF3B4A"/></svg>`;

function escape(v: string) {
  return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Pi's message names the provider ("Signed in to OpenAI. You may now close this page."): only
 * the provider is kept, said Lightair's way. */
function provider(message: string) {
  return /signed in to ([^.]+)/i.exec(message)?.[1]?.trim();
}

function page(ok: boolean, heading: string, body: string, details?: string) {
  const dot = ok ? "#3DD68C" : "#FF5C5C";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escape(heading)} · Lightair</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px; background: #0B0B0C; color: #F0F0F2;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%; max-width: 420px; padding: 32px; border-radius: 16px;
    background: #18181B; border: 1px solid #2B2B30; box-shadow: 0 24px 64px rgba(0,0,0,.45);
  }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 28px; color: #A9A9B1; font-size: 13px; font-weight: 600; }
  .brand svg { width: 28px; height: 28px; }
  h1 { margin: 0 0 8px; font-size: 22px; line-height: 1.25; font-weight: 650; display: flex; align-items: center; gap: 10px; }
  h1 i { width: 9px; height: 9px; border-radius: 50%; background: ${dot}; flex: none; }
  p { margin: 0; color: #A9A9B1; }
  .details { margin-top: 16px; padding: 10px 12px; border-radius: 8px; background: #0B0B0C; border: 1px solid #2B2B30;
    font: 12px/1.5 ui-monospace, Menlo, Consolas, monospace; color: #A9A9B1; white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
<main class="card">
  <div class="brand">${LOGO}<span>Lightair · AI co-host</span></div>
  <h1><i></i>${escape(heading)}</h1>
  <p>${escape(body)}</p>
  ${details ? `<div class="details">${escape(details)}</div>` : ""}
</main>
</body>
</html>`;
}

export function oauthSuccessHtml(message: string): string {
  const who = provider(message);
  return page(true, who ? `Signed in to ${who}` : "Signed in", "Your co-host can use it now. Close this page and go back to Lightair.");
}

export function oauthErrorHtml(message: string, details?: string): string {
  return page(false, "Sign-in didn't finish", `${message} Go back to Lightair and choose Sign in again.`, details);
}
