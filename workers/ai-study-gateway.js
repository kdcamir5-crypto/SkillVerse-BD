const ALLOWED_ORIGIN = "https://kdcamir5-crypto.github.io";
const MAX_IMAGE_BASE64 = 5_500_000;
const MAX_QUESTION_CHARS = 8_000;
const GEMINI_MODEL = "gemini-3.8-flash";
const MAX_RETRIES = 3;

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

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "GET" && url.pathname === "/health") {
      return response({ ok: true, service: "SkillVerse AI Study Gateway" }, 200, origin === ALLOWED_ORIGIN ? origin : "*");
    }

    if (origin !== ALLOWED_ORIGIN) return response({ error: "Origin not allowed" }, 403);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Vary": "Origin"
        }
      });
    }
    if (request.method !== "POST" || url.pathname !== "/solve") return response({ error: "Not found" }, 404, origin);
    if (!env.GEMINI_API_KEY) return response({ error: "AI service is not configured yet.", diagnostic: "MISSING_API_SECRET" }, 503, origin);

    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return response({ error: "Please sign in before asking AI." }, 401, origin);
    try {
      await verifyFirebaseToken(token, "skillverse-bd");
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

    const requestBody = JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0.25, maxOutputTokens: 2048 }
    });
    let aiResponse;
    let payload = {};

    try {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        aiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: requestBody
        });
        payload = await aiResponse.json().catch(() => ({}));

        // Retry temporary Gemini server overloads. Do not retry invalid requests or exhausted quota.
        if (aiResponse.ok || ![500, 502, 503, 504, 524].includes(aiResponse.status) || attempt === MAX_RETRIES) break;
        await wait(700 * (2 ** attempt));
      }

      let groqDiagnostic = null;
      if (!aiResponse.ok && env.GROQ_API_KEY) {
        // Gemini failed: use Groq Qwen 3.8 as a secondary text-and-vision provider.
        let groqResponse;
        let groqPayload = {};
        try {
          const tutorPrompt = `You are SkillVerse BD, a careful educational tutor. Solve the student's question accurately and teach step by step at the ${level} level. Explanation language: ${language}. For Bangla, answer in natural Bangla. For Both, explain in Bangla and English. Show formulas and intermediate steps where useful. If the image/question is unclear or missing information, say so rather than guessing. Structure answer with: Answer, Step-by-step explanation, and Key concept when appropriate. Student's typed question: ${question || "(Question is provided in the image.)"}`;
          const groqContent = imageData
            ? [
                { type: "text", text: tutorPrompt },
                { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageData}` } }
              ]
            : tutorPrompt;
          groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${env.GROQ_API_KEY}`
            },
            body: JSON.stringify({
              model: "qwen/qwen3.8-27b",
              messages: [{ role: "user", content: groqContent }],
              temperature: 0.2,
              max_tokens: 2048,
              reasoning_effort: "none"
            })
          });
          groqPayload = await groqResponse.json().catch(() => ({}));
          const groqAnswer = groqPayload.choices?.[0]?.message?.content?.trim();
          if (groqResponse.ok && groqAnswer) {
            return response({ answer: groqAnswer, provider: "Groq Qwen 3.8" }, 200, origin);
          }
          groqDiagnostic = {
            httpStatus: groqResponse.status,
            code: groqPayload.error?.code || groqPayload.error?.type || "UNKNOWN",
            message: typeof groqPayload.error?.message === "string"
              ? groqPayload.error.message.slice(0, 240)
              : "Groq returned no answer."
          };
        } catch (groqError) {
          groqDiagnostic = { httpStatus: 0, code: "NETWORK_ERROR", message: "Could not reach Groq API." };
        }
      } else if (!aiResponse.ok) {
        groqDiagnostic = { httpStatus: 0, code: "MISSING_GROQ_API_KEY", message: "GROQ_API_KEY secret is not available in this deployed Worker." };
      }

      if (!aiResponse.ok) {
        const providerMessage = typeof payload.error?.message === "string" ? payload.error.message.slice(0, 240) : "No provider message returned.";
        const temporarilyUnavailable = [500, 502, 503, 504, 524].includes(aiResponse.status);
        return response({
          error: temporarilyUnavailable
            ? "Gemini is temporarily busy. We tried again automatically; please retry shortly."
            : aiResponse.status === 429
              ? "AI usage limit reached for now. Please try again later."
              : "Gemini could not process this request.",
          diagnostic: {
            httpStatus: aiResponse.status,
            code: payload.error?.status || payload.error?.code || "UNKNOWN",
            message: providerMessage,
            attempts: temporarilyUnavailable ? MAX_RETRIES + 1 : 1,
            groq: groqDiagnostic
          }
        }, aiResponse.status === 429 ? 429 : 502, origin);
      }

      const answer = payload.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
      if (!answer) return response({ error: "AI returned an empty answer. Try a clearer question.", diagnostic: { finishReason: payload.candidates?.[0]?.finishReason || "NO_CANDIDATE" } }, 502, origin);
      return response({ answer }, 200, origin);
    } catch {
      return response({ error: "Could not connect to AI service. Please try again." }, 502, origin);
    }
  }
};