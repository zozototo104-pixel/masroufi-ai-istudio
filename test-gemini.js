import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
async function run() {
  try {
    const session = await ai.live.connect({ 
      model: "gemini-2.0-flash-exp",
      config: { systemInstruction: "Reply only with 'Hi there' in text." },
      callbacks: { onmessage: (m) => console.log(m) }
    });
    console.log("Connected");
    session.send({ clientContent: { turns: [{ role: "user", parts: [{ text: "Hello" }] }] } });
    console.log("Sent text");
    setTimeout(() => session.close(), 2000);
  } catch (e) { console.error(e); }
}
run();
