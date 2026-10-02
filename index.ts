import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const openai = createOpenAI({
  baseURL: 'https://gateway.ai.vercel.com/v1',
  apiKey: process.env.AI_GATEWAY_API_KEY,
});

async function main() {
  console.log('Generating text...');
  const { text } = await generateText({
    model: openai('moonshotai/kimi-k3'),
    prompt: 'Invent a new holiday and describe its traditions.',
  });
  console.log(text);
}

main().catch(console.error);

