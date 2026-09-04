import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();
const ai = new GoogleGenAI();
async function run() {
  const chat = ai.chats.create({
    model: 'gemini-3.6-flash'
  });
  const res = await chat.sendMessage({ message: "hi" });
  console.log(res.text);
}
run().catch(console.error);
