const ALLOWED_ORIGIN = "https://kdcamir5-crypto.github.io";

const MAX_IMAGE_BASE64 = 5_500_000;
const MAX_QUESTION_CHARS = 8_000;

const GEMINI_MODEL = "gemini-3.8-flash";

// Retry counts: total attempts
const GEMINI_ATTEMPTS = 3;
const SAMBANOVA_ATTEMPTS = 2;
const OPENROUTER_ATTEMPTS = 2;
const GROQ_ATTEMPTS = 1;

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
  const binary = atob(
    normalized + "=".repeat((4 - normalized.length % 4) % 4)
  );
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

async function verifyFirebaseToken(token, projectId) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid token");

  const header = JSON.parse(
    new TextDecoder().decode(decodeBase64Url(parts[0]))
  );

  const claims = JSON.parse(
    new TextDecoder().decode(decodeBase64Url(parts[1]))
  );

  if (header.alg !== "RS256" || !header.kid) {
    throw new Error("Invalid token header");
  }

  const now = Math.floor(Date.now() / 1000);

  if (
    claims.aud !== projectId ||
    claims.iss !== \`https://securetoken.google.com/\${projectId}\` ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    claims.exp <= now ||
    claims.iat > now + 60
  ) {
    throw new Error("Invalid token claims");
  }

  const jwksResponse = await fetch(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
  );

  if (!jwksResponse.ok) {
    throw new Error("Could not verify token");
  }

  const jwks = await jwksResponse.json();
  const jwk = jwks.keys.find(key => key.kid === header.kid);

  if (!jwk) throw new Error("Unknown token signing key");

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
    false,
    ["verify"]
  );

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

function buildTutorPrompt(question, language, level) {
  return \`You are SkillVerse BD, a careful educational tutor.
Solve the student's question accurately and teach step by step at the \${level} level.
Explanation language: \${language}.
For Bangla, answer in natural Bangla.
For Both, explain in Bangla and English.
Show formulas and intermediate steps where useful.
If the image/question is unclear or missing information, say so rather than guessing.
Structure answer with: Answer, Step-by-step explanation, and Key concept when appropriate.
Student's typed question: \${question || "(Question is provided in the image.)"}\`;
}

function buildOpenAIContent(prompt, imageData, mimeType) {
  if (!imageData) return prompt;

  return [
    {
      type: "text",
      text: prompt
    },
    {
      type: "image_url",
      image_url: {
        url: \`data:\${mimeType};base64,\${imageData}\`
      }
    }
  ];
}

function extractOpenAIAnswer(payload) {
  return payload.choices?.[0]?.message?.content?.trim() || "";
}

function isRetryable(status) {
  return status === 0 ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 524;
}

async function callOpenAICompatible({
  name,
  url,
  apiKey,
  model,
  prompt,
  imageData,
  mimeType,
  attempts
}) {
  if (!apiKey) {
    return {
      answer: "",
      diagnostic: {
        provider: name,
        code: "MISSING_API_KEY"
      }
    };
  }

  let lastDiagnostic = {};

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const apiResponse = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": \`Bearer \${apiKey}\`
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: buildOpenAIContent(prompt, imageData, mimeType)
            }
          ],
          temperature: 0.2,
          max_tokens: 2048
        })
      });

      const payload = await apiResponse.json().catch(() => ({}));
      const answer = extractOpenAIAnswer(payload);

      if (apiResponse.ok && answer) {
        return {
          answer,
          provider: name
        };
      }

      lastDiagnostic = {
        provider: name,
        httpStatus: apiResponse.status,
        code: payload.error?.code || payload.error?.type || "UNKNOWN",
        attempt
      };

      if (!isRetryable(apiResponse.status)) break;
    } catch {
      lastDiagnostic = {
        provider: name,
        httpStatus: 0,
        code: "NETWORK_ERROR",
        attempt
      };
    }

    if (attempt < attempts) {
      await wait(700 * (2 ** (attempt - 1)));
    }
  }

  return {
    answer: "",
    diagnostic: lastDiagnostic
  };
}

async function callGemini({
  apiKey,
  prompt,
  imageData,
  mimeType,
  attempts
}) {
  if (!apiKey) {
    return {
      answer: "",
      diagnostic: {
        provider: "Gemini",
        code: "MISSING_API_KEY"
      }
    };
  }

  const parts = [{ text: prompt }];

  if (imageData) {
    parts.push({
      inlineData: {
        mimeType,
        data: imageData
      }
    });
  }

  const requestBody = JSON.stringify({
    contents: [
      {
        role: "user",
        parts
      }
    ],
    generationConfig: {
      temperature: 0.25,
      maxOutputTokens: 2048
    }
  });

  let lastDiagnostic = {};

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const apiResponse = await fetch(
        \`https://generativelanguage.googleapis.com/v1beta/models/\${GEMINI_MODEL}:generateContent\`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: requestBody
        }
      );

      const payload = await apiResponse.json().catch(() => ({}));

      const answer = payload.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("")
        .trim() || "";

      if (apiResponse.ok && answer) {
        return {
          answer,
          provider: "Gemini"
        };
      }

      lastDiagnostic = {
        provider: "Gemini",
        httpStatus: apiResponse.status,
        code: payload.error?.status || payload.error?.code || "UNKNOWN",
        attempt
      };

      if (!isRetryable(apiResponse.status)) break;
    } catch {
      lastDiagnostic = {
        provider: "Gemini",
        httpStatus: 0,
        code: "NETWORK_ERROR",
        attempt
      };
    }

    if (attempt < attempts) {
      await wait(700 * (2 ** (attempt - 1)));
    }
  }

  return {
    answer: "",
    diagnostic: lastDiagnostic
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    // Health check
    if (request.method === "GET" && url.pathname === "/health") {
      return response(
        {
          ok: true,
          service: "SkillVerse AI Study Gateway"
        },
        200,
        origin === ALLOWED_ORIGIN ? origin : "*"
      );
    }

    // CORS validation
    if (origin !== ALLOWED_ORIGIN) {
      return response({ error: "Origin not allowed" }, 403);
    }

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

    if (request.method !== "POST" || url.pathname !== "/solve") {
      return response({ error: "Not found" }, 404, origin);
    }

    // Firebase Authentication
    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";

    if (!token) {
      return response(
        { error: "Please sign in before asking AI." },
        401,
        origin
      );
    }

    try {
      await verifyFirebaseToken(token, "skillverse-bd");
    } catch {
      return response(
        {
          error: "Your login session is invalid or expired. Please sign in again."
        },
        401,
        origin
      );
    }

    // Read input
    let input;

    try {
      input = await request.json();
    } catch {
      return response({ error: "Invalid request data." }, 400, origin);
    }

    const question =
      typeof input.question === "string"
        ? input.question.trim()
        : "";

    const language = ["Bangla", "English", "Both"].includes(input.language)
      ? input.language
      : "Bangla";

    const level = [
      "School",
      "SSC",
      "HSC",
      "University",
      "General"
    ].includes(input.level)
      ? input.level
      : "School";

    const imageData =
      typeof input.imageData === "string"
        ? input.imageData
        : "";

    const mimeType = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ].includes(input.mimeType)
      ? input.mimeType
      : "";

    if (!question && !imageData) {
      return response(
        { error: "Upload a question image or type your question." },
        400,
        origin
      );
    }

    if (question.length > MAX_QUESTION_CHARS) {
      return response({ error: "Question is too long." }, 400, origin);
    }

    if (
      imageData &&
      (
        !mimeType ||
        imageData.length > MAX_IMAGE_BASE64 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(imageData)
      )
    ) {
      return response(
        {
          error: "Image format or size is not supported. Use JPG, PNG or WEBP under about 4 MB."
        },
        400,
        origin
      );
    }

    const tutorPrompt = buildTutorPrompt(question, language, level);

    // 1. GEMINI — FIRST PROVIDER (3 ATTEMPTS)
    const geminiResult = await callGemini({
      apiKey: env.GEMINI_API_KEY,
      prompt: tutorPrompt,
      imageData,
      mimeType,
      attempts: GEMINI_ATTEMPTS
    });

    if (geminiResult.answer) {
      return response(
        {
          answer: geminiResult.answer,
          provider: geminiResult.provider
        },
        200,
        origin
      );
    }

    // 2. SAMBANOVA — SECOND PROVIDER (2 ATTEMPTS)
    const sambaResult = await callOpenAICompatible({
      name: "SambaNova",
      url: "https://api.sambanova.ai/v1/chat/completions",
      apiKey: env.SAMBANOVA_API_KEY,
      model: env.SAMBANOVA_MODEL || "Meta-Llama-3.3-70B-Instruct",
      prompt: tutorPrompt,
      imageData,
      mimeType,
      attempts: SAMBANOVA_ATTEMPTS
    });

    if (sambaResult.answer) {
      return response(
        {
          answer: sambaResult.answer,
          provider: sambaResult.provider
        },
        200,
        origin
      );
    }

    // 3. OPENROUTER — THIRD PROVIDER (2 ATTEMPTS)
    const openRouterResult = await callOpenAICompatible({
      name: "OpenRouter",
      url: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL || "google/gemini-2.5-flash",
      prompt: tutorPrompt,
      imageData,
      mimeType,
      attempts: OPENROUTER_ATTEMPTS
    });

    if (openRouterResult.answer) {
      return response(
        {
          answer: openRouterResult.answer,
          provider: openRouterResult.provider
        },
        200,
        origin
      );
    }

    // 4. GROQ — LAST PROVIDER (1 ATTEMPT)
    const groqResult = await callOpenAICompatible({
      name: "Groq",
      url: "https://api.groq.com/openai/v1/chat/completions",
      apiKey: env.GROQ_API_KEY,
      model: env.GROQ_MODEL || "qwen/qwen3.8-27b",
      prompt: tutorPrompt,
      imageData,
      mimeType,
      attempts: GROQ_ATTEMPTS
    });

    if (groqResult.answer) {
      return response(
        {
          answer: groqResult.answer,
          provider: groqResult.provider
        },
        200,
        origin
      );
    }

    // ALL PROVIDERS FAILED
    return response(
      {
        error: "AI is temporarily busy. Please try again shortly.",
        diagnostic: {
          gemini: geminiResult.diagnostic,
          sambanova: sambaResult.diagnostic,
          openrouter: openRouterResult.diagnostic,
          groq: groqResult.diagnostic
        }
      },
      502,
      origin
    );
  }
};