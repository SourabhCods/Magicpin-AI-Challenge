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

// Conversation history tracking
const conversations = {};

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
    submitted_at: new Date().toISOString(),
  });
});

// 3. Receive Context Data
app.post("/v1/context", (req, res) => {
  const { scope, context_id, version, payload, delivered_at } = req.body;

  if (!contexts[scope]) {
    return res.status(400).json({
      accepted: false,
      reason: "invalid_scope",
      details: `Scope must be one of: category, merchant, customer, trigger. Received: ${scope}`,
    });
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

        // Customer-scoped triggers must compose customer-facing messages
        const isCustomerScoped = !!customerData;

        const triggerKind = triggerData.kind || "generic";
        const templateNameMap = {
          research_digest: "vera_research_digest_v1",
          recall_due: "vera_customer_recall_v1",
          perf_spike: "vera_perf_insight_v1",
          perf_dip: "vera_performance_alert_v1",
          milestone_reached: "vera_milestone_celebration_v1",
          dormant_with_vera: "vera_engagement_reactivation_v1",
          customer_lapsed_soft: "vera_customer_retention_v1",
          review_theme_emerged: "vera_review_insight_v1",
          festival_upcoming: "vera_festival_campaign_v1",
          weather_heatwave: "vera_weather_response_v1",
          competitor_opened: "vera_competitive_response_v1",
          regulation_change: "vera_compliance_alert_v1",
        };
        const templateName =
          templateNameMap[triggerKind] || "vera_generic_message_v1";

        const prompt = `
        You are Vera, an elite AI assistant for merchant growth at magicpin.
        ${
          isCustomerScoped
            ? "Compose a short, highly-compelling business message TO THE CUSTOMER on behalf of the merchant."
            : "Compose a short, highly-compelling business message to send to the merchant."
        }
        
        MESSAGE TEMPLATE: ${templateName}
        TRIGGER KIND: ${triggerKind}
        
        CRITICAL RULES:
        ${
          isCustomerScoped
            ? "1. Addressing: Address the CUSTOMER by their name from the Customer Context. DO NOT address the merchant. You are writing to the customer as the merchant."
            : "1. Owner Name: Always address the merchant by their 'owner_first_name' if available in the context. Do not use generic greetings."
        }
        2. Specificity & Grounding: You MUST use real numbers, dates, offers, and local facts (like 'locality') strictly from the Context below (e.g. from customer_aggregate, performance). DO NOT invent or hallucinate facts.
        3. Citations & Constraints: If the trigger mentions research or compliance alerts, explicitly cite the source. If suggesting an offer, strictly check its day-restrictions (e.g., 'Tue-Thu'). If it conflicts with an event (like an IPL match), surface this restriction explicitly!
        4. Category Vocabulary: Use domain-specific terms (e.g. 'covers' for restaurants, 'conversion' for gyms, 'fluoride' for dentists).
        ${
          isCustomerScoped
            ? "5. Call To Action: End with ONE simple question to the customer to book or engage (e.g., 'Would you like to book a slot for this week?')."
            : `5. Judgment: Do not just blindly follow the trigger. If it implies a bad outcome, advise on a smart, data-informed counter-strategy.
        6. Engagement Compulsion: End with ONE simple, low-effort next step (e.g., "Want me to draft a 3-line WhatsApp? Reply YES.").`
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
            "template_params": ["param1_value", "param2_value"],
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
          const convId = `conv_${merchantId}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

          // Store conversation in history
          conversations[convId] = {
            merchant_id: merchantId,
            customer_id: customerId,
            trigger_id: triggerId,
            turns: [
              {
                turn: 1,
                from: "vera",
                message: result.body,
                timestamp: new Date().toISOString(),
              },
            ],
          };

          return {
            conversation_id: convId,
            merchant_id: merchantId,
            customer_id: customerId,
            send_as: customerId ? "merchant_on_behalf" : "vera",
            trigger_id: triggerId,
            template_name: templateName,
            template_params: result.template_params || [],
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

  const isCustomerReply = from_role === "customer";
  const merchantName = merchantData?.owner_first_name || "Merchant";
  const customerName = customerData?.name || "Customer";

  const prompt = `
    You are ${isCustomerReply ? "Vera, an AI assistant for the merchant (" + merchantName + "). You are handling customer conversations on behalf of the merchant." : "Vera, an AI assistant for merchant growth at magicpin"}.
    The ${isCustomerReply ? "customer (" + customerName + ")" : "merchant"} has replied to your previous message.
    
    Category Context: ${JSON.stringify(categoryData)}
    Merchant Context: ${JSON.stringify(merchantData)}
    Trigger Context: ${JSON.stringify(triggerData)}
    ${customerData ? `Customer Context: ${JSON.stringify(customerData)}` : ""}

    Current Turn Number: ${turn_number}
    ${isCustomerReply ? "Customer (" + customerName + ")" : "Merchant"}'s message: "${message}"
    
    Determine the next action. You can "send" a message, "wait" for more input, or "end" the conversation.
    
    RULES:
    ${
      isCustomerReply
        ? `1. Addressing: You are replying to the CUSTOMER. Address them by their name (${customerName}). Do NOT address the merchant.
       2. Action: If the customer agrees to book or asks a question, action MUST be "send" and you must reply directly to them fulfilling their request.
       3. Hostile/Stop: If the customer asks to stop messaging or is hostile, action MUST be "end".`
        : `1. Hostile: If the merchant is hostile, rude, or asks to stop messaging, action MUST be "end".
       2. Auto-reply: If the merchant's message looks like an automated out-of-office or generic auto-reply (e.g., "Thank you for contacting", "I will get back"):
          - If Current Turn Number is 2 (merchant's first reply), action MUST be "wait" with wait_seconds=3600 (don't end yet).
          - If Current Turn Number is >= 3 and this also looks like auto-reply, action MUST be "end".
       3. Commitment: If the merchant agrees, commits ("lets do it", "sure", "yes"), or asks follow-ups, action MUST be "send". DO NOT re-ask qualifying questions. Immediately execute the task.
       4. Offer Constraints: If suggesting an offer, strictly check day-restrictions (e.g., 'Tue-Thu'). If it conflicts with events like IPL matches, explicitly state the restriction.`
    }
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

    // Update conversation history with this turn
    if (conversations[conversation_id]) {
      conversations[conversation_id].turns.push({
        turn: turn_number,
        from: from_role,
        message: message,
        timestamp: new Date().toISOString(),
      });
      if (result.action === "send") {
        conversations[conversation_id].turns.push({
          turn: turn_number + 1,
          from: from_role === "merchant" ? "vera" : "merchant",
          message: result.body,
          timestamp: new Date().toISOString(),
        });
      }
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
