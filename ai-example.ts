import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { config } from "dotenv";

// Load environment variables from .env.local if present
config({ path: ".env.local" });

async function main() {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    console.error("Please add AI_GATEWAY_API_KEY to your .env.local file.");
    process.exit(1);
  }

  // Create an OpenAI-compatible provider pointed at Vercel AI Gateway
  const openai = createOpenAI({
    baseURL: "https://gateway.ai.vercel.com/v1/api/openai",
    apiKey,
  });

  try {
    const { text } = await generateText({
      model: openai("moonshotai/kimi-k3"),
      prompt: "Invent a new holiday and describe its traditions.",
    });

    console.log("New Holiday Output:");
    console.log("-------------------");
    console.log(text);
  } catch (error) {
    console.error("Error generating text:", error);
  }
}

main();
