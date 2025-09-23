export default {
  async fetch(request, env) {
    const baseHeaders = {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: baseHeaders });
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: baseHeaders });
    }

    let payload;
    try { payload = await request.json(); }
    catch { return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400, headers: baseHeaders }); }

    const { imageBase64 = "", userPrompt = "ping", systemInstruction = "", model = "gemini-2.5-flash" } = payload || {};
    if (!env.GOOGLE_API_KEY) {
      return new Response(JSON.stringify({ error: "GOOGLE_API_KEY missing in worker env" }), { status: 500, headers: baseHeaders });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${env.GOOGLE_API_KEY}`;
    const body = {
      contents: [{
        parts: [
          { text: userPrompt },
          ...(imageBase64 ? [{ inlineData: { data: imageBase64, mimeType: "image/jpeg" } }] : []),
        ],
      }],
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
    };

    const upstream = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await upstream.text();
    if (!upstream.ok) {
      return new Response(JSON.stringify({ error: `upstream ${upstream.status}`, body: text.slice(0, 1000) }), { status: upstream.status, headers: baseHeaders });
    }
    return new Response(text, { headers: baseHeaders });
  }
};
