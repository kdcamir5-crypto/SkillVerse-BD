const ALLOWED_ORIGIN = "https://kdcamir5-crypto.github.io";
const MAX_IMAGE_BASE64 = 5_500_000;
const MAX_QUESTION_CHARS = 8_000;

function response(data, status = 200, origin = ALLOWED_ORIGIN) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin",
      "Cache-Control": "no-store"
    }
  });
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

async function verifyFirebaseToken(token, projectId) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid token");
  const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
  if (header.alg !== "RS256" || !header.kid) throw new Error("Invalid token header");
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}` ||
      typeof claims.sub !== "string" || !claims.sub || claims.exp <= now || claims.iat > now + 60) {
    throw new Error("Invalid token claims");
  }
  const jwksResponse = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
  if (!jwksResponse.ok) throw new Error("Could not verify token");
  const jwks = await jwksResponse.json();
  const jwk = jwks.keys.find(key => key.kid === header.kid);
  if (!jwk) throw new Error("Unknown token signing key");
  const publicKey = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1])
  );
  if (!valid) throw new Error("Invalid token signature");
  return claims;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (origin !== ALLOWED_ORIGIN) return response({ error: "Origin not allowed" }, 403);
    if (request.method === "OPTIONS") return response({}, 204, origin);
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return response({ ok: true, service: "SkillVerse AI Study Gateway" }, 200, origin);
    }
    if (request.method !== "POST" || new URL(request.url).pathname !== "/solve") {
      return response({ error: "Not found" }, 404, origin);
    }
    if (!env.GEMINI_API_KEY) return response({ error: "AI service is not configured yet." }, 503, origin);

    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return response({ error: "Please sign in before asking AI." }, 401, origin);
    let claims;
    try {
      claims = await verifyFirebaseToken(token, "skillverse-bd");
    } catch {
      return response({ error: "Your login session is invalid or expired. Please sign in again." }, 401, origin);
    }

    let input;
    try {
      input = await request.json();
    } catch {
      return response({ error: "Invalid request data." }, 400, origin);
    }
    const question = typeof input.question === "string" ? input.question.trim() : "";
    const language = ["Bangla", "English", "Both"].includes(input.language) ? input.language : "Bangla";
    const level = ["School", "SSC", "HSC", "University", "General"].includes(input.level) ? input.level : "School";
    const imageData = typeof input.imageData === "string" ? input.imageData : "";
    const mimeType = ["image/jpeg", "image/png", "image/webp"].includes(input.mimeType) ? input.mimeType : "";
    if (!question && !imageData) return response({ error: "Upload a question image or type your question." }, 400, origin);
    if (question.length > MAX_QUESTION_CHARS) return response({ error: "Question is too long." }, 400, origin);
    if (imageData && (!mimeType || imageData.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/]+=*$/.test(imageData))) {
      return response({ error: "Image format or size is not supported. Use JPG, PNG or WEBP under about 4 MB." }, 400, origin);
    }

    const parts = [{
      text: `You are SkillVerse BD, a careful educational tutor. Solve the student's question accurately and teach step by step at the ${level} level. Explanation language: ${language}. For Bangla, answer in natural Bangla. For Both, explain in Bangla and English. Show formulas and intermediate steps where useful. If the image/question is unclear or missing information, say so rather than guessing. Structure answer with: Answer, Step-by-step explanation, and Key concept when appropriate. Student's typed question: ${question || "(Question is provided in the image.)"}`
    }];
    if (imageData) parts.push({ inlineData: { mimeType, data: imageData } });

    try {
      const aiResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { temperature: 0.25, maxOutputTokens: 2048 }
        })
      });
      const payload = await aiResponse.json();
      if (!aiResponse.ok) {
        return response({ error: aiResponse.status === 429 ? "AI free usage limit reached for now. Please try again later." : "AI service could not process this question. Please try again." }, aiResponse.status === 429 ? 429 : 502, origin);
      }
      const answer = payload.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
      if (!answer) return response({ error: "AI returned an empty answer. Try a clearer question." }, 502, origin);
      return response({ answer, requestId: claims.sub }, 200, origin);
    } catch {
      return response({ error: "Could not connect to AI service. Please try again." }, 502, origin);
    }
  }
};
