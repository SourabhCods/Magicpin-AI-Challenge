require("dotenv").config();
const express = require("express");
const Groq = require("groq-sdk");

const app = express();
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const contexts = {
  category: {},
  merchant: {},
  customer: {},
  trigger: {},
};

// 1. Liveness Probe
app.get("/v1/healthz", (req, res) => {
  res.json({
    status: "ok",
    uptime_seconds: Math.floor(process.uptime()),
    contexts_loaded: {
      category: Object.keys(contexts.category).length,
      merchant: Object.keys(contexts.merchant).length,
      customer: Object.keys(contexts.customer).length,
      trigger: Object.keys(contexts.trigger).length,
    },
  });
});

// 2. Team Metadata
app.get("/v1/metadata", (req, res) => {
  res.json({
    team_name: "Sourabh Goyal",
    team_members: ["Sourabh Goyal"],
    model: "llama-3.3-70b-versatile",
    approach: "single-prompt composer with retrieval",
    version: "1.0.0",
  });
});

// 3. Receive Context Data
app.post("/v1/context", (req, res) => {
  const { scope, context_id, version, payload, delivered_at } = req.body;

  if (!contexts[scope]) {
    return res.status(400).json({ error: "Invalid scope" });
  }

  // Idempotency / Version check
  const existing = contexts[scope][context_id];
  if (existing && existing.version >= version) {
    // Ignore older or duplicate versions but still return 200 OK
    return res.json({
      accepted: true,
      ack_id: `ack_noop_${Date.now()}`,
      stored_at: new Date().toISOString(),
      note: "ignored_due_to_version",
    });
  }

  // Store context
  contexts[scope][context_id] = { version, payload, delivered_at };

  res.json({
    accepted: true,
    ack_id: `ack_${Date.now()}`,
    stored_at: new Date().toISOString(),
  });
});

// 4. Periodic Wake-up (Tick)
app.post("/v1/tick", async (req, res) => {
  const { now, available_triggers } = req.body;
  const actions = [];

  // For simplicity in this stub, let's just pick the first trigger and the first merchant we have in memory
  if (
    available_triggers &&
    available_triggers.length > 0 &&
    Object.keys(contexts.merchant).length > 0
  ) {
    const triggerId = available_triggers[0];
    const triggerData = contexts.trigger[triggerId]?.payload || {};

    // Extract the EXACT merchant intended for this trigger
    const merchantId =
      triggerData.merchant_id || Object.keys(contexts.merchant)[0];
    const merchantData = contexts.merchant[merchantId]?.payload || {};

    // Extract the EXACT category for this merchant
    const categoryId =
      merchantData.category_slug || Object.keys(contexts.category)[0];
    const categoryData = categoryId
      ? contexts.category[categoryId]?.payload
      : {};

    const prompt = `
        You are Vera, an elite AI assistant for merchant growth at magicpin.
        Compose a short, highly-compelling business message to send to a merchant.
        
        CRITICAL RULES:
        1. Owner Name: Always address the merchant by their 'owner_first_name' if available in the context. Do not use generic greetings.
        2. Specificity & Grounding: You MUST use real numbers, dates, offers, and local facts (like 'locality') strictly from the Context below (e.g. from customer_aggregate, performance). DO NOT invent or hallucinate any numbers or facts.
        3. Citations: If the trigger mentions research or compliance/supply alerts, you MUST explicitly cite the source (e.g., batch numbers, journal names) in the message.
        4. Category Vocabulary: Use domain-specific terms (e.g. 'covers' for restaurants, 'conversion' for gyms, 'fluoride' for dentists).
        5. Add Judgment: Do not just blindly follow the trigger. If a trigger implies a bad outcome (like IPL matches reducing restaurant footfall), advise them on a smart, data-informed counter-strategy.
        6. Engagement Compulsion: End with ONE simple, low-effort next step (e.g., "Want me to draft a 3-line WhatsApp? Reply YES.").

        Category Context: ${JSON.stringify(categoryData)}
        Merchant Context: ${JSON.stringify(merchantData)}
        Trigger Context: ${JSON.stringify(triggerData)}
        
        Return ONLY a valid JSON object with this exact structure (no markdown):
        {
            "body": "The actual message to the merchant",
            "cta": "open_ended or yes_no",
            "suppression_key": "a unique string for this message type"
        }
        `;

    try {
      const completion = await groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "llama-3.3-70b-versatile",
        temperature: 0,
        response_format: { type: "json_object" },
      });

      const result = JSON.parse(completion.choices[0].message.content);

      actions.push({
        merchant_id: merchantId,
        trigger_id: triggerId,
        body: result.body,
        cta: result.cta,
        suppression_key: result.suppression_key || `trigger:${triggerId}`,
      });
    } catch (error) {
      console.error("Groq API Error in /tick:", error);
    }
  }

  res.json({ actions });
});

// 5. Handle Replies
app.post("/v1/reply", async (req, res) => {
  const { conversation_id, merchant_id, from_role, message, turn_number } =
    req.body;

  // Retrieve context for the reply
  const merchantData = contexts.merchant[merchant_id]?.payload || {};
  const categoryId =
    merchantData.category_slug || Object.keys(contexts.category)[0];
  const categoryData = categoryId ? contexts.category[categoryId]?.payload : {};

  // Try to find the associated trigger from memory (optional, but helpful)
  const triggerId = Object.keys(contexts.trigger)[0];
  const triggerData = triggerId ? contexts.trigger[triggerId]?.payload : {};

  const prompt = `
    You are Vera, an AI assistant for merchant growth at magicpin.
    The merchant has replied to our previous message.
    
    Category Context: ${JSON.stringify(categoryData)}
    Merchant Context: ${JSON.stringify(merchantData)}
    Trigger Context: ${JSON.stringify(triggerData)}

    Merchant's message: "${message}"
    
    Determine the next action. You can "send" a message, "wait" for more input, or "end" the conversation.
    
    RULES:
    1. If the merchant is hostile, rude, or asks to stop messaging, action MUST be "end".
    2. If the merchant's message looks like an automated out-of-office or generic auto-reply, action MUST be "end".
    3. If the merchant agrees or asks a follow-up, action should be "send" with a helpful response that continues to add value (e.g. drafting the asset they agreed to).
    4. Rationale: Keep the rationale concise and strictly reflective of your actual reasoning.
    
    Return ONLY a valid JSON object with this exact structure (no markdown):
    {
        "action": "send|wait|end", 
        "body": "The message text to send back (leave empty if wait/end)",
        "rationale": "A concise explanation of why you chose this action based on the rules"
    }
    `;

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "llama-3.3-70b-versatile",
      temperature: 0,
      response_format: { type: "json_object" },
    });

    const result = JSON.parse(completion.choices[0].message.content);

    res.json({
      action: result.action || "wait",
      body: result.body || "",
      rationale: result.rationale || "Processed via Groq",
    });
  } catch (error) {
    console.error("Groq API Error in /reply:", error);
    res.json({ action: "wait", rationale: "Error generating response" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Vera Bot server is running on port ${PORT}`);
});
