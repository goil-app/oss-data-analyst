import { generateText } from "ai";

const result = await generateText({
  model: "anthropic/claude-opus-4.5",
  prompt: "Generate a 10 word poem",
});

console.log(result.text);
