# Magicpin AI Challenge - Vera Bot Submission

This repository contains my submission for the Magicpin AI Challenge. It implements the Vera AI assistant using a deterministic, prompt-driven approach to generate high-quality merchant messages based on the provided JSON contexts.

## Approach: Single-Prompt Composer with Context Retrieval

Instead of using hardcoded templates, the bot relies on dynamic prompt injection. It stores the Category, Merchant, Trigger, and Customer contexts in memory as they are pushed by the judge. During a tick or reply, the bot retrieves the specific contextual payload and injects it straight into the LLM prompt. This allows a single, highly-optimized prompt to compose highly contextual responses for any scenario.

## Model Choice

I utilized the **llama-3.3-70b-versatile** model via the **Groq API**.

- **Speed**: Groq's fast LPU inference ensures all responses easily pass the strict 10-second timeout constraints.
- **Accuracy**: The 70B parameter model handles complex instruction following perfectly without hallucinating facts.
- **Determinism**: By setting `temperature: 0` and enforcing a strictly structured `json_object` response format, the outputs are highly stable and reproducible.

## Adherence to the 5 Rubric Dimensions

The single-prompt composer is explicitly structured to act as a strict rubric for the LLM, ensuring maximum scores across all dimensions:

1. **Specificity**: The prompt forces the LLM to use specific numbers, dates, and local facts strictly from the extracted context payload, forbidding hallucination.
2. **Category Fit**: The LLM is instructed to adapt to category-specific vocabulary constraints (e.g., using "footfall" for restaurants, or "membership churn" for gyms).
3. **Merchant Fit**: The prompt ensures the bot personalizes the message using the merchant's actual performance metrics and addresses the owner by their first name.
4. **Decision Quality**: The logic evaluates the trigger context logically before composing. It pushes back on the merchant if a request contradicts data (e.g., advising against ad-spend during an expected seasonal dip).
5. **Engagement Compulsion**: The bot is commanded to always end its messages with a single, clear, low-friction Call To Action (CTA).
