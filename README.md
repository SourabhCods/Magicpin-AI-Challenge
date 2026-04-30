# Magicpin AI Challenge - Vera Bot Submission

This repository contains my submission for the Magicpin AI Challenge. It implements the Vera AI assistant using a deterministic, prompt-driven approach to generate high-quality merchant messages based on the provided JSON contexts.

## Approach
Instead of using hardcoded templates, the bot relies on dynamic prompt injection. It stores the Category, Merchant, Trigger, and Customer contexts in memory. During a tick or reply, it looks up the specific payload and injects it straight into the LLM prompt.

The prompt is explicitly structured around the challenge's 5 scoring dimensions:
- Forces the use of specific numbers and local facts from the payload.
- Adapts to category-specific vocabulary constraints.
- Personalizes the message using merchant performance metrics.
- Evaluates the trigger context logically before composing.
- Always ends with a single, low-friction CTA.

## Model Choice
I used the **llama-3.3-70b-versatile** model via the **Groq API**. 
- **Speed**: Groq's fast inference ensures all responses easily pass the 10-second timeout constraints.
- **Accuracy**: The 70B model handles complex instruction following perfectly without hallucinating facts.
- **Determinism**: By setting `temperature: 0` and enforcing a JSON response format, the outputs are highly stable and reproducible.

## Implementation Details
The server is built with Node.js and Express.
- `/v1/context`: Checks the version number to ensure idempotency. It replaces older contexts while safely ignoring stale duplicates.
- `/v1/tick`: Dynamically extracts the correct merchant and category based on the trigger payload to avoid mixing data when multiple merchants are loaded.
- `/v1/reply`: Analyzes merchant intent. It can detect hostile responses or out-of-office auto-replies and immediately returns an "end" action to prevent spamming.

## Tradeoffs
To optimize for latency during the local simulator tests, all context data is stored in-memory. In a real production deployment, this state would need to be migrated to a persistent datastore like Redis to support horizontal scaling and handle server restarts.
