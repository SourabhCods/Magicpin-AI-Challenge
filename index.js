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
    // Return 409 for stale or identical versions as per the official spec
    return res.status(409).json({
      accepted: false,
      reason: "stale_version",
      current_version: existing.version,
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

  if (
    !available_triggers ||
    available_triggers.length === 0 ||
    Object.keys(contexts.merchant).length === 0
  ) {
    return res.json({ actions: [] });
  }

  try {
    // Process triggers concurrently (up to 5 max) to stay under the strict 10s timeout budget
    const actionPromises = available_triggers
      .slice(0, 5)
      .map(async (triggerId) => {
        const triggerData = contexts.trigger[triggerId]?.payload || {};
        const merchantId =
          triggerData.merchant_id || Object.keys(contexts.merchant)[0];
        const merchantData = contexts.merchant[merchantId]?.payload || {};

        if (!merchantData.merchant_id) return null; // Skip if merchant isn't fully loaded

        const categoryId =
          merchantData.category_slug || Object.keys(contexts.category)[0];
        const categoryData = categoryId
          ? contexts.category[categoryId]?.payload
          : {};
        const customerId = triggerData.customer_id || null;
        const customerData = customerId
          ? contexts.customer[customerId]?.payload
          : null;

        const isCustomerScoped = !!customerData;

        const prompt = `
        You are Vera, an elite AI assistant for merchant growth at magicpin.
        ${
          isCustomerScoped
            ? "Compose a short, highly-compelling business message TO THE CUSTOMER on behalf of the merchant."
            : "Compose a short, highly-compelling business message to send to the merchant."
        }
        
        CRITICAL RULES:
        ${
          isCustomerScoped
            ? "1. Addressing: Address the CUSTOMER by their name from the Customer Context. DO NOT address the merchant. You are writing to the customer as the merchant."
            : "1. Owner Name: Always address the merchant by their 'owner_first_name' if available in the context. Do not use generic greetings."
        }
        2. Specificity & Grounding: You MUST use real numbers, dates, offers, and local facts strictly from the Context below. DO NOT invent or hallucinate facts.
        3. Citations & Constraints: If the trigger mentions research, explicitly cite the source. If suggesting an offer, strictly check its day-restrictions (e.g., 'Tue-Thu'). If it conflicts with an event (like an IPL match), surface this restriction explicitly!
        4. Category Vocabulary: Use domain-specific terms (e.g. 'covers' for restaurants, 'conversion' for gyms, 'fluoride' for dentists).
        ${
          isCustomerScoped
            ? "5. Call To Action: End with ONE simple question to the customer to book or engage (e.g., 'Would you like to book a slot for this week?')."
            : "5. Judgment & CTA: If a trigger implies a bad outcome, advise on a counter-strategy. End with ONE simple, low-effort next step (e.g., 'Want me to draft a WhatsApp? Reply YES.')."
        }

        Category Context: ${JSON.stringify(categoryData)}
        Merchant Context: ${JSON.stringify(merchantData)}
        Trigger Context: ${JSON.stringify(triggerData)}
        ${isCustomerScoped ? `Customer Context: ${JSON.stringify(customerData)}` : ""}
        
        Return ONLY a valid JSON object with this exact structure (no markdown):
        {
            "body": "The actual message",
            "cta": "open_ended or binary_yes_no",
            "suppression_key": "a unique string for this message type",
            "rationale": "A concise explanation of your reasoning"
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

          return {
            conversation_id: `conv_${merchantId}_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            merchant_id: merchantId,
            customer_id: customerId,
            send_as: customerId ? "merchant_on_behalf" : "vera",
            trigger_id: triggerId,
            body: result.body,
            cta: result.cta,
            suppression_key: result.suppression_key || `trigger:${triggerId}`,
            rationale: result.rationale || "Processed via Groq",
          };
        } catch (err) {
          console.error(`Groq API Error for trigger ${triggerId}:`, err);
          return null; // Fail this specific trigger gracefully, but let the others succeed!
        }
      });

    // Wait for all trigger LLM calls to finish
    const results = await Promise.all(actionPromises);

    // Filter out any nulls
    const actions = results.filter((a) => a !== null);

    res.json({ actions });
  } catch (error) {
    console.error("Groq API Error in /tick:", error);
    res.json({ actions: [] }); // Fail gracefully so the judge simulator doesn't crash
  }
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

  // Extract optional customer context if this is a customer-scoped conversation
  const customerId = req.body.customer_id || null;
  const customerData = customerId
    ? contexts.customer[customerId]?.payload
    : null;

  // Try to find the associated trigger from memory (optional, but helpful)
  const triggerId = Object.keys(contexts.trigger)[0];
  const triggerData = triggerId ? contexts.trigger[triggerId]?.payload : {};

  const prompt = `
    You are Vera, an AI assistant for merchant growth at magicpin.
    The merchant has replied to our previous message.
    
    Category Context: ${JSON.stringify(categoryData)}
    Merchant Context: ${JSON.stringify(merchantData)}
    Trigger Context: ${JSON.stringify(triggerData)}
    ${customerData ? `Customer Context: ${JSON.stringify(customerData)}` : ""}

    Current Turn Number: ${turn_number}
    Merchant's message: "${message}"
    
    Determine the next action. You can "send" a message, "wait" for more input, or "end" the conversation.
    
    RULES:
    1. Hostile: If the merchant is hostile, rude, or asks to stop messaging, action MUST be "end".
    2. Auto-reply: If the merchant's message looks like an automated out-of-office or generic auto-reply:
       - If Current Turn Number is 1, action MUST be "wait".
       - If Current Turn Number is >= 2, action MUST be "end".
    3. Commitment: If the merchant agrees, commits ("lets do it"), or asks a follow-up, action MUST be "send". DO NOT ask another qualifying question. Immediately execute the task (e.g., write the ACTUAL drafted message text in your response).
    4. Offer Constraints: If suggesting an offer to the merchant or drafting a message, strictly check its day-restrictions (e.g. 'Tue-Thu'). If it conflicts with an event (like an IPL match), explicitly state the restriction.
    5. Rationale: Keep the rationale concise and strictly reflective of your actual reasoning.
    
    Return ONLY a valid JSON object with this exact structure (no markdown):
    {
        "action": "send|wait|end", 
        "body": "The message text to send back (leave empty if wait/end)",
        "cta": "open_ended or binary_yes_no (leave empty if wait/end)",
        "wait_seconds": 14400,
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

    const responsePayload = {
      action: result.action || "wait",
      body: result.body || "",
      cta: result.cta || "",
      rationale: result.rationale || "Processed via Groq",
    };

    if (result.action === "wait") {
      responsePayload.wait_seconds = result.wait_seconds || 14400; // default to 4 hours if not specified
    }

    res.json(responsePayload);
  } catch (error) {
    console.error("Groq API Error in /reply:", error);
    res.json({ action: "wait", rationale: "Error generating response" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Vera Bot server is running on port ${PORT}`);
});
